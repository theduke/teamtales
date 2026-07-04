export interface ApiConfig {
  host: string;
  port: number;
  databaseFilename: string;
  credentialEncryptionKey?: string;
}

export function createApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    host: env.TEAMTALES_API_HOST ?? "127.0.0.1",
    port: parsePort(env.PORT ?? env.TEAMTALES_API_PORT ?? "8787"),
    databaseFilename: env.TEAMTALES_DB ?? "teamtales.sqlite",
    credentialEncryptionKey: env.TEAMTALES_CREDENTIAL_KEY,
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid API port: ${value}`);
  }
  return port;
}
