import type { DatabaseSync } from "node:sqlite";

export function withTransaction<T>(database: DatabaseSync, callback: () => T): T {
  if (database.isTransaction) {
    return callback();
  }

  database.exec("BEGIN;");
  try {
    const result = callback();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJsonValue(json: string): unknown {
  return JSON.parse(json) as unknown;
}

export function parseJsonObject(json: string): Record<string, unknown> {
  const value = parseJsonValue(json);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }

  return value as Record<string, unknown>;
}
