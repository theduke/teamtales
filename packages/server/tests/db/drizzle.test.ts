import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { organizations } from "../../src/db/schema.js";
import { openLocalDatabase } from "../../src/db/sqlite.js";

test("Drizzle uses the local node:sqlite database", () => {
  const local = openLocalDatabase({ runMigrations: true });

  try {
    local.db.insert(organizations).values({ id: "org_drizzle", name: "Drizzle", slug: "drizzle" }).run();

    assert.deepEqual(
      local.db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.slug, "drizzle"))
        .get(),
      { id: "org_drizzle", name: "Drizzle" },
    );
  } finally {
    local.close();
  }
});
