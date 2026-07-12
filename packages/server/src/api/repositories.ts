import { and, asc, desc, eq, like, or } from "drizzle-orm";
import type {
  DashboardDto,
  IntegrationDto,
  JsonObject,
  JsonValue,
  OrganizationDto,
  ReportDetailDto,
  ReportSummaryDto,
  SourceObjectDto,
  SourceObjectSummaryDto,
  SyncScopeDto,
} from "@teamtales/common/api";
import type { Metric, Provider, ReportContext } from "@teamtales/common/domain";
import type { DbExecutor } from "../db/mysql.js";
import {
  analysisReportContexts,
  integrationCredentials,
  integrations,
  organizationMemberships,
  organizations,
  reports,
  sourceObjects,
  syncScopes,
} from "../db/schema.js";

export type IntegrationListItemDto = IntegrationDto & { secretHint?: string };

export async function listOrganizations(
  db: DbExecutor,
  userId: string,
): Promise<OrganizationDto[]> {
  return db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .innerJoin(
      organizationMemberships,
      eq(organizationMemberships.organizationId, organizations.id),
    )
    .where(
      and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, "active")),
    )
    .orderBy(asc(organizations.name), asc(organizations.id));
}

export async function listIntegrations(
  db: DbExecutor,
  organizationId: string,
): Promise<IntegrationListItemDto[]> {
  const rows = await db
    .select({ integration: integrations, secretHint: integrationCredentials.secretHint })
    .from(integrations)
    .leftJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
    .where(eq(integrations.organizationId, organizationId))
    .orderBy(asc(integrations.createdAt), asc(integrations.id));
  return rows.map(({ integration, secretHint }) => ({
    ...integration,
    provider: integration.provider as Provider,
    authType: integration.authType === "personal_access_token" ? "personal_access_token" : "oauth",
    status: integration.status as IntegrationDto["status"],
    ...(secretHint ? { secretHint } : {}),
  }));
}

export async function listSyncScopes(
  db: DbExecutor,
  organizationId: string,
): Promise<SyncScopeDto[]> {
  const rows = await db
    .select()
    .from(syncScopes)
    .where(eq(syncScopes.organizationId, organizationId))
    .orderBy(asc(syncScopes.createdAt), asc(syncScopes.id));
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    integrationId: row.integrationId,
    provider: row.provider as Provider,
    scopeType: row.scopeType as SyncScopeDto["scopeType"],
    externalId: row.externalId ?? "",
    externalName: row.externalName,
    ...(row.parentScopeId ? { parentScopeId: row.parentScopeId } : {}),
    selectionMode: row.selectionMode as SyncScopeDto["selectionMode"],
    config: JSON.parse(row.configJson) as JsonObject,
    enabled: Boolean(row.enabled),
    ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt } : {}),
    ...(row.lastAttemptAt ? { lastAttemptAt: row.lastAttemptAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function listReports(
  db: DbExecutor,
  organizationId: string,
): Promise<ReportSummaryDto[]> {
  const rows = await db
    .select()
    .from(reports)
    .where(eq(reports.organizationId, organizationId))
    .orderBy(desc(reports.periodEnd), desc(reports.createdAt), asc(reports.id));
  return rows.map(toReportSummary);
}

export async function listSourceObjects(
  db: DbExecutor,
  organizationId: string,
  options: { objectType?: string; search?: string; offset?: number; limit?: number } = {},
): Promise<{ items: SourceObjectSummaryDto[]; nextCursor?: string; types: string[] }> {
  const conditions = [eq(sourceObjects.organizationId, organizationId)];
  if (options.objectType) conditions.push(eq(sourceObjects.objectType, options.objectType));
  if (options.search) {
    const pattern = `%${options.search}%`;
    const searchCondition = or(
      like(sourceObjects.externalId, pattern),
      like(sourceObjects.rawJson, pattern),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const rows = await db
    .select()
    .from(sourceObjects)
    .where(and(...conditions))
    .orderBy(desc(sourceObjects.lastSeenAt), asc(sourceObjects.id))
    .limit(limit + 1)
    .offset(offset);
  const typeRows = await db
    .selectDistinct({ objectType: sourceObjects.objectType })
    .from(sourceObjects)
    .where(eq(sourceObjects.organizationId, organizationId))
    .orderBy(asc(sourceObjects.objectType));
  const page = rows.slice(0, limit);
  return {
    items: page.map(toSourceObjectSummary),
    ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    types: typeRows.map((row) => row.objectType),
  };
}

export async function getSourceObjectDto(
  db: DbExecutor,
  organizationId: string,
  id: string,
): Promise<SourceObjectDto | undefined> {
  const [row] = await db
    .select()
    .from(sourceObjects)
    .where(and(eq(sourceObjects.organizationId, organizationId), eq(sourceObjects.id, id)))
    .limit(1);
  return row
    ? { ...toSourceObjectSummary(row), raw: JSON.parse(row.rawJson) as JsonValue }
    : undefined;
}

export async function getReportDto(
  db: DbExecutor,
  organizationId: string,
  reportId: string,
): Promise<ReportDetailDto | undefined> {
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.organizationId, organizationId), eq(reports.id, reportId)))
    .limit(1);
  return row ? toReportDetail(row) : undefined;
}

export async function getDashboard(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<DashboardDto | undefined> {
  const organizationItems = await listOrganizations(db, userId);
  const organization = organizationItems.find((item) => item.id === organizationId);
  if (!organization) return undefined;
  const [integrationItems, scopeItems, reportItems, latestReport] = await Promise.all([
    listIntegrations(db, organizationId),
    listSyncScopes(db, organizationId),
    listReports(db, organizationId),
    readLatestReport(db, organizationId),
  ]);
  const latestContext = latestReport
    ? await readReportContext(db, latestReport.analysisReportContextId)
    : await readLatestReportContext(db, organizationId);
  return {
    organizations: organizationItems,
    selectedOrganizationId: organizationId,
    organization,
    integrations: integrationItems,
    syncScopes: scopeItems,
    reports: reportItems,
    ...(latestReport ? { latestReport } : {}),
    metrics: readDashboardMetrics(latestContext),
    highlights: readDashboardHighlights(latestContext),
    workItems: readDashboardWorkItems(latestContext),
    people: readDashboardPeople(latestContext),
  };
}

export const readDashboardMetrics = (context: ReportContext | undefined): Metric[] =>
  context?.metrics ?? [];
export const readDashboardHighlights = (
  context: ReportContext | undefined,
): ReportContext["highlights"] => context?.highlights ?? [];
export const readDashboardWorkItems = (
  context: ReportContext | undefined,
): ReportContext["workItems"] => context?.workItems ?? [];
export const readDashboardPeople = (context: ReportContext | undefined): ReportContext["people"] =>
  context?.people ?? [];

async function readLatestReport(
  db: DbExecutor,
  organizationId: string,
): Promise<ReportDetailDto | undefined> {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.organizationId, organizationId))
    .orderBy(desc(reports.periodEnd), desc(reports.createdAt), desc(reports.id))
    .limit(1);
  return row ? toReportDetail(row) : undefined;
}
async function readReportContext(db: DbExecutor, id: string): Promise<ReportContext | undefined> {
  const [row] = await db
    .select({ contextJson: analysisReportContexts.contextJson })
    .from(analysisReportContexts)
    .where(eq(analysisReportContexts.id, id))
    .limit(1);
  return row ? (JSON.parse(row.contextJson) as ReportContext) : undefined;
}
async function readLatestReportContext(
  db: DbExecutor,
  organizationId: string,
): Promise<ReportContext | undefined> {
  const [row] = await db
    .select({ contextJson: analysisReportContexts.contextJson })
    .from(analysisReportContexts)
    .where(eq(analysisReportContexts.organizationId, organizationId))
    .orderBy(
      desc(analysisReportContexts.periodEnd),
      desc(analysisReportContexts.createdAt),
      desc(analysisReportContexts.id),
    )
    .limit(1);
  return row ? (JSON.parse(row.contextJson) as ReportContext) : undefined;
}
type ReportRow = typeof reports.$inferSelect;
function toReportSummary(row: ReportRow): ReportSummaryDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    analysisReportContextId: row.analysisReportContextId,
    reportType: row.reportType as ReportSummaryDto["reportType"],
    scopeType: row.scopeType as ReportSummaryDto["scopeType"],
    scopeId: row.scopeId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status as ReportSummaryDto["status"],
    title: row.title,
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toReportDetail(row: ReportRow): ReportDetailDto {
  return {
    ...toReportSummary(row),
    bodyMarkdown: row.bodyMarkdown,
    structured: JSON.parse(row.structuredJson) as JsonObject,
  };
}

function toSourceObjectSummary(row: typeof sourceObjects.$inferSelect): SourceObjectSummaryDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    integrationId: row.integrationId,
    ...(row.syncScopeId ? { syncScopeId: row.syncScopeId } : {}),
    provider: row.provider as Provider,
    objectType: row.objectType,
    externalId: row.externalId,
    ...(row.externalUrl ? { externalUrl: row.externalUrl } : {}),
    ...(row.externalCreatedAt ? { externalCreatedAt: row.externalCreatedAt } : {}),
    ...(row.externalUpdatedAt ? { externalUpdatedAt: row.externalUpdatedAt } : {}),
    ...(row.externalDeletedAt ? { externalDeletedAt: row.externalDeletedAt } : {}),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastChangedAt: row.lastChangedAt,
    sourceState: row.sourceState,
  };
}
