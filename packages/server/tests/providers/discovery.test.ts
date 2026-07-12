import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverGitHubResources } from "../../src/providers/discovery.js";
import type {
  GitHubAccount,
  GitHubDiscoveryClient,
  GitHubOrganization,
  GitHubRepository,
} from "../../src/providers/github-discovery-client.js";

class MockGitHubDiscoveryClient implements GitHubDiscoveryClient {
  async getAuthenticatedAccount(): Promise<GitHubAccount> {
    return { id: "1", login: "octocat" };
  }
  async *listOrganizations(): AsyncIterable<GitHubOrganization> {
    yield { id: "10", login: "acme", name: "Acme" };
  }
  async *listRepositories(): AsyncIterable<GitHubRepository> {
    yield {
      id: "101",
      fullName: "acme/widgets",
      ownerId: "10",
      ownerLogin: "acme",
      ownerType: "Organization",
      archived: false,
      fork: false,
    };
    yield {
      id: "102",
      fullName: "octocat/tools",
      ownerId: "1",
      ownerLogin: "octocat",
      ownerType: "User",
      archived: false,
      fork: false,
    };
  }
}

describe("GitHub discovery client", () => {
  it("maps an explicit mock client into immutable scope choices", async () => {
    const discovery = await discoverGitHubResources(new MockGitHubDiscoveryClient());
    assert.deepEqual(
      discovery.organizations.map((org) => org.id),
      ["10"],
    );
    assert.equal(discovery.repositories.find((repo) => repo.id === "101")?.organizationId, "10");
    assert.equal(
      discovery.repositories.find((repo) => repo.id === "102")?.organizationId,
      undefined,
    );
  });
});
