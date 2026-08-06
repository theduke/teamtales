import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";

import {
  integrations,
  linearTeams,
  linearWorkspaces,
  organizations,
  providerResources,
} from "../../src/db/schema.js";
import { stableId } from "../../src/services/ids.js";
import {
  listLinearExecutableResources,
  readLinearResource,
  updateLinearResourceLifecycle,
  upsertLinearTeam,
  upsertLinearWorkspace,
} from "../../src/services/linear-resources.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("Linear dedicated resources", mysqlTestOptions, () => {
  it("uses legacy-stable IDs and keeps workspace/team lifecycle state out of provider resources", async () => {
    const opened = await openTestDatabase();
    const suffix = uniqueId("linear_resource");
    const organizationId = `org_${suffix}`;
    const integrationId = `integration_${suffix}`;
    const now = new Date().toISOString();
    try {
      await opened.db.insert(organizations).values({
        id: organizationId,
        name: "Linear resources",
        slug: organizationId,
      });
      await opened.db.insert(integrations).values({
        id: integrationId,
        organizationId,
        provider: "linear",
        authType: "personal_access_token",
        status: "active",
        displayName: "Linear",
      });
      const workspaceId = await upsertLinearWorkspace(opened.db, {
        organizationId,
        integrationId,
        externalId: "workspace_1",
        displayName: "Acme",
        metadataJson: "{}",
        now,
      });
      const teamId = await upsertLinearTeam(opened.db, {
        organizationId,
        integrationId,
        externalId: "team_1",
        externalParentId: "workspace_1",
        linearWorkspaceId: workspaceId,
        displayName: "Engineering",
        metadataJson: '{"key":"ENG"}',
        now,
      });

      assert.equal(
        workspaceId,
        stableId(
          "provider_resource",
          organizationId,
          integrationId,
          "linear.workspace",
          "workspace_1",
        ),
      );
      assert.equal(
        teamId,
        stableId("provider_resource", organizationId, integrationId, "linear.team", "team_1"),
      );
      const [team] = await opened.db.select().from(linearTeams).where(eq(linearTeams.id, teamId));
      assert.equal(team?.linearWorkspaceId, workspaceId);
      assert.equal(
        (
          await opened.db
            .select()
            .from(providerResources)
            .where(eq(providerResources.integrationId, integrationId))
        ).length,
        0,
      );

      const [workspaceResources, teamResources, readTeam] = await Promise.all([
        listLinearExecutableResources(opened.db, {
          scopeType: "linear.workspace",
          integrationId,
          selectionMode: "all",
          linearWorkspaceId: workspaceId,
        }),
        listLinearExecutableResources(opened.db, {
          scopeType: "linear.team",
          integrationId,
          selectionMode: "individual",
          linearTeamId: teamId,
        }),
        readLinearResource(opened.db, teamId),
      ]);
      assert.deepEqual(
        workspaceResources.map((resource) => resource.id),
        [workspaceId],
      );
      assert.deepEqual(
        teamResources.map((resource) => resource.id),
        [teamId],
      );
      assert.equal(readTeam?.resourceType, "linear.team");

      await updateLinearResourceLifecycle(opened.db, [workspaceId, teamId], {
        syncStatus: "running",
        lastSyncStartedAt: now,
        updatedAt: now,
      });
      const [workspace] = await opened.db
        .select()
        .from(linearWorkspaces)
        .where(eq(linearWorkspaces.id, workspaceId));
      const [updatedTeam] = await opened.db
        .select()
        .from(linearTeams)
        .where(eq(linearTeams.id, teamId));
      assert.equal(workspace?.syncStatus, "running");
      assert.equal(updatedTeam?.syncStatus, "running");
    } finally {
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
    }
  });
});
