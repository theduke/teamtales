import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const migrationsDir = join(process.cwd(), "db", "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (migrationFiles.length === 0) {
  throw new Error(`No SQL migrations found in ${migrationsDir}`);
}

const expectedTables = [
  "integrations",
  "integration_credentials",
  "sync_scopes",
  "sync_cursors",
  "sync_runs",
  "sync_run_items",
  "source_objects",
  "source_object_versions",
  "source_webhook_events",
  "people",
  "external_identities",
  "work_items",
  "activity_events",
  "analysis_runs",
  "analysis_metrics",
  "analysis_highlights",
  "analysis_report_contexts",
  "ai_runs",
  "ai_run_steps",
  "reports",
  "report_inputs",
  "report_artifacts",
  "report_links"
];

const migrationSql = migrationFiles
  .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n\n");

const tableQuery = `
SELECT name
FROM sqlite_schema
WHERE type = 'table'
  AND name NOT LIKE 'sqlite_%'
ORDER BY name;
`;

const result = spawnSync("sqlite3", ["-batch", "-noheader", ":memory:"], {
  input: `PRAGMA foreign_keys = ON;\n${migrationSql}\n${tableQuery}`,
  encoding: "utf8"
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const actualTables = new Set(
  result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
);

const missingTables = expectedTables.filter((table) => !actualTables.has(table));

if (missingTables.length > 0) {
  throw new Error(`Missing expected tables: ${missingTables.join(", ")}`);
}

console.log(`Schema check passed: ${migrationFiles.length} migration(s), ${expectedTables.length} expected tables.`);
