#!/usr/bin/env -S tsx
import { pathToFileURL } from "node:url";

import { openDatabase } from "../db/index.js";
import { createApiConfig } from "./config.js";
import { createApiServer } from "./server.js";

export async function startDevServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = createApiConfig(env);
  const database = await openDatabase({ env });
  const server = createApiServer({ config, database: database.db });

  server.listen(config.port, config.host, () => {
    process.stdout.write(`TeamTales API listening on http://${config.host}:${config.port}\n`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void database.close().finally(() => process.exit(0));
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await startDevServer();
}
