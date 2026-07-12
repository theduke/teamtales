import type { GitHubDiscoveryDto, JsonObject, LinearDiscoveryDto } from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";
import { GitHubRestClient, type FetchLike as GitHubFetchLike } from "./github-client.js";
import {
  GitHubRestDiscoveryClient,
  type GitHubDiscoveryClient,
} from "./github-discovery-client.js";
import {
  fetchConnection,
  LinearGraphqlClient,
  type FetchLike as LinearFetchLike,
  type JsonValueObject,
} from "./linear-client.js";

type FetchLike = GitHubFetchLike & LinearFetchLike;
export class ProviderTokenError extends Error {
  readonly code = "invalid_token";
}
export async function verifyProviderToken(
  provider: Provider,
  token: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<{ displayName: string }> {
  const normalizedToken = token.trim();
  if (!normalizedToken) throw new ProviderTokenError("Provider token must not be empty.");
  try {
    if (provider === "github") {
      const user = await new GitHubRestClient(
        fetchImpl,
        "https://api.github.com",
        normalizedToken,
      ).getObject("/user");
      const login = text(user.login);
      if (!login) throw new Error("GitHub user response did not include a login.");
      return { displayName: login };
    }
    const data = await new LinearGraphqlClient(normalizedToken, fetchImpl).query<{
      organization?: JsonValueObject | null;
    }>(workspaceAndViewerQuery);
    const name = text(data.organization?.name);
    if (!name) throw new Error("Linear organization response did not include a name.");
    return { displayName: name };
  } catch (error) {
    throw new ProviderTokenError(
      error instanceof Error ? error.message : "Invalid provider token.",
    );
  }
}
export async function discoverProviderResources(
  provider: "github",
  token: string,
  fetchImpl?: FetchLike,
): Promise<GitHubDiscoveryDto>;
export async function discoverProviderResources(
  provider: "linear",
  token: string,
  fetchImpl?: FetchLike,
): Promise<LinearDiscoveryDto>;
export async function discoverProviderResources(
  provider: Provider,
  token: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<GitHubDiscoveryDto | LinearDiscoveryDto> {
  const normalizedToken = token.trim();
  if (!normalizedToken) throw new ProviderTokenError("Provider token must not be empty.");
  if (provider === "github") {
    return discoverGitHubResources(new GitHubRestDiscoveryClient(normalizedToken, fetchImpl));
  }
  const client = new LinearGraphqlClient(normalizedToken, fetchImpl);
  const workspace = await client.query<{ organization?: JsonValueObject | null }>(
    workspaceAndViewerQuery,
  );
  const organization = workspace.organization;
  const workspaceId = text(organization?.id);
  const workspaceName = text(organization?.name);
  if (!workspaceId || !workspaceName)
    throw new Error("Linear organization response did not include an identity.");
  const teams = await fetchConnection(client, "teams", teamsQuery);
  return {
    workspace: { id: workspaceId, name: workspaceName },
    teams: teams.flatMap((team) => {
      const id = text(team.id);
      const name = text(team.name);
      const key = text(team.key);
      return id && name && key ? [{ id, name, key }] : [];
    }),
  };
}
export async function discoverGitHubResources(
  client: GitHubDiscoveryClient,
): Promise<GitHubDiscoveryDto> {
  const [user, orgRows, repoRows] = await Promise.all([
    client.getAuthenticatedAccount(),
    collect(client.listOrganizations()),
    collect(client.listRepositories()),
  ]);
  const organizations = orgRows;
  const orgIds = new Set(organizations.map((org) => org.id));
  return {
    account: user,
    organizations,
    repositories: repoRows
      .map((repo) => ({
        ...repo,
        ...(orgIds.has(repo.ownerId) ? { organizationId: repo.ownerId } : {}),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
const workspaceAndViewerQuery = `query LinearWorkspaceAndViewer { viewer { id name displayName email } organization { id name urlKey } }`;
const teamsQuery = `query LinearTeams($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }`;
