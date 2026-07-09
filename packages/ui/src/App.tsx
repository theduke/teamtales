import type { FormEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DashboardDto,
  GenerateWeeklyReportRequestDto,
  JsonObject,
  ReportDetailDto,
  SyncScopeDto,
} from "@teamtales/common/api";
import type { Provider, ReportScopeType } from "@teamtales/common/domain";

import type {
  AuthSession,
  BrowserAddPatIntegrationRequest,
  BrowserAddSyncScopeRequest,
  BrowserCreateOrganizationRequest,
} from "./api";
import { ApiClientError, apiClient } from "./api";

const sections = ["Dashboard", "Setup", "Sync", "Reports", "Data"] as const;
type Section = (typeof sections)[number];

type Notice = { tone: "success" | "error" | "info"; text: string };

const providerOptions: Provider[] = ["github", "linear"];
const syncScopeTypes: SyncScopeDto["scopeType"][] = [
  "github.repository",
  "github.organization",
  "linear.workspace",
  "linear.team",
  "linear.project",
];
const reportScopeTypes: ReportScopeType[] = [
  "organization",
  "person",
  "github_repository",
  "linear_team",
  "linear_project",
];

const emptyDashboard: DashboardDto | undefined = undefined;

export function App(): ReactElement {
  const [section, setSection] = useState<Section>("Dashboard");
  const [health, setHealth] = useState<"unknown" | "ok" | "error">("unknown");
  const [organizations, setOrganizations] = useState<DashboardDto["organizations"]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [dashboard, setDashboard] = useState<DashboardDto | undefined>(emptyDashboard);
  const [selectedReportId, setSelectedReportId] = useState("");
  const [reportDetail, setReportDetail] = useState<ReportDetailDto | undefined>();
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [auth, setAuth] = useState<AuthSession | undefined>();

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === selectedOrganizationId),
    [organizations, selectedOrganizationId],
  );

  const showNotice = useCallback((nextNotice: Notice) => {
    setNotice(nextNotice);
  }, []);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiClientError && error.status === 401) {
        setAuth({ authenticated: false, bootstrapAllowed: false });
        setOrganizations([]);
        setSelectedOrganizationId("");
        setDashboard(undefined);
        setReportDetail(undefined);
      }
      const text =
        error instanceof ApiClientError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "Unexpected error.";
      showNotice({ tone: "error", text });
    },
    [showNotice],
  );

  const loadOrganizations = useCallback(async () => {
    const page = await apiClient.listOrganizations();
    setOrganizations(page.items);
    setSelectedOrganizationId((current) => {
      if (current && page.items.some((organization) => organization.id === current)) {
        return current;
      }
      return page.items[0]?.id ?? "";
    });
  }, []);

  const loadDashboard = useCallback(
    async (organizationId: string) => {
      if (!organizationId) {
        setDashboard(undefined);
        return;
      }
      const nextDashboard = await apiClient.getDashboard(organizationId);
      setDashboard(nextDashboard);
      setSelectedReportId((current) => current || nextDashboard.latestReport?.id || nextDashboard.reports[0]?.id || "");
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadOrganizations();
      if (selectedOrganizationId) {
        await loadDashboard(selectedOrganizationId);
      }
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }, [handleError, loadDashboard, loadOrganizations, selectedOrganizationId]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      setLoading(true);
      try {
        await apiClient.getHealth();
        if (!cancelled) {
          setHealth("ok");
        }
        const session = await apiClient.getCurrentUser();
        if (!cancelled) {
          setAuth(session);
        }
        if (session.authenticated) {
          const page = await apiClient.listOrganizations();
          if (!cancelled) {
            setOrganizations(page.items);
            setSelectedOrganizationId(page.items[0]?.id ?? "");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setHealth((current) => (current === "ok" ? current : "error"));
          handleError(error);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [handleError]);

  async function authenticate(email: string, password: string): Promise<void> {
    setLoading(true);
    try {
      const session = await apiClient.login({ email, password });
      if (!session.authenticated) {
        throw new Error("Login did not establish a session.");
      }
      setAuth(session);
      setNotice(undefined);
      await loadOrganizations();
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  async function bootstrapOrganization(request: BrowserCreateOrganizationRequest): Promise<void> {
    setLoading(true);
    try {
      const organization = await apiClient.createOrganization(request);
      const session = await apiClient.getCurrentUser();
      if (!session.authenticated) {
        throw new Error("Bootstrap completed without establishing a session.");
      }
      setAuth(session);
      await loadOrganizations();
      setSelectedOrganizationId(organization.id);
      showNotice({ tone: "success", text: `Created ${organization.name}.` });
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  async function logout(): Promise<void> {
    setLoading(true);
    try {
      await apiClient.logout();
      setAuth({ authenticated: false, bootstrapAllowed: false });
      setOrganizations([]);
      setSelectedOrganizationId("");
      setDashboard(undefined);
      setSelectedReportId("");
      setReportDetail(undefined);
      setNotice(undefined);
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      if (!selectedOrganizationId) {
        setDashboard(undefined);
        return;
      }
      setLoading(true);
      try {
        const nextDashboard = await apiClient.getDashboard(selectedOrganizationId);
        if (!cancelled) {
          setDashboard(nextDashboard);
          setSelectedReportId((current) => current || nextDashboard.latestReport?.id || nextDashboard.reports[0]?.id || "");
        }
      } catch (error) {
        if (!cancelled) {
          handleError(error);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [handleError, selectedOrganizationId]);

  useEffect(() => {
    let cancelled = false;

    async function loadReport(): Promise<void> {
      if (!selectedReportId || !selectedOrganizationId) {
        setReportDetail(undefined);
        return;
      }
      try {
        const report = await apiClient.getReport(selectedReportId, selectedOrganizationId);
        if (!cancelled) {
          setReportDetail(report);
        }
      } catch (error) {
        if (!cancelled) {
          setReportDetail(undefined);
          handleError(error);
        }
      }
    }

    void loadReport();
    return () => {
      cancelled = true;
    };
  }, [handleError, selectedOrganizationId, selectedReportId]);

  if (!auth || !auth.authenticated) {
    return (
      <AuthScreen
        health={health}
        loading={loading}
        bootstrapAllowed={auth?.bootstrapAllowed ?? false}
        notice={notice}
        onDismissNotice={() => setNotice(undefined)}
        onLogin={(email, password) => void authenticate(email, password)}
        onBootstrap={(request) => void bootstrapOrganization(request)}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>TeamTales Console</h1>
          <div className="meta-row">
            <span className={`status-dot ${health}`}></span>
            <span>API {health}</span>
            {loading ? <span>Loading</span> : null}
          </div>
        </div>
        <div className="topbar-controls">
          <span className="signed-in-user">{auth.user.displayName || auth.user.email}</span>
          <label>
            Organization
            <select value={selectedOrganizationId} onChange={(event) => setSelectedOrganizationId(event.target.value)}>
              <option value="">None</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="section-tabs" aria-label="Console sections">
        {sections.map((name) => (
          <button
            key={name}
            type="button"
            className={section === name ? "active" : ""}
            onClick={() => setSection(name)}
          >
            {name}
          </button>
        ))}
      </nav>

      {notice ? (
        <div className={`notice ${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <main>
        {section === "Dashboard" ? <DashboardSection dashboard={dashboard} /> : null}
        {section === "Setup" ? (
          <SetupSection
            dashboard={dashboard}
            selectedOrganizationId={selectedOrganizationId}
            onCreatedOrganization={(organizationId) => {
              setSelectedOrganizationId(organizationId);
              void refresh();
            }}
            onChanged={() => void refresh()}
            onError={handleError}
            onNotice={showNotice}
          />
        ) : null}
        {section === "Sync" ? (
          <SyncSection
            dashboard={dashboard}
            selectedOrganizationId={selectedOrganizationId}
            onChanged={() => void refresh()}
            onError={handleError}
            onNotice={showNotice}
          />
        ) : null}
        {section === "Reports" ? (
          <ReportsSection
            dashboard={dashboard}
            reportDetail={reportDetail}
            selectedOrganization={selectedOrganization}
            selectedOrganizationId={selectedOrganizationId}
            selectedReportId={selectedReportId}
            onSelectReport={setSelectedReportId}
            onGenerated={(report) => {
              setSelectedReportId(report.id);
              setReportDetail(report);
              void refresh();
            }}
            onError={handleError}
            onNotice={showNotice}
          />
        ) : null}
        {section === "Data" ? <DataSection dashboard={dashboard} reportDetail={reportDetail} /> : null}
      </main>
    </div>
  );
}

function AuthScreen({
  health,
  loading,
  bootstrapAllowed,
  notice,
  onDismissNotice,
  onLogin,
  onBootstrap,
}: {
  health: "unknown" | "ok" | "error";
  loading: boolean;
  bootstrapAllowed: boolean;
  notice: Notice | undefined;
  onDismissNotice: () => void;
  onLogin: (email: string, password: string) => void;
  onBootstrap: (request: BrowserCreateOrganizationRequest) => void;
}): ReactElement {
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [bootstrapForm, setBootstrapForm] = useState({
    organizationName: "",
    organizationSlug: "",
    ownerName: "",
    ownerEmail: "",
    ownerPassword: "",
  });

  function submitLogin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onLogin(loginForm.email.trim(), loginForm.password);
  }

  function submitBootstrap(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onBootstrap({
      name: bootstrapForm.organizationName.trim(),
      slug: optionalText(bootstrapForm.organizationSlug),
      owner: {
        displayName: optionalText(bootstrapForm.ownerName),
        primaryEmail: bootstrapForm.ownerEmail.trim(),
        password: bootstrapForm.ownerPassword,
      },
    });
  }

  return (
    <div className="auth-shell">
      <header className="auth-header">
        <h1>TeamTales Console</h1>
        <div className="meta-row">
          <span className={`status-dot ${health}`}></span>
          <span>API {health}</span>
          {loading ? <span>Loading</span> : null}
        </div>
      </header>

      {notice ? (
        <div className={`notice ${notice.tone}`} role="status">
          <span>{notice.text}</span>
          <button type="button" onClick={onDismissNotice}>
            Dismiss
          </button>
        </div>
      ) : null}

      <main className="auth-main">
        <section className="panel auth-panel">
          <PanelTitle title="Sign in" />
          <form className="form-grid auth-form" onSubmit={submitLogin}>
            <TextField
              label="Email"
              type="email"
              value={loginForm.email}
              required
              onChange={(email) => setLoginForm((current) => ({ ...current, email }))}
            />
            <TextField
              label="Password"
              type="password"
              value={loginForm.password}
              required
              onChange={(password) => setLoginForm((current) => ({ ...current, password }))}
            />
            <button type="submit" disabled={loading}>
              Sign in
            </button>
          </form>
        </section>

        {bootstrapAllowed ? (
          <section className="panel auth-panel">
            <PanelTitle title="Create the first organization" />
            <p className="auth-help">Set up the first owner account and organization.</p>
            <form className="form-grid" onSubmit={submitBootstrap}>
              <TextField
                label="Organization name"
                value={bootstrapForm.organizationName}
                required
                onChange={(organizationName) => setBootstrapForm((current) => ({ ...current, organizationName }))}
              />
              <TextField
                label="Organization slug"
                value={bootstrapForm.organizationSlug}
                onChange={(organizationSlug) => setBootstrapForm((current) => ({ ...current, organizationSlug }))}
              />
              <TextField
                label="Owner name"
                value={bootstrapForm.ownerName}
                onChange={(ownerName) => setBootstrapForm((current) => ({ ...current, ownerName }))}
              />
              <TextField
                label="Owner email"
                type="email"
                value={bootstrapForm.ownerEmail}
                required
                onChange={(ownerEmail) => setBootstrapForm((current) => ({ ...current, ownerEmail }))}
              />
              <TextField
                label="Owner password"
                type="password"
                value={bootstrapForm.ownerPassword}
                required
                onChange={(ownerPassword) => setBootstrapForm((current) => ({ ...current, ownerPassword }))}
              />
              <button type="submit" disabled={loading}>
                Create organization
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function DashboardSection({ dashboard }: { dashboard: DashboardDto | undefined }): ReactElement {
  return (
    <div className="grid two">
      <section className="panel">
        <PanelTitle title="Overview" />
        <div className="stat-grid">
          <Stat label="Integrations" value={dashboard?.integrations.length ?? 0} />
          <Stat label="Sync scopes" value={dashboard?.syncScopes.length ?? 0} />
          <Stat label="Reports" value={dashboard?.reports.length ?? 0} />
          <Stat label="Work items" value={dashboard?.workItems.length ?? 0} />
        </div>
        <Table
          columns={["Metric", "Value", "Dimensions"]}
          rows={(dashboard?.metrics ?? []).map((metric) => [
            metric.name,
            String(metric.value),
            formatJsonSummary(metric.dimensions),
          ])}
          empty="No metrics."
        />
      </section>
      <section className="panel">
        <PanelTitle title="Highlights" />
        <div className="dense-list">
          {(dashboard?.highlights ?? []).map((highlight, index) => (
            <article key={`${highlight.title}-${index}`} className="list-row">
              <strong>{highlight.title}</strong>
              <span>{highlight.reason}</span>
              <small>{highlight.sourceRefs.join(", ") || "No sources"}</small>
            </article>
          ))}
          {(dashboard?.highlights.length ?? 0) === 0 ? <EmptyState text="No highlights." /> : null}
        </div>
      </section>
      <section className="panel wide">
        <PanelTitle title="Work Items" />
        <Table
          columns={["Provider", "Status", "Title", "Facts"]}
          rows={(dashboard?.workItems ?? []).map((item) => [
            item.provider,
            item.status,
            item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </a>
            ) : (
              item.title
            ),
            item.summaryFacts.join("; "),
          ])}
          empty="No work items."
        />
      </section>
      <section className="panel wide">
        <PanelTitle title="People" />
        <Table
          columns={["Person", "Activity", "Metrics", "Sources"]}
          rows={(dashboard?.people ?? []).map((person) => [
            person.displayName,
            person.activitySummary,
            formatJsonSummary(person.metrics),
            person.sourceRefs.join(", "),
          ])}
          empty="No people."
        />
      </section>
    </div>
  );
}

function SetupSection({
  dashboard,
  selectedOrganizationId,
  onCreatedOrganization,
  onChanged,
  onError,
  onNotice,
}: {
  dashboard: DashboardDto | undefined;
  selectedOrganizationId: string;
  onCreatedOrganization: (organizationId: string) => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const [organizationForm, setOrganizationForm] = useState({
    name: "",
    slug: "",
  });
  const [patForm, setPatForm] = useState({
    provider: "github" as Provider,
    displayName: "",
    token: "",
  });

  async function createOrganization(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const request: BrowserCreateOrganizationRequest = {
        name: organizationForm.name.trim(),
        slug: optionalText(organizationForm.slug),
      };
      const organization = await apiClient.createOrganization(request);
      setOrganizationForm({ name: "", slug: "" });
      onCreatedOrganization(organization.id);
      onNotice({ tone: "success", text: `Created ${organization.name}.` });
    } catch (error) {
      onError(error);
    }
  }

  async function addPatIntegration(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const request: BrowserAddPatIntegrationRequest = {
        organizationId: selectedOrganizationId,
        provider: patForm.provider,
        displayName: optionalText(patForm.displayName),
        token: patForm.token,
      };
      const integration = await apiClient.addPatIntegration(request);
      setPatForm((current) => ({ ...current, displayName: "", token: "" }));
      onChanged();
      onNotice({ tone: "success", text: `Added ${integration.provider} integration.` });
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="grid two">
      <section className="panel">
        <PanelTitle title="Organization" />
        <form className="form-grid" onSubmit={(event) => void createOrganization(event)}>
          <TextField
            label="Name"
            value={organizationForm.name}
            required
            onChange={(name) => setOrganizationForm((current) => ({ ...current, name }))}
          />
          <TextField
            label="Slug"
            value={organizationForm.slug}
            onChange={(slug) => setOrganizationForm((current) => ({ ...current, slug }))}
          />
          <button type="submit">Create organization</button>
        </form>
      </section>

      <section className="panel">
        <PanelTitle title="PAT Integration" />
        <form className="form-grid" onSubmit={(event) => void addPatIntegration(event)}>
          <ReadOnlyField label="Organization" value={selectedOrganizationId || "None"} />
          <label>
            Provider
            <select
              value={patForm.provider}
              onChange={(event) =>
                setPatForm((current) => ({ ...current, provider: event.target.value as Provider }))
              }
            >
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Display name"
            value={patForm.displayName}
            onChange={(displayName) => setPatForm((current) => ({ ...current, displayName }))}
          />
          <TextField
            label="Token"
            type="password"
            value={patForm.token}
            required
            onChange={(token) => setPatForm((current) => ({ ...current, token }))}
          />
          <button type="submit" disabled={!selectedOrganizationId}>
            Add PAT
          </button>
        </form>
      </section>

      <section className="panel wide">
        <PanelTitle title="Integrations" />
        <Table
          columns={["Provider", "Name", "Status", "Secret hint", "Updated"]}
          rows={(dashboard?.integrations ?? []).map((integration) => [
            integration.provider,
            integration.displayName,
            integration.status,
            integration.secretHint ?? "Stored",
            formatDateTime(integration.updatedAt),
          ])}
          empty="No integrations."
        />
      </section>
    </div>
  );
}

function SyncSection({
  dashboard,
  selectedOrganizationId,
  onChanged,
  onError,
  onNotice,
}: {
  dashboard: DashboardDto | undefined;
  selectedOrganizationId: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const integrations = dashboard?.integrations ?? [];
  const syncScopes = dashboard?.syncScopes ?? [];
  const [scopeForm, setScopeForm] = useState({
    integrationId: "",
    provider: "github" as Provider,
    scopeType: "github.repository" as SyncScopeDto["scopeType"],
    externalId: "",
    externalName: "",
    config: "{}",
    enabled: true,
  });
  const [triggerForm, setTriggerForm] = useState({
    provider: "github" as Provider,
    integrationId: "",
    syncScopeId: "",
  });

  async function addSyncScope(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const parsedConfig = parseJsonObject(scopeForm.config);
      const request: BrowserAddSyncScopeRequest = {
        organizationId: selectedOrganizationId,
        integrationId: scopeForm.integrationId,
        provider: scopeForm.provider,
        scopeType: scopeForm.scopeType,
        externalId: optionalText(scopeForm.externalId),
        externalName: scopeForm.externalName.trim(),
        config: parsedConfig,
        enabled: scopeForm.enabled,
      };
      const scope = await apiClient.addSyncScope(request);
      setScopeForm((current) => ({
        ...current,
        externalId: "",
        externalName: "",
        config: "{}",
      }));
      onChanged();
      onNotice({ tone: "success", text: `Added sync scope ${scope.externalName}.` });
    } catch (error) {
      onError(error);
    }
  }

  async function triggerSync(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const result = await apiClient.triggerSync(triggerForm.provider, {
        organizationId: selectedOrganizationId || undefined,
        integrationId: optionalText(triggerForm.integrationId),
        syncScopeId: optionalText(triggerForm.syncScopeId),
      });
      const text =
        result.status === "not_implemented"
          ? "Sync execution is not available for this provider."
          : (result.message ?? `Sync status: ${result.status}.`);
      onNotice({ tone: "info", text });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "sync_not_implemented") {
        onNotice({ tone: "info", text: "Sync execution is not available for this provider." });
        return;
      }
      onError(error);
    }
  }

  return (
    <div className="grid two">
      <section className="panel">
        <PanelTitle title="Sync Scope" />
        <form className="form-grid" onSubmit={(event) => void addSyncScope(event)}>
          <ReadOnlyField label="Organization" value={selectedOrganizationId || "None"} />
          <label>
            Integration
            <select
              value={scopeForm.integrationId}
              required
              onChange={(event) => {
                const integration = integrations.find((item) => item.id === event.target.value);
                setScopeForm((current) => ({
                  ...current,
                  integrationId: event.target.value,
                  provider: integration?.provider ?? current.provider,
                }));
              }}
            >
              <option value="">Select</option>
              {integrations.map((integration) => (
                <option key={integration.id} value={integration.id}>
                  {integration.provider} / {integration.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select
              value={scopeForm.provider}
              onChange={(event) =>
                setScopeForm((current) => ({ ...current, provider: event.target.value as Provider }))
              }
            >
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>
          <label>
            Scope type
            <select
              value={scopeForm.scopeType}
              onChange={(event) =>
                setScopeForm((current) => ({
                  ...current,
                  scopeType: event.target.value as SyncScopeDto["scopeType"],
                }))
              }
            >
              {syncScopeTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="External ID"
            value={scopeForm.externalId}
            onChange={(externalId) => setScopeForm((current) => ({ ...current, externalId }))}
          />
          <TextField
            label="External name"
            value={scopeForm.externalName}
            required
            onChange={(externalName) => setScopeForm((current) => ({ ...current, externalName }))}
          />
          <label className="span-2">
            Config JSON
            <textarea
              value={scopeForm.config}
              rows={4}
              spellCheck={false}
              onChange={(event) => setScopeForm((current) => ({ ...current, config: event.target.value }))}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={scopeForm.enabled}
              onChange={(event) => setScopeForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Enabled
          </label>
          <button type="submit" disabled={!selectedOrganizationId}>
            Add scope
          </button>
        </form>
      </section>

      <section className="panel">
        <PanelTitle title="Trigger Sync" />
        <EmptyState text="Choose a provider and scope to run a manual sync." />
        <form className="form-grid" onSubmit={(event) => void triggerSync(event)}>
          <ReadOnlyField label="Organization" value={selectedOrganizationId || "None"} />
          <label>
            Provider
            <select
              value={triggerForm.provider}
              onChange={(event) =>
                setTriggerForm((current) => ({ ...current, provider: event.target.value as Provider }))
              }
            >
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>
          <label>
            Integration
            <select
              value={triggerForm.integrationId}
              onChange={(event) => setTriggerForm((current) => ({ ...current, integrationId: event.target.value }))}
            >
              <option value="">Any</option>
              {integrations.map((integration) => (
                <option key={integration.id} value={integration.id}>
                  {integration.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sync scope
            <select
              value={triggerForm.syncScopeId}
              onChange={(event) => setTriggerForm((current) => ({ ...current, syncScopeId: event.target.value }))}
            >
              <option value="">Any</option>
              {syncScopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.externalName}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!selectedOrganizationId}>
            Run sync
          </button>
        </form>
      </section>

      <section className="panel wide">
        <PanelTitle title="Sync Scopes" />
        <Table
          columns={["Provider", "Type", "External", "Enabled", "Last success", "Updated"]}
          rows={syncScopes.map((scope) => [
            scope.provider,
            scope.scopeType,
            `${scope.externalName}${scope.externalId ? ` (${scope.externalId})` : ""}`,
            scope.enabled ? "Yes" : "No",
            formatDateTime(scope.lastSuccessAt),
            formatDateTime(scope.updatedAt),
          ])}
          empty="No sync scopes."
        />
      </section>
    </div>
  );
}

function ReportsSection({
  dashboard,
  reportDetail,
  selectedOrganization,
  selectedOrganizationId,
  selectedReportId,
  onSelectReport,
  onGenerated,
  onError,
  onNotice,
}: {
  dashboard: DashboardDto | undefined;
  reportDetail: ReportDetailDto | undefined;
  selectedOrganization: DashboardDto["organization"] | undefined;
  selectedOrganizationId: string;
  selectedReportId: string;
  onSelectReport: (reportId: string) => void;
  onGenerated: (report: ReportDetailDto) => void;
  onError: (error: unknown) => void;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const defaultPeriod = useMemo(() => getDefaultPeriod(), []);
  const [form, setForm] = useState({
    periodStart: defaultPeriod.start,
    periodEnd: defaultPeriod.end,
    scopeType: "organization" as ReportScopeType,
    scopeId: "",
    scopeName: "",
    title: "",
    persist: true,
  });

  async function generateWeeklyReport(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const organizationName = selectedOrganization?.name ?? dashboard?.organization.name;
      const request: GenerateWeeklyReportRequestDto = {
        organizationId: selectedOrganizationId,
        organizationName,
        scopeType: form.scopeType,
        scopeId: optionalText(form.scopeId) ?? selectedOrganizationId,
        scopeName: optionalText(form.scopeName) ?? organizationName,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        title: optionalText(form.title),
        persist: form.persist,
      };
      const result = await apiClient.generateWeeklyReport(request);
      onGenerated(result.report);
      onNotice({ tone: "success", text: `Generated ${result.report.title}.` });
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="grid two">
      <section className="panel">
        <PanelTitle title="Weekly Report" />
        <form className="form-grid" onSubmit={(event) => void generateWeeklyReport(event)}>
          <ReadOnlyField label="Organization" value={selectedOrganizationId || "None"} />
          <label>
            Scope type
            <select
              value={form.scopeType}
              onChange={(event) => setForm((current) => ({ ...current, scopeType: event.target.value as ReportScopeType }))}
            >
              {reportScopeTypes.map((scopeType) => (
                <option key={scopeType} value={scopeType}>
                  {scopeType}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Scope ID"
            value={form.scopeId}
            onChange={(scopeId) => setForm((current) => ({ ...current, scopeId }))}
          />
          <TextField
            label="Scope name"
            value={form.scopeName}
            onChange={(scopeName) => setForm((current) => ({ ...current, scopeName }))}
          />
          <TextField
            label="Period start"
            type="date"
            value={form.periodStart}
            required
            onChange={(periodStart) => setForm((current) => ({ ...current, periodStart }))}
          />
          <TextField
            label="Period end"
            type="date"
            value={form.periodEnd}
            required
            onChange={(periodEnd) => setForm((current) => ({ ...current, periodEnd }))}
          />
          <TextField
            label="Title"
            value={form.title}
            onChange={(title) => setForm((current) => ({ ...current, title }))}
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.persist}
              onChange={(event) => setForm((current) => ({ ...current, persist: event.target.checked }))}
            />
            Persist
          </label>
          <button type="submit" disabled={!selectedOrganizationId}>
            Generate
          </button>
        </form>
      </section>

      <section className="panel">
        <PanelTitle title="Reports" />
        <div className="dense-list">
          {(dashboard?.reports ?? []).map((report) => (
            <button
              type="button"
              key={report.id}
              className={`report-row ${selectedReportId === report.id ? "active" : ""}`}
              onClick={() => onSelectReport(report.id)}
            >
              <strong>{report.title}</strong>
              <span>
                {report.reportType} / {report.status}
              </span>
              <small>
                {report.periodStart} to {report.periodEnd}
              </small>
            </button>
          ))}
          {(dashboard?.reports.length ?? 0) === 0 ? <EmptyState text="No reports." /> : null}
        </div>
      </section>

      <section className="panel wide">
        <PanelTitle title="Report Detail" />
        {reportDetail ? (
          <div className="report-detail">
            <div className="detail-grid">
              <ReadOnlyField label="Status" value={reportDetail.status} />
              <ReadOnlyField label="Scope" value={`${reportDetail.scopeType} / ${reportDetail.scopeId}`} />
              <ReadOnlyField label="Period" value={`${reportDetail.periodStart} to ${reportDetail.periodEnd}`} />
              <ReadOnlyField label="Updated" value={formatDateTime(reportDetail.updatedAt)} />
            </div>
            {reportDetail.summary ? <p className="summary">{reportDetail.summary}</p> : null}
            <pre className="markdown-output">{reportDetail.bodyMarkdown || "No report markdown."}</pre>
          </div>
        ) : (
          <EmptyState text="No report selected." />
        )}
      </section>
    </div>
  );
}

function DataSection({
  dashboard,
  reportDetail,
}: {
  dashboard: DashboardDto | undefined;
  reportDetail: ReportDetailDto | undefined;
}): ReactElement {
  return (
    <div className="grid two">
      <section className="panel wide">
        <PanelTitle title="Dashboard DTO" />
        <pre className="json-output">{JSON.stringify(dashboard ?? null, null, 2)}</pre>
      </section>
      <section className="panel wide">
        <PanelTitle title="Report DTO" />
        <pre className="json-output">{JSON.stringify(reportDetail ?? null, null, 2)}</pre>
      </section>
    </div>
  );
}

function PanelTitle({ title }: { title: string }): ReactElement {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }): ReactElement {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: ReactNode[][];
  empty: string;
}): ReactElement {
  if (rows.length === 0) {
    return <EmptyState text={empty} />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, columnIndex) => (
                <td key={`${column}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ text }: { text: string }): ReactElement {
  return <div className="empty-state">{text}</div>;
}

function TextField({
  label,
  value,
  onChange,
  required = false,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}): ReactElement {
  return (
    <label>
      {label}
      <input type={type} value={value} required={required} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <label>
      {label}
      <input value={value} readOnly />
    </label>
  );
}

function optionalText(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function parseJsonObject(value: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config JSON must be an object.");
  }
  return parsed as JsonObject;
}

function formatJsonSummary(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function getDefaultPeriod(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 7);
  return {
    start: toDateInput(start),
    end: toDateInput(end),
  };
}

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}
