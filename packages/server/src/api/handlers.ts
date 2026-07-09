import type { JsonObject, JsonValue, SyncScopeDto } from "@teamtales/common/api";
import type { Provider, ReportScopeType } from "@teamtales/common/domain";

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

export interface HandlerInput {
  context: ApiContext;
  params: RouteParams;
  url: URL;
}

export type Handler = (input: HandlerInput) => Promise<{ status: number; data: JsonValue }> | { status: number; data: JsonValue };

export function healthHandler(input: HandlerInput): { status: number; data: JsonValue } {
  input.context.database.prepare("SELECT 1").get();
  return { status: 200, data: { status: "ok", service: "teamtales-api", database: "ok" } };
}

export function listOrganizationsHandler(input: HandlerInput): { status: number; data: JsonValue } {
  return { status: 200, data: { items: listOrganizations(input.context.database) } };
}

export async function createOrganizationHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const owner = body.owner === undefined ? {} : assertRecord(body.owner);
  const result = createOrganizationService(input.context.database, {
    id: optionalString(body, "id"),
    name: requiredString(body, "name"),
    slug: optionalString(body, "slug"),
    ownerId: optionalString(owner, "id") ?? optionalString(body, "ownerId"),
    ownerName: optionalString(owner, "displayName") ?? optionalString(body, "ownerName"),
    ownerEmail: optionalString(owner, "primaryEmail") ?? optionalString(body, "ownerEmail"),
    membershipId: optionalString(body, "membershipId"),
  });

  return {
    status: 201,
    data: {
      ...result.organization,
      ownerUserId: result.ownerUserId,
      ownerMembershipId: result.ownerMembershipId,
    },
  };
}

export function listIntegrationsHandler(input: HandlerInput): { status: number; data: JsonValue } {
  return {
    status: 200,
    data: { items: listIntegrations(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function createPatIntegrationHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const encryptionKey = input.context.config.credentialEncryptionKey;
  if (!encryptionKey) {
    throw new HttpError(500, "credential_key_missing", "Credential encryption key is not configured.");
  }

  const result = addPersonalAccessTokenIntegrationService(input.context.database, {
    id: optionalString(body, "id"),
    credentialId: optionalString(body, "credentialId"),
    organizationId: requiredString(body, "organizationId"),
    userId: requiredString(body, "userId"),
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
  return {
    status: 200,
    data: { items: listSyncScopes(input.context.database, input.params.organizationId ?? "") },
  };
}

export async function createSyncScopeHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const result = addSyncScopeService(input.context.database, {
    id: optionalString(body, "id"),
    organizationId: requiredString(body, "organizationId"),
    userId: requiredString(body, "userId"),
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

  const report = getReportDto(input.context.database, organizationId, input.params.reportId ?? "");
  if (!report) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  return { status: 200, data: report };
}

export async function createWeeklyReportHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const body = assertRecord(await readJsonBody(input.context.request));
  const persist = optionalBoolean(body, "persist");
  const result = generateWeeklyReportFromRequestService(input.context.database, {
    organizationId: requiredString(body, "organizationId"),
    organizationName: optionalString(body, "organizationName"),
    scopeType: optionalReportScopeType(body, "scopeType"),
    scopeId: optionalString(body, "scopeId"),
    scopeName: optionalString(body, "scopeName"),
    periodStart: requiredString(body, "periodStart"),
    periodEnd: requiredString(body, "periodEnd"),
    title: optionalString(body, "title"),
    persist: persist ?? true,
  });

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

  const dashboard = getDashboard(input.context.database, organizationId);
  if (!dashboard) {
    throw new HttpError(404, "not_found", "Organization not found.");
  }

  return { status: 200, data: dashboard as unknown as JsonObject };
}

export async function triggerSyncHandler(input: HandlerInput): Promise<{ status: number; data: JsonValue }> {
  const provider = parseProvider(input.params.provider ?? "");
  const body = input.context.request.method === "POST" ? assertRecord(await readJsonBody(input.context.request)) : {};
  const encryptionKey = input.context.config.credentialEncryptionKey;
  if (!encryptionKey) {
    throw new HttpError(500, "credential_key_missing", "Credential encryption key is not configured.");
  }

  const result = await runProviderSyncService(input.context.database, {
    provider,
    organizationId: optionalString(body, "organizationId"),
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
