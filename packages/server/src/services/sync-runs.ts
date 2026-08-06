import type { JsonObject, JsonValue, TriggerSyncResponseDto } from "@teamtales/common/api";
import type { ActivityEvent, Provider, WorkItem } from "@teamtales/common/domain";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { logger } from "../api/logger.js";
import type { AppDatabase, MySqlTransaction } from "../db/mysql.js";
import {
  GitHubRestDiscoveryClient,
  type GitHubRepository,
} from "../providers/github-discovery-client.js";
import { GitHubRateLimitError } from "../providers/github-client.js";
import {
  activityEvents,
  integrationCredentials,
  people,
  providerResources,
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
import {
  listExecutableResources as listGitHubExecutableResources,
  readProviderResource as readGitHubResource,
  updateResourceLifecycle as updateGitHubResourceLifecycle,
  upsertGitHubRepository,
} from "./github-resources.js";
import {
  listLinearExecutableResources,
  readLinearResource,
  type ManagedLinearResource,
  updateLinearResourceLifecycle,
} from "./linear-resources.js";

type DatabaseExecutor = AppDatabase | MySqlTransaction;
type SyncRunRow = typeof syncRuns.$inferSelect;
type ManagedResource =
  | import("./github-resources.js").ManagedProviderResource
  | ManagedLinearResource;

export interface RunProviderSyncServiceInput {
  provider: Provider;
  organizationId?: string;
  integrationId?: string;
  syncScopeId?: string;
  encryptionKey: string | Buffer;
  now?: Date;
  /** Internal queue worker fields. */
  existingRunId?: string;
  claimedRun?: SyncRun;
  scopeOverride?: SyncScope;
  providerResourceId?: string;
  githubOrganizationId?: string;
  githubRepositoryId?: string;
  linearWorkspaceId?: string;
  linearTeamId?: string;
}

function resourceId(row: {
  providerResourceId?: string | null;
  githubOrganizationId?: string | null;
  githubRepositoryId?: string | null;
  linearWorkspaceId?: string | null;
  linearTeamId?: string | null;
}): string | undefined {
  return (
    row.githubRepositoryId ??
    row.githubOrganizationId ??
    row.linearTeamId ??
    row.linearWorkspaceId ??
    row.providerResourceId ??
    undefined
  );
}
function resourceFields(
  provider: Provider,
  type: string,
  id: string | undefined,
): Record<string, string> {
  if (!id) return {};
  if (provider === "github")
    return type === "github.organization"
      ? { githubOrganizationId: id }
      : { githubRepositoryId: id };
  if (provider === "linear")
    return type === "linear.workspace" ? { linearWorkspaceId: id } : { linearTeamId: id };
  return { providerResourceId: id };
}
function inputResourceId(input: RunProviderSyncServiceInput): string | undefined {
  return resourceId(input);
}
async function updateResourceLifecycle(
  database: DatabaseExecutor,
  provider: string,
  ids: readonly string[],
  values: Record<string, unknown>,
): Promise<void> {
  if (provider === "github") return updateGitHubResourceLifecycle(database, provider, ids, values);
  if (provider === "linear") return updateLinearResourceLifecycle(database, ids, values);
  if (ids.length > 0)
    await (database as any)
      .update(providerResources)
      .set(values)
      .where(inArray(providerResources.id, [...ids]));
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

export async function enqueueProviderSyncService(
  database: AppDatabase,
  input: RunProviderSyncServiceInput,
): Promise<RunProviderSyncServiceResult> {
  const scope = await readSyncScope(database, input);
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const rootId = stableId("sync_run", "orchestration", scope.id, timestamp);
  const needsGithubDiscovery =
    scope.provider === "github" &&
    scope.scopeType === "github.organization" &&
    scope.selectionMode === "all";
  const resources = needsGithubDiscovery ? [] : await executableResources(database, scope);
  return database.transaction(async (transaction) => {
    const lockName = `teamtales:sync:${scope.id}`;
    const lockResult = (await transaction.execute(
      sql`SELECT GET_LOCK(${lockName}, 10) AS acquired`,
    )) as unknown as [{ acquired: number }[]];
    if (lockResult[0]?.[0]?.acquired !== 1)
      throw new Error("Could not acquire the MySQL lock for this sync scope.");
    try {
      const [active] = await transaction
        .select({ id: syncRuns.id, status: syncRuns.status })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.syncScopeId, scope.id),
            isNull(syncRuns.parentSyncRunId),
            eq(syncRuns.runKind, "orchestration"),
            or(eq(syncRuns.status, "queued"), eq(syncRuns.status, "running")),
          ),
        )
        .orderBy(desc(syncRuns.createdAt))
        .limit(1);
      if (active)
        return queuedSyncResult(
          scope.provider,
          active.id,
          active.status as "queued" | "running",
          "A sync for this scope is already in progress.",
        );

      await transaction.insert(syncRuns).values({
        id: rootId,
        organizationId: scope.organizationId,
        integrationId: scope.integrationId,
        syncScopeId: scope.id,
        provider: scope.provider,
        runType: "manual_resync",
        runKind: "orchestration",
        status: "queued",
        queuedAt: timestamp,
        startedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (needsGithubDiscovery) {
        if (!scope.githubOrganizationId)
          throw new Error("GitHub organization sync scope is not linked to a GitHub organization.");
        const discoveryId = stableId("sync_run", rootId, "discovery");
        await transaction.insert(syncRuns).values({
          id: discoveryId,
          organizationId: scope.organizationId,
          integrationId: scope.integrationId,
          syncScopeId: scope.id,
          ...resourceFields("github", "github.organization", scope.githubOrganizationId),
          parentSyncRunId: rootId,
          provider: scope.provider,
          runType: "manual_resync",
          runKind: "discovery",
          status: "queued",
          queuedAt: timestamp,
          startedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      for (const resource of resources) {
        const childId = stableId("sync_run", rootId, resource.id);
        await transaction.insert(syncRuns).values({
          id: childId,
          organizationId: scope.organizationId,
          integrationId: scope.integrationId,
          syncScopeId: scope.id,
          ...resourceFields(scope.provider, resource.resourceType, resource.id),
          parentSyncRunId: rootId,
          provider: scope.provider,
          runType: "manual_resync",
          runKind: "resource",
          status: "queued",
          queuedAt: timestamp,
          startedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await updateResourceLifecycle(transaction, scope.provider, [resource.id], {
          syncStatus: "queued",
          currentSyncRunId: childId,
          updatedAt: timestamp,
        });
      }
      if (!needsGithubDiscovery && resources.length === 0) {
        await transaction
          .update(syncRuns)
          .set({ status: "completed", finishedAt: timestamp, updatedAt: timestamp })
          .where(eq(syncRuns.id, rootId));
      }
      return queuedSyncResult(
        scope.provider,
        rootId,
        !needsGithubDiscovery && resources.length === 0 ? "completed" : "queued",
        needsGithubDiscovery
          ? "Queued GitHub repository discovery."
          : resources.length === 0
            ? "No active resources matched this sync scope."
            : `Queued ${resources.length} resource sync(s).`,
      );
    } finally {
      await transaction.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
    }
  });
}

async function refreshGitHubOrganizationInventory(
  database: AppDatabase,
  scope: SyncScope,
  encryptionKey: string | Buffer,
  timestamp: string,
): Promise<void> {
  const credential = await readLatestCredential(database, scope.integrationId, encryptionKey);
  const client = new GitHubRestDiscoveryClient(credential.encryptedSecret);
  const repositories: GitHubRepository[] = [];
  for await (const repository of client.listOrganizationRepositories(scope.externalName))
    repositories.push(repository);
  const parentResourceId = scope.githubOrganizationId;
  if (!parentResourceId)
    throw new Error("GitHub organization sync scope is not linked to a GitHub organization.");
  await database.transaction(async (transaction) => {
    for (const repository of repositories) {
      await upsertGitHubRepository(transaction, {
        organizationId: scope.organizationId,
        integrationId: scope.integrationId,
        externalId: repository.id,
        externalParentId: scope.externalId,
        githubOrganizationId: parentResourceId,
        displayName: repository.fullName,
        metadataJson: JSON.stringify({
          ownerId: repository.ownerId,
          ownerLogin: repository.ownerLogin,
          ownerType: repository.ownerType,
          visibility: repository.visibility ?? null,
          archived: repository.archived,
          fork: repository.fork,
          description: repository.description ?? null,
        }),
        now: timestamp,
      });
    }
  });
  logger.info(
    {
      integrationId: scope.integrationId,
      syncScopeId: scope.id,
      repositoryCount: repositories.length,
    },
    "GitHub organization repository inventory refreshed",
  );
}

async function runGitHubOrganizationDiscoveryStep(
  database: AppDatabase,
  discoveryRun: SyncRunRow,
  executionScope: SyncScope,
  encryptionKey: string | Buffer,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const parentSyncRunId = discoveryRun.parentSyncRunId;
  if (!parentSyncRunId) throw new Error("GitHub discovery run is missing its parent sync run.");
  const scope: SyncScope = {
    ...executionScope,
    scopeType: "github.organization",
    selectionMode: "all",
    githubOrganizationId: discoveryRun.githubOrganizationId ?? undefined,
  };
  try {
    await refreshGitHubOrganizationInventory(database, scope, encryptionKey, timestamp);
    const resources = await executableResources(database, scope);
    await database.transaction(async (transaction) => {
      for (const resource of resources) {
        const [existing] = await transaction
          .select({ id: syncRuns.id })
          .from(syncRuns)
          .where(
            and(
              eq(syncRuns.parentSyncRunId, parentSyncRunId),
              eq(syncRuns.githubRepositoryId, resource.id),
              eq(syncRuns.runKind, "resource"),
            ),
          )
          .limit(1);
        if (existing) continue;
        const childId = stableId("sync_run", parentSyncRunId, resource.id);
        await transaction.insert(syncRuns).values({
          id: childId,
          organizationId: scope.organizationId,
          integrationId: scope.integrationId,
          syncScopeId: scope.id,
          githubRepositoryId: resource.id,
          parentSyncRunId,
          provider: "github",
          runType: "manual_resync",
          runKind: "resource",
          status: "queued",
          queuedAt: timestamp,
          startedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await updateResourceLifecycle(transaction, scope.provider, [resource.id], {
          syncStatus: "queued",
          currentSyncRunId: childId,
          updatedAt: timestamp,
        });
      }
      await transaction
        .update(syncRuns)
        .set({
          status: "succeeded",
          finishedAt: timestamp,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        })
        .where(eq(syncRuns.id, discoveryRun.id));
    });
  } catch (error) {
    const retryAt = error instanceof GitHubRateLimitError ? error.retryAt : undefined;
    logger.error(
      { err: error, syncRunId: discoveryRun.id, retryAt: retryAt?.toISOString() },
      "GitHub organization discovery failed",
    );
    await finishFailedSyncRun(
      database,
      discoveryRun.id,
      now,
      error instanceof Error ? error.message : String(error),
      resourceId(discoveryRun),
      retryAt,
    );
  }
}

async function enqueueMissingGithubDiscoverySteps(database: AppDatabase, now: Date): Promise<void> {
  const roots = await database
    .select()
    .from(syncRuns)
    .where(
      and(
        isNull(syncRuns.parentSyncRunId),
        eq(syncRuns.runKind, "orchestration"),
        or(eq(syncRuns.status, "queued"), eq(syncRuns.status, "running")),
      ),
    );
  for (const root of roots) {
    if (!root.syncScopeId || root.provider !== "github") continue;
    const [scope] = await database
      .select()
      .from(syncScopes)
      .where(eq(syncScopes.id, root.syncScopeId))
      .limit(1);
    if (
      !scope ||
      scope.scopeType !== "github.organization" ||
      scope.selectionMode !== "all" ||
      !scope.githubOrganizationId
    )
      continue;
    const [child] = await database
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(eq(syncRuns.parentSyncRunId, root.id))
      .limit(1);
    if (child) continue;
    const timestamp = now.toISOString();
    await database.insert(syncRuns).values({
      id: stableId("sync_run", root.id, "discovery"),
      organizationId: root.organizationId,
      integrationId: root.integrationId,
      syncScopeId: scope.id,
      githubOrganizationId: scope.githubOrganizationId,
      parentSyncRunId: root.id,
      provider: "github",
      runType: root.runType,
      runKind: "discovery",
      status: "queued",
      queuedAt: timestamp,
      startedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

export async function processQueuedProviderSyncBatch(
  database: AppDatabase,
  encryptionKey: string | Buffer,
  options: { limit?: number; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  await enqueueMissingGithubDiscoverySteps(database, now);
  const rows = await claimQueuedProviderSyncRuns(database, now, options.limit ?? 10);
  for (const row of rows) {
    const rowResourceId = resourceId(row);
    if (!rowResourceId || !row.syncScopeId) {
      await finishBlockedSyncRun(
        database,
        row.id,
        now,
        "Claimed sync run is missing its resource or sync scope.",
      );
      continue;
    }
    const [scopeRow] = await database
      .select()
      .from(syncScopes)
      .where(eq(syncScopes.id, row.syncScopeId))
      .limit(1);
    if (!scopeRow) {
      await finishBlockedSyncRun(
        database,
        row.id,
        now,
        "Claimed sync run references a sync scope that no longer exists.",
      );
      continue;
    }
    const resource = await readManagedResource(database, scopeRow.provider, rowResourceId);
    if (!resource) {
      await finishBlockedSyncRun(
        database,
        row.id,
        now,
        "Claimed sync run references a provider resource that no longer exists.",
      );
      continue;
    }
    const scope = toExecutionScope(scopeRow, resource);
    if (row.runKind === "discovery") {
      await runGitHubOrganizationDiscoveryStep(database, row, scope, encryptionKey, now);
      continue;
    }
    await runProviderSyncService(database, {
      provider: row.provider as Provider,
      encryptionKey,
      existingRunId: row.id,
      providerResourceId: resource.id,
      scopeOverride: scope,
      claimedRun: toClaimedSyncRun(row, scope),
      now,
    });
  }
  await refreshParentRunStatuses(
    database,
    rows.map((row) => row.parentSyncRunId).filter((value): value is string => Boolean(value)),
    now,
  );
  return rows.length;
}

export async function cancelProviderSyncRunService(
  database: AppDatabase,
  syncRunId: string,
): Promise<{ syncRunId: string; status: "cancelled"; cancelledResourceRuns: number }> {
  const timestamp = new Date().toISOString();
  return database.transaction(async (transaction) => {
    const [requested] = await transaction
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.id, syncRunId))
      .limit(1);
    if (!requested) throw new Error("Sync run not found.");
    const rootId = requested.parentSyncRunId ?? requested.id;
    const children = await transaction
      .select({
        id: syncRuns.id,
        provider: syncRuns.provider,
        providerResourceId: syncRuns.providerResourceId,
        githubOrganizationId: syncRuns.githubOrganizationId,
        githubRepositoryId: syncRuns.githubRepositoryId,
        linearWorkspaceId: syncRuns.linearWorkspaceId,
        linearTeamId: syncRuns.linearTeamId,
      })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.parentSyncRunId, rootId),
          or(eq(syncRuns.status, "queued"), eq(syncRuns.status, "running")),
        ),
      );
    await transaction
      .update(syncRuns)
      .set({
        status: "cancelled",
        finishedAt: timestamp,
        leaseExpiresAt: null,
        updatedAt: timestamp,
      })
      .where(
        and(
          eq(syncRuns.id, rootId),
          or(eq(syncRuns.status, "queued"), eq(syncRuns.status, "running")),
        ),
      );
    if (children.length > 0)
      await transaction
        .update(syncRuns)
        .set({
          status: "cancelled",
          finishedAt: timestamp,
          leaseExpiresAt: null,
          updatedAt: timestamp,
        })
        .where(
          inArray(
            syncRuns.id,
            children.map((child) => child.id),
          ),
        );
    for (const child of children) {
      const childResourceId = resourceId(child);
      if (!childResourceId) continue;
      await transaction
        .update(syncRuns)
        .set({ updatedAt: timestamp })
        .where(eq(syncRuns.id, child.id));
      await updateResourceLifecycle(transaction, requested.provider, [childResourceId], {
        syncStatus: "idle",
        currentSyncRunId: null,
        updatedAt: timestamp,
      });
    }
    return { syncRunId: rootId, status: "cancelled", cancelledResourceRuns: children.length };
  });
}

function queuedSyncResult(
  provider: Provider,
  syncRunId: string,
  status: "queued" | "running" | "completed",
  message: string,
): RunProviderSyncServiceResult {
  return {
    provider,
    status,
    syncRunId,
    message,
    counters: {
      objectsFetched: 0,
      objectsInserted: 0,
      objectsUpdated: 0,
      objectsUnchanged: 0,
      objectsFailed: 0,
      activityEventsEmitted: 0,
    },
  };
}

async function claimQueuedProviderSyncRuns(
  database: AppDatabase,
  now: Date,
  limit: number,
): Promise<SyncRunRow[]> {
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  return database.transaction(async (transaction) => {
    const reclaimed = await transaction
      .select({
        id: syncRuns.id,
        provider: syncRuns.provider,
        providerResourceId: syncRuns.providerResourceId,
        githubOrganizationId: syncRuns.githubOrganizationId,
        githubRepositoryId: syncRuns.githubRepositoryId,
        linearWorkspaceId: syncRuns.linearWorkspaceId,
        linearTeamId: syncRuns.linearTeamId,
      })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.status, "running"),
          or(eq(syncRuns.runKind, "resource"), eq(syncRuns.runKind, "discovery")),
          lte(syncRuns.leaseExpiresAt, timestamp),
        ),
      );
    if (reclaimed.length > 0) {
      await transaction
        .update(syncRuns)
        .set({ status: "queued", queuedAt: timestamp, leaseExpiresAt: null, updatedAt: timestamp })
        .where(
          inArray(
            syncRuns.id,
            reclaimed.map((row) => row.id),
          ),
        );
      for (const provider of ["github", "linear"] as const) {
        const resourceIds = reclaimed
          .filter((row) => row.provider === provider)
          .flatMap((row) => (resourceId(row) ? [resourceId(row)!] : []));
        await updateResourceLifecycle(transaction, provider, resourceIds, {
          syncStatus: "queued",
          updatedAt: timestamp,
        });
      }
    }
    const locked = (await transaction.execute(sql`
      SELECT id
      FROM sync_runs
      WHERE status = 'queued'
        AND run_kind IN ('resource', 'discovery')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${timestamp})
      ORDER BY queued_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `)) as unknown as [{ id: string }[]];
    const ids = locked[0]?.map((row) => row.id) ?? [];
    if (ids.length === 0) return [];
    const rows = await transaction.select().from(syncRuns).where(inArray(syncRuns.id, ids));
    await transaction
      .update(syncRuns)
      .set({
        status: "running",
        startedAt: timestamp,
        leaseExpiresAt,
        nextAttemptAt: null,
        updatedAt: timestamp,
      })
      .where(and(inArray(syncRuns.id, ids), eq(syncRuns.status, "queued")));
    const parentIds = rows.flatMap((row) => (row.parentSyncRunId ? [row.parentSyncRunId] : []));
    if (parentIds.length > 0)
      await transaction
        .update(syncRuns)
        .set({ status: "running", updatedAt: timestamp })
        .where(inArray(syncRuns.id, parentIds));
    for (const provider of ["github", "linear"] as const) {
      const resourceIds = rows
        .filter((row) => row.provider === provider)
        .flatMap((row) => (resourceId(row) ? [resourceId(row)!] : []));
      await updateResourceLifecycle(transaction, provider, resourceIds, {
        syncStatus: "running",
        lastSyncStartedAt: timestamp,
        updatedAt: timestamp,
      });
    }
    return rows.map((row) => ({ ...row, status: "running", startedAt: timestamp, leaseExpiresAt }));
  });
}

async function executableResources(database: AppDatabase, scope: SyncScope) {
  if (scope.provider === "github") return listGitHubExecutableResources(database, scope);
  if (scope.provider === "linear") return listLinearExecutableResources(database, scope);
  return [];
}

async function readManagedResource(
  database: AppDatabase,
  provider: string,
  id: string,
): Promise<ManagedResource | undefined> {
  if (provider === "github") return readGitHubResource(database, provider, id);
  if (provider === "linear") return readLinearResource(database, id);
  const [row] = await database
    .select()
    .from(providerResources)
    .where(eq(providerResources.id, id))
    .limit(1);
  return row ? { ...row, provider, resourceType: row.resourceType } : undefined;
}

function toExecutionScope(
  scope: typeof syncScopes.$inferSelect,
  resource: ManagedResource,
): SyncScope {
  return {
    id: scope.id,
    organizationId: scope.organizationId,
    integrationId: scope.integrationId,
    provider: scope.provider as Provider,
    scopeType: resource.resourceType as SyncScope["scopeType"],
    externalId: resource.externalId,
    externalName: resource.displayName,
    providerResourceId: scope.providerResourceId ?? undefined,
    githubOrganizationId: scope.githubOrganizationId ?? undefined,
    githubRepositoryId: scope.githubRepositoryId ?? undefined,
    linearWorkspaceId: scope.linearWorkspaceId ?? undefined,
    linearTeamId: scope.linearTeamId ?? undefined,
    parentScopeId: scope.parentScopeId ?? undefined,
    selectionMode: "individual",
    configJson:
      resource.resourceType === "github.repository"
        ? { repository: resource.displayName }
        : (JSON.parse(scope.configJson) as JsonObject),
    enabled: true,
    createdAt: dateFromString(scope.createdAt) ?? new Date(0),
    updatedAt: dateFromString(scope.updatedAt) ?? new Date(0),
  };
}

function toClaimedSyncRun(row: SyncRunRow, scope: SyncScope): SyncRun {
  return {
    id: row.id,
    organizationId: scope.organizationId,
    integrationId: scope.integrationId,
    syncScopeId: scope.id,
    provider: scope.provider,
    runType: row.runType as SyncRun["runType"],
    status: "running",
    startedAt: dateFromString(row.startedAt) ?? new Date(),
    objectsFetched: row.objectsFetched,
    objectsInserted: row.objectsInserted,
    objectsUpdated: row.objectsUpdated,
    objectsUnchanged: row.objectsUnchanged,
    objectsFailed: row.objectsFailed,
    activityEventsEmitted: row.activityEventsEmitted,
    createdAt: dateFromString(row.createdAt) ?? new Date(),
  };
}

async function refreshParentRunStatuses(
  database: AppDatabase,
  parentIds: readonly string[],
  now: Date,
): Promise<void> {
  for (const parentId of new Set(parentIds)) {
    const [parent] = await database
      .select({ status: syncRuns.status })
      .from(syncRuns)
      .where(eq(syncRuns.id, parentId))
      .limit(1);
    if (parent?.status === "cancelled") continue;
    const children = await database
      .select({ status: syncRuns.status })
      .from(syncRuns)
      .where(eq(syncRuns.parentSyncRunId, parentId));
    const pending = children.some(
      (child) => child.status === "queued" || child.status === "running",
    );
    const failed = children.some(
      (child) => child.status === "failed" || child.status === "blocked",
    );
    if (!pending)
      await database
        .update(syncRuns)
        .set({
          status: failed ? "completed_with_errors" : "completed",
          finishedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .where(eq(syncRuns.id, parentId));
  }
}

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
  const syncLog = logger.child({
    provider: input.provider,
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    syncScopeId: input.syncScopeId,
  });
  syncLog.debug("Resolving provider sync scope");
  const scope = input.scopeOverride ?? (await readSyncScope(database, input));
  const scopeLog = logger.child({
    provider: input.provider,
    organizationId: scope.organizationId,
    integrationId: scope.integrationId,
    syncScopeId: scope.id,
    scopeType: scope.scopeType,
    selectionMode: scope.selectionMode,
  });
  const now = input.now ?? new Date();
  const runId = input.existingRunId ?? stableId("sync_run", scope.id, now.toISOString());
  const providerResourceId = inputResourceId(input);
  const run =
    input.claimedRun ??
    (input.existingRunId
      ? await claimExistingSyncRun(database, input.existingRunId, scope, now)
      : await createSyncRun(database, scope, runId, now, providerResourceId));
  const runLog = scopeLog.child({ syncRunId: runId });
  if (await isSyncRunCancelled(database, runId)) return cancelledSyncResult(input.provider, runId);
  let credential: IntegrationCredential | undefined;

  try {
    scopeLog.debug("Reading provider sync credential");
    credential = await readLatestCredential(database, scope.integrationId, input.encryptionKey);
    runLog.info("Provider sync started");
    const cursors = await readSyncCursors(database, scope, providerResourceId);
    runLog.debug({ cursorCount: cursors.length }, "Fetching provider source objects");
    const connectorContext: ConnectorExecutionContext = {
      organizationId: scope.organizationId,
      integrationId: scope.integrationId,
      scope,
      run,
      cursors,
      credential,
    };
    const fetched = await connectorForProvider(input.provider).fetchSourceObjects(connectorContext);
    if (await isSyncRunCancelled(database, runId)) {
      runLog.info("Provider sync was cancelled before persisting results");
      return cancelledSyncResult(input.provider, runId);
    }
    runLog.debug(
      { objectsFetched: fetched.objects.length, cursorUpdates: fetched.cursorUpdates.length },
      "Persisting provider sync results",
    );
    const persisted = await persistFetchResult(
      database,
      scope,
      runId,
      fetched,
      now,
      providerResourceId,
    );
    runLog.info({ counters: persisted.counters }, "Provider sync completed");

    return {
      provider: input.provider,
      status: "completed",
      syncRunId: runId,
      message: `Fetched ${persisted.counters.objectsFetched} ${input.provider} object(s).`,
      counters: persisted.counters,
    };
  } catch (error) {
    if (await isSyncRunCancelled(database, runId)) {
      runLog.info("Provider sync was cancelled");
      return cancelledSyncResult(input.provider, runId);
    }
    const message = redactText(
      error instanceof Error ? error.message : String(error),
      credential ? [credential.encryptedSecret] : [],
    );
    const retryAt = error instanceof GitHubRateLimitError ? error.retryAt : undefined;
    runLog.error({ err: error, retryAt: retryAt?.toISOString() }, "Provider sync failed");
    await finishFailedSyncRun(database, runId, now, message, providerResourceId, retryAt);
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

function cancelledSyncResult(provider: Provider, syncRunId: string): RunProviderSyncServiceResult {
  return {
    provider,
    status: "cancelled",
    syncRunId,
    message: "Sync was cancelled.",
    counters: {
      objectsFetched: 0,
      objectsInserted: 0,
      objectsUpdated: 0,
      objectsUnchanged: 0,
      objectsFailed: 0,
      activityEventsEmitted: 0,
    },
  };
}

async function isSyncRunCancelled(database: AppDatabase, runId: string): Promise<boolean> {
  const [run] = await database
    .select({ status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.id, runId))
    .limit(1);
  return run?.status === "cancelled";
}

async function persistFetchResult(
  database: AppDatabase,
  scope: SyncScope,
  runId: string,
  fetched: ConnectorFetchResult,
  now: Date,
  providerResourceId?: string,
): Promise<RunProviderSyncServiceResult> {
  return database.transaction(async (transaction) => {
    const persistedSourceObjects = await upsertSourceObjects(transaction, fetched.objects, now);
    const normalized = normalizeSourceObjects(persistedSourceObjects, providerResourceId);

    await upsertWorkItems(
      transaction,
      scope.organizationId,
      normalized.workItems,
      normalized.workItemSourceObjectIds,
    );
    await upsertPeopleForEvents(transaction, scope.organizationId, normalized.events);
    await upsertActivityEvents(
      transaction,
      scope.organizationId,
      normalized.events,
      normalized.eventSourceObjectIds,
    );
    await upsertCursors(transaction, scope, fetched, now, providerResourceId);

    const counters = {
      objectsFetched: fetched.objects.length,
      objectsInserted: persistedSourceObjects.filter((object) => object.action === "insert").length,
      objectsUpdated: persistedSourceObjects.filter((object) => object.action === "update").length,
      objectsUnchanged: persistedSourceObjects.filter((object) => object.action === "unchanged")
        .length,
      objectsFailed: 0,
      activityEventsEmitted: normalized.events.length,
    };

    await finishSucceededSyncRun(transaction, runId, scope.id, now, counters, providerResourceId);

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

async function readSyncScope(
  database: AppDatabase,
  input: RunProviderSyncServiceInput,
): Promise<SyncScope> {
  const clauses = [eq(syncScopes.provider, input.provider), eq(syncScopes.enabled, 1)];
  if (input.syncScopeId) clauses.push(eq(syncScopes.id, input.syncScopeId));
  if (input.integrationId) clauses.push(eq(syncScopes.integrationId, input.integrationId));
  if (input.organizationId) clauses.push(eq(syncScopes.organizationId, input.organizationId));

  const [row] = await database
    .select()
    .from(syncScopes)
    .where(and(...clauses))
    .orderBy(desc(syncScopes.updatedAt), asc(syncScopes.id))
    .limit(1);

  if (!row) {
    throw new Error(`No enabled ${input.provider} sync scope matched the request.`);
  }

  return {
    ...row,
    providerResourceId: row.providerResourceId ?? undefined,
    githubOrganizationId: row.githubOrganizationId ?? undefined,
    githubRepositoryId: row.githubRepositoryId ?? undefined,
    linearWorkspaceId: row.linearWorkspaceId ?? undefined,
    linearTeamId: row.linearTeamId ?? undefined,
    parentScopeId: row.parentScopeId ?? undefined,
    provider: row.provider as Provider,
    scopeType: row.scopeType as SyncScope["scopeType"],
    externalId: row.externalId ?? "",
    selectionMode: row.selectionMode as SyncScope["selectionMode"],
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
    .orderBy(desc(integrationCredentials.createdAt), desc(integrationCredentials.id))
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
  providerResourceId?: string,
): Promise<SyncRun> {
  const timestamp = now.toISOString();
  await database.insert(syncRuns).values({
    id: runId,
    organizationId: scope.organizationId,
    integrationId: scope.integrationId,
    syncScopeId: scope.id,
    ...resourceFields(scope.provider, scope.scopeType, providerResourceId),
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

async function claimExistingSyncRun(
  database: AppDatabase,
  runId: string,
  scope: SyncScope,
  now: Date,
): Promise<SyncRun> {
  const timestamp = now.toISOString();
  const [existing] = await database
    .select({
      parentSyncRunId: syncRuns.parentSyncRunId,
      providerResourceId: syncRuns.providerResourceId,
      githubOrganizationId: syncRuns.githubOrganizationId,
      githubRepositoryId: syncRuns.githubRepositoryId,
      linearWorkspaceId: syncRuns.linearWorkspaceId,
      linearTeamId: syncRuns.linearTeamId,
    })
    .from(syncRuns)
    .where(eq(syncRuns.id, runId))
    .limit(1);
  await database
    .update(syncRuns)
    .set({ status: "running", startedAt: timestamp, leaseExpiresAt: null, updatedAt: timestamp })
    .where(eq(syncRuns.id, runId));
  if (existing?.parentSyncRunId)
    await database
      .update(syncRuns)
      .set({ status: "running", updatedAt: timestamp })
      .where(eq(syncRuns.id, existing.parentSyncRunId));
  const existingResourceId = existing ? resourceId(existing) : undefined;
  if (existingResourceId)
    await updateResourceLifecycle(database, scope.provider, [existingResourceId], {
      syncStatus: "running",
      currentSyncRunId: runId,
      lastSyncStartedAt: timestamp,
      updatedAt: timestamp,
    });
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
  providerResourceId?: string,
): Promise<SyncCursor[]> {
  const rows = await database
    .select()
    .from(syncCursors)
    .where(
      providerResourceId
        ? scope.provider === "github"
          ? eq(syncCursors.githubRepositoryId, providerResourceId)
          : scope.provider === "linear"
            ? scope.scopeType === "linear.workspace"
              ? eq(syncCursors.linearWorkspaceId, providerResourceId)
              : eq(syncCursors.linearTeamId, providerResourceId)
            : eq(syncCursors.providerResourceId, providerResourceId)
        : eq(syncCursors.syncScopeId, scope.id),
    )
    .orderBy(asc(syncCursors.objectType), asc(syncCursors.cursorKind));
  return rows.map((row) => ({
    ...row,
    providerResourceId: row.providerResourceId ?? undefined,
    githubOrganizationId: row.githubOrganizationId ?? undefined,
    githubRepositoryId: row.githubRepositoryId ?? undefined,
    linearWorkspaceId: row.linearWorkspaceId ?? undefined,
    linearTeamId: row.linearTeamId ?? undefined,
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
      await database.insert(sourceObjects).values({
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
      lastChangedAt: plan.action === "unchanged" ? (existing?.lastChangedAt ?? now) : now,
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
  providerResourceId?: string,
): NormalizedBatch {
  const workItems: WorkItem[] = [];
  const events: ActivityEvent[] = [];
  const eventSourceObjectIds = new Map<string, string>();
  const workItemSourceObjectIds = new Map<string, string>();

  for (const source of sourceObjects) {
    const context = normalizationContext(source, providerResourceId);

    if (source.objectType === "github.pull_request") {
      const result = normalizeGitHubPullRequest(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "github.issue") {
      const result = normalizeGitHubIssue(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
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
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
      addEvents(result.events, source.id, events, eventSourceObjectIds);
    } else if (source.objectType === "linear.project") {
      const result = normalizeLinearProject(asRecord(source.rawJson), context);
      addWorkItem(result.workItem, source.id, workItems, workItemSourceObjectIds);
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

function normalizationContext(
  source: SourceObjectRow,
  providerResourceId?: string,
): {
  sourceObjectId: string;
  workItemId?: string;
  repositoryId?: string;
  linearTeamId?: string;
  linearProjectId?: string;
} {
  const raw = asRecord(source.rawJson);
  // Resource runs use the repository inventory ID, while a scope can represent a
  // whole organization. Attribute every event to the concrete resource that was
  // fetched so repository-scoped analytics and reports remain accurate.
  const repositoryId =
    source.provider === "github" ? (providerResourceId ?? source.syncScopeId) : undefined;

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
    events.map((event) => event.actorPersonId).filter((value): value is string => Boolean(value)),
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
  providerResourceId?: string,
): Promise<void> {
  for (const cursor of fetched.cursorUpdates) {
    const cursorId = stableId("sync_cursor", scope.id, cursor.objectType, "updated_at");
    await database
      .insert(syncCursors)
      .values({
        id: cursorId,
        organizationId: scope.organizationId,
        integrationId: scope.integrationId,
        syncScopeId: scope.id,
        ...resourceFields(scope.provider, scope.scopeType, providerResourceId),
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
          cursorValue: cursor.cursorValue ?? cursor.highWatermark?.toISOString(),
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
  providerResourceId?: string,
): Promise<void> {
  const timestamp = now.toISOString();
  const [run] = await database
    .select({ provider: syncRuns.provider })
    .from(syncRuns)
    .where(eq(syncRuns.id, runId))
    .limit(1);
  await database
    .update(syncRuns)
    .set({
      status: "succeeded",
      finishedAt: timestamp,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      ...counters,
    })
    .where(and(eq(syncRuns.id, runId), eq(syncRuns.status, "running")));
  await database
    .update(syncScopes)
    .set({
      lastSuccessAt: timestamp,
      lastAttemptAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(syncScopes.id, scopeId));
  if (providerResourceId)
    await updateResourceLifecycle(database, run?.provider ?? "linear", [providerResourceId], {
      syncStatus: "succeeded",
      currentSyncRunId: null,
      lastSyncSucceededAt: timestamp,
      lastSyncError: null,
      consecutiveFailureCount: 0,
      updatedAt: timestamp,
    });
}

async function finishFailedSyncRun(
  database: AppDatabase,
  runId: string,
  now: Date,
  error: string,
  providerResourceId?: string,
  retryAt?: Date,
): Promise<void> {
  const [run] = await database
    .select({ attempt: syncRuns.attempt, provider: syncRuns.provider })
    .from(syncRuns)
    .where(eq(syncRuns.id, runId))
    .limit(1);
  const terminal = (run?.attempt ?? 1) >= 3;
  const retryTimestamp = (
    retryAt && retryAt > now ? retryAt : new Date(now.getTime() + 60_000)
  ).toISOString();
  await database
    .update(syncRuns)
    .set({
      status: terminal ? "failed" : "queued",
      ...(terminal
        ? { finishedAt: now.toISOString(), nextAttemptAt: null }
        : {
            nextAttemptAt: retryTimestamp,
            queuedAt: now.toISOString(),
            attempt: (run?.attempt ?? 1) + 1,
          }),
      objectsFailed: 1,
      error,
      leaseExpiresAt: null,
    })
    .where(eq(syncRuns.id, runId));
  if (providerResourceId)
    await updateResourceLifecycle(database, run?.provider ?? "linear", [providerResourceId], {
      syncStatus: terminal ? "failed" : "queued",
      ...(terminal
        ? { currentSyncRunId: null, nextAttemptAt: null }
        : { currentSyncRunId: null, nextAttemptAt: retryTimestamp }),
      lastSyncFailedAt: now.toISOString(),
      lastSyncError: error,
      consecutiveFailureCount: run?.attempt ?? 1,
      updatedAt: now.toISOString(),
    });
}

/** Mark a claimed queue row terminal when its immutable execution references are gone. */
async function finishBlockedSyncRun(
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
      nextAttemptAt: null,
      leaseExpiresAt: null,
      error,
      objectsFailed: 1,
      updatedAt: now.toISOString(),
    })
    .where(eq(syncRuns.id, runId));
}

function asRecord(value: JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
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
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function dateFromString(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}
