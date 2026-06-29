#!/usr/bin/env -S tsx
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  buildReportContext,
  generateWeeklyMarkdownReport,
  type ActivityEvent,
  type AnalysisInput,
  type Person,
  type ReportContext,
  type ReportScopeType,
  type WorkItem,
} from "../index.js";
import { openLocalDatabase } from "../db/index.js";
import { createIntegrationCredentialRecord } from "../security/index.js";
import {
  createOrganizationWithOwner,
  requireIntegrationInOrganization,
  requireOrganization,
  requireOrganizationRole,
  saveCompleteAnalysisResult,
  saveCompleteReportResult,
} from "../persistence/index.js";
import { parseJsonObject } from "../persistence/sqlite.js";

type Provider = "github" | "linear";

export interface CliIo {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface ParsedArgs {
  command: string[];
  options: Map<string, string | boolean>;
}

interface CliResult {
  exitCode: number;
}

export async function runCli(argv: readonly string[], io: CliIo = {}, env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const out = io.stdout ?? ((message) => process.stdout.write(`${message}\n`));
  const err = io.stderr ?? ((message) => process.stderr.write(`${message}\n`));

  try {
    const parsed = parseArgs(argv);
    const [command, subcommand] = parsed.command;

    if (!command || command === "help" || getBoolean(parsed, "help")) {
      out(usage());
      return { exitCode: 0 };
    }

    switch (`${command}${subcommand ? ` ${subcommand}` : ""}`) {
      case "init-db":
      case "migrate":
        out(JSON.stringify(migrateDatabase(parsed), null, 2));
        return { exitCode: 0 };
      case "org create":
        out(JSON.stringify(createOrganization(parsed), null, 2));
        return { exitCode: 0 };
      case "integration add-pat":
        out(JSON.stringify(addPersonalAccessTokenIntegration(parsed, env), null, 2));
        return { exitCode: 0 };
      case "scope add":
        out(JSON.stringify(addSyncScope(parsed), null, 2));
        return { exitCode: 0 };
      case "sync github":
      case "sync linear":
        out(JSON.stringify(syncPlaceholder(commandProvider(subcommand), parsed), null, 2));
        return { exitCode: 2 };
      case "report weekly":
        out(JSON.stringify(generateWeeklyReport(parsed), null, 2));
        return { exitCode: 0 };
      default:
        throw new Error(`Unknown command: ${parsed.command.join(" ")}`);
    }
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}

function migrateDatabase(parsed: ParsedArgs): Record<string, unknown> {
  const local = openCliDatabase(parsed, true);
  try {
    return {
      database: local.filename,
      applied: local.migrations?.applied.map((migration) => migration.filename) ?? [],
      skipped: local.migrations?.skipped.map((migration) => migration.filename) ?? [],
    };
  } finally {
    local.close();
  }
}

function createOrganization(parsed: ParsedArgs): Record<string, unknown> {
  const name = requiredOption(parsed, "name");
  const id = optionalString(parsed, "id") ?? stableId("org", name);
  const slug = optionalString(parsed, "slug") ?? slugify(name);
  const ownerEmail = optionalString(parsed, "owner-email");
  const ownerName = optionalString(parsed, "owner-name") ?? ownerEmail ?? "Local Owner";
  const ownerId = optionalString(parsed, "owner-id") ?? stableId("user", ownerEmail ?? ownerName);
  const membershipId = optionalString(parsed, "membership-id") ?? stableId("membership", id, ownerId);
  const local = openCliDatabase(parsed, true);

  try {
    const created = createOrganizationWithOwner(local.sqlite, {
      organization: { id, name, slug },
      owner: { id: ownerId, displayName: ownerName, primaryEmail: ownerEmail ?? null },
      membershipId,
    });

    return {
      id: created.organization.id,
      name: created.organization.name,
      slug: created.organization.slug,
      ownerUserId: created.owner.id,
      ownerMembershipId: created.membership.id,
    };
  } finally {
    local.close();
  }
}

function addPersonalAccessTokenIntegration(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const provider = parseProvider(requiredOption(parsed, "provider"));
  const organizationId = requiredOption(parsed, "organization-id");
  const displayName = optionalString(parsed, "name") ?? `${provider} PAT`;
  const integrationId = optionalString(parsed, "id") ?? stableId("integration", organizationId, provider, displayName);
  const credentialId = optionalString(parsed, "credential-id") ?? stableId("credential", integrationId);
  const token = readSecret(parsed, "token", "token-file", "token-env", env);
  const encryptionKey = optionalString(parsed, "encryption-key") ?? env.TEAMTALES_CREDENTIAL_KEY;

  if (!encryptionKey) {
    throw new Error("Missing credential encryption key. Use --encryption-key or TEAMTALES_CREDENTIAL_KEY.");
  }

  const local = openCliDatabase(parsed, true);
  try {
    requireOrganization(local.sqlite, organizationId);
    requireOrganizationRole(local.sqlite, organizationId, requiredOption(parsed, "user-id"), ["owner", "admin"]);

    const now = new Date().toISOString();
    local.sqlite
      .prepare(
        `INSERT INTO integrations (id, organization_id, provider, auth_type, status, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(integrationId, organizationId, provider, "personal_access_token", "active", displayName, now, now);

    const credential = createIntegrationCredentialRecord({
      id: credentialId,
      integrationId,
      plaintextSecret: token,
      encryptionKey,
    });

    local.sqlite
      .prepare(
        `INSERT INTO integration_credentials (
          id, integration_id, encrypted_secret, secret_hint, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.id,
        credential.integrationId,
        credential.encryptedSecret,
        credential.secretHint,
        credential.expiresAt?.toISOString() ?? null,
        now,
        now,
      );

    return {
      id: integrationId,
      organizationId,
      provider,
      authType: "personal_access_token",
      displayName,
      credentialId,
      secretHint: credential.secretHint,
    };
  } finally {
    local.close();
  }
}

function addSyncScope(parsed: ParsedArgs): Record<string, unknown> {
  const provider = parseProvider(requiredOption(parsed, "provider"));
  const organizationId = requiredOption(parsed, "organization-id");
  const integrationId = requiredOption(parsed, "integration-id");
  const scopeType = requiredOption(parsed, "type");
  const externalName = requiredOption(parsed, "name");
  const scopeId = optionalString(parsed, "id") ?? stableId("scope", organizationId, integrationId, scopeType, externalName);
  const config = optionalString(parsed, "config-json") ? parseJsonObject(requiredOption(parsed, "config-json")) : {};
  const now = new Date().toISOString();
  const local = openCliDatabase(parsed, true);

  try {
    requireOrganization(local.sqlite, organizationId);
    requireOrganizationRole(local.sqlite, organizationId, requiredOption(parsed, "user-id"), ["owner", "admin"]);
    requireIntegrationInOrganization(local.sqlite, organizationId, integrationId);

    local.sqlite
      .prepare(
        `INSERT INTO sync_scopes (
          id, organization_id, integration_id, provider, scope_type, external_id, external_name,
          config_json, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scopeId,
        organizationId,
        integrationId,
        provider,
        scopeType,
        optionalString(parsed, "external-id") ?? null,
        externalName,
        JSON.stringify(config),
        getBoolean(parsed, "disabled") ? 0 : 1,
        now,
        now,
      );

    return {
      id: scopeId,
      organizationId,
      integrationId,
      provider,
      scopeType,
      externalName,
      enabled: !getBoolean(parsed, "disabled"),
      config,
    };
  } finally {
    local.close();
  }
}

function syncPlaceholder(provider: Provider, parsed: ParsedArgs): Record<string, unknown> {
  const local = openCliDatabase(parsed, true);
  try {
    return {
      provider,
      status: "not_implemented",
      message: "Provider API sync is intentionally a placeholder in the MVP CLI.",
    };
  } finally {
    local.close();
  }
}

function generateWeeklyReport(parsed: ParsedArgs): Record<string, unknown> {
  const fixture = optionalString(parsed, "fixture");
  const output = optionalString(parsed, "output");
  const persist = getBoolean(parsed, "persist");
  const local = openCliDatabase(parsed, true);

  try {
    const contextSource = fixture ? reportContextFromFixture(fixture, parsed) : reportContextFromDatabase(local.sqlite, parsed);
    const markdown = generateWeeklyMarkdownReport(contextSource.context, { title: optionalString(parsed, "title") });

    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, markdown, "utf8");
    }

    let reportId: string | undefined;
    let analysisReportContextId = contextSource.analysisReportContextId;

    if (persist) {
      if (!analysisReportContextId) {
        const now = new Date().toISOString();
        const analysisRunId = stableId(
          "analysis_run",
          contextSource.context.organization.id,
          contextSource.context.scope.type,
          contextSource.context.scope.id,
          contextSource.context.period.start,
          contextSource.context.period.end,
          "cli",
        );
        analysisReportContextId = stableId("report_context", analysisRunId);
        saveCompleteAnalysisResult(local.sqlite, {
          run: {
            id: analysisRunId,
            organizationId: contextSource.context.organization.id,
            scopeType: contextSource.context.scope.type,
            scopeId: contextSource.context.scope.id,
            periodStart: contextSource.context.period.start,
            periodEnd: contextSource.context.period.end,
            status: "completed",
            startedAt: now,
            finishedAt: now,
          },
          metrics: contextSource.context.metrics.map((metric, index) => ({
            ...metric,
            id: stableId("metric", analysisRunId, String(index), metric.name, JSON.stringify(metric.dimensions ?? {})),
          })),
          highlights: [],
          reportContext: {
            id: analysisReportContextId,
            context: contextSource.context,
          },
        });
      }

      reportId = stableId(
        "report",
        analysisReportContextId,
        "weekly",
        contextSource.context.period.start,
        contextSource.context.period.end,
      );
      saveCompleteReportResult(local.sqlite, {
        report: {
          id: reportId,
          organizationId: contextSource.context.organization.id,
          analysisReportContextId,
          reportType: "weekly",
          scopeType: contextSource.context.scope.type,
          scopeId: contextSource.context.scope.id,
          periodStart: contextSource.context.period.start,
          periodEnd: contextSource.context.period.end,
          status: "completed",
          title: optionalString(parsed, "title") ?? `Weekly report: ${contextSource.context.scope.name}`,
          summary: null,
          bodyMarkdown: markdown,
          structured: { analysisReportContextId },
        },
        inputs: [
          {
            id: stableId("report_input", reportId, analysisReportContextId),
            inputType: "analysis_report_context",
            inputId: analysisReportContextId,
            metadata: { role: "primary" },
          },
        ],
      });
    }

    return {
      reportId,
      analysisReportContextId,
      output,
      markdown: output ? undefined : markdown,
    };
  } finally {
    local.close();
  }
}

function reportContextFromFixture(
  filename: string,
  parsed: ParsedArgs,
): { context: ReportContext; analysisReportContextId?: string } {
  const value = JSON.parse(readFileSync(filename, "utf8")) as unknown;

  if (isRecord(value) && isRecord(value.context)) {
    return {
      context: value.context as ReportContext,
      analysisReportContextId: typeof value.analysisReportContextId === "string" ? value.analysisReportContextId : undefined,
    };
  }

  if (isRecord(value) && Array.isArray(value.events) && Array.isArray(value.workItems) && Array.isArray(value.people)) {
    return { context: buildReportContext(value as AnalysisInput) };
  }

  if (isRecord(value) && Array.isArray(value.events) && Array.isArray(value.work_items) && Array.isArray(value.people)) {
    return {
      context: buildReportContext({
        organization: requiredOrganization(parsed),
        scope: requiredScope(parsed),
        period: requiredPeriod(parsed),
        freshness: isRecord(value.freshness) ? value.freshness : undefined,
        events: value.events as ActivityEvent[],
        workItems: value.work_items as WorkItem[],
        people: value.people as Person[],
      }),
    };
  }

  if (isReportContext(value)) {
    return { context: value };
  }

  throw new Error("Fixture must be a ReportContext, { context }, or AnalysisInput-like JSON.");
}

function reportContextFromDatabase(
  database: DatabaseSync,
  parsed: ParsedArgs,
): { context: ReportContext; analysisReportContextId?: string } {
  const organizationId = requiredOption(parsed, "organization-id");
  const existing = latestReportContext(database, parsed);

  if (existing) {
    return existing;
  }

  const input: AnalysisInput = {
    organization: requiredOrganization(parsed),
    scope: requiredScope(parsed),
    period: requiredPeriod(parsed),
    freshness: databaseFreshness(database, organizationId),
    events: readActivityEvents(database, parsed),
    workItems: readWorkItems(database, parsed),
    people: readPeople(database, parsed),
  };

  return { context: buildReportContext(input) };
}

function latestReportContext(
  database: DatabaseSync,
  parsed: ParsedArgs,
): { context: ReportContext; analysisReportContextId: string } | undefined {
  const organizationId = requiredOption(parsed, "organization-id");
  const scopeId = optionalString(parsed, "scope-id");
  const periodStart = optionalString(parsed, "period-start");
  const periodEnd = optionalString(parsed, "period-end");
  const clauses: string[] = ["organization_id = ?"];
  const values: string[] = [organizationId];

  if (scopeId) {
    clauses.push("scope_id = ?");
    values.push(scopeId);
  }
  if (periodStart) {
    clauses.push("period_start = ?");
    values.push(periodStart);
  }
  if (periodEnd) {
    clauses.push("period_end = ?");
    values.push(periodEnd);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = database
    .prepare(`SELECT id, context_json FROM analysis_report_contexts ${where} ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(...values) as Record<string, unknown> | undefined;

  if (!row || typeof row.id !== "string" || typeof row.context_json !== "string") {
    return undefined;
  }

  return {
    analysisReportContextId: row.id,
    context: JSON.parse(row.context_json) as ReportContext,
  };
}

function readActivityEvents(database: DatabaseSync, parsed: ParsedArgs): ActivityEvent[] {
  const organizationId = requiredOption(parsed, "organization-id");
  const { start, end } = requiredPeriod(parsed);

  return database
    .prepare(
      `SELECT * FROM activity_events
       WHERE organization_id = ? AND occurred_at >= ? AND occurred_at <= ?
       ORDER BY occurred_at, id`,
    )
    .all(organizationId, start, end)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return stripUndefined({
        id: requiredColumn(record, "id"),
        provider: requiredColumn(record, "provider") as Provider,
        eventType: requiredColumn(record, "event_type"),
        actorPersonId: optionalColumn(record, "actor_person_id"),
        workItemId: optionalColumn(record, "work_item_id"),
        repositoryId: optionalColumn(record, "repository_id"),
        linearTeamId: optionalColumn(record, "linear_team_id"),
        linearProjectId: optionalColumn(record, "linear_project_id"),
        occurredAt: requiredColumn(record, "occurred_at"),
        title: requiredColumn(record, "title"),
        body: optionalColumn(record, "body"),
        url: optionalColumn(record, "url"),
        sourceRef: optionalColumn(record, "source_object_id") ? `source_object:${optionalColumn(record, "source_object_id")}` : undefined,
        metadata: parseJsonObject(requiredColumn(record, "metadata_json")),
      });
    });
}

function readWorkItems(database: DatabaseSync, parsed: ParsedArgs): WorkItem[] {
  const organizationId = requiredOption(parsed, "organization-id");

  return database
    .prepare("SELECT * FROM work_items WHERE organization_id = ? ORDER BY updated_at_source, id")
    .all(organizationId)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return stripUndefined({
        id: requiredColumn(record, "id"),
        provider: requiredColumn(record, "provider") as Provider,
        sourceType: requiredColumn(record, "work_type") as WorkItem["sourceType"],
        externalId: requiredColumn(record, "external_id"),
        title: requiredColumn(record, "title"),
        url: optionalColumn(record, "url"),
        status: requiredColumn(record, "status") as WorkItem["status"],
        createdAtSource: optionalColumn(record, "created_at_source"),
        updatedAtSource: optionalColumn(record, "updated_at_source"),
        startedAt: optionalColumn(record, "started_at"),
        completedAt: optionalColumn(record, "completed_at"),
      });
    });
}

function readPeople(database: DatabaseSync, parsed: ParsedArgs): Person[] {
  const organizationId = requiredOption(parsed, "organization-id");

  return database
    .prepare("SELECT id, display_name FROM people WHERE organization_id = ? ORDER BY display_name, id")
    .all(organizationId)
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: requiredColumn(record, "id"),
        displayName: requiredColumn(record, "display_name"),
      };
    });
}

function databaseFreshness(database: DatabaseSync, organizationId: string): AnalysisInput["freshness"] {
  const rows = database
    .prepare(
      `SELECT provider, MAX(last_success_at) AS last_success_at
       FROM sync_scopes
       WHERE organization_id = ?
       GROUP BY provider
       ORDER BY provider`,
    )
    .all(organizationId) as Array<Record<string, unknown>>;
  const freshness: { github?: string; linear?: string; warnings: string[] } = { warnings: [] };

  for (const row of rows) {
    const provider = row.provider;
    const lastSuccessAt = row.last_success_at;
    if ((provider === "github" || provider === "linear") && typeof lastSuccessAt === "string") {
      freshness[provider] = lastSuccessAt;
    }
  }

  return freshness;
}

function requiredOrganization(parsed: ParsedArgs): AnalysisInput["organization"] {
  return {
    id: requiredOption(parsed, "organization-id"),
    name: optionalString(parsed, "organization-name") ?? requiredOption(parsed, "organization-id"),
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "organization";
}

function requiredScope(parsed: ParsedArgs): AnalysisInput["scope"] {
  return {
    type: (optionalString(parsed, "scope-type") ?? "organization") as ReportScopeType,
    id: optionalString(parsed, "scope-id") ?? requiredOption(parsed, "organization-id"),
    name: optionalString(parsed, "scope-name") ?? optionalString(parsed, "scope-id") ?? requiredOption(parsed, "organization-id"),
  };
}

function requiredPeriod(parsed: ParsedArgs): AnalysisInput["period"] {
  return {
    start: requiredOption(parsed, "period-start"),
    end: requiredOption(parsed, "period-end"),
  };
}

function openCliDatabase(parsed: ParsedArgs, runMigrations: boolean) {
  return openLocalDatabase({ filename: optionalString(parsed, "db") ?? "teamtales.sqlite", runMigrations });
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        options.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }

      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(key, next);
        index += 1;
      } else {
        options.set(key, true);
      }
      continue;
    }

    command.push(arg);
  }

  return { command, options };
}

function requiredOption(parsed: ParsedArgs, key: string): string {
  const value = optionalString(parsed, key);
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function optionalString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getBoolean(parsed: ParsedArgs, key: string): boolean {
  return parsed.options.get(key) === true;
}

function readSecret(parsed: ParsedArgs, valueKey: string, fileKey: string, envKey: string, env: NodeJS.ProcessEnv): string {
  const direct = optionalString(parsed, valueKey);
  const file = optionalString(parsed, fileKey);
  const envName = optionalString(parsed, envKey);
  const sources = [direct, file, envName].filter((value) => value !== undefined);

  if (sources.length !== 1) {
    throw new Error(`Provide exactly one of --${valueKey}, --${fileKey}, or --${envKey}.`);
  }

  if (direct !== undefined) {
    return direct;
  }
  if (file !== undefined) {
    return readFileSync(file, "utf8").trim();
  }

  const secret = env[envName as string];
  if (!secret) {
    throw new Error(`Environment variable ${envName} is empty or missing.`);
  }
  return secret;
}

function parseProvider(value: string): Provider {
  if (value !== "github" && value !== "linear") {
    throw new Error(`Unsupported provider: ${value}`);
  }
  return value;
}

function commandProvider(value: string | undefined): Provider {
  if (value === "github" || value === "linear") {
    return value;
  }
  throw new Error("Missing provider subcommand.");
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

function requiredColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string column: ${key}`);
  }
  return value;
}

function optionalColumn(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function isReportContext(value: unknown): value is ReportContext {
  return (
    isRecord(value) &&
    isRecord(value.organization) &&
    isRecord(value.scope) &&
    isRecord(value.period) &&
    Array.isArray(value.metrics) &&
    Array.isArray(value.highlights) &&
    Array.isArray(value.people) &&
    Array.isArray(value.workItems) &&
    Array.isArray(value.risks)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage(): string {
  return `Usage:
  teamtales init-db --db ./teamtales.sqlite
  teamtales migrate --db ./teamtales.sqlite
  teamtales org create --db ./teamtales.sqlite --name "Acme" --owner-email owner@example.com [--id org_acme]
  teamtales integration add-pat --db ./teamtales.sqlite --organization-id org_acme --user-id user_id --provider github --name GitHub --token-env GITHUB_TOKEN
  teamtales scope add --db ./teamtales.sqlite --organization-id org_acme --user-id user_id --integration-id integration_id --provider github --type github.repository --name owner/repo
  teamtales report weekly --db ./teamtales.sqlite --organization-id org_acme --period-start 2026-06-22 --period-end 2026-06-29 [--fixture context.json] [--persist] [--output report.md]

Credential encryption uses --encryption-key or TEAMTALES_CREDENTIAL_KEY. Provider sync commands are placeholders.`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await runCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
