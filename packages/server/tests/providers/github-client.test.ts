import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubRestClient } from "../../src/providers/github-client.js";

describe("GitHubRestClient", () => {
  it("times out while awaiting response headers when fetch ignores the abort signal", async () => {
    const fetch = async (): Promise<Response> => new Promise(() => {});
    const client = new GitHubRestClient(fetch, "https://api.github.test", "token", 10);

    await assert.rejects(
      () => client.getObject("/repos/acme/widgets"),
      /GitHub API request timed out after 10ms: \/repos\/acme\/widgets/,
    );
  });

  it("times out while consuming a response body", async () => {
    const fetch = async (): Promise<Response> =>
      new Response(
        new ReadableStream({
          start() {
            // Deliberately never enqueue or close the body.
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const client = new GitHubRestClient(fetch, "https://api.github.test", "token", 10);

    await assert.rejects(
      () => client.getObject("/repos/acme/widgets"),
      /GitHub API request timed out after 10ms: \/repos\/acme\/widgets/,
    );
  });
});
