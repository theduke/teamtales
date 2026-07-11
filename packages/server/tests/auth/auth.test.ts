import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";

import { apiTokens, authSessions, users } from "../../src/db/schema.js";
import { authenticatePassword, createApiToken, createSession, resolveApiToken, resolveSession, revokeApiToken, revokeSession, setPassword } from "../../src/auth/index.js";
import { mysqlTestOptions, openTestDatabase, uniqueId } from "../helpers/mysql.js";

describe("MySQL authentication", mysqlTestOptions, () => {
  async function databaseWithUser() {
    const opened = await openTestDatabase();
    const userId = uniqueId("user");
    const email = `${userId}@example.test`;
    await opened.db.insert(users).values({ id: userId, displayName: "Alice", primaryEmail: email });
    return { ...opened, userId, email };
  }

  it("sets a scrypt password and authenticates email case-insensitively", async () => {
    const local = await databaseWithUser();
    try {
      await setPassword(local.db, local.userId, "correct horse battery staple");
      const principal = await authenticatePassword(local.db, ` ${local.email.toUpperCase()} `, "correct horse battery staple");
      assert.equal(principal?.userId, local.userId);
      assert.equal(principal?.authMethod, "password");
      assert.equal(await authenticatePassword(local.db, local.email, "incorrect password"), undefined);
      const [stored] = await local.db.select().from(users).where(eq(users.id, local.userId));
      assert.equal(JSON.stringify(stored).includes("correct horse battery staple"), false);
    } finally { await local.db.delete(users).where(eq(users.id, local.userId)); await local.close(); }
  });

  it("rejects weak passwords, unknown users, and users without a password", async () => {
    const local = await databaseWithUser();
    try {
      await assert.rejects(setPassword(local.db, local.userId, "too-short"), /12 and 1024/);
      await assert.rejects(setPassword(local.db, uniqueId("missing"), "long enough password"), /not found/);
      assert.equal(await authenticatePassword(local.db, local.email, "anything at all"), undefined);
      assert.equal(await authenticatePassword(local.db, "missing@example.test", "anything at all"), undefined);
    } finally { await local.db.delete(users).where(eq(users.id, local.userId)); await local.close(); }
  });

  it("stores only a session hash, resolves active sessions, and revokes idempotently", async () => {
    const local = await databaseWithUser(); const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      const created = await createSession(local.db, local.userId, { now, expiresAt: new Date("2026-07-10T10:00:00.000Z") });
      const [row] = await local.db.select().from(authSessions).where(eq(authSessions.id, created.session.id));
      assert.equal(JSON.stringify(row).includes(created.token), false); assert.match(row!.tokenHash, /^sha256:[a-f0-9]{64}$/);
      assert.equal((await resolveSession(local.db, created.token, { now }))?.authMethod, "session");
      assert.equal(await revokeSession(local.db, created.token, { now }), true);
      assert.equal(await revokeSession(local.db, created.token, { now }), false);
      assert.equal(await resolveSession(local.db, created.token, { now }), undefined);
      await assert.rejects(createSession(local.db, local.userId, { now, expiresAt: now }), /future/);
    } finally { await local.db.delete(users).where(eq(users.id, local.userId)); await local.close(); }
  });

  it("rejects expired sessions and invalid expiry dates", async () => {
    const local = await databaseWithUser(); const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      const created = await createSession(local.db, local.userId, { now, expiresAt: new Date("2026-07-09T11:00:00.000Z") });
      assert.equal(await resolveSession(local.db, created.token, { now: new Date("2026-07-09T11:00:00.000Z") }), undefined);
      await assert.rejects(createSession(local.db, local.userId, { now, expiresAt: now }), /future/);
    } finally { await local.db.delete(users).where(eq(users.id, local.userId)); await local.close(); }
  });

  it("returns an API token once, tracks usage, and revokes by token or id", async () => {
    const local = await databaseWithUser(); const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      const created = await createApiToken(local.db, local.userId, { name: "automation", now, expiresAt: new Date("2026-08-09T10:00:00.000Z") });
      const [row] = await local.db.select().from(apiTokens).where(eq(apiTokens.id, created.apiToken.id));
      assert.equal(JSON.stringify(row).includes(created.token), false); assert.equal(row?.tokenPrefix, created.apiToken.prefix);
      const usedAt = new Date("2026-07-09T10:05:00.000Z");
      assert.equal((await resolveApiToken(local.db, created.token, { now: usedAt }))?.userId, local.userId);
      assert.equal((await local.db.select().from(apiTokens).where(eq(apiTokens.id, created.apiToken.id)))[0]?.lastUsedAt, usedAt.toISOString());
      assert.equal(await revokeApiToken(local.db, created.token, { now }), true);
      const second = await createApiToken(local.db, local.userId, { name: "second", now });
      assert.equal(await revokeApiToken(local.db, second.apiToken.id, { now }), true);
      await assert.rejects(createApiToken(local.db, local.userId, { name: " ", now }), /name/);
    } finally { await local.db.delete(users).where(eq(users.id, local.userId)); await local.close(); }
  });

  it("rejects empty token names, missing users, and expired tokens", async () => {
    const local = await databaseWithUser(); const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      await assert.rejects(createApiToken(local.db, local.userId, { name: " ", now }), /name/);
      await assert.rejects(createApiToken(local.db, uniqueId("missing"), { name: "test", now }), /not found/);
      const created = await createApiToken(local.db, local.userId, { name: "short lived", now, expiresAt: new Date("2026-07-09T10:00:01.000Z") });
      assert.equal(await resolveApiToken(local.db, created.token, { now: new Date("2026-07-09T10:00:01.000Z") }), undefined);
    } finally { await local.db.delete(users).where(eq(users.id, local.userId)); await local.close(); }
  });
});
