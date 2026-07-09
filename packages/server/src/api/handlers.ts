import type { JsonObject, JsonValue, SyncScopeDto } from "@teamtales/common/api";
import type { Provider, ReportScopeType } from "@teamtales/common/domain";
import type { AuthPrincipal } from "../auth/index.js";

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
} from "../services/index.js";
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
    principal = authenticatePassword(
      input.context.database,
      requiredString(body, "email"),
      requiredString(body, "password"),
    );
  } catch {
    principal = undefined;
  }
  if (!principal) throw new HttpError(401, "invalid_credentials", "Invalid email or password.");
  const created = createSession(input.context.database, principal.userId);
  return {
    status: 200,
    data: { authenticated: true, bootstrapAllowed: false, user: principalDto(principal) },
    headers: {
      "set-cookie": sessionCookie(created.token, input.context.config.cookieSecure === true),
      "cache-control": "no-store",
    },
  };
}

export function logoutHandler(input: HandlerInput): HandlerResult {
  const token = requestCookie(input.context.request.headers.cookie, "teamtales_session");
  if (token) revokeSession(input.context.database, token);
  return {
    status: 200,
    data: { loggedOut: true },
    headers: {
      "set-cookie": clearSessionCookie(input.context.config.cookieSecure === true),
      "cache-control": "no-store",
    },
  };
}

export function meHandler(input: HandlerInput): HandlerResult {
  const bootstrapAllowed = userCount(input.context.database) === 0;
  if (!input.context.principal) {
    return { status: 200, data: { authenticated: false, bootstrapAllowed }, headers: { "cache-control": "no-store" } };
  }
  return {
    status: 200,
    data: { authenticated: true, bootstrapAllowed: false, user: principalDto(input.context.principal) },
    headers: { "cache-control": "no-store" },
  };
}

export function listApiTokensHandler(input: HandlerInput): HandlerResult {
  const userId = requirePrincipal(input).userId;
  const items = input.context.database
    .prepare(
      `SELECT id, name, token_prefix, created_at, expires_at, last_used_at FROM api_tokens
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id`,
    )
    .all(userId)
    .map(mapApiToken);
  return { status: 200, data: { items }, headers: { "cache-control": "no-store" } };
}

export async function createApiTokenHandler(input: HandlerInput): Promise<HandlerResult> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const expiresAtText = optionalString(body, "expiresAt");
  const expiresAt = expiresAtText ? new Date(expiresAtText) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new HttpError(400, "invalid_request", "expiresAt must be a valid date.");
  }
  let created: ReturnType<typeof createApiToken>;
  try {
    created = createApiToken(input.context.database, requirePrincipal(input).userId, {
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

export function revokeApiTokenHandler(input: HandlerInput): HandlerResult {
  const tokenId = input.params.tokenId ?? "";
  const owned = input.context.database.prepare("SELECT id FROM api_tokens WHERE id = ? AND user_id = ?").get(
    tokenId,
    requirePrincipal(input).userId,
  );
  if (!owned) throw new HttpError(404, "not_found", "API token not found.");
  revokeApiToken(input.context.database, tokenId);
  return { status: 200, data: { revoked: true } };
}

export function healthHandler(input: HandlerInput): { status: number; data: JsonValue } {
  input.context.database.prepare("SELECT 1").get();
  return { status: 200, data: { status: "ok", service: "teamtales-api", database: "ok" } };
}

export function listOrganizationsHandler(input: HandlerInput): { status: number; data: JsonValue } {
  return { status: 200, data: { items: listOrganizations(input.context.database, requirePrincipal(input).userId) } };
}

export async function createOrganizationHandler(input: HandlerInput): Promise<HandlerResult> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const owner = body.owner === undefined ? {} : assertRecord(body.owner);
  const bootstrap = userCount(input.context.database) === 0;
  const principal = input.context.principal;
  if (!bootstrap && !principal) throw new HttpError(401, "unauthorized", "Authentication is required.");
  const ownerEmail = bootstrap ? requiredString(owner, "primaryEmail") : principal!.email ?? undefined;
  const ownerName = bootstrap ? optionalString(owner, "displayName") : principal!.displayName;
  if (bootstrap) validateBootstrapPassword(requiredString(owner, "password"));
  const result = createOrganizationService(input.context.database, {
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
    setPassword(input.context.database, result.ownerUserId, requiredString(owner, "password"));
    const session = createSession(input.context.database, result.ownerUserId);
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

export function listIntegrationsHandler(input: HandlerInput): { status: number; data: JsonValue } {
  requireMembership(input, input.params.organizationId ?? "");
  return {
    status: 200,
    data: { items: listIntegrations(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function createPatIntegrationHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const organizationId = requiredString(body, "organizationId");
  const principal = requireMembership(input, organizationId, ["owner", "admin"]);
  const encryptionKey = input.context.config.credentialEncryptionKey;
  if (!encryptionKey) {
    throw new HttpError(500, "credential_key_missing", "Credential encryption key is not configured.");
  }

  const result = addPersonalAccessTokenIntegrationService(input.context.database, {
    id: optionalString(body, "id"),
    credentialId: optionalString(body, "credentialId"),
    organizationId,
    userId: principal.userId,
    provider: parseProvider(requiredString(body, "provider")),
    displayName: optionalString(body, "displayName") ?? optionalString(body, "name"),
    token: requiredString(body, "token"),
    encryptionKey,
  });

  return {
    status: 201,
    data: result,
  };
}

export function listSyncScopesHandler(input: HandlerInput): { status: number; data: JsonValue } {
  requireMembership(input, input.params.organizationId ?? "");
  return {
    status: 200,
    data: { items: listSyncScopes(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function createSyncScopeHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const organizationId = requiredString(body, "organizationId");
  const principal = requireMembership(input, organizationId, ["owner", "admin"]);
  const result = addSyncScopeService(input.context.database, {
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

export function listReportsHandler(input: HandlerInput): { status: number; data: JsonValue } {
  requireMembership(input, input.params.organizationId ?? "");
  return {
    status: 200,
    data: { items: listReports(input.context.database, input.params.organizationId ?? "") },
  };
}

export function getReportHandler(input: HandlerInput): { status: number; data: JsonValue } {
  const organizationId = input.url.searchParams.get("organizationId");
  if (!organizationId) {
    throw new HttpError(400, "invalid_request", "Missing required query parameter: organizationId.");
  }
  requireMembership(input, organizationId);

  const report = getReportDto(input.context.database, organizationId, input.params.reportId ?? "");
  if (!report) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  return { status: 200, data: report };
}

export async function createWeeklyReportHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const organizationId = requiredString(body, "organizationId");
  const principal = requireMembership(input, organizationId);
  const persist = optionalBoolean(body, "persist");
  const result = generateWeeklyReportFromRequestService(input.context.database, {
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

export function dashboardHandler(input: HandlerInput): { status: number; data: JsonValue } {
  const organizationId = input.url.searchParams.get("organizationId");
  if (!organizationId) {
    throw new HttpError(400, "invalid_request", "Missing required query parameter: organizationId.");
  }
  requireMembership(input, organizationId);

  const dashboard = getDashboard(input.context.database, organizationId, requirePrincipal(input).userId);
  if (!dashboard) {
    throw new HttpError(404, "not_found", "Organization not found.");
  }

  return { status: 200, data: dashboard as unknown as JsonObject };
}

export async function triggerSyncHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const provider = parseProvider(input.params.provider ?? "");
  const body = input.context.request.method === "POST" ? assertRecord(await readJsonBody(input.context.request)) : {};
  const organizationId = requiredString(body, "organizationId");
  requireMembership(input, organizationId);
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

function requireMembership(
  input: HandlerInput,
  organizationId: string,
  allowedRoles?: readonly string[],
): AuthPrincipal {
  const principal = requirePrincipal(input);
  const row = input.context.database
    .prepare(
      `SELECT role FROM organization_memberships
       WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
    )
    .get(organizationId, principal.userId) as { role: string } | undefined;
  if (!row || (allowedRoles && !allowedRoles.includes(row.role))) {
    throw new HttpError(403, "forbidden", "You do not have permission to access this organization.");
  }
  return principal;
}

function userCount(database: ApiContext["database"]): number {
  return (database.prepare("SELECT count(*) AS count FROM users").get() as { count: number }).count;
}

function principalDto(principal: AuthPrincipal): JsonObject {
  return { id: principal.userId, email: principal.email ?? "", displayName: principal.displayName };
}

function validateBootstrapPassword(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < 12 || bytes > 1_024) {
    throw new HttpError(400, "invalid_request", "Password must contain between 12 and 1024 UTF-8 bytes.");
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
