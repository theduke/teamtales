import type { JsonValue } from "../ingestion/json.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type JsonValueObject = { [key: string]: JsonValue };
export type LinearConnectionName =
  | "users"
  | "teams"
  | "projects"
  | "workflowStates"
  | "issueLabels"
  | "issues"
  | "comments";
interface LinearGraphqlPage<T extends JsonValueObject> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}
const endpoint = "https://api.linear.app/graphql";

export class LinearGraphqlClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    if (!token.trim()) throw new Error("Linear personal access token is required");
  }
  async query<T>(query: string, variables: JsonValueObject = {}): Promise<T> {
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: this.token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Linear GraphQL returned non-JSON response with status ${response.status}`);
    }
    if (!response.ok)
      throw new Error(
        `Linear GraphQL request failed with status ${response.status}: ${errorSummary(payload)}`,
      );
    if (!isRecord(payload)) throw new Error("Linear GraphQL returned an invalid response envelope");
    if (Array.isArray(payload.errors) && payload.errors.length)
      throw new Error(`Linear GraphQL errors: ${payload.errors.map(graphqlError).join("; ")}`);
    if (!isRecord(payload.data)) throw new Error("Linear GraphQL response did not include data");
    return payload.data as T;
  }
}

export async function fetchConnection<T extends JsonValueObject>(
  client: LinearGraphqlClient,
  name: LinearConnectionName,
  query: string,
  variables: JsonValueObject = {},
): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | undefined;
  for (;;) {
    const data = await client.query<Record<LinearConnectionName, LinearGraphqlPage<T> | undefined>>(
      query,
      { ...variables, first: 100, after: after ?? null },
    );
    const page = data[name];
    if (!page || !Array.isArray(page.nodes) || !isRecord(page.pageInfo))
      throw new Error(`Linear GraphQL response did not include ${name} page data`);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    after = page.pageInfo.endCursor ?? undefined;
    if (!after) throw new Error(`Linear GraphQL ${name} page is missing endCursor`);
  }
}
function isRecord(value: unknown): value is JsonValueObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorSummary(value: unknown): string {
  return isRecord(value) && typeof value.message === "string"
    ? value.message
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}
function graphqlError(value: unknown): string {
  if (!isRecord(value)) return String(value);
  const message = typeof value.message === "string" ? value.message : "unknown GraphQL error";
  const path = Array.isArray(value.path) ? ` at ${value.path.join(".")}` : "";
  const extensions =
    isRecord(value.extensions) && typeof value.extensions.code === "string"
      ? ` (${value.extensions.code})`
      : "";
  return `${message}${path}${extensions}`;
}
