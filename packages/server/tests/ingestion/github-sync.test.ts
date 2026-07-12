import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GitHubSourceConnector } from "../../src/ingestion/github.js";
import type { ConnectorExecutionContext } from "../../src/ingestion/providers.js";
import type { JsonValue } from "../../src/ingestion/json.js";

const now = new Date("2026-06-29T10:00:00.000Z");

describe("GitHubSourceConnector", () => {
  it("fetches repository pull request objects and related review activity", async () => {
    const fetch = mockGitHubFetch({
      "GET /repos/acme/widgets": jsonResponse(repo()),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([pullSummary(7)]),
      "GET /repos/acme/widgets/pulls/7": jsonResponse(pullDetail(7)),
      "GET /repos/acme/widgets/pulls/7/reviews?per_page=100": jsonResponse([review(90)]),
      "GET /repos/acme/widgets/pulls/7/comments?per_page=100": jsonResponse([reviewComment(91)]),
      "GET /repos/acme/widgets/issues/7/comments?per_page=100": jsonResponse([issueComment(92)]),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    const result = await connector.fetchSourceObjects(context());

    assert.deepEqual(
      result.objects.map((object) => `${object.objectType}:${object.externalId}`),
      [
        "github.repository:100",
        "github.pull_request:700",
        "github.pull_request_review:90",
        "github.pull_request_comment:91",
        "github.issue_comment:92",
      ],
    );
    assert.equal(result.objects[1]?.externalUrl, "https://github.com/acme/widgets/pull/7");
    assert.equal(result.objects[1]?.externalCreatedAt?.toISOString(), "2026-06-28T08:00:00.000Z");
    assert.equal(result.objects[1]?.externalUpdatedAt?.toISOString(), "2026-06-29T09:00:00.000Z");
    assert.equal(
      result.cursorUpdates.find((cursor) => cursor.objectType === "github.pull_request")
        ?.cursorValue,
      "2026-06-29T09:00:00.000Z",
    );
    assert.equal(
      result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
        ? result.metadata.requestsMade
        : undefined,
      6,
    );
    assert.equal(fetch.calls[0]?.headers.authorization, "Bearer github_pat_secret");
  });

  it("uses updated_at cursors to skip old pull requests before fetching details", async () => {
    const fetch = mockGitHubFetch({
      "GET /repos/acme/widgets": jsonResponse(repo()),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([
          pullSummary(7, "2026-06-29T09:00:00.000Z"),
          pullSummary(6, "2026-06-28T09:00:00.000Z"),
        ]),
      "GET /repos/acme/widgets/pulls/7": jsonResponse(pullDetail(7)),
      "GET /repos/acme/widgets/pulls/7/reviews?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls/7/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/issues/7/comments?per_page=100": jsonResponse([]),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    const result = await connector.fetchSourceObjects(
      context({
        cursors: [
          {
            id: "cursor_1",
            organizationId: "org_1",
            integrationId: "int_1",
            syncScopeId: "scope_1",
            provider: "github",
            objectType: "github.pull_request",
            cursorKind: "updated_at",
            highWatermark: new Date("2026-06-29T00:00:00.000Z"),
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );

    assert.deepEqual(
      result.objects.map((object) => `${object.objectType}:${object.externalId}`),
      ["github.repository:100", "github.pull_request:700"],
    );
    assert.equal(
      fetch.calls.some((call) => call.path === "/repos/acme/widgets/pulls/6"),
      false,
    );
  });

  it("walks newest-first and stops after the cursor safety overlap", async () => {
    const fetch = mockGitHubFetch({
      "GET /repos/acme/widgets": jsonResponse(repo()),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([pullSummary(7, "2026-06-29T09:01:00.000Z")], {
          link: '<https://api.github.test/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2>; rel="next"',
        }),
      "GET /repos/acme/widgets/pulls/7": jsonResponse(pullDetail(7)),
      "GET /repos/acme/widgets/pulls/7/reviews?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls/7/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/issues/7/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2":
        jsonResponse([pullSummary(6, "2026-06-29T08:57:00.000Z")], {
          link: '<https://api.github.test/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=3>; rel="next"',
        }),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    const result = await connector.fetchSourceObjects(
      context({
        cursors: [
          {
            id: "cursor_1",
            organizationId: "org_1",
            integrationId: "int_1",
            syncScopeId: "scope_1",
            provider: "github",
            objectType: "github.pull_request",
            cursorKind: "updated_at",
            highWatermark: new Date("2026-06-29T09:00:00.000Z"),
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );

    assert.deepEqual(
      result.objects.map((object) => `${object.objectType}:${object.externalId}`),
      ["github.repository:100", "github.pull_request:700"],
    );
    assert.equal(
      fetch.calls.some((call) => call.key.includes("page=3")),
      false,
    );
    assert.equal(
      fetch.calls.some((call) => call.path === "/repos/acme/widgets/pulls/6"),
      false,
    );
  });

  it("skips pending reviews that GitHub has not timestamped", async () => {
    const fetch = mockGitHubFetch({
      "GET /repos/acme/widgets": jsonResponse(repo()),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([pullSummary(7)]),
      "GET /repos/acme/widgets/pulls/7": jsonResponse(pullDetail(7)),
      "GET /repos/acme/widgets/pulls/7/reviews?per_page=100": jsonResponse([
        { id: 90, state: "PENDING", pull_request_url: "https://api.github.test/repos/acme/widgets/pulls/7" },
      ]),
      "GET /repos/acme/widgets/pulls/7/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/issues/7/comments?per_page=100": jsonResponse([]),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    const result = await connector.fetchSourceObjects(context());

    assert.deepEqual(
      result.objects.map((object) => `${object.objectType}:${object.externalId}`),
      ["github.repository:100", "github.pull_request:700"],
    );
  });

  it("expands an all-repositories organization scope into repository syncs", async () => {
    const fetch = mockGitHubFetch({
      "GET /orgs/acme/repos?type=all&per_page=100": jsonResponse([
        repo(),
        { ...repo(), id: 101, full_name: "acme/gadgets", name: "gadgets" },
      ]),
      "GET /repos/acme/widgets": jsonResponse(repo()),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([]),
      "GET /repos/acme/gadgets": jsonResponse({
        ...repo(),
        id: 101,
        full_name: "acme/gadgets",
        name: "gadgets",
      }),
      "GET /repos/acme/gadgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([]),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    const result = await connector.fetchSourceObjects(organizationContext("all"));

    assert.deepEqual(
      result.objects.map((object) => `${object.objectType}:${object.externalId}`),
      ["github.repository:100", "github.repository:101"],
    );
    assert.equal(
      fetch.calls.some((call) => call.path === "/orgs/acme/repos"),
      true,
    );
  });

  it("does not resync an organization whose selected repositories have child scopes", async () => {
    const connector = new GitHubSourceConnector({
      fetch: mockGitHubFetch({}),
      apiBaseUrl: "https://api.github.test",
    });

    const result = await connector.fetchSourceObjects(organizationContext("selected"));

    assert.deepEqual(result.objects, []);
  });

  it("follows pagination links and optionally fetches commits", async () => {
    const fetch = mockGitHubFetch({
      "GET /repos/acme/widgets": jsonResponse(repo()),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100":
        jsonResponse([pullSummary(7)], {
          link: '<https://api.github.test/repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2>; rel="next"',
        }),
      "GET /repos/acme/widgets/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2":
        jsonResponse([pullSummary(8)]),
      "GET /repos/acme/widgets/pulls/7": jsonResponse(pullDetail(7)),
      "GET /repos/acme/widgets/pulls/7/reviews?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls/7/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/issues/7/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls/7/commits?per_page=100": jsonResponse([commit("abc123")]),
      "GET /repos/acme/widgets/pulls/8": jsonResponse(pullDetail(8)),
      "GET /repos/acme/widgets/pulls/8/reviews?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls/8/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/issues/8/comments?per_page=100": jsonResponse([]),
      "GET /repos/acme/widgets/pulls/8/commits?per_page=100": jsonResponse([commit("def456")]),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    const result = await connector.fetchSourceObjects(context({ includeCommits: true }));

    assert.deepEqual(
      result.objects
        .filter((object) => object.objectType === "github.commit")
        .map((object) => object.externalId),
      ["abc123", "def456"],
    );
    assert.equal(
      result.cursorUpdates.find((cursor) => cursor.objectType === "github.commit")?.cursorValue,
      "2026-06-29T09:30:00.000Z",
    );
  });

  it("throws a rate-limit specific error", async () => {
    const fetch = mockGitHubFetch({
      "GET /repos/acme/widgets": jsonResponse(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1782730800",
          },
        },
      ),
    });
    const connector = new GitHubSourceConnector({ fetch, apiBaseUrl: "https://api.github.test" });

    await assert.rejects(
      () => connector.fetchSourceObjects(context()),
      /GitHub API rate limit exceeded until 2026-06-29T11:00:00.000Z: API rate limit exceeded/,
    );
  });
});

function context(
  options: { includeCommits?: boolean; cursors?: ConnectorExecutionContext["cursors"] } = {},
): ConnectorExecutionContext {
  return {
    organizationId: "org_1",
    integrationId: "int_1",
    scope: {
      id: "scope_1",
      organizationId: "org_1",
      integrationId: "int_1",
      provider: "github",
      scopeType: "github.repository",
      externalId: "acme/widgets",
      externalName: "acme/widgets",
      configJson: options.includeCommits
        ? { repository: "acme/widgets", includeCommits: true }
        : { repository: "acme/widgets" },
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    run: {
      id: "run_1",
      organizationId: "org_1",
      integrationId: "int_1",
      syncScopeId: "scope_1",
      provider: "github",
      runType: "incremental_sync",
      status: "running",
      startedAt: now,
      objectsFetched: 0,
      objectsInserted: 0,
      objectsUpdated: 0,
      objectsUnchanged: 0,
      objectsFailed: 0,
      activityEventsEmitted: 0,
      createdAt: now,
    },
    cursors: options.cursors ?? [],
    credential: {
      integrationId: "int_1",
      encryptedSecret: "github_pat_secret",
      secretHint: "ghit...cret",
    },
  };
}

function organizationContext(selectionMode: "all" | "selected"): ConnectorExecutionContext {
  const result = context();
  return {
    ...result,
    scope: {
      ...result.scope,
      scopeType: "github.organization",
      externalId: "1",
      externalName: "acme",
      selectionMode,
      configJson: {},
    },
  };
}

interface MockCall {
  key: string;
  path: string;
  headers: Record<string, string>;
}

function mockGitHubFetch(routes: Record<string, Response>) {
  const calls: MockCall[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const key = `GET ${url.pathname}${url.search}`;
    const headers = new Headers(init?.headers);
    calls.push({
      key,
      path: url.pathname,
      headers: Object.fromEntries(headers.entries()),
    });

    const response = routes[key];
    if (!response) {
      throw new Error(`Unexpected GitHub API request: ${key}`);
    }

    return response.clone();
  };

  return Object.assign(fetch, { calls });
}

function jsonResponse(
  body: JsonValue,
  options: {
    status?: number;
    statusText?: string;
    link?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (options.link) {
    headers.set("link", options.link);
  }

  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers,
  });
}

function repo(): JsonValue {
  return {
    id: 100,
    name: "widgets",
    full_name: "acme/widgets",
    html_url: "https://github.com/acme/widgets",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-06-29T08:00:00.000Z",
  };
}

function pullSummary(number: number, updatedAt = "2026-06-29T09:00:00.000Z"): JsonValue {
  return {
    id: number * 100,
    number,
    updated_at: updatedAt,
  };
}

function pullDetail(number: number): JsonValue {
  return {
    id: number * 100,
    number,
    title: `Pull request ${number}`,
    state: "open",
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    created_at: "2026-06-28T08:00:00.000Z",
    updated_at: "2026-06-29T09:00:00.000Z",
    user: { id: 1, login: "alice" },
  };
}

function review(id: number): JsonValue {
  return {
    id,
    state: "APPROVED",
    html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
    submitted_at: "2026-06-29T09:10:00.000Z",
    user: { id: 2, login: "bob" },
  };
}

function reviewComment(id: number): JsonValue {
  return {
    id,
    body: "Looks good",
    html_url: `https://github.com/acme/widgets/pull/7#discussion_r${id}`,
    created_at: "2026-06-29T09:12:00.000Z",
    updated_at: "2026-06-29T09:13:00.000Z",
    user: { id: 3, login: "carol" },
  };
}

function issueComment(id: number): JsonValue {
  return {
    id,
    body: "Thanks",
    html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
    created_at: "2026-06-29T09:14:00.000Z",
    updated_at: "2026-06-29T09:15:00.000Z",
    user: { id: 4, login: "dave" },
  };
}

function commit(sha: string): JsonValue {
  return {
    sha,
    html_url: `https://github.com/acme/widgets/commit/${sha}`,
    commit: {
      message: "Ship widgets",
      committer: {
        date: "2026-06-29T09:30:00.000Z",
      },
    },
  };
}
