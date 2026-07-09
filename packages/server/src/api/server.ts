import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type { ApiConfig } from "./config.js";
import { dispatchRoute } from "./router.js";
import { writeData, writeError } from "./http.js";

export interface CreateApiServerOptions {
  config: ApiConfig;
  database: DatabaseSync;
}

export function createApiServer(options: CreateApiServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CreateApiServerOptions,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const result = await dispatchRoute(
      {
        config: options.config,
        database: options.database,
        request,
      },
      url,
    );
    for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
    writeData(response, result.status, result.data);
  } catch (error) {
    writeError(response, error);
  }
}
