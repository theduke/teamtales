import mysql, { type PoolOptions } from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { schema } from "./schema.js";

export type AppDatabase = MySql2Database<typeof schema>;
export type MySqlTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type DbExecutor = AppDatabase | MySqlTransaction;

export interface OpenDatabaseOptions {
  env?: NodeJS.ProcessEnv;
  runMigrations?: boolean;
  migrationsFolder?: string;
}
export interface OpenDatabaseResult {
  db: AppDatabase;
  close(): Promise<void>;
}

export function mysqlConnectionOptions(env: NodeJS.ProcessEnv = process.env): PoolOptions {
  if (env.DATABASE_URL)
    return { uri: env.DATABASE_URL, connectionLimit: 10, enableKeepAlive: true };
  const host = env.DB_HOST;
  const user = env.DB_USERNAME ?? env.DB_USER;
  const database = env.DB_NAME;
  if (!host || !user || !database)
    throw new Error("Set DATABASE_URL or DB_HOST, DB_USER/DB_USERNAME, and DB_NAME for MySQL.");
  const port = Number(env.DB_PORT ?? "3306");
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("DB_PORT must be a valid TCP port.");
  return {
    host,
    port,
    user,
    password: env.DB_PASSWORD ?? "",
    database,
    connectionLimit: 10,
    enableKeepAlive: true,
  };
}

export function resolveMigrationsFolder(cwd = process.cwd(), moduleUrl = import.meta.url): string {
  const candidates = [
    join(cwd, "packages/server/drizzle"),
    join(cwd, "drizzle"),
    fileURLToPath(new URL("../../drizzle", moduleUrl)),
    fileURLToPath(new URL("../drizzle", moduleUrl)),
  ];
  const folder = candidates.find((candidate) => existsSync(candidate));
  if (!folder)
    throw new Error(`Could not find Drizzle migrations. Checked: ${candidates.join(", ")}`);
  return folder;
}

/** Production is opt-in; set TEAMTALES_AUTO_MIGRATE=true for local development. */
export function migrationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TEAMTALES_AUTO_MIGRATE;
  if (value === undefined || value === "") return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("TEAMTALES_AUTO_MIGRATE must be true/false or 1/0.");
}

export async function openDatabase(options: OpenDatabaseOptions = {}): Promise<OpenDatabaseResult> {
  const env = options.env ?? process.env;
  const connectionOptions = mysqlConnectionOptions(env);
  if (options.runMigrations ?? migrationsEnabled(env)) {
    const migrationPool = mysql.createPool({ ...connectionOptions, connectionLimit: 2 });
    try {
      const migrationDb = drizzle({ client: migrationPool, schema, mode: "default" });
      const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
      await migrationPool.query(
        "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (`id` int NOT NULL AUTO_INCREMENT, `hash` text NOT NULL, `created_at` bigint, `name` text NOT NULL, PRIMARY KEY (`id`))",
      );
      await migrate(migrationDb, { migrationsFolder });
    } finally {
      await migrationPool.end();
    }
  }
  const pool = mysql.createPool(connectionOptions);
  const db = drizzle({ client: pool, schema, mode: "default" });
  return { db, close: () => pool.end() };
}
