import { and, eq, inArray, sql } from "drizzle-orm";

import type { AppDatabase, MySqlTransaction } from "../db/mysql.js";
import { githubOrganizations, githubRepositories, providerResources } from "../db/schema.js";

type DatabaseExecutor = AppDatabase | MySqlTransaction;
type LegacyGitHubResource = typeof providerResources.$inferSelect;

export type GitHubResourceMigrationResult = {
  organizations: number;
  repositories: number;
  legacyRowsRemoved: number;
};
export type ManagedProviderResource = {
  id: string;
  provider: string;
  resourceType: string;
  externalId: string;
  displayName: string;
  externalUrl: string | null;
  syncStatus: string;
  lastSyncStartedAt: string | null;
  lastSyncSucceededAt: string | null;
  lastSyncFailedAt: string | null;
  lastSyncError: string | null;
};

export async function upsertGitHubOrganization(
  tx: DatabaseExecutor,
  input: {
    organizationId: string;
    integrationId: string;
    externalId: string;
    displayName: string;
    metadataJson: string;
    now: string;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: githubOrganizations.id })
    .from(githubOrganizations)
    .where(
      and(
        eq(githubOrganizations.integrationId, input.integrationId),
        eq(githubOrganizations.externalId, input.externalId),
      ),
    )
    .limit(1);
  const id =
    existing?.id ??
    `github_organization_${input.organizationId}_${input.integrationId}_${input.externalId}`;
  const value = {
    id,
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    externalId: input.externalId,
    displayName: input.displayName,
    metadataJson: input.metadataJson,
    discoveryState: "active",
    discoveredAt: input.now,
    lastSeenAt: input.now,
    updatedAt: input.now,
  };
  if (existing)
    await tx
      .update(githubOrganizations)
      .set({ ...value, createdAt: undefined })
      .where(eq(githubOrganizations.id, id));
  else await tx.insert(githubOrganizations).values({ ...value, createdAt: input.now });
  return id;
}

export async function upsertGitHubRepository(
  tx: DatabaseExecutor,
  input: {
    organizationId: string;
    integrationId: string;
    externalId: string;
    externalParentId?: string | null;
    githubOrganizationId?: string | null;
    displayName: string;
    metadataJson: string;
    now: string;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: githubRepositories.id })
    .from(githubRepositories)
    .where(
      and(
        eq(githubRepositories.integrationId, input.integrationId),
        eq(githubRepositories.externalId, input.externalId),
      ),
    )
    .limit(1);
  const id =
    existing?.id ??
    `github_repository_${input.organizationId}_${input.integrationId}_${input.externalId}`;
  const value = {
    id,
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    externalId: input.externalId,
    externalParentId: input.externalParentId ?? null,
    githubOrganizationId: input.githubOrganizationId ?? null,
    displayName: input.displayName,
    metadataJson: input.metadataJson,
    discoveryState: "active",
    discoveredAt: input.now,
    lastSeenAt: input.now,
    updatedAt: input.now,
  };
  if (existing)
    await tx
      .update(githubRepositories)
      .set({ ...value, createdAt: undefined })
      .where(eq(githubRepositories.id, id));
  else await tx.insert(githubRepositories).values({ ...value, createdAt: input.now });
  return id;
}

export async function readProviderResource(
  database: DatabaseExecutor,
  provider: string,
  id: string,
): Promise<ManagedProviderResource | undefined> {
  if (provider !== "github" && provider !== "linear") {
    const [row] = await database
      .select()
      .from(providerResources)
      .where(eq(providerResources.id, id))
      .limit(1);
    return row ? { ...row, provider, resourceType: row.resourceType } : undefined;
  }
  if (provider === "linear") return undefined;
  const [repository] = await database
    .select()
    .from(githubRepositories)
    .where(eq(githubRepositories.id, id))
    .limit(1);
  if (repository) return { ...repository, provider: "github", resourceType: "github.repository" };
  const [organization] = await database
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.id, id))
    .limit(1);
  return organization
    ? { ...organization, provider: "github", resourceType: "github.organization" }
    : undefined;
}

export async function listExecutableResources(
  database: AppDatabase,
  scope: {
    provider: string;
    scopeType: string;
    integrationId: string;
    selectionMode: string;
    providerResourceId?: string;
    githubOrganizationId?: string;
    githubRepositoryId?: string;
  },
): Promise<ManagedProviderResource[]> {
  if (scope.provider !== "github" && scope.provider !== "linear") {
    const rows = await database
      .select()
      .from(providerResources)
      .where(
        and(
          eq(providerResources.integrationId, scope.integrationId),
          eq(providerResources.resourceType, scope.scopeType),
          eq(providerResources.discoveryState, "active"),
          scope.providerResourceId && scope.selectionMode !== "all"
            ? eq(providerResources.id, scope.providerResourceId)
            : undefined,
        ),
      );
    return rows.map((row) => ({
      ...row,
      provider: scope.provider,
      resourceType: row.resourceType,
    }));
  }
  if (scope.provider === "linear") return [];
  const rows = await database
    .select()
    .from(githubRepositories)
    .where(
      and(
        eq(githubRepositories.integrationId, scope.integrationId),
        eq(githubRepositories.discoveryState, "active"),
        scope.selectionMode === "all" && scope.githubOrganizationId
          ? eq(githubRepositories.githubOrganizationId, scope.githubOrganizationId)
          : scope.githubRepositoryId
            ? eq(githubRepositories.id, scope.githubRepositoryId)
            : undefined,
      ),
    );
  return rows.map((row) => ({
    ...row,
    provider: "github" as const,
    resourceType: "github.repository",
  }));
}

export async function updateResourceLifecycle(
  database: DatabaseExecutor,
  provider: string,
  ids: readonly string[],
  values: Record<string, unknown>,
): Promise<void> {
  if (ids.length === 0) return;
  if (provider !== "github" && provider !== "linear") {
    await (database as any)
      .update(providerResources)
      .set(values)
      .where(inArray(providerResources.id, [...ids]));
    return;
  }
  if (provider === "linear") return;
  await (database as any)
    .update(githubRepositories)
    .set(values)
    .where(inArray(githubRepositories.id, [...ids]));
  await (database as any)
    .update(githubOrganizations)
    .set(values)
    .where(inArray(githubOrganizations.id, [...ids]));
}

/**
 * Moves legacy GitHub inventory into the dedicated tables without changing IDs.
 * The transaction rolls back if the copy, reference switch, or verification fails.
 */
export async function migrateGitHubResources(
  database: AppDatabase,
): Promise<GitHubResourceMigrationResult> {
  return database.transaction(async (tx) => {
    const legacy = await tx
      .select()
      .from(providerResources)
      .where(eq(providerResources.provider, "github"));
    const unsupported = legacy.filter(
      (row) =>
        row.resourceType !== "github.organization" && row.resourceType !== "github.repository",
    );
    if (unsupported.length > 0)
      throw new Error(
        `Cannot migrate GitHub provider resources with unsupported types: ${unsupported
          .map((row) => row.resourceType)
          .join(", ")}.`,
      );

    const organizations = legacy.filter((row) => row.resourceType === "github.organization");
    const repositories = legacy.filter((row) => row.resourceType === "github.repository");
    const organizationIds = new Set(organizations.map((row) => row.id));
    for (const row of organizations) await copyOrganization(tx, row);
    for (const row of repositories)
      await copyRepository(
        tx,
        row,
        row.parentResourceId && organizationIds.has(row.parentResourceId)
          ? row.parentResourceId
          : (organizations.find(
              (organization) =>
                organization.integrationId === row.integrationId &&
                organization.externalId === row.externalParentId,
            )?.id ?? null),
      );

    await switchReferences(tx);
    await verifyCopy(tx, organizations, repositories);
    await verifyReferencesSwitched(tx);

    if (legacy.length > 0) {
      // The legacy hierarchy is self-referential, so child repositories must be
      // removed before their parent organizations.
      if (repositories.length)
        await tx.delete(providerResources).where(
          inArray(
            providerResources.id,
            repositories.map((row) => row.id),
          ),
        );
      if (organizations.length)
        await tx.delete(providerResources).where(
          inArray(
            providerResources.id,
            organizations.map((row) => row.id),
          ),
        );
      const remaining = await tx
        .select({ id: providerResources.id })
        .from(providerResources)
        .where(
          inArray(
            providerResources.id,
            legacy.map((row) => row.id),
          ),
        );
      if (remaining.length > 0)
        throw new Error("Legacy GitHub provider resources were not removed.");
    }
    return {
      organizations: organizations.length,
      repositories: repositories.length,
      legacyRowsRemoved: legacy.length,
    };
  });
}

async function copyOrganization(tx: DatabaseExecutor, row: LegacyGitHubResource): Promise<void> {
  const value = githubResourceValues(row);
  await tx
    .insert(githubOrganizations)
    .values(value)
    .onDuplicateKeyUpdate({ set: { ...value, createdAt: undefined } });
}

async function copyRepository(
  tx: DatabaseExecutor,
  row: LegacyGitHubResource,
  githubOrganizationId: string | null,
): Promise<void> {
  const value = { ...githubResourceValues(row), githubOrganizationId };
  await tx
    .insert(githubRepositories)
    .values(value)
    .onDuplicateKeyUpdate({ set: { ...value, createdAt: undefined } });
}

function githubResourceValues(row: LegacyGitHubResource) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    integrationId: row.integrationId,
    externalId: row.externalId,
    externalParentId: row.externalParentId,
    displayName: row.displayName,
    externalUrl: row.externalUrl,
    metadataJson: row.metadataJson,
    discoveryState: row.discoveryState,
    discoveredAt: row.discoveredAt,
    lastSeenAt: row.lastSeenAt,
    syncStatus: row.syncStatus,
    currentSyncRunId: row.currentSyncRunId,
    lastSyncStartedAt: row.lastSyncStartedAt,
    lastSyncSucceededAt: row.lastSyncSucceededAt,
    lastSyncFailedAt: row.lastSyncFailedAt,
    lastSyncError: row.lastSyncError,
    nextAttemptAt: row.nextAttemptAt,
    consecutiveFailureCount: row.consecutiveFailureCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function switchReferences(tx: DatabaseExecutor): Promise<void> {
  await tx.execute(sql`
    UPDATE sync_scopes AS target
    JOIN provider_resources AS legacy ON legacy.id = target.provider_resource_id
    SET target.github_organization_id = CASE WHEN legacy.resource_type = 'github.organization' THEN legacy.id ELSE target.github_organization_id END,
        target.github_repository_id = CASE WHEN legacy.resource_type = 'github.repository' THEN legacy.id ELSE target.github_repository_id END,
        target.provider_resource_id = NULL
    WHERE legacy.provider = 'github'
  `);
  await tx.execute(sql`
    UPDATE sync_cursors AS target
    JOIN provider_resources AS legacy ON legacy.id = target.provider_resource_id
    SET target.github_organization_id = CASE WHEN legacy.resource_type = 'github.organization' THEN legacy.id ELSE target.github_organization_id END,
        target.github_repository_id = CASE WHEN legacy.resource_type = 'github.repository' THEN legacy.id ELSE target.github_repository_id END,
        target.provider_resource_id = NULL
    WHERE legacy.provider = 'github'
  `);
  await tx.execute(sql`
    UPDATE sync_runs AS target
    JOIN provider_resources AS legacy ON legacy.id = target.provider_resource_id
    SET target.github_organization_id = CASE WHEN legacy.resource_type = 'github.organization' THEN legacy.id ELSE target.github_organization_id END,
        target.github_repository_id = CASE WHEN legacy.resource_type = 'github.repository' THEN legacy.id ELSE target.github_repository_id END,
        target.provider_resource_id = NULL
    WHERE legacy.provider = 'github'
  `);
  // The generic table has a self-referencing parent FK. The relationship is
  // preserved in github_repositories.github_organization_id before the legacy
  // rows are removed, so clear the old FK as part of the same transaction.
  await tx.execute(sql`
    UPDATE provider_resources
    SET parent_resource_id = NULL
    WHERE provider = 'github'
  `);
}

async function verifyCopy(
  tx: DatabaseExecutor,
  organizations: LegacyGitHubResource[],
  repositories: LegacyGitHubResource[],
): Promise<void> {
  const [copiedOrganizations, copiedRepositories] = await Promise.all([
    tx
      .select()
      .from(githubOrganizations)
      .where(
        inArray(
          githubOrganizations.id,
          organizations.map((row) => row.id),
        ),
      ),
    tx
      .select()
      .from(githubRepositories)
      .where(
        inArray(
          githubRepositories.id,
          repositories.map((row) => row.id),
        ),
      ),
  ]);
  if (
    copiedOrganizations.length !== organizations.length ||
    copiedRepositories.length !== repositories.length
  )
    throw new Error("GitHub resource copy count verification failed.");
  const organizationById = new Map(copiedOrganizations.map((row) => [row.id, row]));
  const repositoryById = new Map(copiedRepositories.map((row) => [row.id, row]));
  for (const row of organizations)
    if (!sameLifecycleFields(row, organizationById.get(row.id)))
      throw new Error(`GitHub organization ${row.id} did not retain all lifecycle fields.`);
  for (const row of repositories) {
    if (!sameLifecycleFields(row, repositoryById.get(row.id)))
      throw new Error(`GitHub repository ${row.id} did not retain all lifecycle fields.`);
    const expectedOrganizationId =
      row.parentResourceId && organizationById.has(row.parentResourceId)
        ? row.parentResourceId
        : (organizations.find(
            (organization) =>
              organization.integrationId === row.integrationId &&
              organization.externalId === row.externalParentId,
          )?.id ?? null);
    if (repositoryById.get(row.id)?.githubOrganizationId !== expectedOrganizationId)
      throw new Error(`GitHub repository ${row.id} did not retain its organization link.`);
  }
}

function sameLifecycleFields(
  legacy: LegacyGitHubResource,
  copied: Record<string, unknown> | undefined,
): boolean {
  if (!copied) return false;
  return Object.entries(githubResourceValues(legacy)).every(
    ([key, value]) => copied[key] === value,
  );
}

async function verifyReferencesSwitched(tx: DatabaseExecutor): Promise<void> {
  const [rows] = await tx.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM sync_scopes AS target JOIN provider_resources AS legacy ON legacy.id = target.provider_resource_id WHERE legacy.provider = 'github') +
      (SELECT COUNT(*) FROM sync_cursors AS target JOIN provider_resources AS legacy ON legacy.id = target.provider_resource_id WHERE legacy.provider = 'github') +
      (SELECT COUNT(*) FROM sync_runs AS target JOIN provider_resources AS legacy ON legacy.id = target.provider_resource_id WHERE legacy.provider = 'github') AS count
  `);
  const count = Number((rows as unknown as Array<{ count: number | string }>)[0]?.count ?? 0);
  if (count !== 0) throw new Error("Not all GitHub sync references were switched safely.");
}
