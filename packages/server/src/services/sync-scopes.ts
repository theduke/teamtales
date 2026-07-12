import type { AppDatabase } from "../db/mysql.js";
import { syncScopes } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import type { DiscoveredResourceDto, JsonObject, SyncScopeDto } from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";

import {
  requireIntegrationInOrganization,
  requireOrganization,
  requireOrganizationRole,
} from "../persistence/index.js";
import { stableId } from "./ids.js";

export interface AddSyncScopeServiceInput {
  id?: string;
  organizationId: string;
  userId: string;
  integrationId: string;
  provider: Provider;
  scopeType: SyncScopeDto["scopeType"];
  externalId?: string;
  externalName: string;
  config?: JsonObject;
  enabled?: boolean;
}

const supportedSyncScopeTypes = [
  "github.repository",
  "github.organization",
  "linear.workspace",
  "linear.team",
  "linear.project",
] as const satisfies readonly SyncScopeDto["scopeType"][];

export async function addSyncScopeService(database: AppDatabase, input: AddSyncScopeServiceInput): Promise<SyncScopeDto> {
  await requireOrganization(database, input.organizationId);
  await requireOrganizationRole(database, input.organizationId, input.userId, ["owner", "admin"]);
  await requireIntegrationInOrganization(database, input.organizationId, input.integrationId);
  validateScopeTypeForProvider(input.provider, input.scopeType);

  const now = new Date().toISOString();
  const scopeId =
    input.id ?? stableId("scope", input.organizationId, input.integrationId, input.scopeType, input.externalName);
  const enabled = input.enabled ?? true;

  await database.insert(syncScopes).values({ id: scopeId, organizationId: input.organizationId, integrationId: input.integrationId, provider: input.provider, scopeType: input.scopeType, externalId: input.externalId ?? null, externalName: input.externalName, configJson: JSON.stringify(input.config ?? {}), enabled: enabled ? 1 : 0, createdAt: now, updatedAt: now });

  return {
    id: scopeId,
    organizationId: input.organizationId,
    integrationId: input.integrationId,
    provider: input.provider,
    scopeType: input.scopeType,
    externalId: input.externalId ?? "",
    externalName: input.externalName,
    config: input.config ?? {},
    enabled,
    createdAt: now,
    updatedAt: now,
  };
}

export async function setSyncScopeSelectionService(database: AppDatabase, input: Omit<AddSyncScopeServiceInput, "scopeType" | "externalId" | "externalName" | "config" | "enabled"> & { selections: DiscoveredResourceDto[] }): Promise<SyncScopeDto[]> {
  await requireOrganization(database, input.organizationId);
  await requireOrganizationRole(database, input.organizationId, input.userId, ["owner", "admin"]);
  await requireIntegrationInOrganization(database, input.organizationId, input.integrationId);
  const now = new Date().toISOString();
  const selected = new Set(input.selections.map(selection => stableId("scope", input.organizationId, input.integrationId, selection.scopeType, selection.externalName)));
  await database.transaction(async transaction => {
    const existing = await transaction.select().from(syncScopes).where(and(eq(syncScopes.organizationId, input.organizationId), eq(syncScopes.integrationId, input.integrationId)));
    for (const selection of input.selections) {
      validateScopeTypeForProvider(input.provider, selection.scopeType);
      const id = stableId("scope", input.organizationId, input.integrationId, selection.scopeType, selection.externalName);
      const row = existing.find(scope => scope.id === id);
      if (row) await transaction.update(syncScopes).set({ externalId: selection.externalId, externalName: selection.externalName, configJson: JSON.stringify(selection.config ?? {}), enabled: 1, updatedAt: now }).where(eq(syncScopes.id, id));
      else await transaction.insert(syncScopes).values({ id, organizationId: input.organizationId, integrationId: input.integrationId, provider: input.provider, scopeType: selection.scopeType, externalId: selection.externalId, externalName: selection.externalName, configJson: JSON.stringify(selection.config ?? {}), enabled: 1, createdAt: now, updatedAt: now });
    }
    for (const scope of existing) if (!selected.has(scope.id)) await transaction.update(syncScopes).set({ enabled: 0, updatedAt: now }).where(eq(syncScopes.id, scope.id));
  });
  const rows = await database.select().from(syncScopes).where(and(eq(syncScopes.organizationId, input.organizationId), eq(syncScopes.integrationId, input.integrationId)));
  return rows.map(row => ({ id: row.id, organizationId: row.organizationId, integrationId: row.integrationId, provider: row.provider as Provider, scopeType: row.scopeType as SyncScopeDto["scopeType"], externalId: row.externalId ?? "", externalName: row.externalName, config: JSON.parse(row.configJson) as JsonObject, enabled: row.enabled === 1, lastSuccessAt: row.lastSuccessAt ?? undefined, lastAttemptAt: row.lastAttemptAt ?? undefined, createdAt: row.createdAt, updatedAt: row.updatedAt }));
}

function validateScopeTypeForProvider(provider: Provider, scopeType: SyncScopeDto["scopeType"]): void {
  if (!supportedSyncScopeTypes.includes(scopeType)) {
    throw new Error(`Unsupported sync scope type: ${scopeType}.`);
  }
  if (!scopeType.startsWith(`${provider}.`)) {
    throw new Error(`Sync scope type ${scopeType} is not supported for provider ${provider}.`);
  }
}
