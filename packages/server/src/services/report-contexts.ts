import type {
  ActivityEvent,
  AnalysisInput,
  Person,
  Provider,
  ReportContext,
  ReportScopeType,
  ScopeRef,
  WorkItem,
} from "@teamtales/common/domain";
import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";

import { buildReportContext } from "../analysis/index.js";
import {
  activityEvents,
  analysisReportContexts,
  organizations,
  people,
  syncScopes,
  workItems,
} from "../db/schema.js";
import { parseJsonObject, type PersistenceDatabase } from "../persistence/database.js";

export interface ResolveReportContextInput {
  organizationId: string;
  organizationName?: string;
  scopeType?: ReportScopeType;
  scopeId?: string;
  scopeName?: string;
  periodStart: string;
  periodEnd: string;
}

export interface ResolvedReportContext {
  context: ReportContext;
  analysisReportContextId?: string;
}

export async function resolveReportContext(
  database: PersistenceDatabase,
  input: ResolveReportContextInput,
): Promise<ResolvedReportContext> {
  const stored = await latestReportContext(database, input);
  if (stored) return stored;

  const scope = resolveScope(input);
  const [storedOrganizationName, events, freshness] = await Promise.all([
    input.organizationName
      ? Promise.resolve(input.organizationName)
      : readOrganizationName(database, input.organizationId),
    readActivityEvents(database, input.organizationId, input.periodStart, input.periodEnd, scope),
    databaseFreshness(database, input.organizationId),
  ]);
  const workItemIds = new Set(
    events.map((event) => event.workItemId).filter((id): id is string => id !== undefined),
  );
  const personIds = new Set(
    events.map((event) => event.actorPersonId).filter((id): id is string => id !== undefined),
  );
  const [selectedWorkItems, selectedPeople] = await Promise.all([
    readWorkItems(
      database,
      input.organizationId,
      scope.type === "organization" ? undefined : workItemIds,
    ),
    readPeople(
      database,
      input.organizationId,
      scope.type === "organization" ? undefined : personIds,
    ),
  ]);

  return {
    context: buildReportContext({
      organization: {
        id: input.organizationId,
        name: storedOrganizationName ?? input.organizationId,
      },
      scope,
      period: { start: input.periodStart, end: input.periodEnd },
      freshness,
      events,
      workItems: selectedWorkItems,
      people: selectedPeople,
    }),
  };
}

export async function latestReportContext(
  database: PersistenceDatabase,
  input: Pick<ResolveReportContextInput, "organizationId"> &
    Partial<Pick<ResolveReportContextInput, "scopeType" | "scopeId" | "periodStart" | "periodEnd">>,
): Promise<ResolvedReportContext | undefined> {
  const clauses: SQL[] = [eq(analysisReportContexts.organizationId, input.organizationId)];
  if (input.scopeType) clauses.push(eq(analysisReportContexts.scopeType, input.scopeType));
  if (input.scopeId) clauses.push(eq(analysisReportContexts.scopeId, input.scopeId));
  if (input.periodStart) clauses.push(eq(analysisReportContexts.periodStart, input.periodStart));
  if (input.periodEnd) clauses.push(eq(analysisReportContexts.periodEnd, input.periodEnd));

  const [row] = await database
    .select({ id: analysisReportContexts.id, contextJson: analysisReportContexts.contextJson })
    .from(analysisReportContexts)
    .where(and(...clauses))
    .orderBy(desc(analysisReportContexts.createdAt), desc(analysisReportContexts.id))
    .limit(1);
  if (!row) return undefined;

  return { analysisReportContextId: row.id, context: JSON.parse(row.contextJson) as ReportContext };
}

export async function readActivityEvents(
  database: PersistenceDatabase,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
  scope?: ScopeRef,
): Promise<ActivityEvent[]> {
  const clauses: SQL[] = [
    eq(activityEvents.organizationId, organizationId),
    gte(activityEvents.occurredAt, periodStart),
    lte(activityEvents.occurredAt, periodEnd),
  ];
  const scopedColumn = scopeEventColumn(scope);
  if (scope && scopedColumn) clauses.push(eq(scopedColumn, scope.id));

  const rows = await database
    .select()
    .from(activityEvents)
    .where(and(...clauses))
    .orderBy(asc(activityEvents.occurredAt), asc(activityEvents.id));
  return rows.map((row) =>
    stripUndefined({
      id: row.id,
      provider: row.provider as Provider,
      eventType: row.eventType,
      actorPersonId: row.actorPersonId ?? undefined,
      workItemId: row.workItemId ?? undefined,
      repositoryId: row.repositoryId ?? undefined,
      linearTeamId: row.linearTeamId ?? undefined,
      linearProjectId: row.linearProjectId ?? undefined,
      occurredAt: row.occurredAt,
      title: row.title,
      body: row.body ?? undefined,
      url: row.url ?? undefined,
      sourceRef: row.sourceObjectId ? `source_object:${row.sourceObjectId}` : undefined,
      metadata: parseJsonObject(row.metadataJson),
    }),
  );
}

export async function readWorkItems(
  database: PersistenceDatabase,
  organizationId: string,
  workItemIds?: ReadonlySet<string>,
): Promise<WorkItem[]> {
  if (workItemIds?.size === 0) return [];
  const clauses: SQL[] = [eq(workItems.organizationId, organizationId)];
  if (workItemIds) clauses.push(inArray(workItems.id, [...workItemIds]));

  const rows = await database
    .select()
    .from(workItems)
    .where(and(...clauses))
    .orderBy(asc(workItems.updatedAtSource), asc(workItems.id));
  return rows.map((row) =>
    stripUndefined({
      id: row.id,
      provider: row.provider as Provider,
      sourceType: row.workType as WorkItem["sourceType"],
      externalId: row.externalId,
      title: row.title,
      url: row.url ?? undefined,
      status: row.status as WorkItem["status"],
      createdAtSource: row.createdAtSource ?? undefined,
      updatedAtSource: row.updatedAtSource ?? undefined,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
    }),
  );
}

export async function readPeople(
  database: PersistenceDatabase,
  organizationId: string,
  personIds?: ReadonlySet<string>,
): Promise<Person[]> {
  if (personIds?.size === 0) return [];
  const clauses: SQL[] = [eq(people.organizationId, organizationId)];
  if (personIds) clauses.push(inArray(people.id, [...personIds]));
  const rows = await database
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(and(...clauses))
    .orderBy(asc(people.displayName), asc(people.id));
  return rows;
}

export async function databaseFreshness(
  database: PersistenceDatabase,
  organizationId: string,
): Promise<AnalysisInput["freshness"]> {
  const rows = await database
    .select({ provider: syncScopes.provider, lastSuccessAt: syncScopes.lastSuccessAt })
    .from(syncScopes)
    .where(eq(syncScopes.organizationId, organizationId))
    .orderBy(asc(syncScopes.provider));
  const freshness: { github?: string; linear?: string; warnings: string[] } = { warnings: [] };
  for (const row of rows) {
    if (
      (row.provider === "github" || row.provider === "linear") &&
      row.lastSuccessAt &&
      (!freshness[row.provider] || row.lastSuccessAt > freshness[row.provider]!)
    ) {
      freshness[row.provider] = row.lastSuccessAt;
    }
  }
  return freshness;
}

async function readOrganizationName(
  database: PersistenceDatabase,
  organizationId: string,
): Promise<string | undefined> {
  const [row] = await database
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.name;
}

function resolveScope(input: ResolveReportContextInput): ScopeRef {
  return {
    type: input.scopeType ?? "organization",
    id: input.scopeId ?? input.organizationId,
    name: input.scopeName ?? input.scopeId ?? input.organizationName ?? input.organizationId,
  };
}

function scopeEventColumn(scope: ScopeRef | undefined) {
  switch (scope?.type) {
    case "github_repository":
      return activityEvents.repositoryId;
    case "linear_team":
      return activityEvents.linearTeamId;
    case "linear_project":
      return activityEvents.linearProjectId;
    case "person":
      return activityEvents.actorPersonId;
    case "organization":
    case undefined:
      return undefined;
  }
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
