import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/mysql.js";

import type { ApiConfig } from "./config.js";
import { dispatchRoute } from "./router.js";
import { writeData, writeError } from "./http.js";

export interface CreateApiServerOptions {
  config: ApiConfig;
  database: AppDatabase;
  uiDirectory?: string;
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
    if (!url.pathname.startsWith("/api/")) {
      serveUi(response, options.uiDirectory ?? join(process.cwd(), "packages/ui/dist"), url.pathname);
      return;
    }
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

function serveUi(response: ServerResponse, directory: string, pathname: string): void {
  const root = resolve(directory);
  let requested: string;
  try { requested = decodeURIComponent(pathname); } catch { requested = "/"; }
  let filename = resolve(root, `.${requested === "/" ? "/index.html" : requested}`);
  const containment = relative(root, filename);
  if (containment === ".." || containment.startsWith(`..${sep}`) || filename === root || !existsSync(filename) || statSync(filename).isDirectory()) filename = join(root, "index.html");
  if (!existsSync(filename)) { response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); response.end("TeamTales UI has not been built."); return; }
  const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
  response.writeHead(200, { "content-type": contentTypes[extname(filename)] ?? "application/octet-stream", "cache-control": extname(filename) === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
  createReadStream(filename).pipe(response);
}
