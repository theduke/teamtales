import { DatabaseSync } from "node:sqlite";

import { runMigrations, type MigrationResult } from "./migrations.js";

export interface OpenLocalDatabaseOptions {
  filename?: string;
  runMigrations?: boolean;
  migrationsDir?: string;
}

export interface LocalDatabase {
  filename: string;
  sqlite: DatabaseSync;
  migrations?: MigrationResult;
  close(): void;
}

export function openLocalDatabase(options: OpenLocalDatabaseOptions = {}): LocalDatabase {
  const filename = options.filename ?? ":memory:";
  const sqlite = new DatabaseSync(filename);

  sqlite.exec("PRAGMA foreign_keys = ON;");

  if (filename !== ":memory:") {
    sqlite.exec("PRAGMA journal_mode = WAL;");
  }

  const migrations = options.runMigrations ? runMigrations(sqlite, options.migrationsDir) : undefined;

  return {
    filename,
    sqlite,
    migrations,
    close() {
      sqlite.close();
    },
  };
}
