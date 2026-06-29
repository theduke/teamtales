import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const algorithm = "aes-256-gcm";
const encryptedSecretPrefix = "v1:aes-256-gcm";
const redacted = "[REDACTED]";

export interface EncryptedCredential {
  encryptedSecret: string;
  secretHint: string;
  expiresAt?: Date;
}

export interface StoredEncryptedCredential {
  encryptedSecret: string;
  secretHint?: string | null;
  expiresAt?: string | Date | null;
}

export interface IntegrationCredentialRecord extends EncryptedCredential {
  id: string;
  integrationId: string;
}

export interface CreateIntegrationCredentialOptions {
  id: string;
  integrationId: string;
  plaintextSecret: string;
  encryptionKey: string | Buffer;
  expiresAt?: Date;
}

export function createIntegrationCredentialRecord(options: CreateIntegrationCredentialOptions): IntegrationCredentialRecord {
  const encrypted = encryptCredentialSecret(options.plaintextSecret, options.encryptionKey, options.expiresAt);

  return {
    id: options.id,
    integrationId: options.integrationId,
    ...encrypted,
  };
}

export function encryptCredentialSecret(plaintextSecret: string, encryptionKey: string | Buffer, expiresAt?: Date): EncryptedCredential {
  if (plaintextSecret.length === 0) {
    throw new Error("Credential secret must not be empty");
  }

  const key = normalizeEncryptionKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextSecret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedSecret: [encryptedSecretPrefix, base64UrlEncode(iv), base64UrlEncode(authTag), base64UrlEncode(ciphertext)].join(":"),
    secretHint: createTokenHint(plaintextSecret),
    expiresAt,
  };
}

export function decryptCredentialSecret(stored: StoredEncryptedCredential | string, encryptionKey: string | Buffer): string {
  const encryptedSecret = typeof stored === "string" ? stored : stored.encryptedSecret;
  const [version, cipherName, encodedIv, encodedAuthTag, encodedCiphertext] = encryptedSecret.split(":");

  if (`${version}:${cipherName}` !== encryptedSecretPrefix || !encodedIv || !encodedAuthTag || !encodedCiphertext) {
    throw new Error("Unsupported encrypted credential format");
  }

  const key = normalizeEncryptionKey(encryptionKey);
  const decipher = createDecipheriv(algorithm, key, base64UrlDecode(encodedIv));
  decipher.setAuthTag(base64UrlDecode(encodedAuthTag));

  return Buffer.concat([decipher.update(base64UrlDecode(encodedCiphertext)), decipher.final()]).toString("utf8");
}

export function createTokenHint(secret: string): string {
  const normalized = secret.trim();
  const digest = createHash("sha256").update(secret).digest("hex").slice(0, 12);

  if (normalized.length <= 8) {
    return `len:${normalized.length}:sha256:${digest}`;
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

export function redactText(input: string, secrets: readonly string[] = []): string {
  let output = input;

  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }

    output = output.split(secret).join(redacted);
  }

  return output
    .replace(/\b(ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, redacted)
    .replace(/\blin_api_[A-Za-z0-9]{16,}\b/g, redacted)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, `Bearer ${redacted}`)
    .replace(/\b(token|access_token|authorization)\s*[:=]\s*["']?[^"'\s,}]{8,}/gi, `$1=${redacted}`);
}

export function redactLogValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, secrets));
  }

  if (value && typeof value === "object") {
    const redactedObject: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        redactedObject[key] = redacted;
      } else {
        redactedObject[key] = redactLogValue(child, secrets);
      }
    }

    return redactedObject;
  }

  return value;
}

export function assertCredentialMatchesHint(secret: string, hint: string): void {
  const actual = Buffer.from(createTokenHint(secret));
  const expected = Buffer.from(hint);

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Credential secret does not match stored hint");
  }
}

function normalizeEncryptionKey(encryptionKey: string | Buffer): Buffer {
  const key = Buffer.isBuffer(encryptionKey) ? Buffer.from(encryptionKey) : decodeKeyString(encryptionKey);

  if (key.byteLength !== 32) {
    throw new Error("Credential encryption key must be 32 bytes");
  }

  return key;
}

function decodeKeyString(encryptionKey: string): Buffer {
  if (/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    return Buffer.from(encryptionKey, "hex");
  }

  return Buffer.from(encryptionKey, "base64url");
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|credential/i.test(key);
}
