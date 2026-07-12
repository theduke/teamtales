import type { JsonValue } from "./json.js";
import type { ConnectorCursorUpdate, ConnectorExecutionContext, ConnectorFetchResult, SourceConnector } from "./providers.js";
import type { GitHubSourceObjectType, IncomingSourceObject } from "./source-object.js";
import { GitHubRestClient } from "../providers/github-client.js";

export const githubMvpObjectTypes = [
  "github.repository",
  "github.pull_request",
  "github.pull_request_review",
  "github.pull_request_comment",
  "github.issue",
  "github.issue_comment",
  "github.commit",
  "github.user",
] as const satisfies readonly GitHubSourceObjectType[];

export const githubMvpScopeTypes = ["github.repository"] as const;

export interface GitHubRepositoryScopeConfig {
  repository: string;
  includeCommits?: boolean;
}

export interface GitHubSourceConnectorOptions {
  fetch?: FetchLike;
  apiBaseUrl?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type GitHubObject = { [key: string]: JsonValue };

export class GitHubSourceConnector implements SourceConnector {
  readonly provider = "github";
  readonly supportedObjectTypes = githubMvpObjectTypes;
  readonly supportedScopeTypes = githubMvpScopeTypes;

  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;

  constructor(options: GitHubSourceConnectorOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  }

  async fetchSourceObjects(context: ConnectorExecutionContext): Promise<ConnectorFetchResult> {
    if (context.scope.scopeType !== "github.repository") {
      throw new Error(`Unsupported GitHub scope type: ${context.scope.scopeType}`);
    }

    const token = context.credential.encryptedSecret.trim();
    if (!token) {
      throw new Error("Missing GitHub personal access token");
    }

    const repository = parseRepositoryScope(context);
    const client = new GitHubRestClient(this.fetchImpl, this.apiBaseUrl, token);
    const factory = new GitHubIncomingObjectFactory(context);
    const objects: IncomingSourceObject[] = [];

    const repositoryMetadata = await client.getObject(`/repos/${repository.path}`);
    objects.push(factory.create("github.repository", String(repositoryMetadata.id ?? repository.name), repositoryMetadata));

    const pullRequestCursor = latestCursor(context, "github.pull_request");
    let pullRequestHighWatermark = pullRequestCursor;
    let reviewHighWatermark: Date | undefined;
    let reviewCommentHighWatermark: Date | undefined;
    let issueCommentHighWatermark: Date | undefined;
    let commitHighWatermark: Date | undefined;

    for await (const pullRequestSummary of client.paginateObjects(`/repos/${repository.path}/pulls`, {
      state: "all",
      sort: "updated",
      direction: "asc",
      per_page: "100",
    })) {
      const summaryUpdatedAt = dateFromString(pullRequestSummary.updated_at);
      if (pullRequestCursor && summaryUpdatedAt && summaryUpdatedAt <= pullRequestCursor) {
        continue;
      }

      const pullNumber = pullRequestNumber(pullRequestSummary);
      const pullRequest = await client.getObject(`/repos/${repository.path}/pulls/${pullNumber}`);
      const pullUpdatedAt = dateFromString(pullRequest.updated_at) ?? summaryUpdatedAt;

      if (pullRequestCursor && pullUpdatedAt && pullUpdatedAt <= pullRequestCursor) {
        continue;
      }

      objects.push(factory.create("github.pull_request", String(pullRequest.id ?? pullNumber), pullRequest));
      pullRequestHighWatermark = maxDate(pullRequestHighWatermark, pullUpdatedAt);

      for await (const review of client.paginateObjects(`/repos/${repository.path}/pulls/${pullNumber}/reviews`, { per_page: "100" })) {
        objects.push(factory.create("github.pull_request_review", String(review.id), review));
        reviewHighWatermark = maxDate(reviewHighWatermark, dateFromString(review.submitted_at) ?? dateFromString(review.updated_at));
      }

      for await (const reviewComment of client.paginateObjects(`/repos/${repository.path}/pulls/${pullNumber}/comments`, { per_page: "100" })) {
        objects.push(factory.create("github.pull_request_comment", String(reviewComment.id), reviewComment));
        reviewCommentHighWatermark = maxDate(reviewCommentHighWatermark, dateFromString(reviewComment.updated_at));
      }

      for await (const issueComment of client.paginateObjects(`/repos/${repository.path}/issues/${pullNumber}/comments`, { per_page: "100" })) {
        objects.push(factory.create("github.issue_comment", String(issueComment.id), issueComment));
        issueCommentHighWatermark = maxDate(issueCommentHighWatermark, dateFromString(issueComment.updated_at));
      }

      if (repository.includeCommits) {
        for await (const commit of client.paginateObjects(`/repos/${repository.path}/pulls/${pullNumber}/commits`, { per_page: "100" })) {
          const externalId = stringField(commit.sha) ?? stringField(commit.node_id);
          if (!externalId) {
            continue;
          }

          objects.push(factory.create("github.commit", externalId, commit));
          commitHighWatermark = maxDate(commitHighWatermark, dateFromString(objectField(commit.commit, "committer")?.date));
        }
      }
    }

    return {
      objects,
      cursorUpdates: compactCursorUpdates([
        { objectType: "github.pull_request", highWatermark: pullRequestHighWatermark },
        { objectType: "github.pull_request_review", highWatermark: reviewHighWatermark },
        { objectType: "github.pull_request_comment", highWatermark: reviewCommentHighWatermark },
        { objectType: "github.issue_comment", highWatermark: issueCommentHighWatermark },
        { objectType: "github.commit", highWatermark: commitHighWatermark },
      ]),
      metadata: {
        repository: repository.name,
        apiBaseUrl: this.apiBaseUrl,
        requestsMade: client.requestsMade,
      },
    };
  }
}

class LegacyGitHubRestClient {
  requestsMade = 0;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiBaseUrl: string,
    private readonly token: string,
  ) {}

  async getObject(path: string, query: Record<string, string> = {}): Promise<GitHubObject> {
    const value = await this.getJson(path, query);
    if (!isJsonObject(value)) {
      throw new Error(`GitHub API returned a non-object response for ${path}`);
    }

    return value;
  }

  async *paginateObjects(path: string, query: Record<string, string> = {}): AsyncGenerator<GitHubObject> {
    let url: string | undefined = this.buildUrl(path, query);

    while (url) {
      const response = await this.request(url);
      const value = await response.json();
      if (!Array.isArray(value)) {
        throw new Error(`GitHub API returned a non-array response for ${path}`);
      }

      for (const item of value) {
        if (!isJsonObject(item)) {
          throw new Error(`GitHub API returned a non-object item for ${path}`);
        }

        yield item;
      }

      url = nextLink(response.headers.get("link"));
    }
  }

  private async getJson(path: string, query: Record<string, string>): Promise<JsonValue> {
    const response = await this.request(this.buildUrl(path, query));
    const value = await response.json();
    if (!isJsonValue(value)) {
      throw new Error(`GitHub API returned a non-JSON response for ${path}`);
    }

    return value;
  }

  private async request(url: string): Promise<Response> {
    this.requestsMade += 1;

    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "teamtales-github-sync",
        "x-github-api-version": "2022-11-28",
      },
    });

    if (response.ok) {
      return response;
    }

    throw await githubApiError(response);
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    const url = new URL(path, `${this.apiBaseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }
}

class GitHubIncomingObjectFactory {
  constructor(private readonly context: ConnectorExecutionContext) {}

  create(objectType: GitHubSourceObjectType, externalId: string, rawJson: GitHubObject): IncomingSourceObject {
    return {
      organizationId: this.context.organizationId,
      integrationId: this.context.integrationId,
      syncScopeId: this.context.scope.id,
      provider: "github",
      objectType,
      externalId,
      rawJson,
      externalUrl: stringField(rawJson.html_url) ?? stringField(rawJson.url),
      externalCreatedAt: dateFromString(rawJson.created_at),
      externalUpdatedAt: dateFromString(rawJson.updated_at) ?? dateFromString(rawJson.submitted_at),
      sourceState: "active",
    };
  }
}

function parseRepositoryScope(context: ConnectorExecutionContext): GitHubRepositoryScopeConfig & { name: string; path: string } {
  const config = isJsonObject(context.scope.configJson) ? context.scope.configJson : {};
  const repository = stringField(config.repository) ?? context.scope.externalName ?? context.scope.externalId;

  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("GitHub repository scope must provide an owner/repo repository name");
  }

  const includeCommits = config.includeCommits === true;
  const [owner, repo] = repository.split("/");

  if (!owner || !repo) {
    throw new Error("GitHub repository scope must provide an owner/repo repository name");
  }

  return {
    repository,
    includeCommits,
    name: repository,
    path: `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  };
}

function latestCursor(context: ConnectorExecutionContext, objectType: GitHubSourceObjectType): Date | undefined {
  let latest: Date | undefined;

  for (const cursor of context.cursors) {
    if (cursor.provider !== "github" || cursor.objectType !== objectType || cursor.cursorKind !== "updated_at") {
      continue;
    }

    latest = maxDate(latest, cursor.highWatermark ?? dateFromString(cursor.cursorValue));
  }

  return latest;
}

function pullRequestNumber(pullRequest: GitHubObject): number {
  const number = pullRequest.number;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    throw new Error("GitHub pull request response is missing an integer number");
  }

  return number;
}

function compactCursorUpdates(updates: readonly ConnectorCursorUpdate[]): ConnectorCursorUpdate[] {
  return updates
    .filter((update) => update.highWatermark !== undefined)
    .map((update) => ({
      ...update,
      cursorValue: update.highWatermark?.toISOString(),
    }));
}

function maxDate(left: Date | undefined, right: Date | undefined): Date | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  return right > left ? right : left;
}

function dateFromString(value: JsonValue | undefined): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

function stringField(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectField(value: JsonValue | undefined, key: string): GitHubObject | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const nested = value[key];
  return isJsonObject(nested) ? nested : undefined;
}

function nextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) {
    return undefined;
  }

  for (const part of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2] === "next") {
      return match[1];
    }
  }

  return undefined;
}

async function githubApiError(response: Response): Promise<Error> {
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  const body = await safeErrorBody(response);
  const prefix =
    response.status === 403 && rateLimitRemaining === "0"
      ? `GitHub API rate limit exceeded${rateLimitReset ? ` until ${new Date(Number(rateLimitReset) * 1000).toISOString()}` : ""}`
      : `GitHub API request failed with ${response.status} ${response.statusText}`;

  return new Error(body ? `${prefix}: ${body}` : prefix);
}

async function safeErrorBody(response: Response): Promise<string | undefined> {
  try {
    const value = await response.json();
    if (isJsonObject(value) && typeof value.message === "string") {
      return value.message;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is GitHubObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}
