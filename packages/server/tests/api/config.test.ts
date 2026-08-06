import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApiConfig } from "../../src/api/config.js";

describe("API configuration", () => {
  it("requires a secure, explicit public origin for production sessions", () => {
    assert.throws(
      () => createApiConfig({ NODE_ENV: "production", TEAMTALES_COOKIE_SECURE: "true" }),
      /TEAMTALES_PUBLIC_ORIGIN/,
    );
    assert.throws(
      () =>
        createApiConfig({
          NODE_ENV: "production",
          TEAMTALES_PUBLIC_ORIGIN: "http://teamtales.example",
          TEAMTALES_COOKIE_SECURE: "true",
        }),
      /must use HTTPS/,
    );
    assert.throws(
      () =>
        createApiConfig({
          NODE_ENV: "production",
          TEAMTALES_PUBLIC_ORIGIN: "https://teamtales.example",
          TEAMTALES_COOKIE_SECURE: "false",
        }),
      /TEAMTALES_COOKIE_SECURE/,
    );
  });

  it("normalizes a configured development origin", () => {
    const config = createApiConfig({
      TEAMTALES_PUBLIC_ORIGIN: "http://localhost:9101/",
      TEAMTALES_COOKIE_SECURE: "false",
    });
    assert.equal(config.publicOrigin, "http://localhost:9101");
  });
});
