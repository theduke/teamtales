import type {
  JsonObject,
  JsonValue,
  TriggerSyncResponseDto,
} from "@teamtales/common/api";
import type {
  ActivityEvent,
  Provider,
  WorkItem,
} from "@teamtales/common/domain";
import { and, asc, desc, eq } from "drizzle-orm";

import type { AppDatabase, MySqlTransaction } from "../db/mysql.js";
import {
  activityEvents,
  integrationCredentials,
  people,
  sourceObjects,
  syncCursors,
  syncRuns,
  syncScopes,
  workItems,
} from "../db/schema.js";
import { GitHubSourceConnector } from "../ingestion/github.js";
import { LinearSourceConnector } from "../ingestion/linear.js";
import type {
  ConnectorExecutionContext,
  ConnectorFetchResult,
  IntegrationCredential,
} from "../ingestion/providers.js";
import { hashCanonicalJson } from "../ingestion/json.js";
import type {
  IncomingSourceObject,
  PersistedSourceObject,
  SourceObjectType,
} from "../ingestion/source-object.js";
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

type DatabaseExecutor = AppDatabase | MySqlTransaction;

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
  database: AppDatabase,
  input: RunProviderSyncServiceInput,
): Promise<RunProviderSyncServiceResult> {
  const scope = await readSyncScope(database, input);
  const credential = await readLatestCredential(
    database,
    scope.integrationId,
    input.encryptionKey,
  );
  const now = input.now ?? new Date();
  const runId = stableId("sync_run", scope.id, now.toISOString());
  const run = await createSyncRun(database, scope, runId, now);

  try {
    const cursors = await readSyncCursors(database, scope);
    const connectorContext: ConnectorExecutionContext = {
      organizationId: scope.organizationId,
      integrationId: scope.integrationId,
      scope,
      run,
      cursors,
      credential,
    };
    const fetched = await connectorForProvider(
      input.provider,
    ).fetchSourceObjects(connectorContext);
    const persisted = await persistFetchResult(
      database,
      scope,
      runId,
      fetched,
      now,
    );

    return {
      provider: input.provider,
      status: "completed",
      syncRunId: runId,
      message: `Fetched ${persisted.counters.objectsFetched} ${input.provider} object(s).`,
      counters: persisted.counters,
    };
  } catch (error) {
    const message = redactText(
      error instanceof Error ? error.message : String(error),
      [credential.encryptedSecret],
    );
    await finishFailedSyncRun(database, runId, now, message);
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

async function persistFetchResult(
  database: AppDatabase,
  scope: SyncScope,
  runId: string,
  fetched: ConnectorFetchResult,
  now: Date,
): Promise<RunProviderSyncServiceResult> {
  return database.transaction(async (transaction) => {
    const persistedSourceObjects = await upsertSourceObjects(
      transaction,
      fetched.objects,
      now,
    );
    const normalized = normalizeSourceObjects(persistedSourceObjects);

    await upsertWorkItems(
      transaction,
      scope.organizationId,
      normalized.workItems,
      normalized.workItemSourceObjectIds,
    );
    await upsertPeopleForEvents(
      transaction,
      scope.organizationId,
      normalized.events,
    );
    await upsertActivityEvents(
      transaction,
      scope.organizationId,
      normalized.events,
      normalized.eventSourceObjectIds,
    );
    await upsertCursors(transaction, scope, fetched, now);

    const counters = {
      objectsFetched: fetched.objects.length,
      objectsInserted: persistedSourceObjects.filter(
        (object) => object.action === "insert",
      ).length,
      objectsUpdated: persistedSourceObjects.filter(
        (object) => object.action === "update",
      ).length,
      objectsUnchanged: persistedSourceObjects.filter(
        (object) => object.action === "unchanged",
      ).length,
      objectsFailed: 0,
      activityEventsEmitted: normalized.events.length,
    };

    await finishSucceededSyncRun(transaction, runId, scope.id, now, counters);

    return {
      provider: scope.provider,
      status: "completed",
      syncRunId: runId,
      counters,
    };
  });
}

function connectorForProvider(
  provider: Provider,
): GitHubSourceConnector | LinearSourceConnector {
  return provider === "github"
    ? new GitHubSourceConnector()
    : new LinearSourceConnector();
}

async function readSyncScope(
  database: AppDatabase,
  input: RunProviderSyncServiceInput,
): Promise<SyncScope> {
  const clauses = [
    eq(syncScopes.provider, input.provider),
    eq(syncScopes.enabled, 1),
  ];
  if (input.syncScopeId) clauses.push(eq(syncScopes.id, input.syncScopeId));
  if (input.integrationId)
    clauses.push(eq(syncScopes.integrationId, input.integrationId));
  if (input.organizationId)
    clauses.push(eq(syncScopes.organizationId, input.organizationId));

  const [row] = await database
    .select()
    .from(syncScopes)
    .where(and(...clauses))
    .orderBy(desc(syncScopes.updatedAt), asc(syncScopes.id))
    .limit(1);

  if (!row) {
    throw new Error(
      `No enabled ${input.provider} sync scope matched the request.`,
    );
  }

  return {
    ...row,
    provider: row.provider as Provider,
    scopeType: row.scopeType as SyncScope["scopeType"],
    externalId: row.externalId ?? "",
    configJson: JSON.parse(row.configJson) as JsonObject,
    enabled: row.enabled === 1,
    lastSuccessAt: dateFromString(row.lastSuccessAt ?? undefined),
    lastAttemptAt: dateFromString(row.lastAttemptAt ?? undefined),
    createdAt: dateFromString(row.createdAt) ?? new Date(0),
    updatedAt: dateFromString(row.updatedAt) ?? new Date(0),
  };
}

async function readLatestCredential(
  database: AppDatabase,
  integrationId: string,
  encryptionKey: string | Buffer,
): Promise<IntegrationCredential> {
  const [row] = await database
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.integrationId, integrationId))
    .orderBy(
      desc(integrationCredentials.createdAt),
      desc(integrationCredentials.id),
    )
    .limit(1);

  if (!row) {
    throw new Error(`No credential found for integration ${integrationId}.`);
  }

  return {
    integrationId,
    encryptedSecret: decryptCredentialSecret(
      {
        encryptedSecret: row.encryptedSecret,
        secretHint: row.secretHint ?? undefined,
        expiresAt: row.expiresAt ?? undefined,
      },
      encryptionKey,
    ),
    secretHint: row.secretHint ?? undefined,
    expiresAt: dateFromString(row.expiresAt ?? undefined),
  };
}

async function createSyncRun(
  database: AppDatabase,
  scope: SyncScope,
  runId: string,
  now: Date,
): Promise<SyncRun> {
  const timestamp = now.toISOString();
  await database
    .insert(syncRuns)
    .values({
      id: runId,
      organizationId: scope.organizationId,
      integrationId: scope.integrationId,
      syncScopeId: scope.id,
      provider: scope.provider,
      runType: "manual_resync",
      status: "running",
      startedAt: timestamp,
      createdAt: timestamp,
    });
  await database
    .update(syncScopes)
    .set({ lastAttemptAt: timestamp, updatedAt: timestamp })
    .where(eq(syncScopes.id, scope.id));

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

async function readSyncCursors(
  database: AppDatabase,
  scope: SyncScope,
): Promise<SyncCursor[]> {
  const rows = await database
    .select()
    .from(syncCursors)
    .where(eq(syncCursors.syncScopeId, scope.id))
    .orderBy(asc(syncCursors.objectType), asc(syncCursors.cursorKind));
  return rows.map((row) => ({
    ...row,
    provider: row.provider as Provider,
    cursorKind: row.cursorKind as SyncCursor["cursorKind"],
    cursorValue: row.cursorValue ?? undefined,
    highWatermark: dateFromString(row.highWatermark ?? undefined),
    lastSuccessAt: dateFromString(row.lastSuccessAt ?? undefined),
    lastAttemptAt: dateFromString(row.lastAttemptAt ?? undefined),
    createdAt: dateFromString(row.createdAt) ?? new Date(0),
    updatedAt: dateFromString(row.updatedAt) ?? new Date(0),
  }));
}

async function upsertSourceObjects(
  database: DatabaseExecutor,
  objects: readonly IncomingSourceObject[],
  now: Date,
): Promise<Array<SourceObjectRow & { action: string }>> {
  const results: Array<SourceObjectRow & { action: string }> = [];
  for (const incoming of objects) {
    const existing = await readExistingSourceObject(database, incoming);
    const plan = planSourceObjectUpsert(incoming, existing, now);
    const id =
      plan.action === "insert"
        ? stableId(
            "source_object",
            incoming.organizationId,
            incoming.integrationId,
            incoming.syncScopeId,
            incoming.provider,
            incoming.objectType,
            incoming.externalId,
          )
        : plan.existingId;

    if (plan.action === "insert") {
      const timestamp = now.toISOString();
      await database
        .insert(sourceObjects)
        .values({
          id,
          organizationId: incoming.organizationId,
          integrationId: incoming.integrationId,
          syncScopeId: incoming.syncScopeId,
          provider: incoming.provider,
          objectType: incoming.objectType,
          externalId: incoming.externalId,
          externalUrl: incoming.externalUrl,
          externalCreatedAt: incoming.externalCreatedAt?.toISOString(),
          externalUpdatedAt: incoming.externalUpdatedAt?.toISOString(),
          externalDeletedAt: incoming.externalDeletedAt?.toISOString(),
          rawJson: JSON.stringify(incoming.rawJson),
          contentHash: plan.contentHash,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          sourceState: incoming.sourceState ?? "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
    } else if (plan.action === "update") {
      const timestamp = now.toISOString();
      await database
        .update(sourceObjects)
        .set({
          externalUrl: incoming.externalUrl,
          externalCreatedAt: incoming.externalCreatedAt?.toISOString(),
          externalUpdatedAt: incoming.externalUpdatedAt?.toISOString(),
          externalDeletedAt: incoming.externalDeletedAt?.toISOString(),
          rawJson: JSON.stringify(incoming.rawJson),
          contentHash: plan.contentHash,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          sourceState: incoming.sourceState ?? "active",
          updatedAt: timestamp,
        })
        .where(eq(sourceObjects.id, id));
    } else {
      const timestamp = now.toISOString();
      await database
        .update(sourceObjects)
        .set({
          lastSeenAt: timestamp,
          sourceState: incoming.sourceState ?? "active",
          updatedAt: timestamp,
        })
        .where(eq(sourceObjects.id, id));
    }

    results.push({
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
      lastChangedAt:
        plan.action === "unchanged" ? (existing?.lastChangedAt ?? now) : now,
      sourceState: incoming.sourceState ?? "active",
      externalUrl: incoming.externalUrl,
      externalCreatedAt: incoming.externalCreatedAt,
      externalUpdatedAt: incoming.externalUpdatedAt,
      externalDeletedAt: incoming.externalDeletedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      action: plan.action,
    });
  }
  return results;
}

async function readExistingSourceObject(
  database: DatabaseExecutor,
  incoming: IncomingSourceObject,
): Promise<PersistedSourceObject | undefined> {
  const [row] = await database
    .select()
    .from(sourceObjects)
    .where(
      and(
        eq(sourceObjects.organizationId, incoming.organizationId),
        eq(sourceObjects.integrationId, incoming.integrationId),
        eq(sourceObjects.syncScopeId, incoming.syncScopeId),
        eq(sourceObjects.provider, incoming.provider),
        eq(sourceObjects.objectType, incoming.objectType),
        eq(sourceObjects.externalId, incoming.externalId),
      ),
    )
    .limit(1);

  if (!row) {
    return undefined;
  }

  return {
    ...row,
    syncScopeId: row.syncScopeId ?? incoming.syncScopeId,
    provider: row.provider as Provider,
    objectType: row.objectType as SourceObjectType,
    rawJson: JSON.parse(row.rawJson) as JsonValue,
    contentHash: row.contentHash as PersistedSourceObject["contentHash"],
    sourceState: row.sourceState as PersistedSourceObject["sourceState"],
    externalUrl: row.externalUrl ?? undefined,
    externalCreatedAt: dateFromString(row.externalCreatedAt ?? undefined),
    externalUpdatedAt: dateFromString(row.externalUpdatedAt ?? undefined),
    externalDeletedAt: dateFromString(row.externalDeletedAt ?? undefined),
    firstSeenAt: dateFromString(row.firstSeenAt) ?? new Date(0),
    lastSeenAt: dateFromString(row.lastSeenAt) ?? new Date(0),
    lastChangedAt: dateFromString(row.lastChangedAt) ?? new Date(0),
    createdAt: dateFromString(row.createdAt) ?? new Date(0),
    updatedAt: dateFromString(row.updatedAt) ?? new Date(0),
  };
}

function normalizeSourceObjects(
  sourceObjects: readonly SourceObjectRow[],
): NormalizedBatch {
  const workItems: WorkItem[] = [];
  const events: ActivityEvent[] = [];
  const eventSourceObjectIds = new Map<string, string>();
  const workItemSourceObjectIds = new Map<string, string>();

  for (const source of sourceObjects) {
    const context = normalizationContext(source);

    if (source.objectType === "github.pull_request") {
      const result = normalizeGitHubPullRequest(
        asRecord(source.rawJson),
        context,
      );
      addWorkItem(
        result.workItem,
        source.id,
        workItems,
        workItemSourceObjectIds,
      );
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.issue") {
      const result = normalizeGitHubIssue(asRecord(source.rawJson), context);
      addWorkItem(
        result.workItem,
        source.id,
        workItems,
        workItemSourceObjectIds,
      );
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.pull_request_review") {
      addEvents(
        [normalizeGitHubPullRequestReview(asRecord(source.rawJson), context)],
        source.id,
        events,
        eventSourceObjectIds,
      );
    } else if (source.objectType === "github.pull_request_comment") {
      addEvents(
        [normalizeGitHubPullRequestComment(asRecord(source.rawJson), context)],
        source.id,
        events,
        eventSourceObjectIds,
      );
    } else if (source.objectType === "github.issue_comment") {
      addEvents(
        [normalizeGitHubIssueComment(asRecord(source.rawJson), context)],
        source.id,
        events,
        eventSourceObjectIds,
      );
    } else if (source.objectType === "github.commit") {
      addEvents(
        [normalizeGitHubCommit(asRecord(source.rawJson), context)],
        source.id,
        events,
        eventSourceObjectIds,
      );
    } else if (source.objectType === "linear.issue") {
      const result = normalizeLinearIssue(asRecord(source.rawJson), context);
      addWorkItem(
        result.workItem,
        source.id,
        workItems,
        workItemSourceObjectIds,
      );
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "linear.project") {
      const result = normalizeLinearProject(asRecord(source.rawJson), context);
      addWorkItem(
        result.workItem,
        source.id,
        workItems,
        workItemSourceObjectIds,
      );
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "linear.comment") {
      addEvents(
        [normalizeLinearComment(asRecord(source.rawJson), context)],
        source.id,
        events,
        eventSourceObjectIds,
      );
    }
  }

  return { workItems, events, eventSourceObjectIds, workItemSourceObjectIds };
}

function normalizationContext(source: SourceObjectRow): {
  sourceObjectId: string;
  workItemId?: string;
  repositoryId?: string;
  linearTeamId?: string;
  linearProjectId?: string;
} {
  const raw = asRecord(source.rawJson);
  const repositoryId =
    source.provider === "github" ? source.syncScopeId : undefined;

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

async function upsertWorkItems(
  database: DatabaseExecutor,
  organizationId: string,
  items: readonly WorkItem[],
  sourceObjectIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const item of items) {
    await database
      .insert(workItems)
      .values({
        id: item.id,
        organizationId,
        sourceObjectId: sourceObjectIds.get(item.id),
        provider: item.provider,
        sourceType: item.sourceType,
        externalId: item.externalId,
        title: item.title,
        url: item.url,
        status: item.status,
        workType: item.sourceType,
        createdAtSource: item.createdAtSource,
        updatedAtSource: item.updatedAtSource,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          sourceObjectId: sourceObjectIds.get(item.id),
          title: item.title,
          url: item.url,
          status: item.status,
          updatedAtSource: item.updatedAtSource,
          startedAt: item.startedAt,
          completedAt: item.completedAt,
          updatedAt: new Date().toISOString(),
        },
      });
  }
}

async function upsertPeopleForEvents(
  database: DatabaseExecutor,
  organizationId: string,
  events: readonly ActivityEvent[],
): Promise<void> {
  for (const personId of new Set(
    events
      .map((event) => event.actorPersonId)
      .filter((value): value is string => Boolean(value)),
  )) {
    await database
      .insert(people)
      .values({ id: personId, organizationId, displayName: personId })
      .onDuplicateKeyUpdate({ set: { updatedAt: new Date().toISOString() } });
  }
}

async function upsertActivityEvents(
  database: DatabaseExecutor,
  organizationId: string,
  events: readonly ActivityEvent[],
  sourceObjectIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const event of events) {
    await database
      .insert(activityEvents)
      .values({
        id: event.id,
        organizationId,
        sourceObjectId: sourceObjectIds.get(event.id),
        provider: event.provider,
        eventType: event.eventType,
        actorPersonId: event.actorPersonId,
        workItemId: event.workItemId,
        repositoryId: event.repositoryId,
        linearTeamId: event.linearTeamId,
        linearProjectId: event.linearProjectId,
        occurredAt: event.occurredAt,
        title: event.title,
        body: event.body,
        url: event.url,
        metadataJson: JSON.stringify(event.metadata ?? {}),
      })
      .onDuplicateKeyUpdate({
        set: {
          sourceObjectId: sourceObjectIds.get(event.id),
          actorPersonId: event.actorPersonId,
          workItemId: event.workItemId,
          title: event.title,
          body: event.body,
          url: event.url,
          metadataJson: JSON.stringify(event.metadata ?? {}),
        },
      });
  }
}

async function upsertCursors(
  database: DatabaseExecutor,
  scope: SyncScope,
  fetched: ConnectorFetchResult,
  now: Date,
): Promise<void> {
  for (const cursor of fetched.cursorUpdates) {
    const cursorId = stableId(
      "sync_cursor",
      scope.id,
      cursor.objectType,
      "updated_at",
    );
    await database
      .insert(syncCursors)
      .values({
        id: cursorId,
        organizationId: scope.organizationId,
        integrationId: scope.integrationId,
        syncScopeId: scope.id,
        provider: scope.provider,
        objectType: cursor.objectType,
        cursorKind: "updated_at",
        cursorValue: cursor.cursorValue ?? cursor.highWatermark?.toISOString(),
        highWatermark: cursor.highWatermark?.toISOString(),
        lastSuccessAt: now.toISOString(),
        lastAttemptAt: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      .onDuplicateKeyUpdate({
        set: {
          cursorValue:
            cursor.cursorValue ?? cursor.highWatermark?.toISOString(),
          highWatermark: cursor.highWatermark?.toISOString(),
          lastSuccessAt: now.toISOString(),
          lastAttemptAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      });
  }
}

async function finishSucceededSyncRun(
  database: DatabaseExecutor,
  runId: string,
  scopeId: string,
  now: Date,
  counters: RunProviderSyncServiceResult["counters"],
): Promise<void> {
  const timestamp = now.toISOString();
  await database
    .update(syncRuns)
    .set({ status: "succeeded", finishedAt: timestamp, ...counters })
    .where(eq(syncRuns.id, runId));
  await database
    .update(syncScopes)
    .set({
      lastSuccessAt: timestamp,
      lastAttemptAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(syncScopes.id, scopeId));
}

async function finishFailedSyncRun(
  database: AppDatabase,
  runId: string,
  now: Date,
  error: string,
): Promise<void> {
  await database
    .update(syncRuns)
    .set({
      status: "failed",
      finishedAt: now.toISOString(),
      objectsFailed: 1,
      error,
    })
    .where(eq(syncRuns.id, runId));
}

function asRecord(value: JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedString(
  record: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0
    ? current
    : undefined;
}

function dateFromString(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}
