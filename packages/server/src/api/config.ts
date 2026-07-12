export interface ApiConfig {
  host: string;
  port: number;
  credentialEncryptionKey?: string;
  cookieSecure?: boolean;
  publicOrigin?: string;
  syncWorkerEnabled: boolean;
  syncWorkerBatchSize: number;
}

export function createApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    host: env.TEAMTALES_API_HOST ?? "127.0.0.1",
    port: parsePort(env.PORT ?? env.TEAMTALES_API_PORT ?? "9100"),
    credentialEncryptionKey: env.TEAMTALES_CREDENTIAL_KEY,
    cookieSecure: parseBoolean(env.TEAMTALES_COOKIE_SECURE ?? "false"),
    publicOrigin: env.TEAMTALES_PUBLIC_ORIGIN,
    syncWorkerEnabled: parseBoolean(
      env.TEAMTALES_SYNC_WORKER ?? (env.NODE_ENV === "production" ? "false" : "true"),
    ),
    syncWorkerBatchSize: parsePositiveInteger(env.TEAMTALES_SYNC_WORKER_BATCH_SIZE ?? "3"),
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("TEAMTALES_SYNC_WORKER_BATCH_SIZE must be a positive integer.");
  }
  return parsed;
}

function parseBoolean(value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid API port: ${value}`);
  }
  return port;
}
