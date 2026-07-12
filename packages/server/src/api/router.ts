import type { IncomingMessage } from "node:http";
import type { AppDatabase } from "../db/mysql.js";
import type { AuthPrincipal } from "../auth/index.js";

import type { ApiConfig } from "./config.js";
import type { Handler, HandlerResult } from "./handlers.js";
import {
  createApiTokenHandler,
  cancelSyncRunHandler,
  createOrganizationHandler,
  createPatIntegrationHandler,
  createSyncScopeHandler,
  createWeeklyReportHandler,
  dashboardHandler,
  getSyncRunHandler,
  getReportHandler,
  getSourceObjectHandler,
  healthHandler,
  listApiTokensHandler,
  listIntegrationsHandler,
  listIntegrationResourcesHandler,
  listOrganizationsHandler,
  listReportsHandler,
  listSourceObjectsHandler,
  listSyncScopesHandler,
  listSyncRunResourcesHandler,
  loginHandler,
  logoutHandler,
  meHandler,
  revokeApiTokenHandler,
  triggerSyncHandler,
  organizationSyncStatusHandler,
  setSyncScopeSelectionHandler,
} from "./handlers.js";
import { HttpError } from "./http.js";
import { resolveApiToken, resolveSession } from "../auth/index.js";

export type RouteParams = Record<string, string>;

export interface ApiContext {
  config: ApiConfig;
  database: AppDatabase;
  request: IncomingMessage;
  principal?: AuthPrincipal;
  authKind?: "session" | "api_token";
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  public?: boolean;
}

const routes: Route[] = [
  route("GET", "/api/health", healthHandler, true),
  route("POST", "/api/auth/login", loginHandler, true),
  route("POST", "/api/auth/logout", logoutHandler, true),
  route("GET", "/api/auth/me", meHandler, true),
  route("GET", "/api/auth/tokens", listApiTokensHandler),
  route("POST", "/api/auth/tokens", createApiTokenHandler),
  route("DELETE", "/api/auth/tokens/:tokenId", revokeApiTokenHandler),
  route("GET", "/api/organizations", listOrganizationsHandler),
  route("POST", "/api/organizations", createOrganizationHandler, true),
  route("GET", "/api/organizations/:organizationId/integrations", listIntegrationsHandler),
  route("POST", "/api/integrations/pat", createPatIntegrationHandler),
  route("GET", "/api/integrations/:integrationId/resources", listIntegrationResourcesHandler),
  route("PUT", "/api/integrations/:integrationId/sync-scopes", setSyncScopeSelectionHandler),
  route("GET", "/api/organizations/:organizationId/sync-scopes", listSyncScopesHandler),
  route("GET", "/api/organizations/:organizationId/sync-status", organizationSyncStatusHandler),
  route("POST", "/api/sync-scopes", createSyncScopeHandler),
  route("GET", "/api/organizations/:organizationId/reports", listReportsHandler),
  route("GET", "/api/organizations/:organizationId/source-objects", listSourceObjectsHandler),
  route("GET", "/api/reports/:reportId", getReportHandler),
  route("GET", "/api/source-objects/:sourceObjectId", getSourceObjectHandler),
  route("POST", "/api/reports/weekly", createWeeklyReportHandler),
  route("GET", "/api/dashboard", dashboardHandler),
  route("POST", "/api/sync/:provider", triggerSyncHandler),
  route("GET", "/api/sync-runs/:syncRunId", getSyncRunHandler),
  route("POST", "/api/sync-runs/:syncRunId/cancel", cancelSyncRunHandler),
  route("GET", "/api/sync-runs/:syncRunId/resources", listSyncRunResourcesHandler),
];

export async function dispatchRoute(context: ApiContext, url: URL): Promise<HandlerResult> {
  const method = context.request.method ?? "GET";
  const pathname = normalizePathname(url.pathname);

  for (const candidate of routes) {
    if (candidate.method !== method) {
      continue;
    }
    const match = candidate.pattern.exec(pathname);
    if (!match) {
      continue;
    }

    const params: RouteParams = {};
    candidate.paramNames.forEach((name, index) => {
      const value = match[index + 1];
      if (value !== undefined) {
        params[name] = decodeURIComponent(value);
      }
    });

    const authenticated = await authenticateRequest(context);
    context.principal = authenticated?.principal;
    context.authKind = authenticated?.kind;
    if (!candidate.public && !context.principal) {
      throw new HttpError(401, "unauthorized", "Authentication is required.");
    }
    if (context.authKind === "session" && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      enforceSameOrigin(context);
    }

    return candidate.handler({ context, params, url });
  }

  throw new HttpError(404, "not_found", "Route not found.");
}

function route(method: string, path: string, handler: Handler, isPublic = false): Route {
  const paramNames: string[] = [];
  const pattern = path
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        paramNames.push(part.slice(1));
        return "([^/]+)";
      }
      return escapeRegExp(part);
    })
    .join("/");

  return {
    method,
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler,
    public: isPublic,
  };
}

async function authenticateRequest(
  context: ApiContext,
): Promise<{ principal: AuthPrincipal; kind: "session" | "api_token" } | undefined> {
  const authorization = context.request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match?.[1]) throw new HttpError(401, "invalid_token", "Invalid bearer token.");
    const principal = await resolveApiToken(context.database, match[1]);
    if (!principal) throw new HttpError(401, "invalid_token", "Invalid or expired bearer token.");
    return { principal, kind: "api_token" };
  }
  const cookie = parseCookies(context.request.headers.cookie)["teamtales_session"];
  if (!cookie) return undefined;
  const principal = await resolveSession(context.database, cookie);
  return principal ? { principal, kind: "session" } : undefined;
}

function enforceSameOrigin(context: ApiContext): void {
  const origin = context.request.headers.origin;
  const expected =
    context.config.publicOrigin ?? `http://${context.request.headers.host ?? "localhost"}`;
  if (!origin || normalizeOrigin(origin) !== normalizeOrigin(expected)) {
    throw new HttpError(403, "csrf_rejected", "Request origin is not allowed.");
  }
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [part.trim(), ""];
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }),
  );
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
