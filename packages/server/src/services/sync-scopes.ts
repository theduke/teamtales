import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, SyncScopeDto } from "@teamtales/common/api";
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

export function addSyncScopeService(database: DatabaseSync, input: AddSyncScopeServiceInput): SyncScopeDto {
  requireOrganization(database, input.organizationId);
  requireOrganizationRole(database, input.organizationId, input.userId, ["owner", "admin"]);
  requireIntegrationInOrganization(database, input.organizationId, input.integrationId);

  const now = new Date().toISOString();
  const scopeId =
    input.id ?? stableId("scope", input.organizationId, input.integrationId, input.scopeType, input.externalName);
  const enabled = input.enabled ?? true;

  database
    .prepare(
      `INSERT INTO sync_scopes (
        id, organization_id, integration_id, provider, scope_type, external_id, external_name,
        config_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scopeId,
      input.organizationId,
      input.integrationId,
      input.provider,
      input.scopeType,
      input.externalId ?? null,
      input.externalName,
      JSON.stringify(input.config ?? {}),
      enabled ? 1 : 0,
      now,
      now,
    );

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
