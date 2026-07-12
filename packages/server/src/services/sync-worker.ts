import { logger } from "../api/logger.js";
import type { AppDatabase } from "../db/mysql.js";
import { processQueuedProviderSyncBatch } from "./sync-runs.js";

export interface ProviderSyncWorker {
  stop(): void;
}

export function startProviderSyncWorker(options: {
  database: AppDatabase;
  encryptionKey: string | Buffer;
  batchSize?: number;
  idlePollMs?: number;
}): ProviderSyncWorker {
  const batchSize = options.batchSize ?? 3;
  const idlePollMs = options.idlePollMs ?? 1_000;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let processing = false;
  const poll = async (): Promise<void> => {
    if (stopped || processing) return;
    processing = true;
    try {
      const processed = await processQueuedProviderSyncBatch(
        options.database,
        options.encryptionKey,
        {
          limit: batchSize,
        },
      );
      if (processed > 0) logger.debug({ processed }, "Provider sync worker processed a batch");
      if (!stopped) timer = setTimeout(poll, processed > 0 ? 0 : idlePollMs);
    } catch (error) {
      logger.error({ err: error }, "Provider sync worker batch failed");
      if (!stopped) timer = setTimeout(poll, idlePollMs);
    } finally {
      processing = false;
    }
  };
  logger.info({ batchSize, idlePollMs }, "Provider sync worker started");
  void poll();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      logger.info("Provider sync worker stopped");
    },
  };
}
