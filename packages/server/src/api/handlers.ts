import type { JsonObject, JsonValue, SyncScopeDto } from "@teamtales/common/api";
import type { Provider, ReportScopeType } from "@teamtales/common/domain";
import type { AuthPrincipal } from "../auth/index.js";
import { and, count, eq, isNull } from "drizzle-orm";
import { apiTokens, integrationCredentials, integrations, organizationMemberships, users } from "../db/schema.js";

import type { ApiContext, RouteParams } from "./router.js";
import {
  assertRecord,
  HttpError,
  optionalBoolean,
  optionalJsonObject,
  optionalString,
  readJsonBody,
  requiredString,
} from "./http.js";
import {
  getDashboard,
  getReportDto,
  listIntegrations,
  listOrganizations,
  listReports,
  listSyncScopes,
} from "./repositories.js";
import {
  addPersonalAccessTokenIntegrationService,
  addSyncScopeService,
  createOrganizationService,
  generateWeeklyReportFromRequestService,
  runProviderSyncService,
  setGitHubScopeSelectionService,
  setLinearScopeSelectionService,
} from "../services/index.js";
import { discoverProviderResources, verifyProviderToken } from "../providers/discovery.js";
import { decryptCredentialSecret } from "../security/credentials.js";
import {
  authenticatePassword,
  createApiToken,
  createSession,
  revokeApiToken,
  revokeSession,
  setPassword,
} from "../auth/index.js";

export interface HandlerInput {
  context: ApiContext;
  params: RouteParams;
  url: URL;
}

export interface HandlerResult { status: number; data: JsonValue; headers?: Record<string, string | string[]> }
export type Handler = (input: HandlerInput) => Promise<HandlerResult> | HandlerResult;

export async function loginHandler(input: HandlerInput): Promise<HandlerResult> {
  const body = assertRecord(await readJsonBody(input.context.request));
  let principal: AuthPrincipal | undefined;
  try {
    principal = await authenticatePassword(
      input.context.database,
      requiredString(body, "email"),
      requiredString(body, "password"),
    );
  } catch {
    principal = undefined;
  }
  if (!principal) throw new HttpError(401, "invalid_credentials", "Invalid email or password.");
  const created = await createSession(input.context.database, principal.userId);
  return {
    status: 200,
    data: { authenticated: true, bootstrapAllowed: false, user: principalDto(principal) },
    headers: {
      "set-cookie": sessionCookie(created.token, input.context.config.cookieSecure === true),
      "cache-control": "no-store",
    },
  };
}

export async function logoutHandler(input: HandlerInput): Promise<HandlerResult> {
  const token = requestCookie(input.context.request.headers.cookie, "teamtales_session");
  if (token) await revokeSession(input.context.database, token);
  return {
    status: 200,
    data: { loggedOut: true },
    headers: {
      "set-cookie": clearSessionCookie(input.context.config.cookieSecure === true),
      "cache-control": "no-store",
    },
  };
}

export async function meHandler(input: HandlerInput): Promise<HandlerResult> {
  const bootstrapAllowed = await userCount(input.context.database) === 0;
  if (!input.context.principal) {
    return { status: 200, data: { authenticated: false, bootstrapAllowed }, headers: { "cache-control": "no-store" } };
  }
  return {
    status: 200,
    data: { authenticated: true, bootstrapAllowed: false, user: principalDto(input.context.principal) },
    headers: { "cache-control": "no-store" },
  };
}

export async function listApiTokensHandler(input: HandlerInput): Promise<HandlerResult> {
  const userId = requirePrincipal(input).userId;
  const items = (await input.context.database.select().from(apiTokens).where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt))).orderBy(apiTokens.createdAt, apiTokens.id)).map(mapApiToken);
  return { status: 200, data: { items }, headers: { "cache-control": "no-store" } };
}

export async function createApiTokenHandler(input: HandlerInput): Promise<HandlerResult> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const expiresAtText = optionalString(body, "expiresAt");
  const expiresAt = expiresAtText ? new Date(expiresAtText) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new HttpError(400, "invalid_request", "expiresAt must be a valid date.");
  }
  let created: Awaited<ReturnType<typeof createApiToken>>;
  try {
    created = await createApiToken(input.context.database, requirePrincipal(input).userId, {
      name: requiredString(body, "name"),
      expiresAt,
    });
  } catch (error) {
    throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : "Invalid API token request.");
  }
  return {
    status: 201,
    data: { token: created.token, apiToken: mapApiToken(created.apiToken as unknown) },
    headers: { "cache-control": "no-store" },
  };
}

export async function revokeApiTokenHandler(input: HandlerInput): Promise<HandlerResult> {
  const tokenId = input.params.tokenId ?? "";
  const [owned] = await input.context.database.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, requirePrincipal(input).userId))).limit(1);
  if (!owned) throw new HttpError(404, "not_found", "API token not found.");
  await revokeApiToken(input.context.database, tokenId);
  return { status: 200, data: { revoked: true } };
}

export async function healthHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  await input.context.database.select({ count: count() }).from(users);
  return { status: 200, data: { status: "ok", service: "teamtales-api", database: "ok" } };
}

export async function listOrganizationsHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  return { status: 200, data: { items: await listOrganizations(input.context.database, requirePrincipal(input).userId) } };
}

export async function createOrganizationHandler(input: HandlerInput): Promise<HandlerResult> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const owner = body.owner === undefined ? {} : assertRecord(body.owner);
  const bootstrap = await userCount(input.context.database) === 0;
  const principal = input.context.principal;
  if (!bootstrap && !principal) throw new HttpError(401, "unauthorized", "Authentication is required.");
  const ownerEmail = bootstrap ? requiredString(owner, "primaryEmail") : principal!.email ?? undefined;
  const ownerName = bootstrap ? optionalString(owner, "displayName") : principal!.displayName;
  if (bootstrap) validateBootstrapPassword(requiredString(owner, "password"));
  const result = await createOrganizationService(input.context.database, {
    id: optionalString(body, "id"),
    name: requiredString(body, "name"),
    slug: optionalString(body, "slug"),
    ownerId: bootstrap ? optionalString(owner, "id") ?? optionalString(body, "ownerId") : principal!.userId,
    ownerName,
    ownerEmail,
    membershipId: optionalString(body, "membershipId"),
  });

  let headers: Record<string, string> | undefined;
  if (bootstrap) {
    await setPassword(input.context.database, result.ownerUserId, requiredString(owner, "password"));
    const session = await createSession(input.context.database, result.ownerUserId);
    headers = { "set-cookie": sessionCookie(session.token, input.context.config.cookieSecure === true) };
  }
  return {
    status: 201,
    data: {
      ...result.organization,
      ownerUserId: result.ownerUserId,
      ownerMembershipId: result.ownerMembershipId,
    },
    ...(headers ? { headers } : {}),
  };
}

export async function listIntegrationsHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  await requireMembership(input, input.params.organizationId ?? "");
  return {
    status: 200,
    data: { items: await listIntegrations(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function createPatIntegrationHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const organizationId = requiredString(body, "organizationId");
  const principal = await requireMembership(input, organizationId, ["owner", "admin"]);
  const encryptionKey = input.context.config.credentialEncryptionKey;
  if (!encryptionKey) {
    throw new HttpError(500, "credential_key_missing", "Credential encryption key is not configured.");
  }

  const provider = parseProvider(requiredString(body, "provider"));
  const token = requiredString(body, "token").trim();
  if (!token) {
    throw new HttpError(400, "invalid_token", "Provider token must not be empty.");
  }
  let verified;
  try { verified = await verifyProviderToken(provider, token); } catch (error) { throw new HttpError(400, "invalid_token", error instanceof Error ? error.message : "Invalid provider token."); }
  const result = await addPersonalAccessTokenIntegrationService(input.context.database, {
    id: optionalString(body, "id"),
    credentialId: optionalString(body, "credentialId"),
    organizationId,
    userId: principal.userId,
    provider,
    displayName: optionalString(body, "displayName") ?? optionalString(body, "name") ?? verified.displayName,
    token,
    encryptionKey,
  });

  return {
    status: 201,
    data: result,
  };
}

export async function listIntegrationResourcesHandler(input: HandlerInput): Promise<HandlerResult> {
  const organizationId = input.url.searchParams.get("organizationId");
  if (!organizationId) throw new HttpError(400, "invalid_request", "Missing required query parameter: organizationId.");
  await requireMembership(input, organizationId);
  const [integration] = await input.context.database.select().from(integrations).where(and(eq(integrations.id, input.params.integrationId ?? ""), eq(integrations.organizationId, organizationId))).limit(1);
  if (!integration) throw new HttpError(404, "not_found", "Integration not found.");
  const [credential] = await input.context.database.select().from(integrationCredentials).where(eq(integrationCredentials.integrationId, integration.id)).limit(1);
  if (!credential) throw new HttpError(404, "not_found", "Integration credential not found.");
  const key = input.context.config.credentialEncryptionKey;
  if (!key) throw new HttpError(500, "credential_key_missing", "Credential encryption key is not configured.");
  const token = decryptCredentialSecret(credential.encryptedSecret, key);
  const provider = integration.provider as Provider;
  return provider === "github"
    ? { status: 200, data: { provider, discovery: await discoverProviderResources("github", token) } }
    : { status: 200, data: { provider, discovery: await discoverProviderResources("linear", token) } };
}

export async function setSyncScopeSelectionHandler(input: HandlerInput): Promise<HandlerResult> {
  const body = assertRecord(await readJsonBody(input.context.request)); const organizationId = requiredString(body, "organizationId"); const principal = await requireMembership(input, organizationId, ["owner", "admin"]);
  const [integration] = await input.context.database.select().from(integrations).where(and(eq(integrations.id, input.params.integrationId ?? ""), eq(integrations.organizationId, organizationId))).limit(1);
  if (!integration) throw new HttpError(404, "not_found", "Integration not found.");
  const [credential] = await input.context.database.select().from(integrationCredentials).where(eq(integrationCredentials.integrationId, integration.id)).limit(1);
  const key = input.context.config.credentialEncryptionKey; if (!credential || !key) throw new HttpError(500, "credential_key_missing", "Integration credential is unavailable.");
  try {
    const provider = integration.provider as Provider; const token = decryptCredentialSecret(credential.encryptedSecret, key);
    if (provider === "github") { const selection = assertRecord(body.selection); const organizations: Array<{ organizationId: string; mode: "all" } | { organizationId: string; mode: "selected"; repositoryIds: string[] }> = Array.isArray(selection.organizations) ? selection.organizations.map(item => { const value = assertRecord(item); const mode = requiredString(value, "mode"); if (mode === "all") return { organizationId: requiredString(value, "organizationId"), mode }; if (mode === "selected") return { organizationId: requiredString(value, "organizationId"), mode, repositoryIds: arrayOfStrings(value.repositoryIds, "repositoryIds") }; throw new HttpError(400, "invalid_request", "Invalid GitHub organization selection mode."); }) : (() => { throw new HttpError(400, "invalid_request", "selection.organizations must be an array."); })(); const items = await setGitHubScopeSelectionService(input.context.database, { organizationId, userId: principal.userId, integrationId: integration.id, provider, selection: { organizations, repositoryIds: arrayOfStrings(selection.repositoryIds, "repositoryIds") }, discovery: await discoverProviderResources("github", token) }); return { status: 200, data: { items } }; }
    const selection = assertRecord(body.selection); const mode = requiredString(selection, "mode"); if (mode !== "all" && mode !== "selected") throw new HttpError(400, "invalid_request", "Invalid Linear selection mode."); const items = await setLinearScopeSelectionService(input.context.database, { organizationId, userId: principal.userId, integrationId: integration.id, provider, selection: mode === "all" ? { mode } : { mode, teamIds: arrayOfStrings(selection.teamIds, "teamIds") }, discovery: await discoverProviderResources("linear", token) }); return { status: 200, data: { items } };
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "provider_discovery_failed", error instanceof Error ? error.message : "Could not validate provider selection."); }
}

export async function listSyncScopesHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  await requireMembership(input, input.params.organizationId ?? "");
  return {
    status: 200,
    data: { items: await listSyncScopes(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function createSyncScopeHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const organizationId = requiredString(body, "organizationId");
  const principal = await requireMembership(input, organizationId, ["owner", "admin"]);
  const result = await addSyncScopeService(input.context.database, {
    id: optionalString(body, "id"),
    organizationId,
    userId: principal.userId,
    integrationId: requiredString(body, "integrationId"),
    provider: parseProvider(requiredString(body, "provider")),
    scopeType: requiredString(body, "scopeType") as SyncScopeDto["scopeType"],
    externalId: optionalString(body, "externalId"),
    externalName: requiredString(body, "externalName"),
    config: optionalJsonObject(body, "config") ?? {},
    enabled: optionalBoolean(body, "enabled"),
  });

  return { status: 201, data: result };
}

export async function listReportsHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  await requireMembership(input, input.params.organizationId ?? "");
  return {
    status: 200,
    data: { items: await listReports(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function getReportHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const organizationId = input.url.searchParams.get("organizationId");
  if (!organizationId) {
    throw new HttpError(400, "invalid_request", "Missing required query parameter: organizationId.");
  }
  await requireMembership(input, organizationId);

  const report = await getReportDto(input.context.database, organizationId, input.params.reportId ?? "");
  if (!report) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  return { status: 200, data: report };
}

export async function createWeeklyReportHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const organizationId = requiredString(body, "organizationId");
  const principal = await requireMembership(input, organizationId);
  const persist = optionalBoolean(body, "persist");
  const result = await generateWeeklyReportFromRequestService(input.context.database, {
    organizationId,
    organizationName: optionalString(body, "organizationName"),
    scopeType: optionalReportScopeType(body, "scopeType"),
    scopeId: optionalString(body, "scopeId"),
    scopeName: optionalString(body, "scopeName"),
    periodStart: requiredString(body, "periodStart"),
    periodEnd: requiredString(body, "periodEnd"),
    title: optionalString(body, "title"),
    persist: persist ?? true,
  }, { createdByUserId: principal.userId });

  return {
    status: persist === false ? 200 : 201,
    data: {
      report: result.report,
      inputs: result.inputs,
    },
  };
}

export async function dashboardHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const organizationId = input.url.searchParams.get("organizationId");
  if (!organizationId) {
    throw new HttpError(400, "invalid_request", "Missing required query parameter: organizationId.");
  }
  await requireMembership(input, organizationId);

  const dashboard = await getDashboard(input.context.database, organizationId, requirePrincipal(input).userId);
  if (!dashboard) {
    throw new HttpError(404, "not_found", "Organization not found.");
  }

  return { status: 200, data: dashboard as unknown as JsonObject };
}

export async function triggerSyncHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const provider = parseProvider(input.params.provider ?? "");
  const body = input.context.request.method === "POST" ? assertRecord(await readJsonBody(input.context.request)) : {};
  const organizationId = requiredString(body, "organizationId");
  await requireMembership(input, organizationId);
  const encryptionKey = input.context.config.credentialEncryptionKey;
  if (!encryptionKey) {
    throw new HttpError(500, "credential_key_missing", "Credential encryption key is not configured.");
  }

  const result = await runProviderSyncService(input.context.database, {
    provider,
    organizationId,
    integrationId: optionalString(body, "integrationId"),
    syncScopeId: optionalString(body, "syncScopeId"),
    encryptionKey,
  });

  return { status: result.status === "failed" ? 500 : 200, data: result as unknown as JsonObject };
}

function parseProvider(value: string): Provider {
  if (value !== "github" && value !== "linear") {
    throw new HttpError(400, "unsupported_provider", `Unsupported provider: ${value}.`);
  }
  return value;
}

function arrayOfStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new HttpError(400, "invalid_request", `${name} must be an array of strings.`);
  return value;
}

function optionalReportScopeType(record: Record<string, unknown>, key: string): ReportScopeType | undefined {
  const value = optionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (
    value !== "organization" &&
    value !== "person" &&
    value !== "github_repository" &&
    value !== "linear_team" &&
    value !== "linear_project"
  ) {
    throw new HttpError(400, "invalid_request", `Unsupported report scope type: ${value}.`);
  }
  return value;
}

function requirePrincipal(input: HandlerInput): AuthPrincipal {
  if (!input.context.principal) throw new HttpError(401, "unauthorized", "Authentication is required.");
  return input.context.principal;
}

async function requireMembership(
  input: HandlerInput,
  organizationId: string,
  allowedRoles?: readonly string[],
): Promise<AuthPrincipal> {
  const principal = requirePrincipal(input);
  const [row] = await input.context.database.select({ role: organizationMemberships.role }).from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, principal.userId), eq(organizationMemberships.status, "active"))).limit(1);
  if (!row || (allowedRoles && !allowedRoles.includes(row.role))) {
    throw new HttpError(403, "forbidden", "You do not have permission to access this organization.");
  }
  return principal;
}

async function userCount(database: ApiContext["database"]): Promise<number> {
  const [row] = await database.select({ value: count() }).from(users);
  return row?.value ?? 0;
}

function principalDto(principal: AuthPrincipal): JsonObject {
  return { id: principal.userId, email: principal.email ?? "", displayName: principal.displayName };
}

function validateBootstrapPassword(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < 8 || bytes > 1_024) {
    throw new HttpError(400, "invalid_request", "Password must contain between 8 and 1024 UTF-8 bytes.");
  }
}

function sessionCookie(token: string, secure: boolean): string {
  return `teamtales_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure: boolean): string {
  return `teamtales_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

function requestCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function mapApiToken(value: unknown): JsonObject {
  const row = value as Record<string, unknown>;
  const read = (snake: string, camel: string): unknown => row[snake] ?? row[camel];
  const id = read("id", "id");
  const name = read("name", "name");
  const prefix = read("token_prefix", "prefix");
  const createdAt = read("created_at", "createdAt");
  if (typeof id !== "string" || typeof name !== "string" || typeof prefix !== "string" || !(typeof createdAt === "string" || createdAt instanceof Date)) {
    throw new HttpError(500, "internal_error", "Invalid API token record.");
  }
  const expiresAt = read("expires_at", "expiresAt");
  const lastUsedAt = read("last_used_at", "lastUsedAt");
  return {
    id,
    name,
    prefix,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    ...((typeof expiresAt === "string" || expiresAt instanceof Date)
      ? { expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt }
      : {}),
    ...((typeof lastUsedAt === "string" || lastUsedAt instanceof Date)
      ? { lastUsedAt: lastUsedAt instanceof Date ? lastUsedAt.toISOString() : lastUsedAt }
      : {}),
  };
}
