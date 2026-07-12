import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { apiTokens, authSessions, users } from "../db/schema.js";
import type { AppDatabase, MySqlTransaction } from "../db/mysql.js";

type AuthDatabase = AppDatabase | MySqlTransaction;

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

export async function setPassword(
  database: AuthDatabase,
  userId: string,
  password: string,
  options: PasswordOptions = {},
): Promise<void> {
  assertPassword(password);
  await requireAuthenticatableUser(database, userId);
  const n = options.scryptN ?? DEFAULT_SCRYPT_N;
  const r = options.scryptR ?? DEFAULT_SCRYPT_R;
  const p = options.scryptP ?? DEFAULT_SCRYPT_P;
  assertScryptParameters(n, r, p);
  const salt = randomBytes(32);
  const hash = derivePassword(password, salt, n, r, p);
  const result = await database.update(users).set({
    passwordHash: hash.toString("base64url"),
    passwordSalt: salt.toString("base64url"),
    passwordScryptN: n,
    passwordScryptR: r,
    passwordScryptP: p,
    updatedAt: new Date().toISOString(),
  }).where(eq(users.id, userId));
  if (affectedRows(result) !== 1) throw new Error(`User ${userId} not found`);
}

export async function authenticatePassword(
  database: AuthDatabase,
  email: string,
  password: string,
): Promise<AuthenticatedPrincipal | undefined> {
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
  const [row] = await database.select({
    id: users.id,
    displayName: users.displayName,
    primaryEmail: users.primaryEmail,
    passwordHash: users.passwordHash,
    passwordSalt: users.passwordSalt,
    passwordScryptN: users.passwordScryptN,
    passwordScryptR: users.passwordScryptR,
    passwordScryptP: users.passwordScryptP,
  }).from(users).where(sql`lower(${users.primaryEmail}) = ${normalizedEmail}`).limit(1);

  if (!row || !validPasswordRow(row)) {
    performDummyPasswordCheck(password);
    return undefined;
  }

  const n = Number(row.passwordScryptN);
  const r = Number(row.passwordScryptR);
  const p = Number(row.passwordScryptP);
  if (!safeScryptParameters(n, r, p)) {
    performDummyPasswordCheck(password);
    return undefined;
  }

  const expected = decodeBase64Url(String(row.passwordHash));
  const salt = decodeBase64Url(String(row.passwordSalt));
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

export async function createSession(
  database: AuthDatabase,
  userId: string,
  options: TokenLifetimeOptions = {},
): Promise<CreatedSession> {
  const now = validDate(options.now ?? new Date(), "now");
  const expiresAt = validDate(options.expiresAt ?? new Date(now.getTime() + DEFAULT_SESSION_LIFETIME_MS), "expiresAt");
  assertFutureExpiry(now, expiresAt);
  await requireAuthenticatableUser(database, userId);

  const token = `tts_${randomBytes(32).toString("base64url")}`;
  const id = `session_${randomUUID()}`;
  await database.insert(authSessions).values({
    id,
    userId,
    tokenHash: hashToken(token),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return { token, session: { id, userId, expiresAt, createdAt: now } };
}

export async function resolveSession(
  database: AuthDatabase,
  token: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): Promise<AuthenticatedPrincipal | undefined> {
  const now = validDate(options.now ?? new Date(), "now");
  const [row] = await database.select({
    credentialId: authSessions.id,
    expiresAt: authSessions.expiresAt,
    revokedAt: authSessions.revokedAt,
    id: users.id,
    displayName: users.displayName,
    primaryEmail: users.primaryEmail,
  }).from(authSessions).innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.tokenHash, hashToken(token))).limit(1);

  if (!activeCredential(row, now)) return undefined;
  await database.update(authSessions).set({ lastUsedAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(authSessions.id, row.credentialId));
  return principalFromRow(row, "session", row.credentialId);
}

export async function revokeSession(
  database: AuthDatabase,
  token: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): Promise<boolean> {
  const now = validDate(options.now ?? new Date(), "now").toISOString();
  const result = await database.update(authSessions).set({ revokedAt: now, updatedAt: now })
    .where(and(eq(authSessions.tokenHash, hashToken(token)), isNull(authSessions.revokedAt)));
  return affectedRows(result) === 1;
}

export async function createApiToken(
  database: AuthDatabase,
  userId: string,
  options: CreateApiTokenOptions,
): Promise<CreatedApiToken> {
  const name = options.name.trim();
  if (!name || name.length > 100) throw new Error("API token name must contain 1 to 100 characters");
  const now = validDate(options.now ?? new Date(), "now");
  const expiresAt = validDate(options.expiresAt ?? new Date(now.getTime() + DEFAULT_API_TOKEN_LIFETIME_MS), "expiresAt");
  assertFutureExpiry(now, expiresAt);
  await requireAuthenticatableUser(database, userId);

  const prefix = randomBytes(9).toString("base64url");
  const token = `ttapi_${prefix}_${randomBytes(32).toString("base64url")}`;
  const id = `api_token_${randomUUID()}`;
  await database.insert(apiTokens).values({
    id,
    userId,
    name,
    tokenPrefix: prefix,
    tokenHash: hashToken(token),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return { token, apiToken: { id, userId, name, prefix, expiresAt, createdAt: now } };
}

export async function resolveApiToken(
  database: AuthDatabase,
  token: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): Promise<AuthenticatedPrincipal | undefined> {
  if (!/^ttapi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const now = validDate(options.now ?? new Date(), "now");
  const [row] = await database.select({
    credentialId: apiTokens.id,
    expiresAt: apiTokens.expiresAt,
    revokedAt: apiTokens.revokedAt,
    id: users.id,
    displayName: users.displayName,
    primaryEmail: users.primaryEmail,
  }).from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hashToken(token))).limit(1);

  if (!activeCredential(row, now)) return undefined;
  await database.update(apiTokens).set({ lastUsedAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(apiTokens.id, row.credentialId));
  return principalFromRow(row, "api_token", row.credentialId);
}

export async function revokeApiToken(
  database: AuthDatabase,
  tokenOrId: string,
  options: Pick<TokenLifetimeOptions, "now"> = {},
): Promise<boolean> {
  const now = validDate(options.now ?? new Date(), "now").toISOString();
  const byToken = /^ttapi_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(tokenOrId);
  const identifier = byToken ? hashToken(tokenOrId) : tokenOrId;
  const identifierCondition = byToken ? eq(apiTokens.tokenHash, identifier) : eq(apiTokens.id, identifier);
  const result = await database.update(apiTokens).set({ revokedAt: now, updatedAt: now })
    .where(and(identifierCondition, isNull(apiTokens.revokedAt)));
  return affectedRows(result) === 1;
}

function assertPassword(password: string): void {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < 8 || byteLength > 1_024) {
    throw new Error("Password must contain between 8 and 1024 UTF-8 bytes");
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

function validPasswordRow(row: {
  passwordHash: string | null;
  passwordSalt: string | null;
  passwordScryptN: number | null;
  passwordScryptR: number | null;
  passwordScryptP: number | null;
}): boolean {
  return typeof row.passwordHash === "string" && typeof row.passwordSalt === "string"
    && typeof row.passwordScryptN === "number" && typeof row.passwordScryptR === "number"
    && typeof row.passwordScryptP === "number";
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

function activeCredential<T extends { revokedAt: string | null; expiresAt: string }>(
  row: T | undefined,
  now: Date,
): row is T {
  if (!row || row.revokedAt !== null) return false;
  const expiresAt = new Date(row.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

function principalFromRow(
  row: { id: string; displayName: string; primaryEmail: string | null },
  authMethod: AuthenticationMethod,
  credentialId: string | null,
): AuthenticatedPrincipal | undefined {
  if (!row.primaryEmail) return undefined;
  return {
    userId: row.id,
    displayName: row.displayName,
    email: row.primaryEmail,
    authMethod,
    credentialId,
  };
}

async function requireAuthenticatableUser(database: AuthDatabase, userId: string): Promise<void> {
  const [user] = await database.select({ primaryEmail: users.primaryEmail }).from(users)
    .where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }
  if (!user.primaryEmail) throw new Error(`User ${userId} must have a primary email address`);
}

function affectedRows(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const header = result[0];
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return 0;
  return Number(header.affectedRows);
}

function validDate(value: Date, name: string): Date {
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be a valid date`);
  return value;
}

function assertFutureExpiry(now: Date, expiresAt: Date): void {
  if (expiresAt.getTime() <= now.getTime()) throw new Error("expiresAt must be in the future");
}
