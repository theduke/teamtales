import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, JsonValue, TriggerSyncResponseDto } from "@teamtales/common/api";
import type { ActivityEvent, Provider, WorkItem } from "@teamtales/common/domain";

import { GitHubSourceConnector } from "../ingestion/github.js";
import { LinearSourceConnector } from "../ingestion/linear.js";
import type { ConnectorExecutionContext, ConnectorFetchResult, IntegrationCredential } from "../ingestion/providers.js";
import { hashCanonicalJson } from "../ingestion/json.js";
import type { IncomingSourceObject, PersistedSourceObject, SourceObjectType } from "../ingestion/source-object.js";
import { planSourceObjectUpsert } from "../ingestion/source-object.js";
import type { SyncCursor, SyncRun, SyncScope } from "../ingestion/sync.js";
import {
  normalizeGitHubCommit,
  normalizeGitHubIssue,
  normalizeGitHubIssueComment,
  normalizeGitHubPullRequest,
  normalizeGitHubPullRequestComment,
  normalizeGitHubPullRequestReview,
  normalizeLinearComment,
  normalizeLinearIssue,
  normalizeLinearProject,
} from "../normalization/index.js";
import { decryptCredentialSecret, redactText } from "../security/index.js";
import { stableId } from "./ids.js";
import { withTransaction } from "../persistence/index.js";

export interface RunProviderSyncServiceInput {
  provider: Provider;
  organizationId?: string;
  integrationId?: string;
  syncScopeId?: string;
  encryptionKey: string | Buffer;
  now?: Date;
}

export type RunProviderSyncServiceResult = TriggerSyncResponseDto & {
  counters: {
    objectsFetched: number;
    objectsInserted: number;
    objectsUpdated: number;
    objectsUnchanged: number;
    objectsFailed: number;
    activityEventsEmitted: number;
  };
};

type SourceObjectRow = PersistedSourceObject & {
  rawJson: JsonValue;
};

type NormalizedBatch = {
  workItems: WorkItem[];
  events: ActivityEvent[];
  eventSourceObjectIds: Map<string, string>;
  workItemSourceObjectIds: Map<string, string>;
};

export async function runProviderSyncService(
  database: DatabaseSync,
  input: RunProviderSyncServiceInput,
): Promise<RunProviderSyncServiceResult> {
  const scope = readSyncScope(database, input);
  const credential = readLatestCredential(database, scope.integrationId, input.encryptionKey);
  const now = input.now ?? new Date();
  const runId = stableId("sync_run", scope.id, now.toISOString());
  const run = createSyncRun(database, scope, runId, now);

  try {
    const cursors = readSyncCursors(database, scope);
    const connectorContext: ConnectorExecutionContext = {
      organizationId: scope.organizationId,
      integrationId: scope.integrationId,
      scope,
      run,
      cursors,
      credential,
    };
    const fetched = await connectorForProvider(input.provider).fetchSourceObjects(connectorContext);
    const persisted = persistFetchResult(database, scope, runId, fetched, now);

    return {
      provider: input.provider,
      status: "completed",
      syncRunId: runId,
      message: `Fetched ${persisted.counters.objectsFetched} ${input.provider} object(s).`,
      counters: persisted.counters,
    };
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), [credential.encryptedSecret]);
    finishFailedSyncRun(database, runId, now, message);
    return {
      provider: input.provider,
      status: "failed",
      syncRunId: runId,
      message,
      counters: {
        objectsFetched: 0,
        objectsInserted: 0,
        objectsUpdated: 0,
        objectsUnchanged: 0,
        objectsFailed: 1,
        activityEventsEmitted: 0,
      },
    };
  }
}

function persistFetchResult(
  database: DatabaseSync,
  scope: SyncScope,
  runId: string,
  fetched: ConnectorFetchResult,
  now: Date,
): RunProviderSyncServiceResult {
  return withTransaction(database, () => {
    const sourceObjects = upsertSourceObjects(database, fetched.objects, now);
    const normalized = normalizeSourceObjects(sourceObjects);

    upsertWorkItems(database, scope.organizationId, normalized.workItems, normalized.workItemSourceObjectIds);
    upsertPeopleForEvents(database, scope.organizationId, normalized.events);
    upsertActivityEvents(database, scope.organizationId, normalized.events, normalized.eventSourceObjectIds);
    upsertCursors(database, scope, fetched, now);

    const counters = {
      objectsFetched: fetched.objects.length,
      objectsInserted: sourceObjects.filter((object) => object.action === "insert").length,
      objectsUpdated: sourceObjects.filter((object) => object.action === "update").length,
      objectsUnchanged: sourceObjects.filter((object) => object.action === "unchanged").length,
      objectsFailed: 0,
      activityEventsEmitted: normalized.events.length,
    };

    finishSucceededSyncRun(database, runId, scope.id, now, counters);

    return {
      provider: scope.provider,
      status: "completed",
      syncRunId: runId,
      counters,
    };
  });
}

function connectorForProvider(provider: Provider): GitHubSourceConnector | LinearSourceConnector {
  return provider === "github" ? new GitHubSourceConnector() : new LinearSourceConnector();
}

function readSyncScope(database: DatabaseSync, input: RunProviderSyncServiceInput): SyncScope {
  const clauses = ["provider = ?", "enabled = 1"];
  const values: string[] = [input.provider];

  if (input.syncScopeId) {
    clauses.push("id = ?");
    values.push(input.syncScopeId);
  }
  if (input.integrationId) {
    clauses.push("integration_id = ?");
    values.push(input.integrationId);
  }
  if (input.organizationId) {
    clauses.push("organization_id = ?");
    values.push(input.organizationId);
  }

  const row = database
    .prepare(
      `SELECT *
       FROM sync_scopes
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, id
       LIMIT 1`,
    )
    .get(...values) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`No enabled ${input.provider} sync scope matched the request.`);
  }

  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    integrationId: requiredString(row, "integration_id"),
    provider: requiredString(row, "provider") as Provider,
    scopeType: requiredString(row, "scope_type") as SyncScope["scopeType"],
    externalId: optionalString(row, "external_id") ?? "",
    externalName: requiredString(row, "external_name"),
    configJson: JSON.parse(requiredString(row, "config_json")) as JsonObject,
    enabled: requiredNumber(row, "enabled") === 1,
    lastSuccessAt: dateFromString(optionalString(row, "last_success_at")),
    lastAttemptAt: dateFromString(optionalString(row, "last_attempt_at")),
    createdAt: dateFromString(requiredString(row, "created_at")) ?? new Date(0),
    updatedAt: dateFromString(requiredString(row, "updated_at")) ?? new Date(0),
  };
}

function readLatestCredential(database: DatabaseSync, integrationId: string, encryptionKey: string | Buffer): IntegrationCredential {
  const row = database
    .prepare(
      `SELECT integration_id, encrypted_secret, secret_hint, expires_at
       FROM integration_credentials
       WHERE integration_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(integrationId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`No credential found for integration ${integrationId}.`);
  }

  return {
    integrationId,
    encryptedSecret: decryptCredentialSecret(
      {
        encryptedSecret: requiredString(row, "encrypted_secret"),
        secretHint: optionalString(row, "secret_hint"),
        expiresAt: optionalString(row, "expires_at"),
      },
      encryptionKey,
    ),
    secretHint: optionalString(row, "secret_hint"),
    expiresAt: dateFromString(optionalString(row, "expires_at")),
  };
}

function createSyncRun(database: DatabaseSync, scope: SyncScope, runId: string, now: Date): SyncRun {
  const timestamp = now.toISOString();
  database
    .prepare(
      `INSERT INTO sync_runs (
        id, organization_id, integration_id, sync_scope_id, provider, run_type, status, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, scope.organizationId, scope.integrationId, scope.id, scope.provider, "manual_resync", "running", timestamp, timestamp);

  database.prepare("UPDATE sync_scopes SET last_attempt_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, scope.id);

  return {
    id: runId,
    organizationId: scope.organizationId,
    integrationId: scope.integrationId,
    syncScopeId: scope.id,
    provider: scope.provider,
    runType: "manual_resync",
    status: "running",
    startedAt: now,
    objectsFetched: 0,
    objectsInserted: 0,
    objectsUpdated: 0,
    objectsUnchanged: 0,
    objectsFailed: 0,
    activityEventsEmitted: 0,
    createdAt: now,
  };
}

function readSyncCursors(database: DatabaseSync, scope: SyncScope): SyncCursor[] {
  return database
    .prepare("SELECT * FROM sync_cursors WHERE sync_scope_id = ? ORDER BY object_type, cursor_kind")
    .all(scope.id)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: requiredString(record, "id"),
        organizationId: requiredString(record, "organization_id"),
        integrationId: requiredString(record, "integration_id"),
        syncScopeId: requiredString(record, "sync_scope_id"),
        provider: requiredString(record, "provider") as Provider,
        objectType: requiredString(record, "object_type"),
        cursorKind: requiredString(record, "cursor_kind") as SyncCursor["cursorKind"],
        cursorValue: optionalString(record, "cursor_value"),
        highWatermark: dateFromString(optionalString(record, "high_watermark")),
        lastSuccessAt: dateFromString(optionalString(record, "last_success_at")),
        lastAttemptAt: dateFromString(optionalString(record, "last_attempt_at")),
        createdAt: dateFromString(requiredString(record, "created_at")) ?? new Date(0),
        updatedAt: dateFromString(requiredString(record, "updated_at")) ?? new Date(0),
      };
    });
}

function upsertSourceObjects(database: DatabaseSync, objects: readonly IncomingSourceObject[], now: Date): Array<SourceObjectRow & { action: string }> {
  return objects.map((incoming) => {
    const existing = readExistingSourceObject(database, incoming);
    const plan = planSourceObjectUpsert(incoming, existing, now);
    const id = plan.action === "insert" ? stableId("source_object", incoming.organizationId, incoming.integrationId, incoming.syncScopeId, incoming.provider, incoming.objectType, incoming.externalId) : plan.existingId;

    if (plan.action === "insert") {
      database
        .prepare(
          `INSERT INTO source_objects (
            id, organization_id, integration_id, sync_scope_id, provider, object_type, external_id,
            external_url, external_created_at, external_updated_at, external_deleted_at, raw_json,
            content_hash, first_seen_at, last_seen_at, last_changed_at, source_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          incoming.organizationId,
          incoming.integrationId,
          incoming.syncScopeId,
          incoming.provider,
          incoming.objectType,
          incoming.externalId,
          incoming.externalUrl ?? null,
          incoming.externalCreatedAt?.toISOString() ?? null,
          incoming.externalUpdatedAt?.toISOString() ?? null,
          incoming.externalDeletedAt?.toISOString() ?? null,
          JSON.stringify(incoming.rawJson),
          plan.contentHash,
          now.toISOString(),
          now.toISOString(),
          now.toISOString(),
          incoming.sourceState ?? "active",
          now.toISOString(),
          now.toISOString(),
        );
    } else if (plan.action === "update") {
      database
        .prepare(
          `UPDATE source_objects
           SET external_url = ?, external_created_at = ?, external_updated_at = ?, external_deleted_at = ?,
               raw_json = ?, content_hash = ?, last_seen_at = ?, last_changed_at = ?, source_state = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          incoming.externalUrl ?? null,
          incoming.externalCreatedAt?.toISOString() ?? null,
          incoming.externalUpdatedAt?.toISOString() ?? null,
          incoming.externalDeletedAt?.toISOString() ?? null,
          JSON.stringify(incoming.rawJson),
          plan.contentHash,
          now.toISOString(),
          now.toISOString(),
          incoming.sourceState ?? "active",
          now.toISOString(),
          id,
        );
    } else {
      database
        .prepare("UPDATE source_objects SET last_seen_at = ?, source_state = ?, updated_at = ? WHERE id = ?")
        .run(now.toISOString(), incoming.sourceState ?? "active", now.toISOString(), id);
    }

    return {
      id,
      organizationId: incoming.organizationId,
      integrationId: incoming.integrationId,
      syncScopeId: incoming.syncScopeId,
      provider: incoming.provider,
      objectType: incoming.objectType,
      externalId: incoming.externalId,
      rawJson: incoming.rawJson,
      contentHash: hashCanonicalJson(incoming.rawJson),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastChangedAt: plan.action === "unchanged" ? (existing?.lastChangedAt ?? now) : now,
      sourceState: incoming.sourceState ?? "active",
      externalUrl: incoming.externalUrl,
      externalCreatedAt: incoming.externalCreatedAt,
      externalUpdatedAt: incoming.externalUpdatedAt,
      externalDeletedAt: incoming.externalDeletedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      action: plan.action,
    };
  });
}

function readExistingSourceObject(database: DatabaseSync, incoming: IncomingSourceObject): PersistedSourceObject | undefined {
  const row = database
    .prepare(
      `SELECT *
       FROM source_objects
       WHERE organization_id = ? AND integration_id = ? AND sync_scope_id = ?
         AND provider = ? AND object_type = ? AND external_id = ?
       LIMIT 1`,
    )
    .get(incoming.organizationId, incoming.integrationId, incoming.syncScopeId, incoming.provider, incoming.objectType, incoming.externalId) as
    | Record<string, unknown>
    | undefined;

  if (!row) {
    return undefined;
  }

  return {
    id: requiredString(row, "id"),
    organizationId: requiredString(row, "organization_id"),
    integrationId: requiredString(row, "integration_id"),
    syncScopeId: requiredString(row, "sync_scope_id"),
    provider: requiredString(row, "provider") as Provider,
    objectType: requiredString(row, "object_type") as SourceObjectType,
    externalId: requiredString(row, "external_id"),
    rawJson: JSON.parse(requiredString(row, "raw_json")) as JsonValue,
    contentHash: requiredString(row, "content_hash") as PersistedSourceObject["contentHash"],
    firstSeenAt: dateFromString(requiredString(row, "first_seen_at")) ?? new Date(0),
    lastSeenAt: dateFromString(requiredString(row, "last_seen_at")) ?? new Date(0),
    lastChangedAt: dateFromString(requiredString(row, "last_changed_at")) ?? new Date(0),
    sourceState: requiredString(row, "source_state") as PersistedSourceObject["sourceState"],
    externalUrl: optionalString(row, "external_url"),
    externalCreatedAt: dateFromString(optionalString(row, "external_created_at")),
    externalUpdatedAt: dateFromString(optionalString(row, "external_updated_at")),
    externalDeletedAt: dateFromString(optionalString(row, "external_deleted_at")),
    createdAt: dateFromString(requiredString(row, "created_at")) ?? new Date(0),
    updatedAt: dateFromString(requiredString(row, "updated_at")) ?? new Date(0),
  };
}

function normalizeSourceObjects(sourceObjects: readonly SourceObjectRow[]): NormalizedBatch {
  const workItems: WorkItem[] = [];
  const events: ActivityEvent[] = [];
  const eventSourceObjectIds = new Map<string, string>();
  const workItemSourceObjectIds = new Map<string, string>();

  for (const source of sourceObjects) {
    const context = normalizationContext(source);

    if (source.objectType === "github.pull_request") {
      const result = normalizeGitHubPullRequest(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.issue") {
      const result = normalizeGitHubIssue(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.pull_request_review") {
      addEvents([normalizeGitHubPullRequestReview(asRecord(source.rawJson), context)], source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.pull_request_comment") {
      addEvents([normalizeGitHubPullRequestComment(asRecord(source.rawJson), context)], source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.issue_comment") {
      addEvents([normalizeGitHubIssueComment(asRecord(source.rawJson), context)], source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.commit") {
      addEvents([normalizeGitHubCommit(asRecord(source.rawJson), context)], source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "linear.issue") {
      const result = normalizeLinearIssue(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "linear.project") {
      const result = normalizeLinearProject(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "linear.comment") {
      addEvents([normalizeLinearComment(asRecord(source.rawJson), context)], source.id, events, eventSourceObjectIds);
    }
  }

  return { workItems, events, eventSourceObjectIds, workItemSourceObjectIds };
}

function normalizationContext(source: SourceObjectRow): { sourceObjectId: string; workItemId?: string; repositoryId?: string; linearTeamId?: string; linearProjectId?: string } {
  const raw = asRecord(source.rawJson);
  const repositoryId = source.provider === "github" ? source.syncScopeId : undefined;

  if (source.objectType === "linear.comment") {
    const issue = recordField(raw, "issue");
    const issueId = stringField(issue ?? {}, "id");
    return {
      sourceObjectId: source.id,
      workItemId: issueId ? `linear:linear_issue:${issueId}` : undefined,
      linearTeamId: nestedString(issue ?? raw, ["team", "id"]),
      linearProjectId: nestedString(issue ?? raw, ["project", "id"]),
    };
  }

  return { sourceObjectId: source.id, repositoryId };
}

function addWorkItem(
  workItem: WorkItem,
  sourceObjectId: string,
  workItems: WorkItem[],
  sourceIds: Map<string, string>,
): void {
  workItems.push(workItem);
  sourceIds.set(workItem.id, sourceObjectId);
}

function addEvents(
  nextEvents: readonly ActivityEvent[],
  sourceObjectId: string,
  events: ActivityEvent[],
  sourceIds: Map<string, string>,
): void {
  for (const event of nextEvents) {
    events.push(event);
    sourceIds.set(event.id, sourceObjectId);
  }
}

function upsertWorkItems(
  database: DatabaseSync,
  organizationId: string,
  workItems: readonly WorkItem[],
  sourceObjectIds: ReadonlyMap<string, string>,
): void {
  for (const item of workItems) {
    database
      .prepare(
        `INSERT INTO work_items (
          id, organization_id, source_object_id, provider, source_type, external_id, title, url, status, work_type,
          created_at_source, updated_at_source, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          source_object_id = excluded.source_object_id,
          title = excluded.title,
          url = excluded.url,
          status = excluded.status,
          updated_at_source = excluded.updated_at_source,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = CURRENT_TIMESTAMP`,
      )
      .run(
        item.id,
        organizationId,
        sourceObjectIds.get(item.id) ?? null,
        item.provider,
        item.sourceType,
        item.externalId,
        item.title,
        item.url ?? null,
        item.status,
        item.sourceType,
        item.createdAtSource ?? null,
        item.updatedAtSource ?? null,
        item.startedAt ?? null,
        item.completedAt ?? null,
      );
  }
}

function upsertPeopleForEvents(database: DatabaseSync, organizationId: string, events: readonly ActivityEvent[]): void {
  for (const personId of new Set(events.map((event) => event.actorPersonId).filter((value): value is string => Boolean(value)))) {
    database
      .prepare(
        `INSERT INTO people (id, organization_id, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
      )
      .run(personId, organizationId, personId);
  }
}

function upsertActivityEvents(
  database: DatabaseSync,
  organizationId: string,
  events: readonly ActivityEvent[],
  sourceObjectIds: ReadonlyMap<string, string>,
): void {
  for (const event of events) {
    database
      .prepare(
        `INSERT INTO activity_events (
          id, organization_id, source_object_id, provider, event_type, actor_person_id, work_item_id,
          repository_id, linear_team_id, linear_project_id, occurred_at, title, body, url, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_object_id = excluded.source_object_id,
          actor_person_id = excluded.actor_person_id,
          work_item_id = excluded.work_item_id,
          title = excluded.title,
          body = excluded.body,
          url = excluded.url,
          metadata_json = excluded.metadata_json`,
      )
      .run(
        event.id,
        organizationId,
        sourceObjectIds.get(event.id) ?? null,
        event.provider,
        event.eventType,
        event.actorPersonId ?? null,
        event.workItemId ?? null,
        event.repositoryId ?? null,
        event.linearTeamId ?? null,
        event.linearProjectId ?? null,
        event.occurredAt,
        event.title,
        event.body ?? null,
        event.url ?? null,
        JSON.stringify(event.metadata ?? {}),
      );
  }
}

function upsertCursors(database: DatabaseSync, scope: SyncScope, fetched: ConnectorFetchResult, now: Date): void {
  for (const cursor of fetched.cursorUpdates) {
    const cursorId = stableId("sync_cursor", scope.id, cursor.objectType, "updated_at");
    database
      .prepare(
        `INSERT INTO sync_cursors (
          id, organization_id, integration_id, sync_scope_id, provider, object_type, cursor_kind,
          cursor_value, high_watermark, last_success_at, last_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sync_scope_id, object_type, cursor_kind) DO UPDATE SET
          cursor_value = excluded.cursor_value,
          high_watermark = excluded.high_watermark,
          last_success_at = excluded.last_success_at,
          last_attempt_at = excluded.last_attempt_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        cursorId,
        scope.organizationId,
        scope.integrationId,
        scope.id,
        scope.provider,
        cursor.objectType,
        "updated_at",
        cursor.cursorValue ?? cursor.highWatermark?.toISOString() ?? null,
        cursor.highWatermark?.toISOString() ?? null,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
  }
}

function finishSucceededSyncRun(
  database: DatabaseSync,
  runId: string,
  scopeId: string,
  now: Date,
  counters: RunProviderSyncServiceResult["counters"],
): void {
  database
    .prepare(
      `UPDATE sync_runs
       SET status = ?, finished_at = ?, objects_fetched = ?, objects_inserted = ?, objects_updated = ?,
           objects_unchanged = ?, objects_failed = ?, activity_events_emitted = ?
       WHERE id = ?`,
    )
    .run(
      "succeeded",
      now.toISOString(),
      counters.objectsFetched,
      counters.objectsInserted,
      counters.objectsUpdated,
      counters.objectsUnchanged,
      counters.objectsFailed,
      counters.activityEventsEmitted,
      runId,
    );
  database
    .prepare("UPDATE sync_scopes SET last_success_at = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?")
    .run(now.toISOString(), now.toISOString(), now.toISOString(), scopeId);
}

function finishFailedSyncRun(database: DatabaseSync, runId: string, now: Date, error: string): void {
  database
    .prepare("UPDATE sync_runs SET status = ?, finished_at = ?, objects_failed = ?, error = ? WHERE id = ?")
    .run("failed", now.toISOString(), 1, error, runId);
}

function asRecord(value: JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedString(record: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
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

function dateFromString(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}
