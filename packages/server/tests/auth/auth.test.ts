import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openLocalDatabase } from "../../src/db/index.js";
import {
  authenticatePassword,
  createApiToken,
  createSession,
  resolveApiToken,
  resolveSession,
  revokeApiToken,
  revokeSession,
  setPassword,
} from "../../src/auth/index.js";

describe("password authentication", () => {
  it("sets a scrypt password and authenticates email case-insensitively", () => {
    const local = databaseWithUser();
    try {
      setPassword(local.sqlite, "user_1", "correct horse battery staple");
      const principal = authenticatePassword(local.sqlite, " ALICE@example.com ", "correct horse battery staple");

      assert.deepEqual(principal, {
        userId: "user_1",
        displayName: "Alice",
        email: "alice@example.com",
        authMethod: "password",
        credentialId: null,
      });
      assert.equal(authenticatePassword(local.sqlite, "alice@example.com", "incorrect password"), undefined);

      const stored = local.sqlite
        .prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
        .get("user_1") as Record<string, unknown>;
      assert.equal(JSON.stringify(stored).includes("correct horse battery staple"), false);
    } finally {
      local.close();
    }
  });

  it("rejects weak passwords, unknown users, and users without a password", () => {
    const local = databaseWithUser();
    try {
      assert.throws(() => setPassword(local.sqlite, "user_1", "too-short"), /12 and 1024/);
      assert.throws(() => setPassword(local.sqlite, "missing", "long enough password"), /not found/);
      assert.equal(authenticatePassword(local.sqlite, "alice@example.com", "anything at all"), undefined);
      assert.equal(authenticatePassword(local.sqlite, "missing@example.com", "anything at all"), undefined);
      assert.equal(authenticatePassword(local.sqlite, "alice@example.com", "x".repeat(2_000)), undefined);
    } finally {
      local.close();
    }
  });
});

describe("browser sessions", () => {
  it("stores only a hash, resolves active sessions, and revokes idempotently", () => {
    const local = databaseWithUser();
    const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      const created = createSession(local.sqlite, "user_1", {
        now,
        expiresAt: new Date("2026-07-10T10:00:00.000Z"),
      });
      assert.match(created.token, /^tts_[A-Za-z0-9_-]{43}$/);
      const row = local.sqlite.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(created.session.id) as Record<string, unknown>;
      assert.equal(JSON.stringify(row).includes(created.token), false);
      assert.match(String(row.token_hash), /^sha256:[a-f0-9]{64}$/);

      assert.equal(resolveSession(local.sqlite, created.token, { now })?.authMethod, "session");
      assert.equal(resolveSession(local.sqlite, "tts_invalid", { now }), undefined);
      assert.equal(revokeSession(local.sqlite, created.token, { now }), true);
      assert.equal(revokeSession(local.sqlite, created.token, { now }), false);
      assert.equal(resolveSession(local.sqlite, created.token, { now }), undefined);
    } finally {
      local.close();
    }
  });

  it("rejects expired sessions and invalid expiry dates", () => {
    const local = databaseWithUser();
    const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      const created = createSession(local.sqlite, "user_1", {
        now,
        expiresAt: new Date("2026-07-09T11:00:00.000Z"),
      });
      assert.equal(resolveSession(local.sqlite, created.token, { now: new Date("2026-07-09T11:00:00.000Z") }), undefined);
      assert.throws(() => createSession(local.sqlite, "user_1", { now, expiresAt: now }), /future/);
    } finally {
      local.close();
    }
  });
});

describe("API tokens", () => {
  it("returns the secret once, persists only its hash, tracks usage, and revokes it", () => {
    const local = databaseWithUser();
    const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      const created = createApiToken(local.sqlite, "user_1", {
        name: "automation",
        now,
        expiresAt: new Date("2026-08-09T10:00:00.000Z"),
      });
      assert.match(created.token, /^ttapi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
      const row = local.sqlite.prepare("SELECT * FROM api_tokens WHERE id = ?").get(created.apiToken.id) as Record<string, unknown>;
      assert.equal(JSON.stringify(row).includes(created.token), false);
      assert.equal(row.token_prefix, created.apiToken.prefix);

      const usedAt = new Date("2026-07-09T10:05:00.000Z");
      const principal = resolveApiToken(local.sqlite, created.token, { now: usedAt });
      assert.equal(principal?.authMethod, "api_token");
      assert.equal(principal?.userId, "user_1");
      assert.equal(
        (local.sqlite.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?").get(created.apiToken.id) as Record<string, unknown>).last_used_at,
        usedAt.toISOString(),
      );

      assert.equal(resolveApiToken(local.sqlite, `${created.token}x`, { now }), undefined);
      assert.equal(revokeApiToken(local.sqlite, created.token, { now }), true);
      assert.equal(resolveApiToken(local.sqlite, created.token, { now }), undefined);

      const second = createApiToken(local.sqlite, "user_1", { name: "second", now });
      assert.equal(revokeApiToken(local.sqlite, second.apiToken.id, { now }), true);
      assert.equal(resolveApiToken(local.sqlite, second.token, { now }), undefined);
    } finally {
      local.close();
    }
  });

  it("rejects empty names, missing users, and expired tokens", () => {
    const local = databaseWithUser();
    const now = new Date("2026-07-09T10:00:00.000Z");
    try {
      assert.throws(() => createApiToken(local.sqlite, "user_1", { name: " ", now }), /name/);
      assert.throws(() => createApiToken(local.sqlite, "missing", { name: "test", now }), /not found/);
      const created = createApiToken(local.sqlite, "user_1", {
        name: "short lived",
        now,
        expiresAt: new Date("2026-07-09T10:00:01.000Z"),
      });
      assert.equal(resolveApiToken(local.sqlite, created.token, { now: new Date("2026-07-09T10:00:01.000Z") }), undefined);
    } finally {
      local.close();
    }
  });
});

function databaseWithUser() {
  const local = openLocalDatabase({ runMigrations: true });
  local.sqlite
    .prepare("INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)")
    .run("user_1", "Alice", "alice@example.com");
  return local;
}
