import type { AppDatabase, MySqlTransaction } from "../db/mysql.js";

export type PersistenceDatabase = AppDatabase | MySqlTransaction;

export function withTransaction<T>(
  database: PersistenceDatabase,
  callback: (transaction: MySqlTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(callback);
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJsonValue(json: string): unknown {
  return JSON.parse(json) as unknown;
}

export function parseJsonObject(json: string): Record<string, unknown> {
  const value = parseJsonValue(json);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}
