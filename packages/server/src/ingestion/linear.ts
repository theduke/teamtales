import type { JsonValue } from "./json.js";
import type {
  ConnectorExecutionContext,
  ConnectorFetchResult,
  SourceConnector,
} from "./providers.js";
import type { IncomingSourceObject, LinearSourceObjectType } from "./source-object.js";
import type { SyncCursor } from "./sync.js";
import { fetchConnection, LinearGraphqlClient } from "../providers/linear-client.js";

const linearGraphqlEndpoint = "https://api.linear.app/graphql";

export const linearMvpObjectTypes = [
  "linear.workspace",
  "linear.user",
  "linear.team",
  "linear.project",
  "linear.workflow_state",
  "linear.label",
  "linear.issue",
  "linear.comment",
] as const satisfies readonly LinearSourceObjectType[];

export const linearMvpScopeTypes = ["linear.workspace", "linear.team", "linear.project"] as const;

export interface LinearWorkspaceScopeConfig {
  workspaceId?: string;
  includeProjects?: boolean;
}

export interface LinearTeamScopeConfig {
  teamId: string;
  includeProjects?: boolean;
}

type JsonValueObject = { [key: string]: JsonValue };

type WorkspaceAndViewerResponse = {
  viewer?: JsonValueObject | null;
  organization?: JsonValueObject | null;
};

export class LinearSourceConnector implements SourceConnector {
  readonly provider = "linear";
  readonly supportedObjectTypes = linearMvpObjectTypes;
  readonly supportedScopeTypes = linearMvpScopeTypes;

  async fetchSourceObjects(context: ConnectorExecutionContext): Promise<ConnectorFetchResult> {
    if (context.scope.provider !== this.provider) {
      throw new Error(
        `Linear connector cannot fetch ${context.scope.provider} scope ${context.scope.id}`,
      );
    }

    const client = new LinearGraphqlClient(context.credential.encryptedSecret);
    const scope = linearScope(context);
    const identity = sourceIdentity(context);
    const objects: IncomingSourceObject[] = [];
    const cursorUpdates = [];

    const workspaceAndViewer =
      await client.query<WorkspaceAndViewerResponse>(workspaceAndViewerQuery);
    const workspace = workspaceAndViewer.organization;
    if (workspace) {
      objects.push(
        toIncoming(
          identity,
          "linear.workspace",
          stringId(workspace, context.scope.externalId),
          workspace,
        ),
      );
    }

    const viewer = workspaceAndViewer.viewer;
    if (viewer) {
      objects.push(toIncoming(identity, "linear.user", stringId(viewer), viewer));
    }

    for (const user of await fetchConnection(client, "users", usersQuery)) {
      objects.push(toIncoming(identity, "linear.user", stringId(user), user));
    }

    for (const team of filterByScope(await fetchConnection(client, "teams", teamsQuery), scope)) {
      objects.push(toIncoming(identity, "linear.team", stringId(team), team));
    }

    for (const project of filterByScope(
      await fetchConnection(client, "projects", projectsQuery),
      scope,
    )) {
      objects.push(
        toIncoming(
          identity,
          "linear.project",
          stringId(project),
          project,
          dateFromField(project, "createdAt"),
          dateFromField(project, "updatedAt"),
        ),
      );
    }

    for (const workflowState of filterByScope(
      await fetchConnection(client, "workflowStates", workflowStatesQuery),
      scope,
    )) {
      objects.push(
        toIncoming(
          identity,
          "linear.workflow_state",
          stringId(workflowState),
          workflowState,
          dateFromField(workflowState, "createdAt"),
          dateFromField(workflowState, "updatedAt"),
        ),
      );
    }

    for (const label of filterByScope(
      await fetchConnection(client, "issueLabels", issueLabelsQuery),
      scope,
    )) {
      objects.push(
        toIncoming(
          identity,
          "linear.label",
          stringId(label),
          label,
          dateFromField(label, "createdAt"),
          dateFromField(label, "updatedAt"),
        ),
      );
    }

    const issueSince = cursorSince(context.cursors, "linear.issue");
    const issueFilter = scopedUpdatedAtFilter(scope, issueSince);
    const issues = await fetchConnection(client, "issues", issuesQuery, { filter: issueFilter });
    const issueHighWatermark = maxUpdatedAt(issues);
    for (const issue of issues) {
      objects.push(
        toIncoming(
          identity,
          "linear.issue",
          stringId(issue),
          issue,
          dateFromField(issue, "createdAt"),
          dateFromField(issue, "updatedAt"),
          stringField(issue, "url"),
        ),
      );
    }
    cursorUpdates.push({
      objectType: "linear.issue",
      cursorValue: issueHighWatermark?.toISOString() ?? issueSince?.toISOString(),
      highWatermark: issueHighWatermark ?? issueSince,
    });

    const commentSince = cursorSince(context.cursors, "linear.comment");
    const commentFilter = scopedUpdatedAtFilter(scope, commentSince, true);
    const comments = await fetchConnection(client, "comments", commentsQuery, {
      filter: commentFilter,
    });
    const commentHighWatermark = maxUpdatedAt(comments);
    for (const comment of comments) {
      objects.push(
        toIncoming(
          identity,
          "linear.comment",
          stringId(comment),
          comment,
          dateFromField(comment, "createdAt"),
          dateFromField(comment, "updatedAt"),
          stringField(comment, "url"),
        ),
      );
    }
    cursorUpdates.push({
      objectType: "linear.comment",
      cursorValue: commentHighWatermark?.toISOString() ?? commentSince?.toISOString(),
      highWatermark: commentHighWatermark ?? commentSince,
    });

    const metadata: JsonValueObject = stripUndefinedJson({
      endpoint: linearGraphqlEndpoint,
      scopeType: context.scope.scopeType,
      teamId: scope.teamId,
      projectId: scope.projectId,
      issueSince: issueSince?.toISOString(),
      commentSince: commentSince?.toISOString(),
    });

    return {
      objects,
      cursorUpdates,
      metadata,
    };
  }
}

function sourceIdentity(
  context: ConnectorExecutionContext,
): Omit<IncomingSourceObject, "objectType" | "externalId" | "rawJson"> {
  return {
    organizationId: context.organizationId,
    integrationId: context.integrationId,
    syncScopeId: context.scope.id,
    provider: "linear",
  };
}

function toIncoming(
  identity: Omit<IncomingSourceObject, "objectType" | "externalId" | "rawJson">,
  objectType: LinearSourceObjectType,
  externalId: string,
  rawJson: JsonValueObject,
  externalCreatedAt?: Date,
  externalUpdatedAt?: Date,
  externalUrl?: string,
): IncomingSourceObject {
  const incoming: IncomingSourceObject = {
    ...identity,
    objectType,
    externalId,
    rawJson,
    sourceState: "active",
  };

  if (externalCreatedAt) {
    incoming.externalCreatedAt = externalCreatedAt;
  }
  if (externalUpdatedAt) {
    incoming.externalUpdatedAt = externalUpdatedAt;
  }
  if (externalUrl) {
    incoming.externalUrl = externalUrl;
  }

  return incoming;
}

function linearScope(context: ConnectorExecutionContext): { teamId?: string; projectId?: string } {
  const config = isRecord(context.scope.configJson) ? context.scope.configJson : {};
  const configuredTeamId = stringField(config, "teamId") ?? stringField(config, "linearTeamId");
  const configuredProjectId =
    stringField(config, "projectId") ?? stringField(config, "linearProjectId");

  return {
    teamId:
      context.scope.scopeType === "linear.team"
        ? (configuredTeamId ?? context.scope.externalId)
        : configuredTeamId,
    projectId:
      context.scope.scopeType === "linear.project"
        ? (configuredProjectId ?? context.scope.externalId)
        : configuredProjectId,
  };
}

function filterByScope<TNode extends JsonValueObject>(
  nodes: TNode[],
  scope: { teamId?: string; projectId?: string },
): TNode[] {
  return nodes.filter((node) => {
    if (
      scope.projectId &&
      stringField(node, "id") !== scope.projectId &&
      nestedString(node, ["project", "id"]) !== scope.projectId
    ) {
      return false;
    }

    if (
      scope.teamId &&
      nestedString(node, ["team", "id"]) !== scope.teamId &&
      !teamsIncludeId(node, scope.teamId) &&
      stringField(node, "id") !== scope.teamId
    ) {
      return false;
    }

    return true;
  });
}

function scopedUpdatedAtFilter(
  scope: { teamId?: string; projectId?: string },
  since: Date | undefined,
  isComment = false,
): JsonValueObject | null {
  const filter: JsonValueObject = {};
  if (since) {
    filter.updatedAt = { gte: since.toISOString() };
  }
  if (scope.teamId) {
    if (isComment) {
      const issueFilter = isRecord(filter.issue) ? filter.issue : {};
      issueFilter.team = { id: { eq: scope.teamId } };
      filter.issue = issueFilter;
    } else {
      filter.team = { id: { eq: scope.teamId } };
    }
  }
  if (scope.projectId) {
    if (isComment) {
      const issueFilter = isRecord(filter.issue) ? filter.issue : {};
      issueFilter.project = { id: { eq: scope.projectId } };
      filter.issue = issueFilter;
    } else {
      filter.project = { id: { eq: scope.projectId } };
    }
  }
  return Object.keys(filter).length > 0 ? filter : null;
}

function cursorSince(
  cursors: readonly SyncCursor[],
  objectType: LinearSourceObjectType,
): Date | undefined {
  const candidates = cursors.filter(
    (cursor) =>
      cursor.provider === "linear" &&
      cursor.objectType === objectType &&
      cursor.cursorKind === "updated_at",
  );
  const dates = candidates
    .flatMap((cursor) => [
      cursor.highWatermark,
      cursor.cursorValue ? parseDate(cursor.cursorValue) : undefined,
    ])
    .filter((date): date is Date => date instanceof Date);

  return dates.sort((left, right) => right.getTime() - left.getTime())[0];
}

function maxUpdatedAt(nodes: readonly JsonValueObject[]): Date | undefined {
  return nodes
    .map((node) => dateFromField(node, "updatedAt"))
    .filter((date): date is Date => date instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0];
}

function stringId(record: JsonValueObject, fallback?: string): string {
  const id = stringField(record, "id") ?? fallback;
  if (!id) {
    throw new Error("Linear object is missing id");
  }
  return id;
}

function dateFromField(record: JsonValueObject, key: string): Date | undefined {
  return parseDate(stringField(record, key));
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function teamsIncludeId(node: JsonValueObject, teamId: string): boolean {
  const teams = node.teams;
  if (!isRecord(teams) || !Array.isArray(teams.nodes)) {
    return false;
  }

  return teams.nodes.some((team) => isRecord(team) && stringField(team, "id") === teamId);
}

function nestedString(record: JsonValueObject, path: readonly string[]): string | undefined {
  let value: JsonValue | undefined = record;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

function stringField(record: JsonValueObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stripUndefinedJson(record: Record<string, JsonValue | undefined>): JsonValueObject {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as JsonValueObject;
}

function isRecord(value: unknown): value is JsonValueObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const pageInfoFragment = `
  pageInfo {
    hasNextPage
    endCursor
  }
`;

const workspaceAndViewerQuery = `
  query LinearWorkspaceAndViewer {
    viewer {
      id
      name
      displayName
      email
      avatarUrl
      active
      createdAt
      updatedAt
    }
    organization {
      id
      name
      urlKey
      createdAt
      updatedAt
    }
  }
`;

const usersQuery = `
  query LinearUsers($first: Int!, $after: String) {
    users(first: $first, after: $after) {
      nodes {
        id
        name
        displayName
        email
        avatarUrl
        active
        createdAt
        updatedAt
      }
      ${pageInfoFragment}
    }
  }
`;

const teamsQuery = `
  query LinearTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes {
        id
        key
        name
        description
        private
        createdAt
        updatedAt
      }
      ${pageInfoFragment}
    }
  }
`;

const projectsQuery = `
  query LinearProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      nodes {
        id
        name
        description
        state
        url
        createdAt
        updatedAt
        completedAt
        canceledAt
        teams {
          nodes {
            id
            key
            name
          }
        }
      }
      ${pageInfoFragment}
    }
  }
`;

const workflowStatesQuery = `
  query LinearWorkflowStates($first: Int!, $after: String) {
    workflowStates(first: $first, after: $after) {
      nodes {
        id
        name
        type
        color
        position
        createdAt
        updatedAt
        team {
          id
          key
          name
        }
      }
      ${pageInfoFragment}
    }
  }
`;

const issueLabelsQuery = `
  query LinearIssueLabels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after) {
      nodes {
        id
        name
        description
        color
        createdAt
        updatedAt
        team {
          id
          key
          name
        }
      }
      ${pageInfoFragment}
    }
  }
`;

const issuesQuery = `
  query LinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      nodes {
        id
        identifier
        number
        title
        description
        url
        priority
        estimate
        createdAt
        updatedAt
        startedAt
        completedAt
        canceledAt
        archivedAt
        team {
          id
          key
          name
        }
        state {
          id
          name
          type
        }
        assignee {
          id
          name
          displayName
          email
        }
        creator {
          id
          name
          displayName
          email
        }
        project {
          id
          name
          url
        }
        labels {
          nodes {
            id
            name
            color
          }
        }
      }
      ${pageInfoFragment}
    }
  }
`;

const commentsQuery = `
  query LinearComments($first: Int!, $after: String, $filter: CommentFilter) {
    comments(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      nodes {
        id
        body
        url
        createdAt
        updatedAt
        user {
          id
          name
          displayName
          email
        }
        issue {
          id
          identifier
          title
          url
          team {
            id
            key
            name
          }
          project {
            id
            name
            url
          }
        }
      }
      ${pageInfoFragment}
    }
  }
`;
