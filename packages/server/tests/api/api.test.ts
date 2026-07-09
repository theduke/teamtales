import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { ApiResponseDto } from "@teamtales/common/api";
import type { ReportContext } from "@teamtales/common/domain";

import { createApiServer } from "../../src/api/server.js";
import { openLocalDatabase } from "../../src/db/index.js";
import { saveCompleteAnalysisResult } from "../../src/persistence/index.js";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("TeamTales API", () => {
  let app: Awaited<ReturnType<typeof startApi>>;
  let generatedReportId = "";

  before(async () => {
    app = await startApi();
  });

  after(async () => {
    await app.close();
  });

  it("returns health status", async () => {
    const response = await apiFetch<{ status: string; service: string; database: string }>(app.url, "/api/health");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, data: { status: "ok", service: "teamtales-api", database: "ok" } });
  });

  it("creates and lists organizations", async () => {
    const created = await apiFetch<Record<string, unknown>>(app.url, "/api/organizations", {
      method: "POST",
      body: {
        id: "org_api",
        name: "API Org",
        owner: { id: "user_api_owner", displayName: "API Owner", primaryEmail: "owner@example.com" },
      },
    });
    const listed = await apiFetch<{ items: Array<{ id: string; name: string; slug: string }> }>(app.url, "/api/organizations");

    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.ok && created.body.data.id, "org_api");
    assert.equal(listed.body.ok && listed.body.data.items.some((organization) => organization.id === "org_api"), true);
  });

  it("adds a PAT integration without returning plaintext", async () => {
    const token = "github_pat_secret_1234567890";
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

    const row = app.database.sqlite
      .prepare("SELECT encrypted_secret FROM integration_credentials WHERE integration_id = ?")
      .get(response.body.ok ? response.body.data.id : "") as { encrypted_secret: string };
    assert.equal(row.encrypted_secret.includes(token), false);
  });

  it("adds and lists a sync scope", async () => {
    const integration = app.database.sqlite
      .prepare("SELECT id FROM integrations WHERE organization_id = ? AND provider = ?")
      .get("org_api", "github") as { id: string };
    const created = await apiFetch<Record<string, unknown>>(app.url, "/api/sync-scopes", {
      method: "POST",
      body: {
        organizationId: "org_api",
        userId: "user_api_owner",
        integrationId: integration.id,
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
    assert.equal(listed.body.ok && listed.body.data.items.some((scope) => scope.externalName === "acme/widgets"), true);
  });

  it("generates and persists a weekly report", async () => {
    seedAnalysisContext(app.database.sqlite);

    const generated = await apiFetch<{ report: { id: string; bodyMarkdown: string }; inputs: unknown[] }>(
      app.url,
      "/api/reports/weekly",
      {
        method: "POST",
        body: {
          organizationId: "org_api",
          periodStart: "2026-06-22",
          periodEnd: "2026-06-29",
          title: "Weekly API Report",
          persist: true,
        },
      },
    );
    const reports = await apiFetch<{ items: Array<{ id: string; title: string }> }>(
      app.url,
      "/api/organizations/org_api/reports",
    );

    assert.equal(generated.status, 201);
    assert.match(generated.body.ok ? generated.body.data.report.bodyMarkdown : "", /^# Weekly API Report/);
    generatedReportId = generated.body.ok ? generated.body.data.report.id : "";
    assert.equal(reports.body.ok && reports.body.data.items.some((report) => report.title === "Weekly API Report"), true);
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
    seedActivity(app.database.sqlite);

    const generated = await apiFetch<{ report: { bodyMarkdown: string } }>(app.url, "/api/reports/weekly", {
      method: "POST",
      body: {
        organizationId: "org_from_db",
        organizationName: "DB Org",
        periodStart: "2026-06-22",
        periodEnd: "2026-06-29",
        title: "Weekly DB Report",
        persist: true,
      },
    });

    assert.equal(generated.status, 201);
    assert.match(generated.body.ok ? generated.body.data.report.bodyMarkdown : "", /activity.events: 1/);
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
            ? ((headers as Record<string, string>).authorization ?? (headers as Record<string, string>).Authorization)
            : undefined;
      assert.equal(authorization, "Bearer github_pat_secret_1234567890");
      const parsed = new URL(url);
      if (parsed.pathname === "/repos/acme/widgets") {
        return jsonResponse({ id: 101, name: "widgets", full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" });
      }
      if (parsed.pathname === "/repos/acme/widgets/pulls") {
        return jsonResponse([]);
      }
      return jsonResponse({ message: `Unexpected path ${parsed.pathname}` }, 404);
    };

    try {
      const response = await apiFetch<{ status: string; counters: { objectsFetched: number }; syncRunId: string }>(
        app.url,
        "/api/sync/github",
        { method: "POST", body: { organizationId: "org_api" } },
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.ok && response.body.data.status, "completed");
      assert.equal(response.body.ok && response.body.data.counters.objectsFetched, 1);
      assert.equal(
        (
          app.database.sqlite
            .prepare("SELECT count(*) AS count FROM source_objects WHERE organization_id = ? AND object_type = ?")
            .get("org_api", "github.repository") as { count: number }
        ).count,
        1,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function startApi() {
  const database = openLocalDatabase({ runMigrations: true });
  const server = createApiServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      databaseFilename: ":memory:",
      credentialEncryptionKey: key,
    },
    database: database.sqlite,
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
      database.close();
    },
  };
}

function seedActivity(database: import("node:sqlite").DatabaseSync): void {
  database
    .prepare("INSERT INTO people (id, organization_id, display_name) VALUES (?, ?, ?)")
    .run("person_db", "org_from_db", "Database Person");
  database
    .prepare(
      `INSERT INTO work_items (
        id, organization_id, provider, source_type, external_id, title, status, work_type, updated_at_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "work_db",
      "org_from_db",
      "github",
      "pull_request",
      "42",
      "Database-backed work",
      "merged",
      "github_pull_request",
      "2026-06-28T12:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO activity_events (
        id, organization_id, provider, event_type, actor_person_id, work_item_id, occurred_at, title, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "event_db",
      "org_from_db",
      "github",
      "pull_request.merged",
      "person_db",
      "work_db",
      "2026-06-28T12:00:00.000Z",
      "Merged database-backed work",
      "{}",
    );
}

async function apiFetch<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: ApiResponseDto<T> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

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

function seedAnalysisContext(database: import("node:sqlite").DatabaseSync): void {
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

  saveCompleteAnalysisResult(database, {
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
