#!/usr/bin/env -S tsx
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildReportContext,
  type ActivityEvent,
  type AnalysisInput,
  type Person,
  type Provider,
  type ReportContext,
  type ReportScopeType,
  type WorkItem,
} from "../index.js";
import { resetUserPassword, setPassword } from "../auth/index.js";
import { openDatabase, type AppDatabase } from "../db/index.js";
import { parseJsonObject } from "../persistence/database.js";
import {
  addPersonalAccessTokenIntegrationService,
  addSyncScopeService,
  createOrganizationService,
  generateWeeklyReportService,
  enqueueProviderSyncService,
  processQueuedProviderSyncBatch,
  resolveReportContext,
} from "../services/index.js";

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
    const [command] = parsed.command;

    if (!command || command === "help" || getBoolean(parsed, "help")) {
      out(usage());
      return { exitCode: 0 };
    }

    const commandName = parsed.command.join(" ");
    if (!supportedCommands.has(commandName)) throw new Error(`Unknown command: ${parsed.command.join(" ")}`);

    const opened = await openCliDatabase(parsed, env, commandName === "init-db" || commandName === "migrate");
    try {
      let result: Record<string, unknown>;
      switch (commandName) {
        case "init-db":
        case "migrate":
          result = migrateDatabase(parsed, env);
          break;
        case "org create":
          result = await createOrganization(opened.db, parsed);
          break;
        case "auth set-password":
          result = await setUserPassword(opened.db, parsed, env);
          break;
        case "ops iam reset-user-password":
          result = await resetUserPasswordForOperations(opened.db, parsed, env);
          break;
        case "integration add-pat":
          result = await addPersonalAccessTokenIntegration(opened.db, parsed, env);
          break;
        case "scope add":
          result = await addSyncScope(opened.db, parsed);
          break;
        case "sync github":
        case "sync linear":
          result = await runProviderSync(opened.db, commandProvider(parsed.command[1]), parsed, env);
          break;
        case "sync worker":
          result = await runSyncWorker(opened.db, parsed, env);
          break;
        case "report weekly":
          result = await generateWeeklyReport(opened.db, parsed);
          break;
        default:
          throw new Error(`Unknown command: ${parsed.command.join(" ")}`);
      }
      out(JSON.stringify(result, null, 2));
      return { exitCode: 0 };
    } finally {
      await opened.close();
    }
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}

const supportedCommands = new Set([
  "init-db",
  "migrate",
  "org create",
  "auth set-password",
  "ops iam reset-user-password",
  "integration add-pat",
  "scope add",
  "sync github",
  "sync linear",
  "sync worker",
  "report weekly",
]);

function migrateDatabase(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    database: databaseLabel(parsed, env),
    migrated: true,
  };
}

async function createOrganization(database: AppDatabase, parsed: ParsedArgs): Promise<Record<string, unknown>> {
  const created = await createOrganizationService(database, {
    id: optionalString(parsed, "id"),
    name: requiredOption(parsed, "name"),
    slug: optionalString(parsed, "slug"),
    ownerEmail: optionalString(parsed, "owner-email"),
    ownerName: optionalString(parsed, "owner-name"),
    ownerId: optionalString(parsed, "owner-id"),
    membershipId: optionalString(parsed, "membership-id"),
  });
  return {
    id: created.organization.id,
    name: created.organization.name,
    slug: created.organization.slug,
    ownerUserId: created.ownerUserId,
    ownerMembershipId: created.ownerMembershipId,
  };
}

async function setUserPassword(database: AppDatabase, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const userId = requiredOption(parsed, "user-id");
  const password = readSecret(parsed, "password", "password-file", "password-env", env);
  await setPassword(database, userId, password);
  return { userId, passwordUpdated: true };
}

async function resetUserPasswordForOperations(database: AppDatabase, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const user = requiredOption(parsed, "user");
  const password = readSecret(parsed, "password", "password-file", "password-env", env);
  const userId = await resetUserPassword(database, user, password);
  return { userId, passwordUpdated: true };
}

async function addPersonalAccessTokenIntegration(database: AppDatabase, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const provider = parseProvider(requiredOption(parsed, "provider"));
  const organizationId = requiredOption(parsed, "organization-id");
  const displayName = optionalString(parsed, "name") ?? `${provider} PAT`;
  const integrationId = optionalString(parsed, "id") ?? stableId("integration", organizationId, provider, displayName);
  const credentialId = optionalString(parsed, "credential-id") ?? stableId("credential", integrationId);
  const token = readSecret(parsed, "token", "token-file", "token-env", env);
  const encryptionKey = optionalString(parsed, "encryption-key") ?? env.TEAMTALES_CREDENTIAL_KEY;
  if (!encryptionKey) throw new Error("Missing credential encryption key. Use --encryption-key or TEAMTALES_CREDENTIAL_KEY.");

  const integration = await addPersonalAccessTokenIntegrationService(database, {
    id: integrationId,
    credentialId,
    organizationId,
    userId: requiredOption(parsed, "user-id"),
    provider,
    displayName,
    token,
    encryptionKey,
  });
  return {
    id: integration.id,
    organizationId: integration.organizationId,
    provider: integration.provider,
    authType: integration.authType,
    displayName: integration.displayName,
    credentialId: integration.credentialId,
    secretHint: integration.secretHint,
  };
}

async function addSyncScope(database: AppDatabase, parsed: ParsedArgs): Promise<Record<string, unknown>> {
  const provider = parseProvider(requiredOption(parsed, "provider"));
  const organizationId = requiredOption(parsed, "organization-id");
  const integrationId = requiredOption(parsed, "integration-id");
  const scopeType = requiredOption(parsed, "type");
  const externalName = requiredOption(parsed, "name");
  const scopeId = optionalString(parsed, "id") ?? stableId("scope", organizationId, integrationId, scopeType, externalName);
  const config = optionalString(parsed, "config-json") ? parseJsonObject(requiredOption(parsed, "config-json")) : {};
  const scope = await addSyncScopeService(database, {
    id: scopeId,
    organizationId,
    userId: requiredOption(parsed, "user-id"),
    integrationId,
    provider,
    scopeType: scopeType as Parameters<typeof addSyncScopeService>[1]["scopeType"],
    externalId: optionalString(parsed, "external-id"),
    externalName,
    config: config as Parameters<typeof addSyncScopeService>[1]["config"],
    enabled: !getBoolean(parsed, "disabled"),
  });
  return {
    id: scope.id,
    organizationId: scope.organizationId,
    integrationId: scope.integrationId,
    provider: scope.provider,
    scopeType: scope.scopeType,
    externalName: scope.externalName,
    enabled: scope.enabled,
    config: scope.config,
  };
}

async function runProviderSync(database: AppDatabase, provider: Provider, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const encryptionKey = optionalString(parsed, "encryption-key") ?? env.TEAMTALES_CREDENTIAL_KEY;
  if (!encryptionKey) throw new Error("Missing credential encryption key. Use --encryption-key or TEAMTALES_CREDENTIAL_KEY.");
  return enqueueProviderSyncService(database, {
    provider,
    organizationId: optionalString(parsed, "organization-id"),
    integrationId: optionalString(parsed, "integration-id"),
    syncScopeId: optionalString(parsed, "scope-id") ?? optionalString(parsed, "sync-scope-id"),
    encryptionKey,
  });
}

async function runSyncWorker(database: AppDatabase, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const encryptionKey = optionalString(parsed, "encryption-key") ?? env.TEAMTALES_CREDENTIAL_KEY;
  if (!encryptionKey) throw new Error("Missing credential encryption key. Use --encryption-key or TEAMTALES_CREDENTIAL_KEY.");
  return { processed: await processQueuedProviderSyncBatch(database, encryptionKey, { limit: Number(optionalString(parsed, "limit") ?? "10") }) };
}

async function generateWeeklyReport(database: AppDatabase, parsed: ParsedArgs): Promise<Record<string, unknown>> {
  const fixture = optionalString(parsed, "fixture");
  const output = optionalString(parsed, "output");
  const persist = getBoolean(parsed, "persist");
  const contextSource = fixture ? reportContextFromFixture(fixture, parsed) : await reportContextFromDatabase(database, parsed);
  const generated = await generateWeeklyReportService(database, {
    analysisReportContextId: contextSource.analysisReportContextId,
    context: contextSource.context,
    title: optionalString(parsed, "title"),
    persist,
    analysisRunIdSeed: "cli",
  });
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, generated.markdown, "utf8");
  }
  return {
    reportId: persist ? generated.report.id : undefined,
    analysisReportContextId: persist ? generated.analysisReportContextId : contextSource.analysisReportContextId,
    output,
    markdown: output ? undefined : generated.markdown,
  };
}

function reportContextFromFixture(filename: string, parsed: ParsedArgs): { context: ReportContext; analysisReportContextId?: string } {
  const value = JSON.parse(readFileSync(filename, "utf8")) as unknown;
  if (isRecord(value) && isRecord(value.context)) {
    return {
      context: value.context as ReportContext,
      analysisReportContextId: typeof value.analysisReportContextId === "string" ? value.analysisReportContextId : undefined,
    };
  }
  if (isRecord(value) && Array.isArray(value.events) && Array.isArray(value.workItems) && Array.isArray(value.people)) {
    return { context: buildReportContext(value as unknown as AnalysisInput) };
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
  if (isReportContext(value)) return { context: value };
  throw new Error("Fixture must be a ReportContext, { context }, or AnalysisInput-like JSON.");
}

async function reportContextFromDatabase(database: AppDatabase, parsed: ParsedArgs): Promise<{ context: ReportContext; analysisReportContextId?: string }> {
  const organization = requiredOrganization(parsed);
  const scope = requiredScope(parsed);
  const period = requiredPeriod(parsed);
  return resolveReportContext(database, {
    organizationId: organization.id,
    organizationName: organization.name,
    scopeType: scope.type,
    scopeId: scope.id,
    scopeName: scope.name,
    periodStart: period.start,
    periodEnd: period.end,
  });
}

function requiredOrganization(parsed: ParsedArgs): AnalysisInput["organization"] {
  return {
    id: requiredOption(parsed, "organization-id"),
    name: optionalString(parsed, "organization-name") ?? requiredOption(parsed, "organization-id"),
  };
}

function requiredScope(parsed: ParsedArgs): AnalysisInput["scope"] {
  return {
    type: (optionalString(parsed, "scope-type") ?? "organization") as ReportScopeType,
    id: optionalString(parsed, "scope-id") ?? requiredOption(parsed, "organization-id"),
    name: optionalString(parsed, "scope-name") ?? optionalString(parsed, "scope-id") ?? requiredOption(parsed, "organization-id"),
  };
}

function requiredPeriod(parsed: ParsedArgs): AnalysisInput["period"] {
  return { start: requiredOption(parsed, "period-start"), end: requiredOption(parsed, "period-end") };
}

function cliEnvironment(parsed: ParsedArgs, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const databaseUrl = optionalString(parsed, "db");
  return databaseUrl ? { ...env, DATABASE_URL: databaseUrl } : env;
}

function openCliDatabase(parsed: ParsedArgs, env: NodeJS.ProcessEnv, runMigrations: boolean) {
  return openDatabase({ env: cliEnvironment(parsed, env), runMigrations });
}

function databaseLabel(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string | undefined {
  return optionalString(parsed, "db") ?? (env.DATABASE_URL ? "DATABASE_URL" : env.DB_NAME);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
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
      } else options.set(key, true);
      continue;
    }
    command.push(arg);
  }
  return { command, options };
}

function requiredOption(parsed: ParsedArgs, key: string): string {
  const value = optionalString(parsed, key);
  if (!value) throw new Error(`Missing required option --${key}`);
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
  if (sources.length !== 1) throw new Error(`Provide exactly one of --${valueKey}, --${fileKey}, or --${envKey}.`);
  if (direct !== undefined) return direct;
  if (file !== undefined) return readFileSync(file, "utf8").trim();
  const secret = env[envName as string];
  if (!secret) throw new Error(`Environment variable ${envName} is empty or missing.`);
  return secret;
}

function parseProvider(value: string): Provider {
  if (value !== "github" && value !== "linear") throw new Error(`Unsupported provider: ${value}`);
  return value;
}

function commandProvider(value: string | undefined): Provider {
  if (value === "github" || value === "linear") return value;
  throw new Error("Missing provider subcommand.");
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

function isReportContext(value: unknown): value is ReportContext {
  return isRecord(value) && isRecord(value.organization) && isRecord(value.scope) && isRecord(value.period) &&
    Array.isArray(value.metrics) && Array.isArray(value.highlights) && Array.isArray(value.people) &&
    Array.isArray(value.workItems) && Array.isArray(value.risks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage(): string {
  return `Usage:
  teamtales init-db [--db mysql://user:password@host/teamtales]
  teamtales migrate [--db mysql://user:password@host/teamtales]
  teamtales org create [--db mysql://...] --name "Acme" --owner-email owner@example.com [--id org_acme]
  teamtales auth set-password [--db mysql://...] --user-id user_id --password-env TEAMTALES_PASSWORD
  teamtales ops iam reset-user-password [--db mysql://...] --user user_id_or_email --password-env TEAMTALES_PASSWORD
  teamtales integration add-pat [--db mysql://...] --organization-id org_acme --user-id user_id --provider github --name GitHub --token-env GITHUB_TOKEN
  teamtales scope add [--db mysql://...] --organization-id org_acme --user-id user_id --integration-id integration_id --provider github --type github.repository --name owner/repo
  teamtales sync github [--db mysql://...] --organization-id org_acme [--scope-id scope_id]
  teamtales sync worker [--db mysql://...] [--limit 10]
  teamtales report weekly [--db mysql://...] --organization-id org_acme --period-start 2026-06-22 --period-end 2026-06-29 [--fixture context.json] [--persist] [--output report.md]

MySQL configuration uses --db, DATABASE_URL, or DB_HOST/DB_PORT/DB_USER/DB_USERNAME/DB_PASSWORD/DB_NAME.
Credential encryption uses --encryption-key or TEAMTALES_CREDENTIAL_KEY.`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await runCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
