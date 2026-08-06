import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { and, count, eq } from "drizzle-orm";

import type { ApiResponseDto } from "@teamtales/common/api";
import type { ReportContext } from "@teamtales/common/domain";

import { createApiServer } from "../../src/api/server.js";
import { createApiToken } from "../../src/auth/index.js";
import type { AppDatabase } from "../../src/db/index.js";
import {
  activityEvents,
  integrationCredentials,
  integrations,
  linearTeams,
  linearWorkspaces,
  organizationMemberships,
  people,
  providerResources,
  sourceObjects,
  syncScopes,
  users,
  workItems,
} from "../../src/db/schema.js";
import { saveCompleteAnalysisResult } from "../../src/persistence/index.js";
import { processQueuedProviderSyncBatch } from "../../src/services/sync-runs.js";
import { mysqlTestOptions, openTestDatabase } from "../helpers/mysql.js";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let browserCookie = "";

describe("TeamTales API", mysqlTestOptions, () => {
  let app: Awaited<ReturnType<typeof startApi>>;
  let generatedReportId = "";

  before(async () => {
    browserCookie = "";
    app = await startApi();
  });

  after(async () => {
    await app.close();
  });

  it("returns health status", async () => {
    const response = await apiFetch<{ status: string; service: string; database: string }>(
      app.url,
      "/api/health",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true,
      data: { status: "ok", service: "teamtales-api", database: "ok" },
    });
  });

  it("rejects protected routes before bootstrap", async () => {
    const response = await apiFetch<Record<string, unknown>>(app.url, "/api/organizations");
    assert.equal(response.status, 401);
  });

  it("rejects cross-origin initial bootstrap requests", async () => {
    const response = await fetch(`${app.url}/api/organizations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        id: "org_api",
        name: "API Org",
        owner: {
          id: "user_api_owner",
          displayName: "API Owner",
          primaryEmail: "owner@example.com",
          password: "correct horse battery staple",
        },
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "csrf_rejected",
    );
  });

  it("serializes concurrent initial bootstrap attempts and creates one owner", async () => {
    const body = {
      id: "org_api",
      name: "API Org",
      owner: {
        id: "user_api_owner",
        displayName: "API Owner",
        primaryEmail: "owner@example.com",
        password: "correct horse battery staple",
      },
    };
    const bootstrap = () =>
      fetch(`${app.url}/api/organizations`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: app.url },
        body: JSON.stringify(body),
      });
    const responses = await Promise.all([bootstrap(), bootstrap()]);
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: (await response.json()) as ApiResponseDto<Record<string, unknown>>,
        cookie: response.headers.get("set-cookie"),
      })),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 401]);
    const created = results.find((result) => result.status === 201);
    assert.ok(created);
    assert.equal(created.body.ok, true);
    browserCookie = created.cookie?.split(";", 1)[0] ?? "";
    assert.match(browserCookie, /^teamtales_session=/);

    const [userTotal] = await app.database.db.select({ total: count() }).from(users);
    const [membershipTotal] = await app.database.db
      .select({ total: count() })
      .from(organizationMemberships);
    assert.equal(Number(userTotal?.total), 1);
    assert.equal(Number(membershipTotal?.total), 1);

    const listed = await apiFetch<{ items: Array<{ id: string; name: string; slug: string }> }>(
      app.url,
      "/api/organizations",
    );

    assert.equal(
      listed.body.ok &&
        listed.body.data.items.some((organization) => organization.id === "org_api"),
      true,
    );
  });

  it("rejects cross-origin and originless login requests", async () => {
    for (const headers of [
      { "content-type": "application/json", origin: "https://attacker.example" },
      { "content-type": "application/json" },
    ]) {
      const response = await fetch(`${app.url}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "owner@example.com",
          password: "correct horse battery staple",
        }),
      });
      assert.equal(response.status, 403);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "csrf_rejected",
      );
    }
  });

  it("adds a PAT integration without returning plaintext", async () => {
    const token = "github_pat_secret_1234567890";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      String(input).startsWith(app.url)
        ? originalFetch(input, init)
        : jsonResponse({ id: 1, login: "octocat" });
    try {
      const response = await apiFetch<Record<string, unknown>>(app.url, "/api/integrations/pat", {
        method: "POST",
        body: {
          organizationId: "org_api",
          userId: "user_api_owner",
          provider: "github",
          displayName: "API GitHub",
          token,
        },
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.ok, true);
      assert.equal(JSON.stringify(response.body).includes(token), false);
      assert.equal(response.body.ok && response.body.data.secretHint, "gith...7890");

      const [row] = await app.database.db
        .select({ encryptedSecret: integrationCredentials.encryptedSecret })
        .from(integrationCredentials)
        .where(
          eq(
            integrationCredentials.integrationId,
            response.body.ok ? String(response.body.data.id) : "",
          ),
        );
      assert.equal(row?.encryptedSecret.includes(token), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates, discovers, and modifies GitHub relational scopes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(app.url)) return originalFetch(input, init);
      const path = new URL(url).pathname;
      if (path === "/user") return jsonResponse({ id: 1, login: "octocat", name: "Octocat" });
      if (path === "/user/orgs") return jsonResponse([{ id: 10, login: "acme", name: "Acme" }]);
      if (path === "/user/repos")
        return jsonResponse([
          {
            id: 101,
            full_name: "acme/widgets",
            owner: { id: 10, login: "acme", type: "Organization" },
            archived: false,
            fork: false,
          },
          {
            id: 102,
            full_name: "octocat/private-tools",
            owner: { id: 1, login: "octocat", type: "User" },
            archived: false,
            fork: false,
          },
        ]);
      return jsonResponse({ message: `Unexpected GitHub path ${path}` }, 404);
    };
    try {
      const created = await apiFetch<{ id: string }>(app.url, "/api/integrations/pat", {
        method: "POST",
        body: {
          organizationId: "org_api",
          provider: "github",
          displayName: "Scoped GitHub",
          token: "github_scoped_token",
        },
      });
      assert.equal(created.status, 201);
      const integrationId = created.body.ok ? created.body.data.id : "";
      const discovered = await apiFetch<{
        provider: string;
        discovery: { organizations: Array<{ id: string }>; repositories: Array<{ id: string }> };
      }>(app.url, `/api/integrations/${integrationId}/resources?organizationId=org_api`);
      assert.equal(discovered.status, 200);
      assert.deepEqual(
        discovered.body.ok && discovered.body.data.discovery.organizations.map((item) => item.id),
        ["10"],
      );
      const saved = await apiFetch(app.url, `/api/integrations/${integrationId}/sync-scopes`, {
        method: "PUT",
        body: {
          organizationId: "org_api",
          selection: {
            organizations: [{ organizationId: "10", mode: "selected", repositoryIds: ["101"] }],
            repositoryIds: ["102"],
          },
        },
      });
      assert.equal(saved.status, 200);
      let rows = await app.database.db
        .select()
        .from(syncScopes)
        .where(eq(syncScopes.integrationId, integrationId));
      const organization = rows.find((row) => row.scopeType === "github.organization");
      const child = rows.find((row) => row.externalId === "101");
      const standalone = rows.find((row) => row.externalId === "102");
      assert.equal(organization?.selectionMode, "selected");
      assert.equal(child?.parentScopeId, organization?.id);
      assert.equal(standalone?.parentScopeId, null);
      assert.equal(standalone?.selectionMode, "individual");
      assert.equal(
        rows.every((row) => row.configJson === "{}"),
        true,
      );
      const resources = await app.database.db
        .select()
        .from(providerResources)
        .where(eq(providerResources.integrationId, integrationId));
      const organizationResource = resources.find(
        (resource) => resource.resourceType === "github.organization",
      );
      const repositoryResource = resources.find((resource) => resource.externalId === "101");
      assert.equal(resources.length, 3);
      assert.equal(organization?.providerResourceId, organizationResource?.id);
      assert.equal(child?.providerResourceId, repositoryResource?.id);
      assert.equal(repositoryResource?.parentResourceId, organizationResource?.id);
      const modified = await apiFetch(app.url, `/api/integrations/${integrationId}/sync-scopes`, {
        method: "PUT",
        body: {
          organizationId: "org_api",
          selection: { organizations: [{ organizationId: "10", mode: "all" }], repositoryIds: [] },
        },
      });
      assert.equal(modified.status, 200);
      rows = await app.database.db
        .select()
        .from(syncScopes)
        .where(eq(syncScopes.integrationId, integrationId));
      assert.equal(
        rows.find((row) => row.scopeType === "github.organization")?.selectionMode,
        "all",
      );
      assert.equal(rows.find((row) => row.externalId === "101")?.enabled, 0);
      assert.equal(rows.find((row) => row.externalId === "102")?.enabled, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates and modifies Linear workspace team scopes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(app.url)) return originalFetch(input, init);
      const request = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      if (request.query?.includes("LinearWorkspaceAndViewer"))
        return jsonResponse({
          data: {
            viewer: { id: "viewer" },
            organization: { id: "workspace_1", name: "Linear Workspace" },
          },
        });
      if (request.query?.includes("LinearTeams"))
        return jsonResponse({
          data: {
            teams: {
              nodes: [
                { id: "team_1", name: "Engineering", key: "ENG" },
                { id: "team_2", name: "Design", key: "DES" },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      return jsonResponse({ errors: [{ message: "Unexpected Linear query" }] }, 400);
    };
    try {
      const created = await apiFetch<{ id: string }>(app.url, "/api/integrations/pat", {
        method: "POST",
        body: {
          organizationId: "org_api",
          provider: "linear",
          displayName: "Scoped Linear",
          token: "linear_scoped_token",
        },
      });
      assert.equal(created.status, 201);
      const integrationId = created.body.ok ? created.body.data.id : "";
      const saved = await apiFetch(app.url, `/api/integrations/${integrationId}/sync-scopes`, {
        method: "PUT",
        body: { organizationId: "org_api", selection: { mode: "selected", teamIds: ["team_1"] } },
      });
      assert.equal(saved.status, 200);
      let rows = await app.database.db
        .select()
        .from(syncScopes)
        .where(eq(syncScopes.integrationId, integrationId));
      const workspace = rows.find((row) => row.scopeType === "linear.workspace");
      assert.equal(workspace?.selectionMode, "selected");
      assert.equal(rows.find((row) => row.externalId === "team_1")?.parentScopeId, workspace?.id);
      const [workspaces, teams, genericResources] = await Promise.all([
        app.database.db
          .select()
          .from(linearWorkspaces)
          .where(eq(linearWorkspaces.integrationId, integrationId)),
        app.database.db
          .select()
          .from(linearTeams)
          .where(eq(linearTeams.integrationId, integrationId)),
        app.database.db
          .select()
          .from(providerResources)
          .where(eq(providerResources.integrationId, integrationId)),
      ]);
      const workspaceResource = workspaces.find(
        (resource) => resource.externalId === "workspace_1",
      );
      const teamResource = teams.find((resource) => resource.externalId === "team_1");
      assert.equal(workspaces.length, 1);
      assert.equal(teams.length, 2);
      assert.equal(genericResources.length, 0);
      assert.equal(workspace?.linearWorkspaceId, workspaceResource?.id);
      assert.equal(teamResource?.linearWorkspaceId, workspaceResource?.id);
      const modified = await apiFetch(app.url, `/api/integrations/${integrationId}/sync-scopes`, {
        method: "PUT",
        body: { organizationId: "org_api", selection: { mode: "all" } },
      });
      assert.equal(modified.status, 200);
      rows = await app.database.db
        .select()
        .from(syncScopes)
        .where(eq(syncScopes.integrationId, integrationId));
      assert.equal(rows.find((row) => row.scopeType === "linear.workspace")?.selectionMode, "all");
      assert.equal(rows.find((row) => row.externalId === "team_1")?.enabled, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds and lists a sync scope", async () => {
    const integrationsForOrg = await app.database.db
      .select({ id: integrations.id, displayName: integrations.displayName })
      .from(integrations)
      .where(and(eq(integrations.organizationId, "org_api"), eq(integrations.provider, "github")));
    const integration = integrationsForOrg.find((value) => value.displayName === "Scoped GitHub");
    const created = await apiFetch<Record<string, unknown>>(app.url, "/api/sync-scopes", {
      method: "POST",
      body: {
        organizationId: "org_api",
        userId: "user_api_owner",
        integrationId: integration!.id,
        provider: "github",
        scopeType: "github.repository",
        externalName: "acme/widgets",
        config: { defaultBranch: "main" },
      },
    });
    const listed = await apiFetch<{ items: Array<{ externalName: string }> }>(
      app.url,
      "/api/organizations/org_api/sync-scopes",
    );

    assert.equal(created.status, 201);
    assert.equal(created.body.ok && created.body.data.externalName, "acme/widgets");
    assert.equal(
      listed.body.ok &&
        listed.body.data.items.some((scope) => scope.externalName === "acme/widgets"),
      true,
    );
  });

  it("generates and persists a weekly report", async () => {
    await seedAnalysisContext(app.database.db);

    const generated = await apiFetch<{
      report: { id: string; bodyMarkdown: string };
      inputs: unknown[];
    }>(app.url, "/api/reports/weekly", {
      method: "POST",
      body: {
        organizationId: "org_api",
        periodStart: "2026-06-22",
        periodEnd: "2026-06-29",
        title: "Weekly API Report",
        persist: true,
      },
    });
    const reports = await apiFetch<{ items: Array<{ id: string; title: string }> }>(
      app.url,
      "/api/organizations/org_api/reports",
    );

    assert.equal(generated.status, 201);
    assert.match(
      generated.body.ok ? generated.body.data.report.bodyMarkdown : "",
      /^# Weekly API Report/,
    );
    generatedReportId = generated.body.ok ? generated.body.data.report.id : "";
    assert.equal(
      reports.body.ok &&
        reports.body.data.items.some((report) => report.title === "Weekly API Report"),
      true,
    );
    assert.equal(reports.body.ok && "bodyMarkdown" in reports.body.data.items[0]!, false);
  });

  it("gets a persisted report detail", async () => {
    const report = await apiFetch<{ id: string; bodyMarkdown: string }>(
      app.url,
      `/api/reports/${generatedReportId}?organizationId=org_api`,
    );

    assert.equal(report.status, 200);
    assert.equal(report.body.ok && report.body.data.id, generatedReportId);
    assert.match(report.body.ok ? report.body.data.bodyMarkdown : "", /^# Weekly API Report/);
  });

  it("builds a weekly report from database activity when no context exists", async () => {
    await apiFetch<Record<string, unknown>>(app.url, "/api/organizations", {
      method: "POST",
      body: {
        id: "org_from_db",
        name: "DB Org",
        owner: { id: "user_db_owner", displayName: "DB Owner", primaryEmail: "db@example.com" },
      },
    });
    await seedActivity(app.database.db);

    const generated = await apiFetch<{ report: { bodyMarkdown: string } }>(
      app.url,
      "/api/reports/weekly",
      {
        method: "POST",
        body: {
          organizationId: "org_from_db",
          organizationName: "DB Org",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          title: "Weekly DB Report",
          persist: true,
        },
      },
    );

    assert.equal(generated.status, 201);
    assert.match(
      generated.body.ok ? generated.body.data.report.bodyMarkdown : "",
      /activity.events: 1/,
    );
  });

  it("returns a dashboard envelope", async () => {
    const dashboard = await apiFetch<{
      organizations: unknown[];
      selectedOrganizationId: string;
      organization: { id: string };
      integrations: unknown[];
      syncScopes: unknown[];
      reports: unknown[];
      latestReport?: { id: string; bodyMarkdown: string };
      metrics: unknown[];
      highlights: unknown[];
      workItems: unknown[];
      people: unknown[];
    }>(app.url, "/api/dashboard?organizationId=org_api");

    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.organizations), true);
    assert.equal(dashboard.body.ok && dashboard.body.data.selectedOrganizationId, "org_api");
    assert.equal(dashboard.body.ok && dashboard.body.data.organization.id, "org_api");
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.integrations), true);
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.syncScopes), true);
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.reports), true);
    assert.equal(dashboard.body.ok && dashboard.body.data.latestReport?.id, generatedReportId);
    assert.equal(dashboard.body.ok && dashboard.body.data.metrics.length, 1);
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.highlights), true);
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.workItems), true);
    assert.equal(dashboard.body.ok && Array.isArray(dashboard.body.data.people), true);
  });

  it("returns an error envelope", async () => {
    const response = await apiFetch<Record<string, never>>(app.url, "/api/reports/report_missing");

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Missing required query parameter: organizationId.",
      },
    });
  });

  it("runs provider sync and persists fetched source objects", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(app.url)) {
        return originalFetch(input, init);
      }
      const headers = init?.headers;
      const authorization =
        headers instanceof Headers
          ? headers.get("authorization")
          : headers && !Array.isArray(headers)
            ? ((headers as Record<string, string>).authorization ??
              (headers as Record<string, string>).Authorization)
            : undefined;
      assert.equal(authorization, "Bearer github_scoped_token");
      const parsed = new URL(url);
      if (parsed.pathname === "/orgs/acme/repos") {
        return jsonResponse([
          {
            id: 101,
            full_name: "acme/widgets",
            owner: { id: 10, login: "acme", type: "Organization" },
            archived: false,
            fork: false,
          },
        ]);
      }
      if (parsed.pathname === "/repos/acme/widgets") {
        return jsonResponse({
          id: 101,
          name: "widgets",
          full_name: "acme/widgets",
          html_url: "https://github.com/acme/widgets",
        });
      }
      if (parsed.pathname === "/repos/acme/widgets/pulls") {
        return jsonResponse([]);
      }
      return jsonResponse({ message: `Unexpected path ${parsed.pathname}` }, 404);
    };

    try {
      const [organizationScope] = await app.database.db
        .select()
        .from(syncScopes)
        .where(and(eq(syncScopes.scopeType, "github.organization"), eq(syncScopes.enabled, 1)))
        .limit(1);
      assert.ok(organizationScope);
      const response = await apiFetch<{
        status: string;
        counters: { objectsFetched: number };
        syncRunId: string;
      }>(app.url, "/api/sync/github", {
        method: "POST",
        body: { organizationId: "org_api", syncScopeId: organizationScope.id },
      });

      assert.equal(response.status, 202);
      assert.equal(response.body.ok && response.body.data.status, "queued");
      const syncRunId = response.body.ok ? response.body.data.syncRunId : undefined;
      assert.ok(syncRunId);
      const duplicate = await apiFetch<{ syncRunId?: string; status: string }>(
        app.url,
        "/api/sync/github",
        { method: "POST", body: { organizationId: "org_api", syncScopeId: organizationScope.id } },
      );
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body.ok && duplicate.body.data.syncRunId, syncRunId);
      const cancelled = await apiFetch<{ status: string; cancelledResourceRuns: number }>(
        app.url,
        `/api/sync-runs/${syncRunId}/cancel`,
        { method: "POST" },
      );
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.ok && cancelled.body.data.status, "cancelled");
      const cancelledStatus = await apiFetch<{ run: { status: string } }>(
        app.url,
        `/api/sync-runs/${syncRunId}`,
      );
      assert.equal(cancelledStatus.body.ok && cancelledStatus.body.data.run.status, "cancelled");
      const retried = await apiFetch<{ syncRunId?: string; status: string }>(
        app.url,
        "/api/sync/github",
        { method: "POST", body: { organizationId: "org_api", syncScopeId: organizationScope.id } },
      );
      assert.equal(retried.status, 202);
      const retriedSyncRunId = retried.body.ok ? retried.body.data.syncRunId : undefined;
      assert.ok(retriedSyncRunId);
      assert.notEqual(retriedSyncRunId, syncRunId);
      const queued = await apiFetch<{
        run: { status: string };
        childRunCounts: Record<string, number>;
      }>(app.url, `/api/sync-runs/${retriedSyncRunId}`);
      assert.equal(queued.status, 200);
      assert.equal(queued.body.ok && queued.body.data.run.status, "queued");
      await processQueuedProviderSyncBatch(app.database.db, key, { limit: 10 });
      await processQueuedProviderSyncBatch(app.database.db, key, { limit: 10 });
      const completed = await apiFetch<{ run: { status: string } }>(
        app.url,
        `/api/sync-runs/${retriedSyncRunId}`,
      );
      assert.equal(completed.body.ok && completed.body.data.run.status, "completed");
      assert.equal(
        (
          await app.database.db
            .select({ count: count() })
            .from(sourceObjects)
            .where(
              and(
                eq(sourceObjects.organizationId, "org_api"),
                eq(sourceObjects.objectType, "github.repository"),
              ),
            )
        )[0]?.count,
        1,
      );
      const [sourceObject] = await app.database.db
        .select()
        .from(sourceObjects)
        .where(eq(sourceObjects.organizationId, "org_api"))
        .limit(1);
      assert.ok(sourceObject);
      const items = await apiFetch<{ items: Array<{ id: string; objectType: string }> }>(
        app.url,
        "/api/organizations/org_api/source-objects?type=github.repository&search=widgets",
      );
      assert.equal(items.status, 200);
      assert.equal(
        items.body.ok && items.body.data.items.some((item) => item.id === sourceObject.id),
        true,
      );
      assert.equal(
        items.body.ok &&
          items.body.data.items.every((item) => item.objectType === "github.repository"),
        true,
      );
      const detail = await apiFetch<{ id: string; raw: { full_name: string } }>(
        app.url,
        `/api/source-objects/${sourceObject.id}?organizationId=org_api`,
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.ok && detail.body.data.raw.full_name, "acme/widgets");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects unsafe cookie requests without a same-origin Origin header", async () => {
    const response = await fetch(`${app.url}/api/auth/tokens`, {
      method: "POST",
      headers: { cookie: browserCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "blocked" }),
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "csrf_rejected",
    );
  });

  it("creates an API token and accepts it without CSRF headers", async () => {
    const created = await apiFetch<{ token: string; apiToken: { id: string; name: string } }>(
      app.url,
      "/api/auth/tokens",
      { method: "POST", body: { name: "automation" } },
    );
    assert.equal(created.status, 201);
    const token = created.body.ok ? created.body.data.token : "";
    const cookie = browserCookie;
    browserCookie = "";
    const organizations = await apiFetch<{ items: unknown[] }>(app.url, "/api/organizations", {
      headers: { authorization: `Bearer ${token}` },
    });
    browserCookie = cookie;
    assert.equal(organizations.status, 200);
    assert.equal(organizations.body.ok, true);
  });

  it("enforces active membership and mutation roles for API-token users", async () => {
    const now = new Date().toISOString();
    await app.database.db.insert(users).values({
      id: "user_viewer",
      displayName: "API Viewer",
      primaryEmail: "viewer@example.com",
      createdAt: now,
      updatedAt: now,
    });
    const token = (await createApiToken(app.database.db, "user_viewer", { name: "viewer test" }))
      .token;

    const forbiddenWithoutMembership = await apiFetch(
      app.url,
      "/api/organizations/org_api/reports",
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    assert.equal(forbiddenWithoutMembership.status, 403);

    await app.database.db.insert(organizationMemberships).values({
      id: "membership_viewer",
      organizationId: "org_api",
      userId: "user_viewer",
      role: "viewer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const forbiddenMutation = await apiFetch(app.url, "/api/integrations/pat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: {
        organizationId: "org_api",
        userId: "user_api_owner",
        provider: "github",
        token: "attempted_spoof",
      },
    });
    assert.equal(forbiddenMutation.status, 403);
  });

  it("logs out and logs back in with the password", async () => {
    const loggedOut = await apiFetch<{ loggedOut: boolean }>(app.url, "/api/auth/logout", {
      method: "POST",
    });
    assert.equal(loggedOut.status, 200);
    assert.equal((await apiFetch(app.url, "/api/organizations")).status, 401);

    const loggedIn = await apiFetch<{ authenticated: boolean }>(app.url, "/api/auth/login", {
      method: "POST",
      body: { email: "owner@example.com", password: "correct horse battery staple" },
    });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.ok && loggedIn.body.data.authenticated, true);
    assert.match(browserCookie, /^teamtales_session=/);
  });
});

async function startApi() {
  const database = await openTestDatabase();
  const server = createApiServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      credentialEncryptionKey: key,
    },
    database: database.db,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    database,
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await database.close();
    },
  };
}

async function seedActivity(database: AppDatabase): Promise<void> {
  await database
    .insert(people)
    .values({ id: "person_db", organizationId: "org_from_db", displayName: "Database Person" });
  await database.insert(workItems).values({
    id: "work_db",
    organizationId: "org_from_db",
    provider: "github",
    sourceType: "pull_request",
    externalId: "42",
    title: "Database-backed work",
    status: "merged",
    workType: "github_pull_request",
    updatedAtSource: "2026-06-28T12:00:00.000Z",
  });
  await database.insert(activityEvents).values({
    id: "event_db",
    organizationId: "org_from_db",
    provider: "github",
    eventType: "pull_request.merged",
    actorPersonId: "person_db",
    workItemId: "work_db",
    occurredAt: "2026-06-28T12:00:00.000Z",
    title: "Merged database-backed work",
    metadataJson: "{}",
  });
}

async function apiFetch<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: ApiResponseDto<T> }> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (browserCookie) headers.cookie = browserCookie;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.origin = baseUrl;
  Object.assign(headers, options.headers);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) browserCookie = setCookie.split(";", 1)[0] ?? "";

  return {
    status: response.status,
    body: (await response.json()) as ApiResponseDto<T>,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function seedAnalysisContext(database: AppDatabase): Promise<void> {
  const context: ReportContext = {
    organization: { id: "org_api", name: "API Org" },
    scope: { type: "organization", id: "org_api", name: "API Org" },
    period: { start: "2026-06-22", end: "2026-06-29" },
    freshness: { warnings: [] },
    metrics: [{ name: "activity.events", value: 4 }],
    highlights: [],
    people: [],
    workItems: [],
    risks: [],
  };

  await saveCompleteAnalysisResult(database, {
    run: {
      id: "analysis_run_api",
      organizationId: "org_api",
      scopeType: "organization",
      scopeId: "org_api",
      periodStart: "2026-06-22",
      periodEnd: "2026-06-29",
      status: "completed",
      startedAt: "2026-06-29T09:00:00.000Z",
      finishedAt: "2026-06-29T09:01:00.000Z",
    },
    metrics: [{ id: "metric_api", name: "activity.events", value: 4 }],
    highlights: [],
    reportContext: {
      id: "report_context_api",
      context,
    },
  });
}
