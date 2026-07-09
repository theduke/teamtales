import type { DatabaseSync } from "node:sqlite";
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

import { buildReportContext } from "../analysis/index.js";
import { parseJsonObject } from "../persistence/sqlite.js";

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

export function resolveReportContext(database: DatabaseSync, input: ResolveReportContextInput): ResolvedReportContext {
  const stored = latestReportContext(database, input);
  if (stored) {
    return stored;
  }

  const organization = {
    id: input.organizationId,
    name: input.organizationName ?? readOrganizationName(database, input.organizationId) ?? input.organizationId,
  };
  const scope = resolveScope(input);
  const events = readActivityEvents(database, input.organizationId, input.periodStart, input.periodEnd, scope);
  const workItemIds = new Set(events.map((event) => event.workItemId).filter((id): id is string => id !== undefined));
  const personIds = new Set(events.map((event) => event.actorPersonId).filter((id): id is string => id !== undefined));

  return {
    context: buildReportContext({
      organization,
      scope,
      period: {
        start: input.periodStart,
        end: input.periodEnd,
      },
      freshness: databaseFreshness(database, input.organizationId),
      events,
      workItems: readWorkItems(database, input.organizationId, scope.type === "organization" ? undefined : workItemIds),
      people: readPeople(database, input.organizationId, scope.type === "organization" ? undefined : personIds),
    }),
  };
}

export function latestReportContext(
  database: DatabaseSync,
  input: Pick<ResolveReportContextInput, "organizationId"> &
    Partial<Pick<ResolveReportContextInput, "scopeType" | "scopeId" | "periodStart" | "periodEnd">>,
): ResolvedReportContext | undefined {
  const clauses: string[] = ["organization_id = ?"];
  const values: string[] = [input.organizationId];

  if (input.scopeType) {
    clauses.push("scope_type = ?");
    values.push(input.scopeType);
  }
  if (input.scopeId) {
    clauses.push("scope_id = ?");
    values.push(input.scopeId);
  }
  if (input.periodStart) {
    clauses.push("period_start = ?");
    values.push(input.periodStart);
  }
  if (input.periodEnd) {
    clauses.push("period_end = ?");
    values.push(input.periodEnd);
  }

  const row = database
    .prepare(
      `SELECT id, context_json
       FROM analysis_report_contexts
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(...values) as Record<string, unknown> | undefined;

  if (!row || typeof row.id !== "string" || typeof row.context_json !== "string") {
    return undefined;
  }

  return {
    analysisReportContextId: row.id,
    context: JSON.parse(row.context_json) as ReportContext,
  };
}

export function readActivityEvents(
  database: DatabaseSync,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
  scope?: ScopeRef,
): ActivityEvent[] {
  const clauses = ["organization_id = ?", "occurred_at >= ?", "occurred_at <= ?"];
  const values = [organizationId, periodStart, periodEnd];

  const scopedColumn = scopeColumn(scope);
  if (scope !== undefined && scopedColumn !== undefined) {
    clauses.push(`${scopedColumn} = ?`);
    values.push(scope.id);
  }

  return database
    .prepare(
      `SELECT * FROM activity_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at, id`,
    )
    .all(...values)
    .map((row) => {
      const record = row as Record<string, unknown>;
      const sourceObjectId = optionalColumn(record, "source_object_id");
      return stripUndefined({
        id: requiredColumn(record, "id"),
        provider: requiredColumn(record, "provider") as Provider,
        eventType: requiredColumn(record, "event_type"),
        actorPersonId: optionalColumn(record, "actor_person_id"),
        workItemId: optionalColumn(record, "work_item_id"),
        repositoryId: optionalColumn(record, "repository_id"),
        linearTeamId: optionalColumn(record, "linear_team_id"),
        linearProjectId: optionalColumn(record, "linear_project_id"),
        occurredAt: requiredColumn(record, "occurred_at"),
        title: requiredColumn(record, "title"),
        body: optionalColumn(record, "body"),
        url: optionalColumn(record, "url"),
        sourceRef: sourceObjectId ? `source_object:${sourceObjectId}` : undefined,
        metadata: parseJsonObject(requiredColumn(record, "metadata_json")),
      });
    });
}

export function readWorkItems(database: DatabaseSync, organizationId: string, workItemIds?: ReadonlySet<string>): WorkItem[] {
  if (workItemIds !== undefined && workItemIds.size === 0) {
    return [];
  }

  const clauses = ["organization_id = ?"];
  const values = [organizationId];
  if (workItemIds !== undefined) {
    clauses.push(`id IN (${placeholders(workItemIds.size)})`);
    values.push(...workItemIds);
  }

  return database
    .prepare(`SELECT * FROM work_items WHERE ${clauses.join(" AND ")} ORDER BY updated_at_source, id`)
    .all(...values)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return stripUndefined({
        id: requiredColumn(record, "id"),
        provider: requiredColumn(record, "provider") as Provider,
        sourceType: requiredColumn(record, "work_type") as WorkItem["sourceType"],
        externalId: requiredColumn(record, "external_id"),
        title: requiredColumn(record, "title"),
        url: optionalColumn(record, "url"),
        status: requiredColumn(record, "status") as WorkItem["status"],
        createdAtSource: optionalColumn(record, "created_at_source"),
        updatedAtSource: optionalColumn(record, "updated_at_source"),
        startedAt: optionalColumn(record, "started_at"),
        completedAt: optionalColumn(record, "completed_at"),
      });
    });
}

export function readPeople(database: DatabaseSync, organizationId: string, personIds?: ReadonlySet<string>): Person[] {
  if (personIds !== undefined && personIds.size === 0) {
    return [];
  }

  const clauses = ["organization_id = ?"];
  const values = [organizationId];
  if (personIds !== undefined) {
    clauses.push(`id IN (${placeholders(personIds.size)})`);
    values.push(...personIds);
  }

  return database
    .prepare(`SELECT id, display_name FROM people WHERE ${clauses.join(" AND ")} ORDER BY display_name, id`)
    .all(...values)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: requiredColumn(record, "id"),
        displayName: requiredColumn(record, "display_name"),
      };
    });
}

export function databaseFreshness(database: DatabaseSync, organizationId: string): AnalysisInput["freshness"] {
  const rows = database
    .prepare(
      `SELECT provider, MAX(last_success_at) AS last_success_at
       FROM sync_scopes
       WHERE organization_id = ?
       GROUP BY provider
       ORDER BY provider`,
    )
    .all(organizationId) as Array<Record<string, unknown>>;
  const freshness: { github?: string; linear?: string; warnings: string[] } = { warnings: [] };

  for (const row of rows) {
    const provider = row.provider;
    const lastSuccessAt = row.last_success_at;
    if ((provider === "github" || provider === "linear") && typeof lastSuccessAt === "string") {
      freshness[provider] = lastSuccessAt;
    }
  }

  return freshness;
}

function readOrganizationName(database: DatabaseSync, organizationId: string): string | undefined {
  const row = database.prepare("SELECT name FROM organizations WHERE id = ?").get(organizationId) as
    | Record<string, unknown>
    | undefined;
  return row ? optionalColumn(row, "name") : undefined;
}

function resolveScope(input: ResolveReportContextInput): ScopeRef {
  return {
    type: input.scopeType ?? "organization",
    id: input.scopeId ?? input.organizationId,
    name: input.scopeName ?? input.scopeId ?? input.organizationName ?? input.organizationId,
  };
}

function scopeColumn(scope: ScopeRef | undefined): string | undefined {
  switch (scope?.type) {
    case "github_repository":
      return "repository_id";
    case "linear_team":
      return "linear_team_id";
    case "linear_project":
      return "linear_project_id";
    case "person":
      return "actor_person_id";
    case "organization":
    case undefined:
      return undefined;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function requiredColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column: ${key}`);
  }
  return value;
}

function optionalColumn(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
