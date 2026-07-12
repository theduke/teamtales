import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { it } from "node:test";
import type { AppDatabase } from "../../src/db/index.js";
import { createApiServer } from "../../src/api/server.js";

it("serves the SPA without allowing encoded path traversal", async () => {
  const parent = mkdtempSync(join(tmpdir(), "teamtales-static-"));
  const ui = join(parent, "ui");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(ui);
  writeFileSync(join(ui, "index.html"), "teamtales-index");
  writeFileSync(join(parent, "secret.txt"), "must-not-be-served");
  const server = createApiServer({
    config: { host: "127.0.0.1", port: 0 },
    database: {} as AppDatabase,
    uiDirectory: ui,
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const body = await new Promise<string>((resolve, reject) => {
      const outgoing = request(
        { host: "127.0.0.1", port: address.port, path: "/%2e%2e/secret.txt" },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(body, "teamtales-index");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(parent, { recursive: true, force: true });
  }
});
