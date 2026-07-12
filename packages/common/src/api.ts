import type {
  AnalysisInput,
  Highlight,
  Metric,
  Provider,
  ReportContext,
  ReportScopeType,
  ScopeRef,
} from "./domain.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ApiErrorDto = {
  code: string;
  message: string;
  details?: JsonObject;
};

export type ApiErrorResponse = {
  ok: false;
  error: ApiErrorDto;
};

export type ApiResponseDto<T> =
  | {
      ok: true;
      data: T;
    }
  | ApiErrorResponse;

export type PageDto<T> = {
  items: T[];
  nextCursor?: string;
};

export type OrganizationDto = {
  id: string;
  name: string;
  slug: string;
};

export type OrganizationSummaryDto = OrganizationDto;

export type AuthUserDto = {
  id: string;
  email: string;
  displayName: string;
};

export type AuthMeDto =
  | { authenticated: false; bootstrapAllowed: boolean }
  | { authenticated: true; bootstrapAllowed: false; user: AuthUserDto };

export type LoginRequestDto = { email: string; password: string };
export type LoginResponseDto = Extract<AuthMeDto, { authenticated: true }>;
export type ApiTokenDto = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
};
export type CreateApiTokenRequestDto = { name: string; expiresAt?: string };
export type CreateApiTokenResponseDto = { token: string; apiToken: ApiTokenDto };

export type IntegrationDto = {
  id: string;
  organizationId: string;
  provider: Provider;
  authType: "personal_access_token" | "oauth";
  status: "active" | "disabled" | "error";
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationWithSecretHintDto = IntegrationDto & {
  secretHint?: string;
};

export type IntegrationSummaryDto = IntegrationWithSecretHintDto;

export type SyncScopeDto = {
  id: string;
  organizationId: string;
  integrationId: string;
  provider: Provider;
  scopeType:
    | "github.repository"
    | "github.organization"
    | "linear.workspace"
    | "linear.team"
    | "linear.project";
  externalId: string;
  externalName: string;
  parentScopeId?: string;
  selectionMode: "all" | "selected" | "individual";
  config: JsonObject;
  enabled: boolean;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisRunStatusDto = "running" | "completed" | "failed";

export type AnalysisRunDto = {
  id: string;
  organizationId: string;
  scope: ScopeRef;
  periodStart: string;
  periodEnd: string;
  status: AnalysisRunStatusDto;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  createdAt: string;
};

export type AnalysisReportContextDto = {
  id: string;
  organizationId: string;
  analysisRunId: string;
  scopeType: ReportScopeType;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  context: ReportContext;
  createdAt: string;
};

export type SaveAnalysisRequestDto = {
  input: AnalysisInput;
};

export type SaveAnalysisResponseDto = {
  run: AnalysisRunDto;
  metrics: (Metric & { id: string })[];
  highlights: (Highlight & { id: string })[];
  reportContext: AnalysisReportContextDto;
};

export type ReportTypeDto = "weekly" | "monthly" | "quarterly" | "custom";
export type ReportStatusDto = "draft" | "completed" | "failed";
export type ReportInputTypeDto =
  | "analysis_report_context"
  | "analysis_metric"
  | "analysis_highlight"
  | "activity_event"
  | "work_item"
  | "source_object"
  | "previous_report";

export type ReportDto = {
  id: string;
  organizationId: string;
  analysisReportContextId: string;
  reportType: ReportTypeDto;
  scopeType: ReportScopeType;
  scopeId: string;
  periodStart: string;
  periodEnd: string;
  status: ReportStatusDto;
  title: string;
  summary?: string;
  bodyMarkdown: string;
  structured: JsonObject;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ReportSummaryDto = Omit<ReportDto, "bodyMarkdown" | "structured">;
export type ReportDetailDto = ReportDto;

export type ReportInputDto = {
  id: string;
  reportId: string;
  inputType: ReportInputTypeDto;
  inputId: string;
  metadata?: JsonObject;
  createdAt: string;
};

export type GenerateReportRequestDto = {
  analysisReportContextId: string;
  reportType: ReportTypeDto;
  title?: string;
  persist?: boolean;
};

export type GenerateReportResponseDto = {
  report: ReportDto;
  inputs: ReportInputDto[];
};

export type CreateOrganizationRequestDto = {
  id?: string;
  name: string;
  slug?: string;
  owner?: {
    id?: string;
    displayName?: string;
    primaryEmail?: string;
    password?: string;
  };
  ownerId?: string;
  ownerName?: string;
  ownerEmail?: string;
  membershipId?: string;
};

export type CreateOrganizationResponseDto = OrganizationDto & {
  ownerUserId: string;
  ownerMembershipId: string;
};

export type AddPatIntegrationRequestDto = {
  id?: string;
  credentialId?: string;
  organizationId: string;
  provider: Provider;
  displayName?: string;
  name?: string;
  token: string;
};

export type AddPatIntegrationResponseDto = IntegrationWithSecretHintDto & {
  credentialId?: string;
};

export type AddSyncScopeRequestDto = {
  id?: string;
  organizationId: string;
  integrationId: string;
  provider: Provider;
  scopeType: SyncScopeDto["scopeType"];
  externalId?: string;
  externalName: string;
  config?: JsonObject;
  enabled?: boolean;
};

export type DiscoveredResourceDto = {
  scopeType: Extract<
    SyncScopeDto["scopeType"],
    "github.repository" | "github.organization" | "linear.workspace" | "linear.team"
  >;
  externalId: string;
  externalName: string;
  group?: string;
  description?: string;
  config?: JsonObject;
};
export type GitHubDiscoveryDto = {
  account: { id: string; login: string; name?: string; avatarUrl?: string };
  organizations: Array<{
    id: string;
    login: string;
    name?: string;
    avatarUrl?: string;
    repositoryCount?: number;
  }>;
  repositories: Array<{
    id: string;
    fullName: string;
    ownerId: string;
    ownerLogin: string;
    ownerType: "Organization" | "User";
    organizationId?: string;
    visibility?: string;
    archived: boolean;
    fork: boolean;
    description?: string;
  }>;
};
export type LinearDiscoveryDto = {
  workspace: { id: string; name: string };
  teams: Array<{ id: string; name: string; key: string }>;
};
export type ListIntegrationResourcesResponseDto =
  | { provider: "github"; discovery: GitHubDiscoveryDto }
  | { provider: "linear"; discovery: LinearDiscoveryDto };
export type SetGitHubScopeSelectionRequestDto = {
  organizationId: string;
  selection: {
    organizations: Array<
      | { organizationId: string; mode: "all" }
      | { organizationId: string; mode: "selected"; repositoryIds: string[] }
    >;
    repositoryIds: string[];
  };
};
export type SetLinearScopeSelectionRequestDto = {
  organizationId: string;
  selection: { mode: "all" } | { mode: "selected"; teamIds: string[] };
};
export type SetSyncScopeSelectionRequestDto =
  | SetGitHubScopeSelectionRequestDto
  | SetLinearScopeSelectionRequestDto;
export type SetSyncScopeSelectionResponseDto = { items: SyncScopeDto[] };

export type GenerateWeeklyReportRequestDto = {
  organizationId: string;
  organizationName?: string;
  scopeType?: ReportScopeType;
  scopeId?: string;
  scopeName?: string;
  periodStart: string;
  periodEnd: string;
  title?: string;
  persist?: boolean;
};

export type DashboardDto = {
  organizations: OrganizationSummaryDto[];
  selectedOrganizationId: string;
  organization: OrganizationSummaryDto;
  integrations: IntegrationSummaryDto[];
  syncScopes: SyncScopeDto[];
  reports: ReportSummaryDto[];
  latestReport?: ReportDetailDto;
  metrics: Metric[];
  highlights: ReportContext["highlights"];
  workItems: ReportContext["workItems"];
  people: ReportContext["people"];
};

export type TriggerSyncRequestDto = {
  organizationId?: string;
  integrationId?: string;
  syncScopeId?: string;
};

export type TriggerSyncResponseDto = {
  provider: Provider;
  status: "queued" | "running" | "completed" | "failed" | "not_implemented";
  syncRunId?: string;
  message?: string;
};

/** Known sync states are suggested while allowing forward-compatible server states. */
export type SyncRunStatusDto =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | (string & {});

export type SyncRunCountersDto = {
  objectsFetched: number;
  objectsInserted: number;
  objectsUpdated: number;
  objectsUnchanged: number;
  objectsFailed: number;
  activityEventsEmitted: number;
};

export type SyncRunDto = SyncRunCountersDto & {
  id: string;
  organizationId: string;
  integrationId: string;
  syncScopeId?: string;
  providerResourceId?: string;
  parentSyncRunId?: string;
  provider: Provider;
  runType: string;
  runKind: string;
  status: SyncRunStatusDto;
  queuedAt?: string;
  startedAt: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  attempt: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type SyncRunStatusCountsDto = Record<string, number>;

export type SyncRunProgressDto = {
  run: SyncRunDto;
  childRunCounts: SyncRunStatusCountsDto;
};

export type SyncRunResourceProgressDto = {
  resource?: {
    id: string;
    provider: Provider;
    resourceType: string;
    externalId: string;
    displayName: string;
    externalUrl?: string;
    syncStatus: string;
    lastSyncStartedAt?: string;
    lastSyncSucceededAt?: string;
    lastSyncFailedAt?: string;
    lastSyncError?: string;
  };
  run: SyncRunDto;
};

export type OrganizationSyncStatusDto = {
  organizationId: string;
  activeRuns: SyncRunDto[];
  resourceStatusCounts: Record<string, number>;
};

export type TriggerSyncNotImplementedError = {
  ok: false;
  error: {
    code: "sync_not_implemented";
    message: string;
    details?: {
      provider?: Provider;
    };
  };
};

export type CreateOrganizationRequest = CreateOrganizationRequestDto;
export type AddPatIntegrationRequest = AddPatIntegrationRequestDto;
export type AddSyncScopeRequest = AddSyncScopeRequestDto;
export type GenerateWeeklyReportRequest = GenerateWeeklyReportRequestDto;
export type TriggerSyncRequest = TriggerSyncRequestDto;
export type TriggerSyncResponse = TriggerSyncResponseDto;

export interface TeamtalesApiClient {
  getHealth(): Promise<{ status: "ok" }>;
  getCurrentUser(): Promise<AuthMeDto>;
  login(request: LoginRequestDto): Promise<AuthMeDto>;
  logout(): Promise<{ loggedOut: true }>;
  listApiTokens(): Promise<PageDto<ApiTokenDto>>;
  createApiToken(request: CreateApiTokenRequestDto): Promise<CreateApiTokenResponseDto>;
  revokeApiToken(tokenId: string): Promise<{ revoked: true }>;
  getCurrentUser(): Promise<AuthMeDto>;
  login(request: LoginRequestDto): Promise<LoginResponseDto>;
  logout(): Promise<void>;
  listApiTokens(): Promise<PageDto<ApiTokenDto>>;
  createApiToken(request: CreateApiTokenRequestDto): Promise<CreateApiTokenResponseDto>;
  revokeApiToken(tokenId: string): Promise<void>;
  getDashboard(organizationId: string): Promise<DashboardDto>;
  listOrganizations(): Promise<PageDto<OrganizationSummaryDto>>;
  createOrganization(request: CreateOrganizationRequestDto): Promise<CreateOrganizationResponseDto>;
  listIntegrations(organizationId: string): Promise<PageDto<IntegrationSummaryDto>>;
  addPatIntegration(request: AddPatIntegrationRequestDto): Promise<AddPatIntegrationResponseDto>;
  listSyncScopes(organizationId: string): Promise<PageDto<SyncScopeDto>>;
  addSyncScope(request: AddSyncScopeRequestDto): Promise<SyncScopeDto>;
  listReports(organizationId: string): Promise<PageDto<ReportSummaryDto>>;
  getReport(reportId: string, organizationId: string): Promise<ReportDetailDto>;
  generateWeeklyReport(request: GenerateWeeklyReportRequestDto): Promise<GenerateReportResponseDto>;
  triggerSync(provider: Provider, request?: TriggerSyncRequestDto): Promise<TriggerSyncResponseDto>;
  getSyncRun(syncRunId: string): Promise<SyncRunProgressDto>;
  listSyncRunResources(
    syncRunId: string,
    cursor?: string,
  ): Promise<PageDto<SyncRunResourceProgressDto>>;
  getOrganizationSyncStatus(organizationId: string): Promise<OrganizationSyncStatusDto>;
}

export type TeamTalesApiClient = TeamtalesApiClient;
