import { z } from "zod";
import { GitHubRestClient, type FetchLike } from "./github-client.js";

const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? undefined);
const githubId = z.union([z.string(), z.number()]).transform(String);

export const githubAccountSchema = z.object({
  id: githubId,
  login: z.string(),
  name: optionalText,
  avatar_url: optionalText,
});
export const githubOrganizationSchema = z.object({
  id: githubId,
  login: z.string(),
  name: optionalText,
  avatar_url: optionalText,
  public_repos: z.number().int().nonnegative().optional(),
});
export const githubRepositorySchema = z.object({
  id: githubId,
  full_name: z.string(),
  owner: z.object({ id: githubId, login: z.string(), type: z.enum(["Organization", "User"]) }),
  visibility: optionalText,
  archived: z.boolean(),
  fork: z.boolean(),
  description: optionalText,
});

export type GitHubAccount = { id: string; login: string; name?: string; avatarUrl?: string };
export type GitHubOrganization = {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  repositoryCount?: number;
};
export type GitHubRepository = {
  id: string;
  fullName: string;
  ownerId: string;
  ownerLogin: string;
  ownerType: "Organization" | "User";
  visibility?: string;
  archived: boolean;
  fork: boolean;
  description?: string;
};

/** Typed boundary for GitHub discovery. Fakes can return these values directly. */
export interface GitHubDiscoveryClient {
  getAuthenticatedAccount(): Promise<GitHubAccount>;
  listOrganizations(): AsyncIterable<GitHubOrganization>;
  listRepositories(): AsyncIterable<GitHubRepository>;
}

export class GitHubRestDiscoveryClient implements GitHubDiscoveryClient {
  private readonly client: GitHubRestClient;
  constructor(token: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.client = new GitHubRestClient(fetchImpl, "https://api.github.com", token);
  }
  async getAuthenticatedAccount(): Promise<GitHubAccount> {
    const value = githubAccountSchema.parse(await this.client.getObject("/user"));
    return {
      id: value.id,
      login: value.login,
      ...(value.name ? { name: value.name } : {}),
      ...(value.avatar_url ? { avatarUrl: value.avatar_url } : {}),
    };
  }
  async *listOrganizations(): AsyncIterable<GitHubOrganization> {
    for await (const raw of this.client.paginateObjects("/user/orgs", { per_page: "100" })) {
      const value = githubOrganizationSchema.parse(raw);
      yield {
        id: value.id,
        login: value.login,
        ...(value.name ? { name: value.name } : {}),
        ...(value.avatar_url ? { avatarUrl: value.avatar_url } : {}),
        ...(value.public_repos !== undefined ? { repositoryCount: value.public_repos } : {}),
      };
    }
  }
  async *listRepositories(): AsyncIterable<GitHubRepository> {
    for await (const raw of this.client.paginateObjects("/user/repos", {
      affiliation: "owner,collaborator,organization_member",
      per_page: "100",
      sort: "full_name",
    })) {
      const value = githubRepositorySchema.parse(raw);
      yield {
        id: value.id,
        fullName: value.full_name,
        ownerId: value.owner.id,
        ownerLogin: value.owner.login,
        ownerType: value.owner.type,
        ...(value.visibility ? { visibility: value.visibility } : {}),
        archived: value.archived,
        fork: value.fork,
        ...(value.description ? { description: value.description } : {}),
      };
    }
  }

  /** Enumerates an organization directly, including repositories absent from `/user/repos`. */
  async *listOrganizationRepositories(organizationLogin: string): AsyncIterable<GitHubRepository> {
    for await (const raw of this.client.paginateObjects(
      `/orgs/${encodeURIComponent(organizationLogin)}/repos`,
      { per_page: "100", type: "all", sort: "full_name" },
    )) {
      const value = githubRepositorySchema.parse(raw);
      yield {
        id: value.id,
        fullName: value.full_name,
        ownerId: value.owner.id,
        ownerLogin: value.owner.login,
        ownerType: value.owner.type,
        ...(value.visibility ? { visibility: value.visibility } : {}),
        archived: value.archived,
        fork: value.fork,
        ...(value.description ? { description: value.description } : {}),
      };
    }
  }
}
