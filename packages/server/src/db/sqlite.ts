import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";

import { runMigrations, type MigrationResult } from "./migrations.js";
import { schema } from "./schema.js";

export type AppDatabase = NodeSQLiteDatabase<typeof schema> & { $client: DatabaseSync };

export interface OpenLocalDatabaseOptions {
  filename?: string;
  runMigrations?: boolean;
  migrationsDir?: string;
}

export interface LocalDatabase {
  filename: string;
  sqlite: DatabaseSync;
  db: AppDatabase;
  migrations?: MigrationResult;
  close(): void;
}

export function openLocalDatabase(options: OpenLocalDatabaseOptions = {}): LocalDatabase {
  const filename = options.filename ?? ":memory:";
  const sqlite = new DatabaseSync(filename);
  const db = drizzle({ client: sqlite, schema });

  sqlite.exec("PRAGMA foreign_keys = ON;");

  if (filename !== ":memory:") {
    sqlite.exec("PRAGMA journal_mode = WAL;");
  }

  const migrations = options.runMigrations ? runMigrations(db, options.migrationsDir) : undefined;

  return {
    filename,
    sqlite,
    db,
    migrations,
    close() {
      sqlite.close();
    },
  };
}
