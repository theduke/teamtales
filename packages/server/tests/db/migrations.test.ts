import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  integrationCredentials,
  integrations,
  organizations,
  sourceObjects,
  syncScopes,
} from "../../src/db/schema.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("MySQL migrations", mysqlTestOptions, () => {
  it("apply idempotently and expose the expected schema", async () => {
    const first = await openTestDatabase();
    await first.close();
    const second = await openTestDatabase();
    try {
      const [columns] = await second.db.execute("SHOW COLUMNS FROM integration_credentials");
      const names = (columns as unknown as Array<{ Field: string }>).map((column) => column.Field);
      assert.equal(names.includes("encrypted_secret"), true);
      assert.equal(names.includes("secret_hint"), true);
    } finally {
      await second.close();
    }
  });

  it("enforces foreign keys and natural uniqueness", async () => {
    const opened = await openTestDatabase();
    const suffix = uniqueId("migration");
    const orgId = `org_${suffix}`,
      integrationId = `integration_${suffix}`,
      scopeId = `scope_${suffix}`;
    try {
      await assert.rejects(
        opened.db.insert(integrationCredentials).values({
          id: `credential_${suffix}`,
          integrationId: `missing_${suffix}`,
          encryptedSecret: "encrypted",
        }),
        /foreign key/i,
      );
      await assert.rejects(
        opened.db.insert(integrations).values({
          id: integrationId,
          organizationId: `missing_${suffix}`,
          provider: "github",
          authType: "personal_access_token",
          status: "active",
          displayName: "GitHub",
        }),
        /foreign key/i,
      );
      await opened.db.insert(organizations).values({ id: orgId, name: "Migration", slug: orgId });
      await opened.db.insert(integrations).values({
        id: integrationId,
        organizationId: orgId,
        provider: "github",
        authType: "personal_access_token",
        status: "active",
        displayName: "GitHub",
      });
      await opened.db.insert(syncScopes).values({
        id: scopeId,
        organizationId: orgId,
        integrationId,
        provider: "github",
        scopeType: "github.repository",
        externalName: "acme/widgets",
        configJson: "{}",
      });
      const object = {
        organizationId: orgId,
        integrationId,
        syncScopeId: scopeId,
        provider: "github",
        objectType: "github.pull_request",
        externalId: "42",
        rawJson: "{}",
        contentHash: "hash",
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        lastChangedAt: new Date().toISOString(),
        sourceState: "active",
      };
      await opened.db.insert(sourceObjects).values({ id: `source_a_${suffix}`, ...object });
      await assert.rejects(
        opened.db.insert(sourceObjects).values({ id: `source_b_${suffix}`, ...object }),
        /duplicate|unique/i,
      );
    } finally {
      await opened.db.delete(organizations).where(eq(organizations.id, orgId));
      await opened.close();
    }
  });
});
