import type { JsonValue } from "../ingestion/json.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type GitHubObject = { [key: string]: JsonValue };

export class GitHubRestClient {
  requestsMade = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiBaseUrl: string,
    private readonly token: string,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  async getObject(path: string, query: Record<string, string> = {}): Promise<GitHubObject> {
    const value = await this.getJson(path, query);
    if (!isJsonObject(value))
      throw new Error(`GitHub API returned a non-object response for ${path}`);
    return value;
  }

  async *paginateObjects(
    path: string,
    query: Record<string, string> = {},
  ): AsyncGenerator<GitHubObject> {
    let url: string | undefined = this.buildUrl(path, query);
    while (url) {
      const response = await this.request(url);
      const value = await response.json();
      if (!Array.isArray(value))
        throw new Error(`GitHub API returned a non-array response for ${path}`);
      for (const item of value) {
        if (!isJsonObject(item))
          throw new Error(`GitHub API returned a non-object item for ${path}`);
        yield item;
      }
      url = nextLink(response.headers.get("link"));
    }
  }

  private async getJson(path: string, query: Record<string, string>): Promise<JsonValue> {
    const value = await (await this.request(this.buildUrl(path, query))).json();
    if (!isJsonValue(value)) throw new Error(`GitHub API returned a non-JSON response for ${path}`);
    return value;
  }

  private async request(url: string): Promise<Response> {
    this.requestsMade += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "user-agent": "teamtales-github-sync",
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `GitHub API request timed out after ${this.requestTimeoutMs}ms: ${new URL(url).pathname}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) return response;
    throw await githubApiError(response);
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const url = new URL(path, `${this.apiBaseUrl.replace(/\/+$/, "")}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }
}

function nextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  return linkHeader
    .split(",")
    .map((part) => part.trim())
    .map((part) => /<([^>]+)>;\s*rel="([^"]+)"/.exec(part))
    .find((match) => match?.[2] === "next")?.[1];
}

export async function githubApiError(response: Response): Promise<Error> {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  let message: string | undefined;
  try {
    const body: unknown = await response.json();
    if (isJsonObject(body) && typeof body.message === "string") message = body.message;
  } catch {
    /* retain status */
  }
  const prefix =
    response.status === 403 && remaining === "0"
      ? `GitHub API rate limit exceeded${reset ? ` until ${new Date(Number(reset) * 1000).toISOString()}` : ""}`
      : `GitHub API request failed with ${response.status} ${response.statusText}`;
  return new Error(message ? `${prefix}: ${message}` : prefix);
}

function isJsonObject(value: unknown): value is GitHubObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isJsonObject(value) && Object.values(value).every(isJsonValue))
  );
}
