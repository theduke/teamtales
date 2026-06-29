import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import {
  assertCredentialMatchesHint,
  createIntegrationCredentialRecord,
  createTokenHint,
  decryptCredentialSecret,
  encryptCredentialSecret,
  redactLogValue,
  redactText,
} from "../../src/security/index.js";

describe("integration credential helpers", () => {
  it("encrypts secrets, stores a hint, and decrypts only with the key", () => {
    const key = randomBytes(32);
    const secret = "ghp_1234567890abcdefSECRET";
    const credential = encryptCredentialSecret(secret, key);

    assert.notEqual(credential.encryptedSecret, secret);
    assert.equal(credential.encryptedSecret.includes(secret), false);
    assert.equal(credential.secretHint, "ghp_...CRET");
    assert.equal(decryptCredentialSecret(credential, key), secret);
    assertCredentialMatchesHint(secret, credential.secretHint);
    assert.throws(() => decryptCredentialSecret(credential, randomBytes(32)));
  });

  it("builds integration credential records without plaintext tokens", () => {
    const key = randomBytes(32).toString("hex");
    const expiresAt = new Date("2026-07-01T00:00:00.000Z");
    const record = createIntegrationCredentialRecord({
      id: "cred_1",
      integrationId: "int_1",
      plaintextSecret: "lin_api_1234567890abcdef",
      encryptionKey: key,
      expiresAt,
    });

    assert.equal(record.id, "cred_1");
    assert.equal(record.integrationId, "int_1");
    assert.equal(record.expiresAt, expiresAt);
    assert.equal(record.encryptedSecret.includes("lin_api_1234567890abcdef"), false);
    assert.equal(decryptCredentialSecret(record, key), "lin_api_1234567890abcdef");
  });

  it("uses hash-only hints for very short secrets", () => {
    const hint = createTokenHint("short");

    assert.match(hint, /^len:5:sha256:[a-f0-9]{12}$/);
    assert.equal(hint.includes("short"), false);
  });

  it("redacts explicit secrets and common token shapes from text", () => {
    const logLine =
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz token=ghp_1234567890abcdefABCDEF linear=lin_api_1234567890abcdef";
    const output = redactText(logLine, ["abcdefghijklmnopqrstuvwxyz"]);

    assert.equal(output.includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(output.includes("ghp_1234567890abcdefABCDEF"), false);
    assert.equal(output.includes("lin_api_1234567890abcdef"), false);
  });

  it("redacts sensitive keys inside structured log values", () => {
    const value = redactLogValue({
      message: "sync failed for token ghp_1234567890abcdefABCDEF",
      nested: {
        accessToken: "plain-secret",
        safe: "visible",
      },
    });

    assert.deepEqual(value, {
      message: "sync failed for token [REDACTED]",
      nested: {
        accessToken: "[REDACTED]",
        safe: "visible",
      },
    });
  });
});
