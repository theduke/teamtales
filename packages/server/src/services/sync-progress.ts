import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type {
  OrganizationSyncStatusDto,
  PageDto,
  SyncRunDto,
  SyncRunProgressDto,
  SyncRunResourceProgressDto,
} from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";

import type { AppDatabase } from "../db/mysql.js";
import { providerResources, syncRuns } from "../db/schema.js";

const pageSize = 50;

export async function readSyncRunProgress(
  database: AppDatabase,
  syncRunId: string,
): Promise<SyncRunProgressDto | undefined> {
  const [row] = await database.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)).limit(1);
  if (!row) return undefined;
  const children = await database
    .select({ status: syncRuns.status })
    .from(syncRuns)
    .where(eq(syncRuns.parentSyncRunId, syncRunId));
  const childRunCounts = children.reduce<Record<string, number>>((counts, child) => {
    counts[child.status] = (counts[child.status] ?? 0) + 1;
    return counts;
  }, {});
  return { run: toSyncRunDto(row), childRunCounts };
}

export async function listSyncRunResourceProgress(
  database: AppDatabase,
  syncRunId: string,
  cursor?: string,
): Promise<PageDto<SyncRunResourceProgressDto>> {
  const conditions = [eq(syncRuns.parentSyncRunId, syncRunId)];
  if (cursor) conditions.push(gt(syncRuns.id, cursor));
  const rows = await database
    .select()
    .from(syncRuns)
    .where(and(...conditions))
    .orderBy(asc(syncRuns.id))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  const resourceIds = page.flatMap((row) =>
    row.providerResourceId ? [row.providerResourceId] : [],
  );
  const resources =
    resourceIds.length === 0
      ? []
      : await database
          .select()
          .from(providerResources)
          .where(inArray(providerResources.id, resourceIds));
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return {
    items: page.map((row) => {
      const resource = row.providerResourceId ? byId.get(row.providerResourceId) : undefined;
      return {
        ...(resource ? { resource: toResourceDto(resource) } : {}),
        run: toSyncRunDto(row),
      };
    }),
    ...(rows.length > pageSize ? { nextCursor: page.at(-1)?.id } : {}),
  };
}

export async function readOrganizationSyncStatus(
  database: AppDatabase,
  organizationId: string,
): Promise<OrganizationSyncStatusDto> {
  const [runs, resources] = await Promise.all([
    database
      .select()
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.organizationId, organizationId),
          isNull(syncRuns.parentSyncRunId),
          or(eq(syncRuns.status, "queued"), eq(syncRuns.status, "running")),
        ),
      )
      .orderBy(desc(syncRuns.createdAt)),
    database
      .select({ syncStatus: providerResources.syncStatus })
      .from(providerResources)
      .where(eq(providerResources.organizationId, organizationId)),
  ]);
  const resourceStatusCounts = resources.reduce<Record<string, number>>((counts, resource) => {
    counts[resource.syncStatus] = (counts[resource.syncStatus] ?? 0) + 1;
    return counts;
  }, {});
  return { organizationId, activeRuns: runs.map(toSyncRunDto), resourceStatusCounts };
}

export function toSyncRunDto(row: typeof syncRuns.$inferSelect): SyncRunDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    integrationId: row.integrationId,
    ...(row.syncScopeId ? { syncScopeId: row.syncScopeId } : {}),
    ...(row.providerResourceId ? { providerResourceId: row.providerResourceId } : {}),
    ...(row.parentSyncRunId ? { parentSyncRunId: row.parentSyncRunId } : {}),
    provider: row.provider as Provider,
    runType: row.runType,
    runKind: row.runKind,
    status: row.status,
    ...(row.queuedAt ? { queuedAt: row.queuedAt } : {}),
    startedAt: row.startedAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    attempt: row.attempt,
    objectsFetched: row.objectsFetched,
    objectsInserted: row.objectsInserted,
    objectsUpdated: row.objectsUpdated,
    objectsUnchanged: row.objectsUnchanged,
    objectsFailed: row.objectsFailed,
    activityEventsEmitted: row.activityEventsEmitted,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toResourceDto(
  resource: typeof providerResources.$inferSelect,
): NonNullable<SyncRunResourceProgressDto["resource"]> {
  return {
    id: resource.id,
    provider: resource.provider as Provider,
    resourceType: resource.resourceType,
    externalId: resource.externalId,
    displayName: resource.displayName,
    ...(resource.externalUrl ? { externalUrl: resource.externalUrl } : {}),
    syncStatus: resource.syncStatus,
    ...(resource.lastSyncStartedAt ? { lastSyncStartedAt: resource.lastSyncStartedAt } : {}),
    ...(resource.lastSyncSucceededAt ? { lastSyncSucceededAt: resource.lastSyncSucceededAt } : {}),
    ...(resource.lastSyncFailedAt ? { lastSyncFailedAt: resource.lastSyncFailedAt } : {}),
    ...(resource.lastSyncError ? { lastSyncError: resource.lastSyncError } : {}),
  };
}
