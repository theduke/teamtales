import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LinearSourceConnector } from "../../src/ingestion/linear.js";
import type { ConnectorExecutionContext } from "../../src/ingestion/providers.js";
import type { SyncCursor } from "../../src/ingestion/sync.js";

const originalFetch = globalThis.fetch;

describe("LinearSourceConnector", () => {
  it("fetches Linear workspace objects with pagination and updated-at cursors", async () => {
    const calls: Array<{ authorization: string | null; query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = mockLinearFetch((query, variables, init) => {
      calls.push({
        authorization: new Headers(init.headers).get("authorization"),
        query,
        variables,
      });

      if (query.includes("LinearWorkspaceAndViewer")) {
        return {
          viewer: {
            id: "user_viewer",
            name: "Ada",
            displayName: "Ada Lovelace",
            email: "ada@example.test",
            active: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-06-28T12:00:00.000Z",
          },
          organization: {
            id: "workspace_1",
            name: "Acme",
            urlKey: "acme",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-06-28T12:00:00.000Z",
          },
        };
      }

      if (query.includes("LinearUsers")) {
        if (variables.after === null) {
          return connection("users", [{ id: "user_1", name: "Grace", active: true, createdAt: "2026-01-02T00:00:00.000Z" }], true, "users_page_2");
        }
        return connection("users", [{ id: "user_2", name: "Katherine", active: true, createdAt: "2026-01-03T00:00:00.000Z" }]);
      }

      if (query.includes("LinearTeams")) {
        return connection("teams", [{ id: "team_1", key: "ENG", name: "Engineering", createdAt: "2026-01-02T00:00:00.000Z" }]);
      }

      if (query.includes("LinearProjects")) {
        return connection("projects", [
          {
            id: "project_1",
            name: "MVP",
            state: "started",
            url: "https://linear.app/acme/project/mvp",
            createdAt: "2026-01-04T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z",
            teams: { nodes: [{ id: "team_1", key: "ENG", name: "Engineering" }] },
          },
        ]);
      }

      if (query.includes("LinearWorkflowStates")) {
        return connection("workflowStates", [
          {
            id: "state_1",
            name: "Done",
            type: "completed",
            team: { id: "team_1", key: "ENG", name: "Engineering" },
            createdAt: "2026-01-05T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z",
          },
        ]);
      }

      if (query.includes("LinearIssueLabels")) {
        return connection("issueLabels", [
          {
            id: "label_1",
            name: "backend",
            color: "#00ff00",
            team: { id: "team_1", key: "ENG", name: "Engineering" },
            createdAt: "2026-01-06T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z",
          },
        ]);
      }

      if (query.includes("LinearIssues")) {
        assert.deepEqual(variables.filter, {
          updatedAt: { gte: "2026-06-28T00:00:00.000Z" },
          team: { id: { eq: "team_1" } },
        });
        return connection("issues", [
          {
            id: "issue_1",
            identifier: "ENG-123",
            number: 123,
            title: "Ship real Linear sync",
            url: "https://linear.app/acme/issue/ENG-123",
            createdAt: "2026-06-27T00:00:00.000Z",
            updatedAt: "2026-06-29T08:00:00.000Z",
            team: { id: "team_1", key: "ENG", name: "Engineering" },
            state: { id: "state_1", name: "Done", type: "completed" },
          },
        ]);
      }

      if (query.includes("LinearComments")) {
        assert.deepEqual(variables.filter, {
          updatedAt: { gte: "2026-06-28T06:00:00.000Z" },
          issue: { team: { id: { eq: "team_1" } } },
        });
        return connection("comments", [
          {
            id: "comment_1",
            body: "Ready",
            url: "https://linear.app/acme/issue/ENG-123#comment-comment_1",
            createdAt: "2026-06-29T07:00:00.000Z",
            updatedAt: "2026-06-29T09:00:00.000Z",
            issue: { id: "issue_1", identifier: "ENG-123", title: "Ship real Linear sync" },
            user: { id: "user_1", name: "Grace" },
          },
        ]);
      }

      throw new Error(`unexpected query: ${query}`);
    });

    try {
      const result = await new LinearSourceConnector().fetchSourceObjects(context([issueCursor(), commentCursor()]));

      assert.equal(calls.every((call) => call.authorization === "lin_api_test_token"), true);
      assert.equal(calls.find((call) => call.query.includes("LinearUsers") && call.variables.after === "users_page_2") !== undefined, true);
      assert.deepEqual(
        result.objects.map((object) => `${object.objectType}:${object.externalId}`),
        [
          "linear.workspace:workspace_1",
          "linear.user:user_viewer",
          "linear.user:user_1",
          "linear.user:user_2",
          "linear.team:team_1",
          "linear.project:project_1",
          "linear.workflow_state:state_1",
          "linear.label:label_1",
          "linear.issue:issue_1",
          "linear.comment:comment_1",
        ],
      );
      assert.equal(result.objects.find((object) => object.objectType === "linear.issue")?.externalUrl, "https://linear.app/acme/issue/ENG-123");
      assert.deepEqual(result.cursorUpdates, [
        {
          objectType: "linear.issue",
          cursorValue: "2026-06-29T08:00:00.000Z",
          highWatermark: new Date("2026-06-29T08:00:00.000Z"),
        },
        {
          objectType: "linear.comment",
          cursorValue: "2026-06-29T09:00:00.000Z",
          highWatermark: new Date("2026-06-29T09:00:00.000Z"),
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces GraphQL errors without leaking the token", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Field does not exist", path: ["issues"], extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    try {
      await assert.rejects(new LinearSourceConnector().fetchSourceObjects(context()), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Field does not exist at issues \(GRAPHQL_VALIDATION_FAILED\)/);
        assert.equal(error.message.includes("lin_api_test_token"), false);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function context(cursors: SyncCursor[] = []): ConnectorExecutionContext {
  const now = new Date("2026-06-29T10:00:00.000Z");
  return {
    organizationId: "org_1",
    integrationId: "integration_1",
    credential: {
      integrationId: "integration_1",
      encryptedSecret: "lin_api_test_token",
    },
    cursors,
    scope: {
      id: "scope_1",
      organizationId: "org_1",
      integrationId: "integration_1",
      provider: "linear",
      scopeType: "linear.team",
      externalId: "team_1",
      externalName: "Engineering",
      configJson: { teamId: "team_1" },
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    run: {
      id: "run_1",
      organizationId: "org_1",
      integrationId: "integration_1",
      syncScopeId: "scope_1",
      provider: "linear",
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
  };
}

function issueCursor(): SyncCursor {
  return syncCursor("linear.issue", "2026-06-28T00:00:00.000Z");
}

function commentCursor(): SyncCursor {
  return syncCursor("linear.comment", "2026-06-28T06:00:00.000Z");
}

function syncCursor(objectType: string, cursorValue: string): SyncCursor {
  const now = new Date("2026-06-29T10:00:00.000Z");
  return {
    id: `cursor_${objectType}`,
    organizationId: "org_1",
    integrationId: "integration_1",
    syncScopeId: "scope_1",
    provider: "linear",
    objectType,
    cursorKind: "updated_at",
    cursorValue,
    createdAt: now,
    updatedAt: now,
  };
}

function mockLinearFetch(resolver: (query: string, variables: Record<string, unknown>, init: RequestInit) => Record<string, unknown>): typeof fetch {
  return async (_input, init) => {
    assert.ok(init);
    assert.equal(init.method, "POST");
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: resolver(body.query, body.variables, init) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function connection(name: string, nodes: Record<string, unknown>[], hasNextPage = false, endCursor: string | null = null): Record<string, unknown> {
  return {
    [name]: {
      nodes,
      pageInfo: {
        hasNextPage,
        endCursor,
      },
    },
  };
}
