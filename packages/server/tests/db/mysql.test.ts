import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { authenticatePassword, setPassword } from "../../src/auth/index.js";
import {
  openDatabase,
  migrationsEnabled,
  mysqlConnectionOptions,
  resolveMigrationsFolder,
} from "../../src/db/index.js";
import { integrations, organizations, syncScopes, users } from "../../src/db/schema.js";
import {
  addPersonalAccessTokenIntegrationService,
  addSyncScopeService,
  createOrganizationService,
} from "../../src/services/index.js";

describe("MySQL configuration", () => {
  it("accepts Wasmer capability variables and DB_USERNAME precedence", () => {
    const options = mysqlConnectionOptions({
      DB_HOST: "mysql.internal",
      DB_PORT: "3307",
      DB_USERNAME: "wasmer-user",
      DB_USER: "fallback",
      DB_PASSWORD: "secret",
      DB_NAME: "teamtales",
    });
    assert.equal(options.host, "mysql.internal");
    assert.equal(options.port, 3307);
    assert.equal(options.user, "wasmer-user");
    assert.equal(options.database, "teamtales");
  });

  it("accepts DATABASE_URL", () => {
    assert.equal(
      mysqlConnectionOptions({ DATABASE_URL: "mysql://user:pass@localhost/db" }).uri,
      "mysql://user:pass@localhost/db",
    );
  });

  it("only auto-runs migrations when explicitly enabled", () => {
    assert.equal(migrationsEnabled({}), false);
    assert.equal(migrationsEnabled({ TEAMTALES_AUTO_MIGRATE: "true" }), true);
    assert.equal(migrationsEnabled({ TEAMTALES_AUTO_MIGRATE: "0" }), false);
    assert.throws(
      () => migrationsEnabled({ TEAMTALES_AUTO_MIGRATE: "sometimes" }),
      /TEAMTALES_AUTO_MIGRATE/,
    );
  });

  it("finds migrations from the repository root and server workspace", () => {
    const root = join(import.meta.dirname, "../../../..");
    const fromRoot = resolveMigrationsFolder(root, import.meta.url);
    const fromWorkspace = resolveMigrationsFolder(join(root, "packages/server"), import.meta.url);
    assert.equal(fromRoot, fromWorkspace);
    assert.match(fromRoot, /packages\/server\/drizzle$/);
  });
});

const testDatabaseUrl = process.env.TEAMTALES_TEST_DATABASE_URL;
it(
  "runs migrations and meaningful Drizzle operations against MySQL",
  { skip: !testDatabaseUrl },
  async () => {
    const opened = await openDatabase({
      env: { DATABASE_URL: testDatabaseUrl },
      runMigrations: true,
    });
    const suffix = randomUUID();
    const organizationId = `org_${suffix}`;
    const userId = `user_${suffix}`;
    try {
      const created = await createOrganizationService(opened.db, {
        id: organizationId,
        name: `Test ${suffix}`,
        slug: `test-${suffix}`,
        ownerId: userId,
        ownerEmail: `${suffix}@example.test`,
        ownerName: "Test Owner",
        membershipId: `membership_${suffix}`,
      });
      assert.equal(created.ownerUserId, userId);
      await setPassword(opened.db, userId, "correct horse battery staple");
      assert.equal(
        (
          await authenticatePassword(
            opened.db,
            `${suffix}@example.test`,
            "correct horse battery staple",
          )
        )?.userId,
        userId,
      );
      const integration = await addPersonalAccessTokenIntegrationService(opened.db, {
        id: `integration_${suffix}`,
        credentialId: `credential_${suffix}`,
        organizationId,
        userId,
        provider: "github",
        displayName: "Test GitHub",
        token: "github_pat_integration_test",
        encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      });
      const scope = await addSyncScopeService(opened.db, {
        id: `scope_${suffix}`,
        organizationId,
        userId,
        integrationId: integration.id,
        provider: "github",
        scopeType: "github.repository",
        externalName: "owner/repository",
        config: { owner: "owner", repo: "repository" },
      });
      const [storedScope] = await opened.db
        .select()
        .from(syncScopes)
        .where(eq(syncScopes.id, scope.id));
      assert.equal(storedScope?.integrationId, integration.id);
      assert.deepEqual(JSON.parse(storedScope?.configJson ?? "{}"), {
        owner: "owner",
        repo: "repository",
      });
    } finally {
      await opened.db.delete(syncScopes).where(eq(syncScopes.organizationId, organizationId));
      await opened.db.delete(integrations).where(eq(integrations.organizationId, organizationId));
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.db.delete(users).where(eq(users.id, userId));
      await opened.close();
    }
  },
);
