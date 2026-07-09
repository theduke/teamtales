import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { ReportContext } from "../../src/analysis/types.js";
import { runCli } from "../../src/cli/index.js";
import { authenticatePassword } from "../../src/auth/index.js";
import { decryptCredentialSecret } from "../../src/security/index.js";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type CapturedIo = {
  stdout: string[];
  stderr: string[];
  io: {
    stdout(message: string): void;
    stderr(message: string): void;
  };
};

describe("teamtales CLI", () => {
  it("initializes a local database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");

    try {
      const result = await runCli(["init-db", "--db", db], capture().io);

      assert.equal(result.exitCode, 0);
      assert.equal(existsSync(db), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists organization metadata and an owner membership", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");
    const io = capture();
    const expectedOwnerUserId = stableTestId("user", "owner@example.com");
    const expectedOwnerMembershipId = stableTestId("membership", "org_acme", expectedOwnerUserId);

    try {
      const result = await runCli(
        ["org", "create", "--db", db, "--id", "org_acme", "--name", "Acme", "--owner-email", "owner@example.com"],
        io.io,
      );

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(io.stdout[0] ?? "{}"), {
        id: "org_acme",
        name: "Acme",
        slug: "acme",
        ownerUserId: expectedOwnerUserId,
        ownerMembershipId: expectedOwnerMembershipId,
      });

      const sqlite = new DatabaseSync(db);
      try {
        assert.equal((sqlite.prepare("SELECT count(*) AS count FROM organizations").get() as { count: number }).count, 1);
        assert.equal((sqlite.prepare("SELECT role FROM organization_memberships WHERE organization_id = ?").get("org_acme") as { role: string }).role, "owner");
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sets a login password for an existing user without exposing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");
    const io = capture();
    try {
      await createTestOrganization(db);
      const result = await runCli(
        ["auth", "set-password", "--db", db, "--user-id", "user_owner", "--password-env", "TEST_PASSWORD"],
        io.io,
        { TEST_PASSWORD: "correct horse battery staple" },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(io.stdout.join("\n").includes("correct horse battery staple"), false);

      const sqlite = new DatabaseSync(db);
      try {
        assert.equal(authenticatePassword(sqlite, "owner@example.com", "correct horse battery staple")?.userId, "user_owner");
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds a PAT integration with an encrypted credential and no plaintext storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");

    try {
      await createTestOrganization(db);
      const io = capture();
      const result = await runCli(
        [
          "integration",
          "add-pat",
          "--db",
          db,
          "--organization-id",
          "org_acme",
          "--user-id",
          "user_owner",
          "--provider",
          "github",
          "--name",
          "Acme GitHub",
          "--token-env",
          "TEST_PAT",
        ],
        io.io,
        { TEAMTALES_CREDENTIAL_KEY: key, TEST_PAT: "github_pat_secret_1234567890" },
      );

      assert.equal(result.exitCode, 0);
      const output = JSON.parse(io.stdout[0] ?? "{}") as { id: string; secretHint: string };
      assert.equal(output.secretHint, "gith...7890");

      const sqlite = new DatabaseSync(db);
      try {
        const row = sqlite
          .prepare("SELECT encrypted_secret, secret_hint FROM integration_credentials WHERE integration_id = ?")
          .get(output.id) as { encrypted_secret: string; secret_hint: string };

        assert.notEqual(row.encrypted_secret.includes("github_pat_secret_1234567890"), true);
        assert.equal(decryptCredentialSecret({ encryptedSecret: row.encrypted_secret, secretHint: row.secret_hint }, key), "github_pat_secret_1234567890");
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds a sync scope for an existing integration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");

    try {
      await createTestOrganization(db);
      const integration = capture();
      await runCli(
        [
          "integration",
          "add-pat",
          "--db",
          db,
          "--organization-id",
          "org_acme",
          "--user-id",
          "user_owner",
          "--provider",
          "linear",
          "--token",
          "lin_api_secret_1234567890",
        ],
        integration.io,
        { TEAMTALES_CREDENTIAL_KEY: key },
      );
      const integrationId = JSON.parse(integration.stdout[0] ?? "{}").id as string;

      const io = capture();
      const result = await runCli(
        [
          "scope",
          "add",
          "--db",
          db,
          "--organization-id",
          "org_acme",
          "--user-id",
          "user_owner",
          "--integration-id",
          integrationId,
          "--provider",
          "linear",
          "--type",
          "linear.team",
          "--name",
          "Engineering",
          "--config-json",
          "{\"teamKey\":\"ENG\"}",
        ],
        io.io,
      );

      assert.equal(result.exitCode, 0);
      assert.equal(JSON.parse(io.stdout[0] ?? "{}").externalName, "Engineering");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("generates deterministic weekly markdown from fixture JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");
    const fixture = join(directory, "context.json");
    const output = join(directory, "weekly.md");
    const context: ReportContext = {
      organization: { id: "org_acme", name: "Acme" },
      scope: { type: "github_repository", id: "repo_widgets", name: "acme/widgets" },
      period: { start: "2026-06-22", end: "2026-06-29" },
      freshness: { warnings: [] },
      metrics: [{ name: "activity.events", value: 1 }],
      highlights: [],
      people: [],
      workItems: [],
      risks: [],
    };

    try {
      writeFileSync(fixture, JSON.stringify(context), "utf8");

      const result = await runCli(["report", "weekly", "--db", db, "--fixture", fixture, "--output", output], capture().io);

      assert.equal(result.exitCode, 0);
      assert.match(readFileSync(output, "utf8"), /^# Weekly report: acme\/widgets/);
      assert.equal(readFileSync(output, "utf8"), readFileSync(output, "utf8"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("generates a weekly report from an existing database report context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");
    const context: ReportContext = {
      organization: { id: "org_acme", name: "Acme" },
      scope: { type: "organization", id: "org_acme", name: "Acme" },
      period: { start: "2026-06-22", end: "2026-06-29" },
      freshness: { warnings: [] },
      metrics: [{ name: "activity.events", value: 3 }],
      highlights: [],
      people: [],
      workItems: [],
      risks: [],
    };

    try {
      await runCli(["init-db", "--db", db], capture().io);
      const sqlite = new DatabaseSync(db);
      try {
        seedOrganization(sqlite, "org_acme", "Acme", "acme");
        sqlite
          .prepare(
            `INSERT INTO analysis_runs (
              id, organization_id, scope_type, scope_id, period_start, period_end, status, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("analysis_run_1", "org_acme", "organization", "org_acme", "2026-06-22", "2026-06-29", "completed", "2026-06-29T09:00:00.000Z");
        sqlite
          .prepare(
            `INSERT INTO analysis_report_contexts (
              id, organization_id, analysis_run_id, scope_type, scope_id, period_start, period_end, context_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "report_context_1",
            "org_acme",
            "analysis_run_1",
            "organization",
            "org_acme",
            "2026-06-22",
            "2026-06-29",
            JSON.stringify(context),
          );
      } finally {
        sqlite.close();
      }

      const io = capture();
      const result = await runCli(
        [
          "report",
          "weekly",
          "--db",
          db,
          "--organization-id",
          "org_acme",
          "--period-start",
          "2026-06-22",
          "--period-end",
          "2026-06-29",
        ],
        io.io,
      );

      assert.equal(result.exitCode, 0);
      assert.match(JSON.parse(io.stdout[0] ?? "{}").markdown, /- activity.events: 3/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs provider sync commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");
    const originalFetch = globalThis.fetch;

    try {
      await createTestOrganization(db);
      const integration = capture();
      await runCli(
        [
          "integration",
          "add-pat",
          "--db",
          db,
          "--organization-id",
          "org_acme",
          "--user-id",
          "user_owner",
          "--provider",
          "github",
          "--name",
          "Acme GitHub",
          "--token",
          "github_pat_secret_1234567890",
        ],
        integration.io,
        { TEAMTALES_CREDENTIAL_KEY: key },
      );
      const integrationId = JSON.parse(integration.stdout[0] ?? "{}").id as string;
      await runCli(
        [
          "scope",
          "add",
          "--db",
          db,
          "--organization-id",
          "org_acme",
          "--user-id",
          "user_owner",
          "--integration-id",
          integrationId,
          "--provider",
          "github",
          "--type",
          "github.repository",
          "--name",
          "acme/widgets",
        ],
        capture().io,
      );

      globalThis.fetch = async (input, init) => {
        const headers = init?.headers;
        const authorization =
          headers instanceof Headers
            ? headers.get("authorization")
            : headers && !Array.isArray(headers)
              ? ((headers as Record<string, string>).authorization ?? (headers as Record<string, string>).Authorization)
              : undefined;
        assert.equal(authorization, "Bearer github_pat_secret_1234567890");
        const parsed = new URL(String(input));
        if (parsed.pathname === "/repos/acme/widgets") {
          return jsonResponse({ id: 101, name: "widgets", full_name: "acme/widgets" });
        }
        if (parsed.pathname === "/repos/acme/widgets/pulls") {
          return jsonResponse([]);
        }
        return jsonResponse({ message: `Unexpected path ${parsed.pathname}` }, 404);
      };

      const io = capture();
      const result = await runCli(
        ["sync", "github", "--db", db, "--organization-id", "org_acme"],
        io.io,
        { TEAMTALES_CREDENTIAL_KEY: key },
      );

      assert.equal(result.exitCode, 0);
      const output = JSON.parse(io.stdout[0] ?? "{}") as { status: string; counters: { objectsFetched: number } };
      assert.equal(output.status, "completed");
      assert.equal(output.counters.objectsFetched, 1);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a sync scope attached to another organization's integration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-"));
    const db = join(directory, "teamtales.sqlite");

    try {
      await createTestOrganization(db, { id: "org_a", name: "A", ownerId: "user_a", ownerEmail: "a@example.com" });
      await createTestOrganization(db, { id: "org_b", name: "B", ownerId: "user_b", ownerEmail: "b@example.com" });
      const integration = capture();
      await runCli(
        [
          "integration",
          "add-pat",
          "--db",
          db,
          "--organization-id",
          "org_a",
          "--user-id",
          "user_a",
          "--provider",
          "github",
          "--token",
          "github_pat_secret_1234567890",
        ],
        integration.io,
        { TEAMTALES_CREDENTIAL_KEY: key },
      );
      const integrationId = JSON.parse(integration.stdout[0] ?? "{}").id as string;

      const io = capture();
      const result = await runCli(
        [
          "scope",
          "add",
          "--db",
          db,
          "--organization-id",
          "org_b",
          "--user-id",
          "user_b",
          "--integration-id",
          integrationId,
          "--provider",
          "github",
          "--type",
          "github.repository",
          "--name",
          "acme/widgets",
        ],
        io.io,
      );

      assert.equal(result.exitCode, 1);
      assert.match(io.stderr[0] ?? "", /Integration not found in organization org_b/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function createTestOrganization(
  db: string,
  options: { id?: string; name?: string; ownerId?: string; ownerEmail?: string } = {},
): Promise<string> {
  const id = options.id ?? "org_acme";
  const ownerId = options.ownerId ?? "user_owner";
  await runCli(
    [
      "org",
      "create",
      "--db",
      db,
      "--id",
      id,
      "--name",
      options.name ?? "Acme",
      "--owner-id",
      ownerId,
      "--owner-email",
      options.ownerEmail ?? "owner@example.com",
    ],
    capture().io,
  );
  return ownerId;
}

function seedOrganization(sqlite: DatabaseSync, id: string, name: string, slug: string): void {
  sqlite.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)").run(id, name, slug);
}

function stableTestId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

function capture(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(message: string): void {
        stdout.push(message);
      },
      stderr(message: string): void {
        stderr.push(message);
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
