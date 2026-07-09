import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const PASSWORD_KEY_LENGTH = 64;
const DEFAULT_SCRYPT_N = 16_384;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const DEFAULT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_API_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1_000;

export type AuthenticationMethod = "password" | "session" | "api_token";

export interface AuthenticatedPrincipal {
  userId: string;
  displayName: string;
  email: string;
  authMethod: AuthenticationMethod;
  credentialId: string | null;
}

/** Concise alias used by HTTP request contexts. */
export type AuthPrincipal = AuthenticatedPrincipal;

export interface PasswordOptions {
  scryptN?: number;
  scryptR?: number;
  scryptP?: number;
}

export interface TokenLifetimeOptions {
  now?: Date;
  expiresAt?: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreatedSession {
  token: string;
  session: SessionRecord;
}

export interface CreateApiTokenOptions extends TokenLifetimeOptions {
  name: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreatedApiToken {
  token: string;
  apiToken: ApiTokenRecord;
}

export function setPassword(
  database: DatabaseSync,
  userId: string,
  password: string,
  options: PasswordOptions = {},
): void {
  assertPassword(password);
  requireAuthenticatableUser(database, userId);
  const n = options.scryptN ?? DEFAULT_SCRYPT_N;
  const r = options.scryptR ?? DEFAULT_SCRYPT_R;
  const p = options.scryptP ?? DEFAULT_SCRYPT_P;
  assertScryptParameters(n, r, p);
  const salt = randomBytes(32);
  const hash = derivePassword(password, salt, n, r, p);
  const result = database
    .prepare(
      `UPDATE users
       SET password_hash = ?, password_salt = ?, password_scrypt_n = ?,
           password_scrypt_r = ?, password_scrypt_p = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(hash.toString("base64url"), salt.toString("base64url"), n, r, p, new Date().toISOString(), userId);

  if (result.changes !== 1) {
    throw new Error(`User ${userId} not found`);
  }
}

export function authenticatePassword(
  database: DatabaseSync,
  email: string,
  password: string,
): AuthenticatedPrincipal | undefined {
  if (Buffer.byteLength(password, "utf8") > 1_024) {
    performDummyPasswordCheck("invalid password");
    return undefined;
  }
  let normalizedEmail: string;
  try {
    normalizedEmail = normalizeEmail(email);
  } catch {
    performDummyPasswordCheck(password);
    return undefined;
  }
  const row = database
    .prepare(
      `SELECT id, display_name, primary_email, password_hash, password_salt,
              password_scrypt_n, password_scrypt_r, password_scrypt_p
       FROM users WHERE lower(primary_email) = ?`,
    )
    .get(normalizedEmail) as Record<string, unknown> | undefined;

  if (!row || !validPasswordRow(row)) {
    performDummyPasswordCheck(password);
    return undefined;
  }

  const n = Number(row.password_scrypt_n);
  const r = Number(row.password_scrypt_r);
  const p = Number(row.password_scrypt_p);
  if (!safeScryptParameters(n, r, p)) {
    performDummyPasswordCheck(password);
    return undefined;
  }

  const expected = decodeBase64Url(String(row.password_hash));
  const salt = decodeBase64Url(String(row.password_salt));
  if (expected?.length !== PASSWORD_KEY_LENGTH || !salt) {
    performDummyPasswordCheck(password);
    return undefined;
  }

  const actual = derivePassword(password, salt, n, r, p);
  if (!timingSafeEqual(actual, expected)) {
    return undefined;
  }

  return principalFromRow(row, "password", null);
}

export function createSession(
  database: DatabaseSync,
  userId: string,
  options: TokenLifetimeOptions = {},
): CreatedSession {
  const now = validDate(options.now ?? new Date(), "now");
  const expiresAt = validDate(options.expiresAt ?? new Date(now.getTime() + DEFAULT_SESSION_LIFETIME_MS), "expiresAt");
  assertFutureExpiry(now, expiresAt);
  requireAuthenticatableUser(database, userId);

  const token = `tts_${randomBytes(32).toString("base64url")}`;
  const id = `session_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO auth_sessions
         (id, user_id, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, hashToken(token), expiresAt.toISOString(), now.toISOString(), now.toISOString());

  return { token, session: { id, userId, expiresAt, createdAt: now } };
}

export function resolveSession(
  database: DatabaseSync,
  token: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): AuthenticatedPrincipal | undefined {
  const now = validDate(options.now ?? new Date(), "now");
  const row = database
    .prepare(
      `SELECT s.id AS credential_id, s.expires_at, s.revoked_at,
              u.id, u.display_name, u.primary_email
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as Record<string, unknown> | undefined;

  if (!activeCredential(row, now)) return undefined;
  database.prepare("UPDATE auth_sessions SET last_used_at = ?, updated_at = ? WHERE id = ?").run(
    now.toISOString(),
    now.toISOString(),
    String(row.credential_id),
  );
  return principalFromRow(row, "session", String(row.credential_id));
}

export function revokeSession(
  database: DatabaseSync,
  token: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): boolean {
  const now = validDate(options.now ?? new Date(), "now").toISOString();
  return database
    .prepare("UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .run(now, now, hashToken(token)).changes === 1;
}

export function createApiToken(
  database: DatabaseSync,
  userId: string,
  options: CreateApiTokenOptions,
): CreatedApiToken {
  const name = options.name.trim();
  if (!name || name.length > 100) throw new Error("API token name must contain 1 to 100 characters");
  const now = validDate(options.now ?? new Date(), "now");
  const expiresAt = validDate(options.expiresAt ?? new Date(now.getTime() + DEFAULT_API_TOKEN_LIFETIME_MS), "expiresAt");
  assertFutureExpiry(now, expiresAt);
  requireAuthenticatableUser(database, userId);

  const prefix = randomBytes(9).toString("base64url");
  const token = `ttapi_${prefix}_${randomBytes(32).toString("base64url")}`;
  const id = `api_token_${randomUUID()}`;
  database
    .prepare(
      `INSERT INTO api_tokens
         (id, user_id, name, token_prefix, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, name, prefix, hashToken(token), expiresAt.toISOString(), now.toISOString(), now.toISOString());

  return { token, apiToken: { id, userId, name, prefix, expiresAt, createdAt: now } };
}

export function resolveApiToken(
  database: DatabaseSync,
  token: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): AuthenticatedPrincipal | undefined {
  if (!/^ttapi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const now = validDate(options.now ?? new Date(), "now");
  const row = database
    .prepare(
      `SELECT t.id AS credential_id, t.expires_at, t.revoked_at,
              u.id, u.display_name, u.primary_email
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    )
    .get(hashToken(token)) as Record<string, unknown> | undefined;

  if (!activeCredential(row, now)) return undefined;
  database.prepare("UPDATE api_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?").run(
    now.toISOString(),
    now.toISOString(),
    String(row.credential_id),
  );
  return principalFromRow(row, "api_token", String(row.credential_id));
}

export function revokeApiToken(
  database: DatabaseSync,
  tokenOrId: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): boolean {
  const now = validDate(options.now ?? new Date(), "now").toISOString();
  const byToken = /^ttapi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(tokenOrId);
  const where = byToken ? "token_hash = ?" : "id = ?";
  const identifier = byToken ? hashToken(tokenOrId) : tokenOrId;
  return database
    .prepare(`UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE ${where} AND revoked_at IS NULL`)
    .run(now, now, identifier).changes === 1;
}

function assertPassword(password: string): void {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < 12 || byteLength > 1_024) {
    throw new Error("Password must contain between 12 and 1024 UTF-8 bytes");
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 320) throw new Error("A valid email address is required");
  return normalized;
}

function derivePassword(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, PASSWORD_KEY_LENGTH, { N: n, r, p, maxmem: SCRYPT_MAX_MEMORY });
}

function performDummyPasswordCheck(password: string): void {
  const salt = Buffer.alloc(32, 0x5a);
  derivePassword(password, salt, DEFAULT_SCRYPT_N, DEFAULT_SCRYPT_R, DEFAULT_SCRYPT_P);
}

function assertScryptParameters(n: number, r: number, p: number): void {
  if (!safeScryptParameters(n, r, p)) throw new Error("Invalid scrypt parameters");
}

function safeScryptParameters(n: number, r: number, p: number): boolean {
  return Number.isInteger(n) && n >= 16_384 && n <= 65_536 && (n & (n - 1)) === 0
    && Number.isInteger(r) && r >= 8 && r <= 16
    && Number.isInteger(p) && p >= 1 && p <= 4;
}

function validPasswordRow(row: Record<string, unknown>): boolean {
  return typeof row.password_hash === "string" && typeof row.password_salt === "string"
    && typeof row.password_scrypt_n === "number" && typeof row.password_scrypt_r === "number"
    && typeof row.password_scrypt_p === "number";
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

function hashToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function activeCredential(row: Record<string, unknown> | undefined, now: Date): row is Record<string, unknown> {
  if (!row || row.revoked_at !== null) return false;
  const expiresAt = new Date(String(row.expires_at));
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

function principalFromRow(
  row: Record<string, unknown>,
  authMethod: AuthenticationMethod,
  credentialId: string | null,
): AuthenticatedPrincipal | undefined {
  if (typeof row.primary_email !== "string" || !row.primary_email) return undefined;
  return {
    userId: String(row.id),
    displayName: String(row.display_name),
    email: row.primary_email,
    authMethod,
    credentialId,
  };
}

function requireAuthenticatableUser(database: DatabaseSync, userId: string): void {
  const user = database.prepare("SELECT primary_email FROM users WHERE id = ?").get(userId) as
    | { primary_email: string | null }
    | undefined;
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }
  if (!user.primary_email) throw new Error(`User ${userId} must have a primary email address`);
}

function validDate(value: Date, name: string): Date {
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid date`);
  return value;
}

function assertFutureExpiry(now: Date, expiresAt: Date): void {
  if (expiresAt.getTime() <= now.getTime()) throw new Error("expiresAt must be in the future");
}
