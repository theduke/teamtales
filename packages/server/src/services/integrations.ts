import type { AppDatabase } from "../db/mysql.js";
import { integrationCredentials, integrations } from "../db/schema.js";
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

export async function addPersonalAccessTokenIntegrationService(
  database: AppDatabase,
  input: AddPersonalAccessTokenIntegrationInput,
): Promise<IntegrationWithSecretHintDto> {
  const displayName = input.displayName ?? `${input.provider} PAT`;
  const integrationId =
    input.id ?? stableId("integration", input.organizationId, input.provider, displayName);
  const credentialId = input.credentialId ?? stableId("credential", integrationId);

  return withTransaction(database, async (transaction) => {
    await requireOrganization(transaction, input.organizationId);
    await requireOrganizationRole(transaction, input.organizationId, input.userId, [
      "owner",
      "admin",
    ]);

    const now = new Date().toISOString();
    await transaction.insert(integrations).values({
      id: integrationId,
      organizationId: input.organizationId,
      provider: input.provider,
      authType: "personal_access_token",
      status: "active",
      displayName,
      createdAt: now,
      updatedAt: now,
    });

    const credential = createIntegrationCredentialRecord({
      id: credentialId,
      integrationId,
      plaintextSecret: input.token,
      encryptionKey: input.encryptionKey,
    });

    await transaction.insert(integrationCredentials).values({
      id: credential.id,
      integrationId: credential.integrationId,
      encryptedSecret: credential.encryptedSecret,
      secretHint: credential.secretHint,
      expiresAt: credential.expiresAt?.toISOString() ?? null,
      createdAt: now,
      updatedAt: now,
    });

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
