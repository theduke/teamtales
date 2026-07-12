import type { JsonObject } from "@teamtales/common/api";
import { GitHubRestClient, type FetchLike } from "./github-client.js";

/** Boundary for GitHub's discovery API; tests provide an in-memory implementation. */
export interface GitHubDiscoveryClient {
  getAuthenticatedAccount(): Promise<JsonObject>;
  listOrganizations(): AsyncIterable<JsonObject>;
  listRepositories(): AsyncIterable<JsonObject>;
}

export class GitHubRestDiscoveryClient implements GitHubDiscoveryClient {
  private readonly client: GitHubRestClient;

  constructor(token: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.client = new GitHubRestClient(fetchImpl, "https://api.github.com", token);
  }

  getAuthenticatedAccount(): Promise<JsonObject> { return this.client.getObject("/user"); }
  listOrganizations(): AsyncIterable<JsonObject> { return this.client.paginateObjects("/user/orgs", { per_page: "100" }); }
  listRepositories(): AsyncIterable<JsonObject> { return this.client.paginateObjects("/user/repos", { affiliation: "owner,collaborator,organization_member", per_page: "100", sort: "full_name" }); }
}
