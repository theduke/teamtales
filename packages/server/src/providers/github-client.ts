import type { JsonValue } from "../ingestion/json.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type GitHubObject = { [key: string]: JsonValue };

export class GitHubRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAt?: Date,
  ) {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

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
      const { link, value } = await this.requestJson(url);
      if (!Array.isArray(value))
        throw new Error(`GitHub API returned a non-array response for ${path}`);
      for (const item of value) {
        if (!isJsonObject(item))
          throw new Error(`GitHub API returned a non-object item for ${path}`);
        yield item;
      }
      url = nextLink(link);
    }
  }

  private async getJson(path: string, query: Record<string, string>): Promise<JsonValue> {
    const { value } = await this.requestJson(this.buildUrl(path, query));
    if (!isJsonValue(value)) throw new Error(`GitHub API returned a non-JSON response for ${path}`);
    return value;
  }

  /** The deadline covers both receiving headers and consuming the response body. */
  private async requestJson(url: string): Promise<{ link: string | null; value: unknown }> {
    this.requestsMade += 1;
    const controller = new AbortController();
    let didTimeout = false;
    let rejectTimeout: (reason: Error) => void;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort();
      rejectTimeout(timeoutError(url, this.requestTimeoutMs));
    }, this.requestTimeoutMs);
    try {
      return await Promise.race([this.fetchJson(url, controller.signal), timeoutPromise]);
    } catch (error) {
      if (didTimeout) throw timeoutError(url, this.requestTimeoutMs);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJson(
    url: string,
    signal: AbortSignal,
  ): Promise<{ link: string | null; value: unknown }> {
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "teamtales-github-sync",
        "x-github-api-version": "2022-11-28",
      },
      signal,
    });
    if (!response.ok) throw await githubApiError(response);
    return { link: response.headers.get("link"), value: await response.json() };
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const url = new URL(path, `${this.apiBaseUrl.replace(/\/+$/, "")}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }
}

function timeoutError(url: string, timeoutMs: number): Error {
  return new Error(`GitHub API request timed out after ${timeoutMs}ms: ${new URL(url).pathname}`);
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
  const resetSeconds = Number(reset);
  const retryAt = Number.isFinite(resetSeconds) ? new Date(resetSeconds * 1000) : undefined;
  if (response.status === 403 && remaining === "0") {
    const prefix = `GitHub API rate limit exceeded${retryAt ? ` until ${retryAt.toISOString()}` : ""}`;
    return new GitHubRateLimitError(message ? `${prefix}: ${message}` : prefix, retryAt);
  }
  const prefix = `GitHub API request failed with ${response.status} ${response.statusText}`;
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
