import type {
  AddPatIntegrationRequestDto,
  AddPatIntegrationResponseDto,
  AddSyncScopeRequestDto,
  ApiResponseDto,
  CreateOrganizationRequestDto,
  CreateOrganizationResponseDto,
  DashboardDto,
  GenerateReportResponseDto,
  GenerateWeeklyReportRequestDto,
  IntegrationSummaryDto,
  OrganizationSummaryDto,
  PageDto,
  ReportDetailDto,
  ReportSummaryDto,
  SyncScopeDto,
  TriggerSyncRequestDto,
  TriggerSyncResponseDto,
} from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
};

export type AuthSession =
  | { authenticated: false; bootstrapAllowed: boolean }
  | { authenticated: true; bootstrapAllowed: false; user: AuthUser };

export type LoginRequest = { email: string; password: string };
export type BrowserCreateOrganizationRequest = Omit<CreateOrganizationRequestDto, "owner"> & {
  owner?: {
    displayName?: string;
    primaryEmail?: string;
    password?: string;
  };
};
export type BrowserAddPatIntegrationRequest = Omit<AddPatIntegrationRequestDto, "userId">;
export type BrowserAddSyncScopeRequest = Omit<AddSyncScopeRequestDto, "userId">;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

class BrowserTeamtalesApiClient {
  getHealth(): Promise<{ status: "ok" }> {
    return request<{ status: "ok" }>("/api/health");
  }

  getDashboard(organizationId: string): Promise<DashboardDto> {
    return request<DashboardDto>(`/api/dashboard?organizationId=${encodeURIComponent(organizationId)}`);
  }

  listOrganizations(): Promise<PageDto<OrganizationSummaryDto>> {
    return request<PageDto<OrganizationSummaryDto>>("/api/organizations");
  }

  createOrganization(requestBody: BrowserCreateOrganizationRequest): Promise<CreateOrganizationResponseDto> {
    return request<CreateOrganizationResponseDto>("/api/organizations", jsonPost(requestBody));
  }

  listIntegrations(organizationId: string): Promise<PageDto<IntegrationSummaryDto>> {
    return request<PageDto<IntegrationSummaryDto>>(
      `/api/organizations/${encodeURIComponent(organizationId)}/integrations`,
    );
  }

  addPatIntegration(requestBody: BrowserAddPatIntegrationRequest): Promise<AddPatIntegrationResponseDto> {
    return request<AddPatIntegrationResponseDto>("/api/integrations/pat", jsonPost(requestBody));
  }

  listSyncScopes(organizationId: string): Promise<PageDto<SyncScopeDto>> {
    return request<PageDto<SyncScopeDto>>(
      `/api/organizations/${encodeURIComponent(organizationId)}/sync-scopes`,
    );
  }

  addSyncScope(requestBody: BrowserAddSyncScopeRequest): Promise<SyncScopeDto> {
    return request<SyncScopeDto>("/api/sync-scopes", jsonPost(requestBody));
  }

  listReports(organizationId: string): Promise<PageDto<ReportSummaryDto>> {
    return request<PageDto<ReportSummaryDto>>(`/api/organizations/${encodeURIComponent(organizationId)}/reports`);
  }

  getReport(reportId: string, organizationId: string): Promise<ReportDetailDto> {
    return request<ReportDetailDto>(
      `/api/reports/${encodeURIComponent(reportId)}?organizationId=${encodeURIComponent(organizationId)}`,
    );
  }

  generateWeeklyReport(requestBody: GenerateWeeklyReportRequestDto): Promise<GenerateReportResponseDto> {
    return request<GenerateReportResponseDto>("/api/reports/weekly", jsonPost(requestBody));
  }

  triggerSync(provider: Provider, requestBody: TriggerSyncRequestDto = {}): Promise<TriggerSyncResponseDto> {
    return request<TriggerSyncResponseDto>(`/api/sync/${encodeURIComponent(provider)}`, jsonPost(requestBody));
  }

  getCurrentUser(): Promise<AuthSession> {
    return request<AuthSession>("/api/auth/me");
  }

  login(requestBody: LoginRequest): Promise<AuthSession> {
    return request<AuthSession>("/api/auth/login", jsonPost(requestBody));
  }

  logout(): Promise<void> {
    return request<void>("/api/auth/logout", jsonPost({}));
  }
}

export const apiClient = new BrowserTeamtalesApiClient();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  const payload = (await response.json()) as ApiResponseDto<T>;

  if (!payload.ok) {
    throw new ApiClientError(response.status, payload.error.code, payload.error.message);
  }

  return payload.data;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
  };
}
