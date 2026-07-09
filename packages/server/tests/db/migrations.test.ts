import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openLocalDatabase, runMigrations } from "../../src/db/index.js";

describe("local SQLite migrations", () => {
  it("applies project migrations and records them idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-db-"));
    const filename = join(directory, "teamtales.sqlite");

    try {
      const local = openLocalDatabase({ filename, runMigrations: true });

      assert.equal(existsSync(filename), true);
      assert.equal(local.migrations?.applied.length, 1);
      assert.equal(local.migrations?.skipped.length, 0);

      const integrationColumns = local.sqlite
        .prepare("PRAGMA table_info(integration_credentials)")
        .all() as Array<{ name: string }>;

      assert.deepEqual(
        integrationColumns.map((column) => column.name).filter((name) => ["encrypted_secret", "secret_hint"].includes(name)),
        ["encrypted_secret", "secret_hint"],
      );

      const organizationColumns = local.sqlite.prepare("PRAGMA table_info(organizations)").all() as Array<{ name: string }>;
      assert.deepEqual(
        organizationColumns.map((column) => column.name).filter((name) => ["id", "name", "slug"].includes(name)),
        ["id", "name", "slug"],
      );

      const secondRun = runMigrations(local.sqlite);

      assert.equal(secondRun.applied.length, 0);
      assert.equal(secondRun.skipped.length, 1);

      local.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enables foreign key enforcement", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      assert.throws(
        () =>
          local.sqlite
            .prepare(
              "INSERT INTO integration_credentials (id, integration_id, encrypted_secret, secret_hint) VALUES (?, ?, ?, ?)",
            )
            .run("cred_1", "missing_integration", "encrypted", "hint"),
        /FOREIGN KEY/,
      );

      assert.throws(
        () =>
          local.sqlite
            .prepare(
              `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run("integration_1", "missing_org", "github", "personal_access_token", "active", "GitHub"),
        /FOREIGN KEY/,
      );
    } finally {
      local.close();
    }
  });

  it("enforces organization-scoped uniqueness and ownership", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      insertOrganization(local.sqlite, "org_1", "Acme", "acme");
      insertOrganization(local.sqlite, "org_2", "Beta", "beta");
      insertIntegration(local.sqlite, "integration_1", "org_1");
      insertIntegration(local.sqlite, "integration_2", "org_2");
      insertScope(local.sqlite, "scope_1", "org_1", "integration_1");
      insertScope(local.sqlite, "scope_2", "org_2", "integration_2");

      insertSourceObject(local.sqlite, "source_1", "org_1", "integration_1", "scope_1", "42");
      insertSourceObject(local.sqlite, "source_2", "org_2", "integration_2", "scope_2", "42");

      assert.throws(() => insertSourceObject(local.sqlite, "source_3", "org_1", "integration_1", "scope_1", "42"), /UNIQUE/);
      insertScope(local.sqlite, "scope_3", "org_1", "integration_1");
      insertSourceObject(local.sqlite, "source_4", "org_1", "integration_1", "scope_3", "42");
      assert.throws(() => insertScope(local.sqlite, "scope_bad", "org_2", "integration_1"), /FOREIGN KEY/);
      assert.throws(
        () =>
          local.sqlite
            .prepare(
              `INSERT INTO activity_events (
                id, organization_id, source_object_id, provider, event_type, work_item_id,
                occurred_at, title
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run("event_bad", "org_2", "source_1", "github", "updated", null, "2026-06-29T09:00:00.000Z", "Bad"),
        /FOREIGN KEY/,
      );
    } finally {
      local.close();
    }
  });

  it("enforces allowed sync scope types", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      insertOrganization(local.sqlite, "org_1", "Acme", "acme");
      insertIntegration(local.sqlite, "integration_1", "org_1");

      insertScope(local.sqlite, "scope_1", "org_1", "integration_1");
      assert.throws(() => insertScope(local.sqlite, "scope_bad", "org_1", "integration_1", "not-a-scope"), /CHECK/);
    } finally {
      local.close();
    }
  });
});

function insertOrganization(
  database: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  id: string,
  name: string,
  slug: string,
): void {
  database.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
}

function insertIntegration(
  database: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  id: string,
  organizationId: string,
): void {
  database
    .prepare(
      `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, organizationId, "github", "personal_access_token", "active", id);
}

function insertScope(
  database: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  id: string,
  organizationId: string,
  integrationId: string,
  scopeType = "github.repository",
): void {
  database
    .prepare(
      `INSERT INTO sync_scopes (id, organization_id, integration_id, provider, scope_type, external_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, organizationId, integrationId, "github", scopeType, id);
}

function insertSourceObject(
  database: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  id: string,
  organizationId: string,
  integrationId: string,
  syncScopeId: string,
  externalId: string,
): void {
  database
    .prepare(
      `INSERT INTO source_objects (
        id, organization_id, integration_id, sync_scope_id, provider, object_type, external_id,
        raw_json, content_hash, first_seen_at, last_seen_at, last_changed_at, source_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      organizationId,
      integrationId,
      syncScopeId,
      "github",
      "github.pull_request",
      externalId,
      "{}",
      "hash",
      "2026-06-29T09:00:00.000Z",
      "2026-06-29T09:00:00.000Z",
      "2026-06-29T09:00:00.000Z",
      "active",
    );
}
