import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { integrations, organizations } from "../../src/db/schema.js";
import { createOrganizationService, addSyncScopeService } from "../../src/services/index.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("addSyncScopeService", mysqlTestOptions, () => {
  it("rejects sync scope types that do not match the provider and persists compatible scopes", async () => {
    const opened = await openTestDatabase(); const suffix = uniqueId("scope");
    const organizationId = `org_${suffix}`, userId = `user_${suffix}`, githubId = `github_${suffix}`, linearId = `linear_${suffix}`;
    try {
      await createOrganizationService(opened.db, { id: organizationId, name: "Service Org", slug: organizationId, ownerId: userId, ownerName: "Owner" });
      await opened.db.insert(integrations).values([
        { id: githubId, organizationId, provider: "github", authType: "personal_access_token", status: "active", displayName: githubId },
        { id: linearId, organizationId, provider: "linear", authType: "personal_access_token", status: "active", displayName: linearId },
      ]);
      await assert.rejects(addSyncScopeService(opened.db, { organizationId, userId, integrationId: githubId, provider: "github", scopeType: "linear.team", externalName: "Engineering" }), /not supported for provider github/);
      await assert.rejects(addSyncScopeService(opened.db, { organizationId, userId, integrationId: linearId, provider: "linear", scopeType: "github.repository", externalName: "acme\/widgets" }), /not supported for provider linear/);
      const scope = await addSyncScopeService(opened.db, { id: `saved_${suffix}`, organizationId, userId, integrationId: linearId, provider: "linear", scopeType: "linear.team", externalId: "team_eng", externalName: "Engineering" });
      assert.equal(scope.provider, "linear"); assert.equal(scope.scopeType, "linear.team");
    } finally { await opened.db.delete(organizations).where(eq(organizations.id, organizationId)); await opened.close(); }
  });
});
