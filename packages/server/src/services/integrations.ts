import type { DatabaseSync } from "node:sqlite";
import type { IntegrationDto } from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";

import {
  requireOrganization,
  requireOrganizationRole,
  withTransaction,
} from "../persistence/index.js";
import { createIntegrationCredentialRecord } from "../security/index.js";
import { stableId } from "./ids.js";

export type IntegrationWithSecretHintDto = IntegrationDto & {
  credentialId: string;
  secretHint: string;
};

export interface AddPersonalAccessTokenIntegrationInput {
  id?: string;
  credentialId?: string;
  organizationId: string;
  userId: string;
  provider: Provider;
  displayName?: string;
  token: string;
  encryptionKey: string | Buffer;
}

export function addPersonalAccessTokenIntegrationService(
  database: DatabaseSync,
  input: AddPersonalAccessTokenIntegrationInput,
): IntegrationWithSecretHintDto {
  const displayName = input.displayName ?? `${input.provider} PAT`;
  const integrationId = input.id ?? stableId("integration", input.organizationId, input.provider, displayName);
  const credentialId = input.credentialId ?? stableId("credential", integrationId);

  return withTransaction(database, () => {
    requireOrganization(database, input.organizationId);
    requireOrganizationRole(database, input.organizationId, input.userId, ["owner", "admin"]);

    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(integrationId, input.organizationId, input.provider, "personal_access_token", "active", displayName, now, now);

    const credential = createIntegrationCredentialRecord({
      id: credentialId,
      integrationId,
      plaintextSecret: input.token,
      encryptionKey: input.encryptionKey,
    });

    database
      .prepare(
        `INSERT INTO integration_credentials (
          id, integration_id, encrypted_secret, secret_hint, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.id,
        credential.integrationId,
        credential.encryptedSecret,
        credential.secretHint,
        credential.expiresAt?.toISOString() ?? null,
        now,
        now,
      );

    return {
      id: integrationId,
      organizationId: input.organizationId,
      provider: input.provider,
      authType: "personal_access_token",
      status: "active",
      displayName,
      createdAt: now,
      updatedAt: now,
      credentialId,
      secretHint: credential.secretHint,
    };
  });
}
