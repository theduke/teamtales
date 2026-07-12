import { and, eq, inArray } from "drizzle-orm";

import type { AppDatabase, MySqlTransaction } from "../db/mysql.js";
import { linearTeams, linearWorkspaces } from "../db/schema.js";
import { stableId } from "./ids.js";

type DatabaseExecutor = AppDatabase | MySqlTransaction;

export type ManagedLinearResource = {
  id: string;
  provider: "linear";
  resourceType: "linear.workspace" | "linear.team";
  externalId: string;
  displayName: string;
  externalUrl: string | null;
  syncStatus: string;
  lastSyncStartedAt: string | null;
  lastSyncSucceededAt: string | null;
  lastSyncFailedAt: string | null;
  lastSyncError: string | null;
};

export async function upsertLinearWorkspace(
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
    .select({ id: linearWorkspaces.id })
    .from(linearWorkspaces)
    .where(
      and(
        eq(linearWorkspaces.integrationId, input.integrationId),
        eq(linearWorkspaces.externalId, input.externalId),
      ),
    )
    .limit(1);
  const id =
    existing?.id ??
    stableId(
      "provider_resource",
      input.organizationId,
      input.integrationId,
      "linear.workspace",
      input.externalId,
    );
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
      .update(linearWorkspaces)
      .set({ ...value, createdAt: undefined })
      .where(eq(linearWorkspaces.id, id));
  else await tx.insert(linearWorkspaces).values({ ...value, createdAt: input.now });
  return id;
}

export async function upsertLinearTeam(
  tx: DatabaseExecutor,
  input: {
    organizationId: string;
    integrationId: string;
    externalId: string;
    externalParentId?: string | null;
    linearWorkspaceId?: string | null;
    displayName: string;
    metadataJson: string;
    now: string;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: linearTeams.id })
    .from(linearTeams)
    .where(
      and(
        eq(linearTeams.integrationId, input.integrationId),
        eq(linearTeams.externalId, input.externalId),
      ),
    )
    .limit(1);
  const id =
    existing?.id ??
    stableId(
      "provider_resource",
      input.organizationId,
      input.integrationId,
      "linear.team",
      input.externalId,
    );
  const value = {
    id,
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    externalId: input.externalId,
    externalParentId: input.externalParentId ?? null,
    linearWorkspaceId: input.linearWorkspaceId ?? null,
    displayName: input.displayName,
    metadataJson: input.metadataJson,
    discoveryState: "active",
    discoveredAt: input.now,
    lastSeenAt: input.now,
    updatedAt: input.now,
  };
  if (existing)
    await tx
      .update(linearTeams)
      .set({ ...value, createdAt: undefined })
      .where(eq(linearTeams.id, id));
  else await tx.insert(linearTeams).values({ ...value, createdAt: input.now });
  return id;
}

export async function readLinearResource(
  database: DatabaseExecutor,
  id: string,
): Promise<ManagedLinearResource | undefined> {
  const [team] = await database.select().from(linearTeams).where(eq(linearTeams.id, id)).limit(1);
  if (team) return { ...team, provider: "linear", resourceType: "linear.team" };
  const [workspace] = await database
    .select()
    .from(linearWorkspaces)
    .where(eq(linearWorkspaces.id, id))
    .limit(1);
  return workspace ? { ...workspace, provider: "linear", resourceType: "linear.workspace" } : undefined;
}

export async function listLinearExecutableResources(
  database: AppDatabase,
  scope: {
    scopeType: string;
    integrationId: string;
    selectionMode: string;
    linearWorkspaceId?: string;
    linearTeamId?: string;
  },
): Promise<ManagedLinearResource[]> {
  if (scope.scopeType === "linear.workspace") {
    const rows = await database
      .select()
      .from(linearWorkspaces)
      .where(
        and(
          eq(linearWorkspaces.integrationId, scope.integrationId),
          eq(linearWorkspaces.discoveryState, "active"),
          scope.linearWorkspaceId && scope.selectionMode !== "all"
            ? eq(linearWorkspaces.id, scope.linearWorkspaceId)
            : undefined,
        ),
      );
    return rows.map((row) => ({ ...row, provider: "linear" as const, resourceType: "linear.workspace" as const }));
  }
  if (scope.scopeType !== "linear.team") return [];
  const rows = await database
    .select()
    .from(linearTeams)
    .where(
      and(
        eq(linearTeams.integrationId, scope.integrationId),
        eq(linearTeams.discoveryState, "active"),
        scope.linearTeamId ? eq(linearTeams.id, scope.linearTeamId) : undefined,
      ),
    );
  return rows.map((row) => ({ ...row, provider: "linear" as const, resourceType: "linear.team" as const }));
}

export async function updateLinearResourceLifecycle(
  database: DatabaseExecutor,
  ids: readonly string[],
  values: Record<string, unknown>,
): Promise<void> {
  if (ids.length === 0) return;
  await (database as any).update(linearTeams).set(values).where(inArray(linearTeams.id, [...ids]));
  await (database as any)
    .update(linearWorkspaces)
    .set(values)
    .where(inArray(linearWorkspaces.id, [...ids]));
}
