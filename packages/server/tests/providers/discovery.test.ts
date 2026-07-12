import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonObject } from "@teamtales/common/api";
import { discoverGitHubResources } from "../../src/providers/discovery.js";
import type { GitHubDiscoveryClient } from "../../src/providers/github-discovery-client.js";

class MockGitHubDiscoveryClient implements GitHubDiscoveryClient {
  async getAuthenticatedAccount(): Promise<JsonObject> { return { id: 1, login: "octocat" }; }
  async *listOrganizations(): AsyncIterable<JsonObject> { yield { id: 10, login: "acme", name: "Acme" }; }
  async *listRepositories(): AsyncIterable<JsonObject> {
    yield { id: 101, full_name: "acme/widgets", owner: { id: 10, login: "acme", type: "Organization" }, archived: false, fork: false };
    yield { id: 102, full_name: "octocat/tools", owner: { id: 1, login: "octocat", type: "User" }, archived: false, fork: false };
  }
}

describe("GitHub discovery client", () => {
  it("maps an explicit mock client into immutable scope choices", async () => {
    const discovery = await discoverGitHubResources(new MockGitHubDiscoveryClient());
    assert.deepEqual(discovery.organizations.map(org => org.id), ["10"]);
    assert.equal(discovery.repositories.find(repo => repo.id === "101")?.organizationId, "10");
    assert.equal(discovery.repositories.find(repo => repo.id === "102")?.organizationId, undefined);
  });
});
