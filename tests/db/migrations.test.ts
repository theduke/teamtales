import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openLocalDatabase, runMigrations } from "../../src/db/index.js";

describe("local SQLite migrations", () => {
  it("applies project migrations and records them idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamtales-db-"));
    const filename = join(directory, "teamtales.sqlite");

    try {
      const local = openLocalDatabase({ filename, runMigrations: true });

      assert.equal(existsSync(filename), true);
      assert.equal(local.migrations?.applied.length, 1);
      assert.equal(local.migrations?.skipped.length, 0);

      const integrationColumns = local.sqlite
        .prepare("PRAGMA table_info(integration_credentials)")
        .all() as Array<{ name: string }>;

      assert.deepEqual(
        integrationColumns.map((column) => column.name).filter((name) => ["encrypted_secret", "secret_hint"].includes(name)),
        ["encrypted_secret", "secret_hint"],
      );

      const secondRun = runMigrations(local.sqlite);

      assert.equal(secondRun.applied.length, 0);
      assert.equal(secondRun.skipped.length, 1);

      local.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enables foreign key enforcement", () => {
    const local = openLocalDatabase({ runMigrations: true });

    try {
      assert.throws(
        () =>
          local.sqlite
            .prepare(
              "INSERT INTO integration_credentials (id, integration_id, encrypted_secret, secret_hint) VALUES (?, ?, ?, ?)",
            )
            .run("cred_1", "missing_integration", "encrypted", "hint"),
        /FOREIGN KEY/,
      );
    } finally {
      local.close();
    }
  });
});
