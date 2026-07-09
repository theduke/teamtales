import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "./sqlite.js";

export interface Migration {
  filename: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  filename: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationResult {
  applied: AppliedMigration[];
  skipped: AppliedMigration[];
}

export function loadMigrations(migrationsDir = defaultMigrationsDir()): Migration[] {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDir}`);
  }

  return files.map((filename) => {
    const sql = readFileSync(join(migrationsDir, filename), "utf8");

    return {
      filename,
      checksum: checksumSql(sql),
      sql,
    };
  });
}

export function runMigrations(database: AppDatabase | DatabaseSync, migrationsDir = defaultMigrationsDir()): MigrationResult {
  const sqlite = "$client" in database ? database.$client : database;
  sqlite.exec("PRAGMA foreign_keys = ON;");
  ensureMigrationsTable(database);

  const migrations = loadMigrations(migrationsDir);
  const appliedByName = new Map<string, AppliedMigration>();
  const existingRows = sqlite
    .prepare("SELECT filename, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY filename")
    .all()
    .map((row) => ({
      filename: String(row.filename),
      checksum: String(row.checksum),
      appliedAt: String(row.appliedAt),
    }));

  for (const row of existingRows) {
    appliedByName.set(row.filename, row);
  }

  const result: MigrationResult = {
    applied: [],
    skipped: [],
  };

  for (const migration of migrations) {
    const existing = appliedByName.get(migration.filename);

    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for ${migration.filename}`);
      }

      result.skipped.push(existing);
      continue;
    }

    const appliedAt = new Date().toISOString();

    sqlite.exec("BEGIN;");
    try {
      sqlite.exec(migration.sql);
      sqlite
        .prepare("INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)")
        .run(migration.filename, migration.checksum, appliedAt);
      sqlite.exec("COMMIT;");
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }

    result.applied.push({
      filename: migration.filename,
      checksum: migration.checksum,
      appliedAt,
    });
  }

  return result;
}

function ensureMigrationsTable(database: AppDatabase | DatabaseSync): void {
  const sqlite = "$client" in database ? database.$client : database;
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);
}

function checksumSql(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

function defaultMigrationsDir(): string {
  return join(process.cwd(), "db", "migrations");
}
