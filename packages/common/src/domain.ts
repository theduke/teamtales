export type Provider = "github" | "linear";

export type ReportScopeType =
  | "organization"
  | "person"
  | "github_repository"
  | "linear_team"
  | "linear_project";

export type HighlightType =
  | "completed_work"
  | "merged_pr"
  | "active_discussion"
  | "cross_team_collaboration"
  | "project_progress"
  | "potential_blocker"
  | "long_running_item_completed";

export type WorkItemStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "merged"
  | "closed"
  | "stale"
  | "unknown";

export type WorkType =
  | "github_pull_request"
  | "github_issue"
  | "linear_issue"
  | "linear_project";

export type ActivityEvent = {
  id: string;
  provider: Provider;
  eventType: string;
  actorPersonId?: string;
  workItemId?: string;
  repositoryId?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  occurredAt: string;
  title: string;
  body?: string;
  url?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
};

export type WorkItem = {
  id: string;
  provider: Provider;
  sourceType: WorkType;
  externalId: string;
  title: string;
  url?: string;
  status: WorkItemStatus;
  createdAtSource?: string;
  updatedAtSource?: string;
  startedAt?: string;
  completedAt?: string;
  repositoryId?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linkedWorkItemIds?: string[];
  labels?: string[];
};

export type Person = {
  id: string;
  displayName: string;
};

export type ScopeRef = {
  type: ReportScopeType;
  id: string;
  name: string;
};

export type OrganizationRef = {
  id: string;
  name: string;
};

export type Period = {
  start: string;
  end: string;
};

export type Metric = {
  name: string;
  value: number;
  dimensions?: Record<string, unknown>;
};

export type Highlight = {
  workItemId: string;
  highlightType: HighlightType;
  score: number;
  title: string;
  reason: string[];
  sourceRefs: string[];
  relatedPeople: string[];
  relatedWorkItems: string[];
};

export type Risk = {
  title: string;
  reason: string;
  sourceRefs: string[];
};

export type Freshness = {
  github?: string;
  linear?: string;
  warnings: string[];
};

export type ReportContext = {
  organization: OrganizationRef;
  scope: ScopeRef;
  period: Period;
  freshness: Freshness;
  metrics: Metric[];
  highlights: {
    title: string;
    reason: string;
    sourceRefs: string[];
    relatedPeople: string[];
    relatedWorkItems: string[];
  }[];
  people: {
    personId: string;
    displayName: string;
    activitySummary: string;
    metrics: Record<string, number>;
    sourceRefs: string[];
  }[];
  workItems: {
    id: string;
    provider: Provider;
    title: string;
    url: string;
    status: WorkItemStatus;
    summaryFacts: string[];
  }[];
  risks: Risk[];
};

export type AnalysisInput = {
  organization: OrganizationRef;
  scope: ScopeRef;
  period: Period;
  freshness?: Partial<Freshness>;
  events: ActivityEvent[];
  workItems: WorkItem[];
  people: Person[];
  manuallyPinnedWorkItemIds?: string[];
};
