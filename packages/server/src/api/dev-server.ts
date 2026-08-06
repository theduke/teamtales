#!/usr/bin/env -S tsx
import { pathToFileURL } from "node:url";

import { openDatabase } from "../db/index.js";
import { createApiConfig } from "./config.js";
import { createApiServer } from "./server.js";
import { logger } from "./logger.js";
import { startProviderSyncWorker } from "../services/sync-worker.js";

export async function startDevServer(
  env: NodeJS.ProcessEnv = process.env,
  options: { runMigrations?: boolean } = {},
): Promise<void> {
  const config = createApiConfig(env);
  const database = await openDatabase({ env, runMigrations: options.runMigrations });
  const server = createApiServer({ config, database: database.db });
  const worker =
    config.syncWorkerEnabled && config.credentialEncryptionKey
      ? startProviderSyncWorker({
          database: database.db,
          encryptionKey: config.credentialEncryptionKey,
          batchSize: config.syncWorkerBatchSize,
        })
      : undefined;
  if (config.syncWorkerEnabled && !config.credentialEncryptionKey)
    logger.warn("Provider sync worker is enabled but TEAMTALES_CREDENTIAL_KEY is not configured.");

  server.listen(config.port, config.host, () => {
    logger.info(`TeamTales API listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (): void => {
    worker?.stop();
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
