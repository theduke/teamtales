#!/usr/bin/env -S tsx
import { pathToFileURL } from "node:url";

import { openLocalDatabase } from "../db/index.js";
import { createApiConfig } from "./config.js";
import { createApiServer } from "./server.js";

export async function startDevServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = createApiConfig(env);
  const local = openLocalDatabase({ filename: config.databaseFilename, runMigrations: true });
  const server = createApiServer({ config, database: local.sqlite });

  server.listen(config.port, config.host, () => {
    process.stdout.write(`TeamTales API listening on http://${config.host}:${config.port}\n`);
  });

  const shutdown = (): void => {
    server.close(() => {
      local.close();
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await startDevServer();
}
