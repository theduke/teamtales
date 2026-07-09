import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openLocalDatabase } from "../../src/db/index.js";
import { createOrganizationService, addSyncScopeService } from "../../src/services/index.js";

describe("addSyncScopeService", () => {
  it("rejects sync scope types that do not match the provider", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      seedOrganization(local.sqlite);
      insertIntegration(local.sqlite, "integration_github", "github");
      insertIntegration(local.sqlite, "integration_linear", "linear");

      assert.throws(
        () =>
          addSyncScopeService(local.sqlite, {
            organizationId: "org_service",
            userId: "user_service_owner",
            integrationId: "integration_github",
            provider: "github",
            scopeType: "linear.team",
            externalName: "Engineering",
          }),
        /not supported for provider github/,
      );

      assert.throws(
        () =>
          addSyncScopeService(local.sqlite, {
            organizationId: "org_service",
            userId: "user_service_owner",
            integrationId: "integration_linear",
            provider: "linear",
            scopeType: "github.repository",
            externalName: "acme/widgets",
          }),
        /not supported for provider linear/,
      );
    } finally {
      local.close();
    }
  });

  it("persists a compatible sync scope", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      seedOrganization(local.sqlite);
      insertIntegration(local.sqlite, "integration_linear", "linear");

      const scope = addSyncScopeService(local.sqlite, {
        organizationId: "org_service",
        userId: "user_service_owner",
        integrationId: "integration_linear",
        provider: "linear",
        scopeType: "linear.team",
        externalId: "team_eng",
        externalName: "Engineering",
      });

      assert.equal(scope.provider, "linear");
      assert.equal(scope.scopeType, "linear.team");
    } finally {
      local.close();
    }
  });
});

function seedOrganization(database: import("node:sqlite").DatabaseSync): void {
  createOrganizationService(database, {
    id: "org_service",
    name: "Service Org",
    ownerId: "user_service_owner",
    ownerName: "Service Owner",
  });
}

function insertIntegration(database: import("node:sqlite").DatabaseSync, id: string, provider: "github" | "linear"): void {
  database
    .prepare(
      `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "org_service", provider, "personal_access_token", "active", id);
}
