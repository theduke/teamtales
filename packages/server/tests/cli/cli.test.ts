import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { runCli } from "../../src/cli/index.js";
import { authenticatePassword } from "../../src/auth/index.js";
import { integrationCredentials, organizations } from "../../src/db/schema.js";
import { decryptCredentialSecret } from "../../src/security/index.js";
import { mysqlTestOptions, openTestDatabase, testDatabaseUrl, uniqueId } from "../helpers/mysql.js";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
type CapturedIo = {
  stdout: string[];
  stderr: string[];
  io: { stdout(message: string): void; stderr(message: string): void };
};
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: testDatabaseUrl,
  ...extra,
});

it("prints CLI help without opening a database", async () => {
  const io = capture();
  const result = await runCli(["help"], io.io, {});
  assert.equal(result.exitCode, 0);
  assert.match(io.stdout.join("\n"), /MySQL configuration/);
});

describe("teamtales CLI with MySQL", mysqlTestOptions, () => {
  it("runs migrations", async () => {
    const io = capture();
    const result = await runCli(["migrate"], io.io, env());
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(io.stdout[0] ?? "{}").migrated, true);
  });

  it("persists organization metadata, membership, and password", async () => {
    const suffix = uniqueId("cli"),
      organizationId = `org_${suffix}`,
      userId = `user_${suffix}`;
    try {
      const created = capture();
      assert.equal(
        (
          await runCli(
            [
              "org",
              "create",
              "--id",
              organizationId,
              "--name",
              "Acme",
              "--owner-id",
              userId,
              "--owner-email",
              `${suffix}@example.test`,
            ],
            created.io,
            env(),
          )
        ).exitCode,
        0,
      );
      const passwordIo = capture();
      assert.equal(
        (
          await runCli(
            ["auth", "set-password", "--user-id", userId, "--password-env", "TEST_PASSWORD"],
            passwordIo.io,
            env({ TEST_PASSWORD: "correct horse battery staple" }),
          )
        ).exitCode,
        0,
      );
      assert.equal(passwordIo.stdout.join("\n").includes("correct horse battery staple"), false);
      const opened = await openTestDatabase();
      try {
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
      } finally {
        await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
        await opened.close();
      }
    } catch (error) {
      const opened = await openTestDatabase();
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
      throw error;
    }
  });

  it("resets a user password by ID or primary email through the operations command", async () => {
    const suffix = uniqueId("cli"),
      organizationId = `org_${suffix}`,
      userId = `user_${suffix}`,
      email = `${suffix}@example.test`;
    try {
      assert.equal(
        (
          await runCli(
            [
              "org",
              "create",
              "--id",
              organizationId,
              "--name",
              "Acme",
              "--owner-id",
              userId,
              "--owner-email",
              email,
            ],
            capture().io,
            env(),
          )
        ).exitCode,
        0,
      );
      const byId = capture();
      assert.equal(
        (
          await runCli(
            [
              "ops",
              "iam",
              "reset-user-password",
              "--user",
              userId,
              "--password-env",
              "TEST_PASSWORD",
            ],
            byId.io,
            env({ TEST_PASSWORD: "initial password value" }),
          )
        ).exitCode,
        0,
      );
      assert.equal(JSON.parse(byId.stdout[0] ?? "{}").userId, userId);
      const byEmail = capture();
      assert.equal(
        (
          await runCli(
            [
              "ops",
              "iam",
              "reset-user-password",
              "--user",
              email.toUpperCase(),
              "--password-env",
              "TEST_PASSWORD",
            ],
            byEmail.io,
            env({ TEST_PASSWORD: "correct horse battery staple" }),
          )
        ).exitCode,
        0,
      );
      assert.equal(JSON.parse(byEmail.stdout[0] ?? "{}").userId, userId);
      assert.equal(
        `${byId.stdout.join("\n")}\n${byEmail.stdout.join("\n")}`.includes(
          "correct horse battery staple",
        ),
        false,
      );
      const opened = await openTestDatabase();
      try {
        assert.equal(
          (await authenticatePassword(opened.db, email, "correct horse battery staple"))?.userId,
          userId,
        );
      } finally {
        await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
        await opened.close();
      }
    } catch (error) {
      const opened = await openTestDatabase();
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
      throw error;
    }
  });

  it("adds an encrypted PAT and compatible sync scope", async () => {
    const suffix = uniqueId("cli"),
      organizationId = `org_${suffix}`,
      userId = `user_${suffix}`,
      integrationId = `integration_${suffix}`,
      credentialId = `credential_${suffix}`;
    try {
      await runCli(
        ["org", "create", "--id", organizationId, "--name", "Acme", "--owner-id", userId],
        capture().io,
        env(),
      );
      const integration = capture();
      const result = await runCli(
        [
          "integration",
          "add-pat",
          "--id",
          integrationId,
          "--credential-id",
          credentialId,
          "--organization-id",
          organizationId,
          "--user-id",
          userId,
          "--provider",
          "linear",
          "--token-env",
          "TEST_PAT",
        ],
        integration.io,
        env({ TEAMTALES_CREDENTIAL_KEY: key, TEST_PAT: "lin_api_secret_1234567890" }),
      );
      assert.equal(result.exitCode, 0);
      assert.equal(integration.stdout.join("\n").includes("lin_api_secret_1234567890"), false);
      const scope = capture();
      assert.equal(
        (
          await runCli(
            [
              "scope",
              "add",
              "--id",
              `scope_${suffix}`,
              "--organization-id",
              organizationId,
              "--user-id",
              userId,
              "--integration-id",
              integrationId,
              "--provider",
              "linear",
              "--type",
              "linear.team",
              "--name",
              "Engineering",
              "--config-json",
              '{"teamKey":"ENG"}',
            ],
            scope.io,
            env(),
          )
        ).exitCode,
        0,
      );
      assert.equal(JSON.parse(scope.stdout[0] ?? "{}").externalName, "Engineering");
      const opened = await openTestDatabase();
      try {
        const [row] = await opened.db
          .select()
          .from(integrationCredentials)
          .where(eq(integrationCredentials.id, credentialId));
        assert.equal(
          decryptCredentialSecret(
            { encryptedSecret: row!.encryptedSecret, secretHint: row!.secretHint ?? undefined },
            key,
          ),
          "lin_api_secret_1234567890",
        );
      } finally {
        await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
        await opened.close();
      }
    } catch (error) {
      const opened = await openTestDatabase();
      await opened.db.delete(organizations).where(eq(organizations.id, organizationId));
      await opened.close();
      throw error;
    }
  });

  it("rejects a scope attached to another organization's integration", async () => {
    const suffix = uniqueId("cli"),
      orgA = `org_a_${suffix}`,
      orgB = `org_b_${suffix}`,
      userA = `user_a_${suffix}`,
      userB = `user_b_${suffix}`,
      integrationId = `integration_${suffix}`;
    try {
      await runCli(
        ["org", "create", "--id", orgA, "--name", "A", "--owner-id", userA],
        capture().io,
        env(),
      );
      await runCli(
        ["org", "create", "--id", orgB, "--name", "B", "--owner-id", userB],
        capture().io,
        env(),
      );
      await runCli(
        [
          "integration",
          "add-pat",
          "--id",
          integrationId,
          "--organization-id",
          orgA,
          "--user-id",
          userA,
          "--provider",
          "github",
          "--token",
          "github_pat_secret_1234567890",
        ],
        capture().io,
        env({ TEAMTALES_CREDENTIAL_KEY: key }),
      );
      const io = capture();
      const result = await runCli(
        [
          "scope",
          "add",
          "--organization-id",
          orgB,
          "--user-id",
          userB,
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
        env(),
      );
      assert.equal(result.exitCode, 1);
      assert.match(io.stderr[0] ?? "", /Integration not found/);
    } finally {
      const opened = await openTestDatabase();
      await opened.db.delete(organizations).where(eq(organizations.id, orgA));
      await opened.db.delete(organizations).where(eq(organizations.id, orgB));
      await opened.close();
    }
  });

  it("generates deterministic fixture reports and honors --output/--persist semantics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-cli-mysql-"));
    const fixture = join(directory, "context.json");
    const output = join(directory, "weekly.md");
    writeFileSync(
      fixture,
      JSON.stringify({
        organization: { id: "org_fixture", name: "Fixture" },
        scope: { type: "organization", id: "org_fixture", name: "Fixture" },
        period: { start: "2026-06-22", end: "2026-06-29" },
        freshness: { warnings: [] },
        metrics: [{ name: "activity.events", value: 1 }],
        highlights: [],
        people: [],
        workItems: [],
        risks: [],
      }),
    );
    try {
      const io = capture();
      const result = await runCli(
        [
          "report",
          "weekly",
          "--fixture",
          fixture,
          "--organization-id",
          "org_fixture",
          "--period-start",
          "2026-06-22",
          "--period-end",
          "2026-06-29",
          "--title",
          "Fixture Weekly",
          "--output",
          output,
        ],
        io.io,
        env(),
      );
      assert.equal(result.exitCode, 0);
      const response = JSON.parse(io.stdout[0] ?? "{}") as {
        reportId?: string;
        output?: string;
        markdown?: string;
      };
      assert.equal(response.reportId, undefined);
      assert.equal(response.output, output);
      assert.equal(response.markdown, undefined);
      assert.match(readFileSync(output, "utf8"), /^# Fixture Weekly/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function capture(): CapturedIo {
  const stdout: string[] = [],
    stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
  };
}
