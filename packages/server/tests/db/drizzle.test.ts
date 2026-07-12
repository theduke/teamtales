import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { organizations } from "../../src/db/schema.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

test("Drizzle uses the configured MySQL database asynchronously", mysqlTestOptions, async () => {
  const opened = await openTestDatabase();
  const id = uniqueId("org");
  try {
    await opened.db.insert(organizations).values({ id, name: "Drizzle", slug: id });
    const [row] = await opened.db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, id));
    assert.deepEqual(row, { id, name: "Drizzle" });
  } finally {
    await opened.db.delete(organizations).where(eq(organizations.id, id));
    await opened.close();
  }
});
