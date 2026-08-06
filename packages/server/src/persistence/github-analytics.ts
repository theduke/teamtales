import { and, eq } from "drizzle-orm";
import type {
  GitHubAnalyticsDto,
  AnalyticsScopeType,
} from "@teamtales/common/api";
import type { DbExecutor } from "../db/mysql.js";
import {
  activityEvents,
  githubOrganizations,
  githubRepositories,
  sourceObjects,
  syncScopes,
} from "../db/schema.js";

type Raw = Record<string, unknown>;
type PrRow = {
  object: typeof sourceObjects.$inferSelect;
  scope: typeof syncScopes.$inferSelect | null;
  repositoryName: string | null;
  organizationName: string | null;
};
type RepositoryRef = { id: string; name: string; organizationId?: string };

export async function getGitHubAnalytics(
  db: DbExecutor,
  organizationId: string,
  options: {
    start: string;
    end: string;
    scopeType?: AnalyticsScopeType;
    scopeId?: string;
  },
): Promise<GitHubAnalyticsDto> {
  const start = new Date(options.start);
  const end = new Date(options.end);
  const rows = (await db
    .select({
      object: sourceObjects,
      scope: syncScopes,
      repositoryName: githubRepositories.displayName,
      organizationName: githubOrganizations.displayName,
    })
    .from(sourceObjects)
    .leftJoin(syncScopes, eq(syncScopes.id, sourceObjects.syncScopeId))
    .leftJoin(
      githubRepositories,
      eq(githubRepositories.id, syncScopes.githubRepositoryId),
    )
    .leftJoin(
      githubOrganizations,
      eq(githubOrganizations.id, syncScopes.githubOrganizationId),
    )
    .where(
      and(
        eq(sourceObjects.organizationId, organizationId),
        eq(sourceObjects.provider, "github"),
        eq(sourceObjects.objectType, "github.pull_request"),
      ),
    )) as PrRow[];
  const repositoryRows = await db
    .select({
      id: githubRepositories.id,
      externalId: githubRepositories.externalId,
      name: githubRepositories.displayName,
      organizationId: githubRepositories.githubOrganizationId,
    })
    .from(githubRepositories)
    .where(eq(githubRepositories.organizationId, organizationId));
  const repositoriesByExternalId = new Map<string, RepositoryRef>();
  for (const repository of repositoryRows) {
    const reference = {
      id: repository.id,
      name: repository.name,
      organizationId: repository.organizationId ?? undefined,
    };
    repositoriesByExternalId.set(repository.id, reference);
    repositoriesByExternalId.set(repository.externalId, reference);
  }

  const unique = new Map<string, PrRow>();
  for (const row of rows) {
    const previous = unique.get(row.object.externalId);
    if (!previous || row.object.lastSeenAt > previous.object.lastSeenAt) {
      unique.set(row.object.externalId, row);
    }
  }
  const selected = [...unique.values()].filter((row) => {
    const raw = parse(row.object.rawJson);
    const author = identity(raw.user);
    const created = date(raw.created_at);
    const mergedAt = date(raw.merged_at);
    if (!inRange(created, start, end) && !inRange(mergedAt, start, end))
      return false;
    const repository = repositoryRef(row, raw, repositoriesByExternalId);
    const repositoryMatches =
      !options.scopeType || options.scopeType === "github_organization"
        ? !options.scopeId ||
          row.scope?.githubOrganizationId === options.scopeId ||
          repository?.organizationId === options.scopeId
        : options.scopeType === "github_repository"
          ? row.scope?.githubRepositoryId === options.scopeId ||
            repository?.id === options.scopeId
          : author === options.scopeId ||
            identity(raw.merged_by) === options.scopeId;
    return repositoryMatches;
  });

  const developers = new Map<string, Breakdown>();
  const repositories = new Map<string, Breakdown>();
  const trend = new Map<string, Trend>();
  let opened = 0;
  let merged = 0;
  let additions = 0;
  let deletions = 0;
  for (const row of selected) {
    const raw = parse(row.object.rawJson);
    const author = identity(raw.user) ?? "Unknown developer";
    const mergedBy = identity(raw.merged_by) ?? author;
    const prAdditions = number(raw.additions);
    const prDeletions = number(raw.deletions);
    const created = date(raw.created_at);
    const mergedAt = date(raw.merged_at);
    const repositoryRefValue = repositoryRef(
      row,
      raw,
      repositoriesByExternalId,
    );
    const repoId =
      repositoryRefValue?.id ??
      row.scope?.githubRepositoryId ??
      row.object.syncScopeId ??
      "unknown";
    const repoName =
      repositoryRefValue?.name ?? row.repositoryName ?? "Unknown repository";
    const developer = developers.get(author) ?? blank(author, author);
    const repository = repositories.get(repoId) ?? blank(repoId, repoName);
    const openedInPeriod = inRange(created, start, end);
    developer.additions += openedInPeriod ? prAdditions : 0;
    developer.deletions += openedInPeriod ? prDeletions : 0;
    repository.additions += openedInPeriod ? prAdditions : 0;
    repository.deletions += openedInPeriod ? prDeletions : 0;
    if (inRange(created, start, end)) {
      opened += 1;
      developer.opened += 1;
      repository.opened += 1;
      addTrend(trend, created!, "opened", prAdditions, prDeletions);
    }
    if (inRange(mergedAt, start, end)) {
      merged += 1;
      const merger = developers.get(mergedBy) ?? blank(mergedBy, mergedBy);
      merger.merged += 1;
      developers.set(mergedBy, merger);
      repository.merged += 1;
      addTrend(trend, mergedAt!, "merged", 0, 0);
    }
    developers.set(author, developer);
    repositories.set(repoId, repository);
    additions += inRange(created, start, end) ? prAdditions : 0;
    deletions += inRange(created, start, end) ? prDeletions : 0;
  }

  const events = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.organizationId, organizationId),
        eq(activityEvents.provider, "github"),
      ),
    );
  const eventCounts = events.filter((event) => {
    const occurred = new Date(event.occurredAt);
    if (occurred < start || occurred >= end) return false;
    if (!options.scopeType) return true;
    return selected.some(
      (row) =>
        `github:github_pull_request:${row.object.externalId}` ===
        event.workItemId,
    );
  });

  return {
    period: { start: options.start, end: options.end },
    scope: {
      ...(options.scopeType ? { type: options.scopeType } : {}),
      ...(options.scopeId ? { id: options.scopeId } : {}),
      name: options.scopeId ?? "All GitHub activity",
    },
    totals: {
      pullRequests: selected.length,
      opened,
      merged,
      additions,
      deletions,
      reviews: eventCounts.filter(
        (event) => event.eventType === "github.pr_reviewed",
      ).length,
      comments: eventCounts.filter((event) =>
        event.eventType.includes("commented"),
      ).length,
    },
    developers: sortBreakdowns(developers),
    repositories: sortBreakdowns(repositories),
    trend: [...trend.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, ...value })),
    scopes: buildScopes(rows, repositoriesByExternalId),
  };
}

type Breakdown = {
  id: string;
  name: string;
  opened: number;
  merged: number;
  additions: number;
  deletions: number;
};
type Trend = {
  opened: number;
  merged: number;
  additions: number;
  deletions: number;
};
function blank(id: string, name: string): Breakdown {
  return { id, name, opened: 0, merged: 0, additions: 0, deletions: 0 };
}
function sortBreakdowns(items: Map<string, Breakdown>): Breakdown[] {
  return [...items.values()].sort(
    (a, b) => b.opened + b.merged - a.opened - a.merged,
  );
}
function parse(value: string): Raw {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Raw) : {};
  } catch {
    return {};
  }
}
function identity(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Raw;
  return typeof raw.login === "string"
    ? raw.login
    : typeof raw.name === "string"
      ? raw.name
      : undefined;
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function date(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}
function inRange(value: Date | undefined, start: Date, end: Date): boolean {
  return Boolean(value && value >= start && value < end);
}
function addTrend(
  map: Map<string, Trend>,
  value: Date,
  field: "opened" | "merged",
  additions: number,
  deletions: number,
): void {
  const key = value.toISOString().slice(0, 10);
  const item = map.get(key) ?? {
    opened: 0,
    merged: 0,
    additions: 0,
    deletions: 0,
  };
  item[field] += 1;
  item.additions += additions;
  item.deletions += deletions;
  map.set(key, item);
}
function buildScopes(
  rows: PrRow[],
  repositoriesByExternalId: Map<string, RepositoryRef>,
): GitHubAnalyticsDto["scopes"] {
  const scopes = new Map<string, GitHubAnalyticsDto["scopes"][number]>();
  for (const row of rows) {
    if (row.scope?.githubOrganizationId && row.organizationName)
      scopes.set(`github_organization:${row.scope.githubOrganizationId}`, {
        id: row.scope.githubOrganizationId,
        name: row.organizationName,
        type: "github_organization",
      });
    if (row.scope?.githubRepositoryId && row.repositoryName)
      scopes.set(`github_repository:${row.scope.githubRepositoryId}`, {
        id: row.scope.githubRepositoryId,
        name: row.repositoryName,
        type: "github_repository",
      });
    const repository = repositoryRef(
      row,
      parse(row.object.rawJson),
      repositoriesByExternalId,
    );
    if (repository)
      scopes.set(`github_repository:${repository.id}`, {
        id: repository.id,
        name: repository.name,
        type: "github_repository",
      });
    const author = identity(parse(row.object.rawJson).user);
    if (author)
      scopes.set(`developer:${author}`, {
        id: author,
        name: author,
        type: "developer",
      });
  }
  return [...scopes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function repositoryRef(
  row: PrRow,
  raw: Raw,
  repositoriesByExternalId: Map<string, RepositoryRef>,
): RepositoryRef | undefined {
  if (row.scope?.githubRepositoryId) {
    const linked = repositoriesByExternalId.get(row.scope.githubRepositoryId);
    if (linked) return linked;
  }
  const repository =
    objectValue(raw, "base")?.repo ?? objectValue(raw, "repository");
  if (!repository || typeof repository !== "object") return undefined;
  const repositoryRaw = repository as Raw;
  const externalId =
    typeof repositoryRaw.id === "string" || typeof repositoryRaw.id === "number"
      ? String(repositoryRaw.id)
      : undefined;
  const byId = externalId
    ? repositoriesByExternalId.get(externalId)
    : undefined;
  if (byId) return byId;
  const fullName = repositoryRaw.full_name;
  return typeof fullName === "string"
    ? ([...repositoriesByExternalId.values()].find(
        (item) => item.name === fullName,
      ) ?? { id: fullName, name: fullName })
    : undefined;
}

function objectValue(value: Raw, key: string): Raw | undefined {
  const result = value[key];
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Raw)
    : undefined;
}
