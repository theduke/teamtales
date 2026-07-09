import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type { ApiConfig } from "./config.js";
import type { Handler } from "./handlers.js";
import {
  createOrganizationHandler,
  createPatIntegrationHandler,
  createSyncScopeHandler,
  createWeeklyReportHandler,
  dashboardHandler,
  getReportHandler,
  healthHandler,
  listIntegrationsHandler,
  listOrganizationsHandler,
  listReportsHandler,
  listSyncScopesHandler,
  triggerSyncHandler,
} from "./handlers.js";
import { HttpError } from "./http.js";

export type RouteParams = Record<string, string>;

export interface ApiContext {
  config: ApiConfig;
  database: DatabaseSync;
  request: IncomingMessage;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [
  route("GET", "/api/health", healthHandler),
  route("GET", "/api/organizations", listOrganizationsHandler),
  route("POST", "/api/organizations", createOrganizationHandler),
  route("GET", "/api/organizations/:organizationId/integrations", listIntegrationsHandler),
  route("POST", "/api/integrations/pat", createPatIntegrationHandler),
  route("GET", "/api/organizations/:organizationId/sync-scopes", listSyncScopesHandler),
  route("POST", "/api/sync-scopes", createSyncScopeHandler),
  route("GET", "/api/organizations/:organizationId/reports", listReportsHandler),
  route("GET", "/api/reports/:reportId", getReportHandler),
  route("POST", "/api/reports/weekly", createWeeklyReportHandler),
  route("GET", "/api/dashboard", dashboardHandler),
  route("POST", "/api/sync/:provider", triggerSyncHandler),
];

export async function dispatchRoute(context: ApiContext, url: URL): Promise<{ status: number; data: import("@teamtales/common/api").JsonValue }> {
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

    return candidate.handler({ context, params, url });
  }

  throw new HttpError(404, "not_found", "Route not found.");
}

function route(method: string, path: string, handler: Handler): Route {
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
  };
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
