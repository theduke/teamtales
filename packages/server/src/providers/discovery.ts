import type { DiscoveredResourceDto, JsonObject } from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";
import { GitHubRestClient, type FetchLike as GitHubFetchLike } from "./github-client.js";
import { fetchConnection, LinearGraphqlClient, type FetchLike as LinearFetchLike, type JsonValueObject } from "./linear-client.js";

type FetchLike = GitHubFetchLike & LinearFetchLike;
export class ProviderTokenError extends Error { readonly code = "invalid_token"; }
export async function verifyProviderToken(provider: Provider, token: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): Promise<{ displayName: string }> {
  try {
    if (provider === "github") {
      const user = await new GitHubRestClient(fetchImpl, "https://api.github.com", token).getObject("/user");
      const login = text(user.login); if (!login) throw new Error("GitHub user response did not include a login.");
      return { displayName: login };
    }
    const data = await new LinearGraphqlClient(token, fetchImpl).query<{ organization?: JsonValueObject | null }>(workspaceAndViewerQuery);
    const name = text(data.organization?.name); if (!name) throw new Error("Linear organization response did not include a name.");
    return { displayName: name };
  } catch (error) { throw new ProviderTokenError(error instanceof Error ? error.message : "Invalid provider token."); }
}
export async function discoverProviderResources(provider: Provider, token: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): Promise<DiscoveredResourceDto[]> {
  if (provider === "github") {
    const client = new GitHubRestClient(fetchImpl, "https://api.github.com", token); const resources: DiscoveredResourceDto[] = [];
    await Promise.all([collect(client.paginateObjects("/user/orgs", { per_page: "100" })), (async () => { for await (const repo of client.paginateObjects("/user/repos", { affiliation: "owner,collaborator,organization_member", per_page: "100", sort: "full_name" })) { const id = text(repo.id); const name = text(repo.full_name); const owner = object(repo.owner); if (id && name) resources.push({ scopeType: "github.repository", externalId: id, externalName: name, group: text(owner?.login), description: text(repo.description), config: {} }); } })()]);
    return resources.sort((a, b) => a.externalName.localeCompare(b.externalName));
  }
  const client = new LinearGraphqlClient(token, fetchImpl); const workspace = await client.query<{ organization?: JsonValueObject | null }>(workspaceAndViewerQuery);
  const resources: DiscoveredResourceDto[] = []; const organization = workspace.organization;
  if (organization && text(organization.id) && text(organization.name)) resources.push({ scopeType: "linear.workspace", externalId: text(organization.id)!, externalName: text(organization.name)!, group: "Workspace", config: {} });
  const [teams, projects] = await Promise.all([fetchConnection(client, "teams", teamsQuery), fetchConnection(client, "projects", projectsQuery)]);
  for (const team of teams) { const id = text(team.id); const name = text(team.name); if (id && name) resources.push({ scopeType: "linear.team", externalId: id, externalName: name, group: "Teams", description: text(team.key), config: {} }); }
  for (const project of projects) { const id = text(project.id); const name = text(project.name); const teams = object(project.teams); const nodes = Array.isArray(teams?.nodes) ? teams.nodes : []; const firstTeam = object(nodes[0]); if (id && name) resources.push({ scopeType: "linear.project", externalId: id, externalName: name, group: text(firstTeam?.name) ?? "Projects", description: text(project.state), config: {} }); }
  return resources;
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result; }
function text(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function object(value: unknown): JsonObject | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined; }
const workspaceAndViewerQuery = `query LinearWorkspaceAndViewer { viewer { id name displayName email } organization { id name urlKey } }`;
const teamsQuery = `query LinearTeams($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }`;
const projectsQuery = `query LinearProjects($first: Int!, $after: String) { projects(first: $first, after: $after) { nodes { id name state teams { nodes { name } } } pageInfo { hasNextPage endCursor } } }`;
