import type { DatabaseSync } from "node:sqlite";
import type {
  DashboardDto,
  IntegrationDto,
  JsonObject,
  OrganizationDto,
  ReportDetailDto,
  ReportSummaryDto,
  SyncScopeDto,
} from "@teamtales/common/api";
import type { Metric, Provider, ReportContext } from "@teamtales/common/domain";

import { getReportForOrganization } from "../persistence/index.js";
import { parseJsonObject } from "../persistence/sqlite.js";

export type IntegrationListItemDto = IntegrationDto & {
  secretHint?: string;
};

export function listOrganizations(database: DatabaseSync): OrganizationDto[] {
  return database
    .prepare("SELECT id, name, slug FROM organizations ORDER BY name, id")
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: requiredString(record, "id"),
        name: requiredString(record, "name"),
        slug: requiredString(record, "slug"),
      };
    });
}

export function listIntegrations(database: DatabaseSync, organizationId: string): IntegrationListItemDto[] {
  return database
    .prepare(
      `SELECT integrations.*, integration_credentials.secret_hint
       FROM integrations
       LEFT JOIN integration_credentials ON integration_credentials.integration_id = integrations.id
       WHERE integrations.organization_id = ?
       ORDER BY integrations.created_at, integrations.id`,
    )
    .all(organizationId)
    .map(mapIntegration);
}

export function listSyncScopes(database: DatabaseSync, organizationId: string): SyncScopeDto[] {
  return database
    .prepare("SELECT * FROM sync_scopes WHERE organization_id = ? ORDER BY created_at, id")
    .all(organizationId)
    .map(mapSyncScope);
}

export function listReports(database: DatabaseSync, organizationId: string): ReportSummaryDto[] {
  return database
    .prepare("SELECT * FROM reports WHERE organization_id = ? ORDER BY period_end DESC, created_at DESC, id")
    .all(organizationId)
    .map(mapReportSummary);
}

export function getReportDto(database: DatabaseSync, organizationId: string, reportId: string): ReportDetailDto | undefined {
  const report = getReportForOrganization(database, organizationId, reportId);
  return report
    ? {
        id: report.id,
        organizationId: report.organizationId,
        analysisReportContextId: report.analysisReportContextId,
        reportType: report.reportType,
        scopeType: report.scopeType,
        scopeId: report.scopeId,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        status: report.status,
        title: report.title,
        summary: report.summary ?? undefined,
        bodyMarkdown: report.bodyMarkdown,
        structured: report.structured as JsonObject,
        createdByUserId: report.createdByUserId ?? undefined,
        createdAt: report.createdAt ?? "",
        updatedAt: report.updatedAt ?? "",
      }
    : undefined;
}

export function getDashboard(database: DatabaseSync, organizationId: string): DashboardDto | undefined {
  const organizations = listOrganizations(database);
  const organization = organizations.find((item) => item.id === organizationId);
  if (!organization) {
    return undefined;
  }
  const latestReport = readLatestReport(database, organizationId);
  const latestContext = latestReport
    ? readReportContext(database, latestReport.analysisReportContextId)
    : readLatestReportContext(database, organizationId);

  return {
    organizations,
    selectedOrganizationId: organizationId,
    organization,
    integrations: listIntegrations(database, organizationId),
    syncScopes: listSyncScopes(database, organizationId),
    reports: listReports(database, organizationId),
    ...(latestReport === undefined ? {} : { latestReport }),
    metrics: readDashboardMetrics(latestContext),
    highlights: readDashboardHighlights(latestContext),
    workItems: readDashboardWorkItems(latestContext),
    people: readDashboardPeople(latestContext),
  };
}

export function readDashboardMetrics(context: ReportContext | undefined): Metric[] {
  return context?.metrics ?? [];
}

export function readDashboardHighlights(context: ReportContext | undefined): ReportContext["highlights"] {
  return context?.highlights ?? [];
}

export function readDashboardWorkItems(context: ReportContext | undefined): ReportContext["workItems"] {
  return context?.workItems ?? [];
}

export function readDashboardPeople(context: ReportContext | undefined): ReportContext["people"] {
  return context?.people ?? [];
}

function mapIntegration(row: unknown): IntegrationListItemDto {
  const record = row as Record<string, unknown>;
  const secretHint = optionalString(record, "secret_hint");
  return {
    id: requiredString(record, "id"),
    organizationId: requiredString(record, "organization_id"),
    provider: requiredString(record, "provider") as Provider,
    authType: requiredString(record, "auth_type") === "personal_access_token" ? "personal_access_token" : "oauth",
    status: requiredString(record, "status") as IntegrationDto["status"],
    displayName: requiredString(record, "display_name"),
    createdAt: requiredString(record, "created_at"),
    updatedAt: requiredString(record, "updated_at"),
    ...(secretHint === undefined ? {} : { secretHint }),
  };
}

function mapSyncScope(row: unknown): SyncScopeDto {
  const record = row as Record<string, unknown>;
  const lastSuccessAt = optionalString(record, "last_success_at");
  const lastAttemptAt = optionalString(record, "last_attempt_at");

  return {
    id: requiredString(record, "id"),
    organizationId: requiredString(record, "organization_id"),
    integrationId: requiredString(record, "integration_id"),
    provider: requiredString(record, "provider") as Provider,
    scopeType: requiredString(record, "scope_type") as SyncScopeDto["scopeType"],
    externalId: optionalString(record, "external_id") ?? "",
    externalName: requiredString(record, "external_name"),
    config: parseJsonObject(requiredString(record, "config_json")) as JsonObject,
    enabled: Boolean(requiredNumber(record, "enabled")),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    createdAt: requiredString(record, "created_at"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

function mapReportSummary(row: unknown): ReportSummaryDto {
  const record = row as Record<string, unknown>;
  const summary = optionalString(record, "summary");
  const createdByUserId = optionalString(record, "created_by_user_id");

  return {
    id: requiredString(record, "id"),
    organizationId: requiredString(record, "organization_id"),
    analysisReportContextId: requiredString(record, "analysis_report_context_id"),
    reportType: requiredString(record, "report_type") as ReportSummaryDto["reportType"],
    scopeType: requiredString(record, "scope_type") as ReportSummaryDto["scopeType"],
    scopeId: requiredString(record, "scope_id"),
    periodStart: requiredString(record, "period_start"),
    periodEnd: requiredString(record, "period_end"),
    status: requiredString(record, "status") as ReportSummaryDto["status"],
    title: requiredString(record, "title"),
    ...(summary === undefined ? {} : { summary }),
    ...(createdByUserId === undefined ? {} : { createdByUserId }),
    createdAt: requiredString(record, "created_at"),
    updatedAt: requiredString(record, "updated_at"),
  };
}

function readLatestReport(database: DatabaseSync, organizationId: string): ReportDetailDto | undefined {
  const row = database
    .prepare("SELECT * FROM reports WHERE organization_id = ? ORDER BY period_end DESC, created_at DESC, id DESC LIMIT 1")
    .get(organizationId);
  return row ? mapReportDetail(row) : undefined;
}

function readReportContext(database: DatabaseSync, analysisReportContextId: string): ReportContext | undefined {
  const row = database
    .prepare("SELECT context_json FROM analysis_report_contexts WHERE id = ?")
    .get(analysisReportContextId) as Record<string, unknown> | undefined;
  return typeof row?.context_json === "string" ? (JSON.parse(row.context_json) as ReportContext) : undefined;
}

function readLatestReportContext(database: DatabaseSync, organizationId: string): ReportContext | undefined {
  const row = database
    .prepare(
      `SELECT context_json
       FROM analysis_report_contexts
       WHERE organization_id = ?
       ORDER BY period_end DESC, created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(organizationId) as Record<string, unknown> | undefined;
  return typeof row?.context_json === "string" ? (JSON.parse(row.context_json) as ReportContext) : undefined;
}

function mapReportDetail(row: unknown): ReportDetailDto {
  const summary = mapReportSummary(row);
  const record = row as Record<string, unknown>;
  return {
    ...summary,
    bodyMarkdown: requiredString(record, "body_markdown"),
    structured: parseJsonObject(requiredString(record, "structured_json")) as JsonObject,
  };
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column: ${key}`);
  }
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected number column: ${key}`);
  }
  return value;
}
