import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { integrations, organizations, syncRuns, syncScopes } from "../../src/db/schema.js";
import {
  enqueueProviderSyncService,
  processQueuedProviderSyncBatch,
} from "../../src/services/sync-runs.js";
import { mysqlTestOptions, openTestDatabase } from "../helpers/mysql.js";

describe("queued provider sync recovery", mysqlTestOptions, () => {
  const cleanup: Array<() => Promise<void>> = [];

  after(async () => {
    for (const remove of cleanup.reverse()) await remove();
  });

  it("completes an orchestration run when a scope has no active resources", async () => {
    const opened = await openTestDatabase();
    const suffix = randomUUID().replaceAll("-", "");
    const organizationId = `org_sync_empty_${suffix}`;
    const integrationId = `integration_sync_empty_${suffix}`;
    const scopeId = `scope_sync_empty_${suffix}`;
    const now = new Date().toISOString();
    cleanup.push(async () => {
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
    });
    await opened.db.insert(organizations).values({
      id: organizationId,
      name: "Empty sync scope",
      slug: `empty-sync-scope-${suffix}`,
      createdAt: now,
      updatedAt: now,
    });
    await opened.db.insert(integrations).values({
      id: integrationId,
      organizationId,
      provider: "github",
      authType: "personal_access_token",
      status: "active",
      displayName: "Empty GitHub",
      createdAt: now,
      updatedAt: now,
    });
    await opened.db.insert(syncScopes).values({
      id: scopeId,
      organizationId,
      integrationId,
      provider: "github",
      scopeType: "github.repository",
      externalId: "empty",
      externalName: "acme/empty",
      selectionMode: "individual",
      configJson: JSON.stringify({ repository: "acme/empty" }),
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    });

    const queued = await enqueueProviderSyncService(opened.db, {
      provider: "github",
      organizationId,
      syncScopeId: scopeId,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const [run] = await opened.db.select().from(syncRuns).where(eq(syncRuns.id, queued.syncRunId!));

    assert.equal(queued.status, "completed");
    assert.equal(run?.status, "completed");
    assert.equal(typeof run?.finishedAt, "string");
  });

  it("fails claimed rows whose execution references are no longer valid", async () => {
    const opened = await openTestDatabase();
    const suffix = randomUUID().replaceAll("-", "");
    const organizationId = `org_sync_missing_${suffix}`;
    const integrationId = `integration_sync_missing_${suffix}`;
    const runId = `run_sync_missing_${suffix}`;
    const now = new Date().toISOString();
    cleanup.push(async () => {
      await opened.db.delete(syncRuns).where(eq(syncRuns.id, runId));
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
    });
    await opened.db.insert(organizations).values({
      id: organizationId,
      name: "Invalid sync run",
      slug: `invalid-sync-run-${suffix}`,
      createdAt: now,
      updatedAt: now,
    });
    await opened.db.insert(integrations).values({
      id: integrationId,
      organizationId,
      provider: "github",
      authType: "personal_access_token",
      status: "active",
      displayName: "Invalid GitHub",
      createdAt: now,
      updatedAt: now,
    });
    await opened.db.insert(syncRuns).values({
      id: runId,
      organizationId,
      integrationId,
      syncScopeId: "scope_that_does_not_exist",
      provider: "github",
      runType: "manual_resync",
      runKind: "resource",
      status: "queued",
      queuedAt: now,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    assert.equal(
      await processQueuedProviderSyncBatch(
        opened.db,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        { limit: 1 },
      ),
      1,
    );
    const [run] = await opened.db.select().from(syncRuns).where(eq(syncRuns.id, runId));

    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /missing its resource or sync scope/);
    assert.equal(run?.leaseExpiresAt, null);
  });
});
