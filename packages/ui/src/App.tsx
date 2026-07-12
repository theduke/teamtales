import type { FormEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router";
import {
  ActionIcon,
  Alert,
  Anchor,
  AppShell,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Table as MantineTable,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconActivity,
  IconArrowRight,
  IconBuilding,
  IconChartBar,
  IconDatabase,
  IconFileText,
  IconLayoutDashboard,
  IconLogout,
  IconPlugConnected,
  IconRefresh,
  IconSettings,
  IconUsers,
} from "@tabler/icons-react";
import type {
  DashboardDto,
  GenerateWeeklyReportRequestDto,
  ReportDetailDto,
} from "@teamtales/common/api";
import type { Provider, ReportScopeType } from "@teamtales/common/domain";
import type {
  AuthSession,
  BrowserAddPatIntegrationRequest,
  BrowserCreateOrganizationRequest,
} from "./api";
import { ApiClientError, apiClient } from "./api";
import { ProvidersSection } from "./ProvidersSection";

const sections = [
  ["Dashboard", "/dashboard", IconLayoutDashboard],
  ["Setup", "/setup", IconSettings],
  ["Providers", "/providers", IconPlugConnected],
  ["Sync", "/sync", IconRefresh],
  ["Reports", "/reports", IconFileText],
  ["Data", "/data", IconDatabase],
] as const;
type Notice = { tone: "success" | "error" | "info"; text: string };
const providerOptions: Provider[] = ["github", "linear"];
const reportScopeTypes: ReportScopeType[] = [
  "organization",
  "person",
  "github_repository",
  "linear_team",
  "linear_project",
];

export function App(): ReactElement {
  const navigate = useNavigate();
  const [health, setHealth] = useState<"unknown" | "ok" | "error">("unknown");
  const [organizations, setOrganizations] = useState<DashboardDto["organizations"]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [dashboard, setDashboard] = useState<DashboardDto>();
  const [selectedReportId, setSelectedReportId] = useState("");
  const [reportDetail, setReportDetail] = useState<ReportDetailDto>();
  const [loading, setLoading] = useState(false);
  const [auth, setAuth] = useState<AuthSession>();
  const selectedOrganization = useMemo(
    () => organizations.find((item) => item.id === selectedOrganizationId),
    [organizations, selectedOrganizationId],
  );
  const showNotice = useCallback(
    ({ tone, text }: Notice) =>
      notifications.show({
        message: text,
        color: tone === "error" ? "red" : tone === "success" ? "teal" : "blue",
      }),
    [],
  );
  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiClientError && error.status === 401) {
        setAuth({ authenticated: false, bootstrapAllowed: false });
        setOrganizations([]);
        setSelectedOrganizationId("");
        setDashboard(undefined);
        setReportDetail(undefined);
      }
      showNotice({
        tone: "error",
        text:
          error instanceof ApiClientError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : "Unexpected error.",
      });
    },
    [showNotice],
  );
  const loadOrganizations = useCallback(async () => {
    const page = await apiClient.listOrganizations();
    setOrganizations(page.items);
    setSelectedOrganizationId((current) =>
      current && page.items.some((item) => item.id === current)
        ? current
        : (page.items[0]?.id ?? ""),
    );
  }, []);
  const loadDashboard = useCallback(async (id: string) => {
    if (!id) {
      setDashboard(undefined);
      return;
    }
    const next = await apiClient.getDashboard(id);
    setDashboard(next);
    setSelectedReportId((current) => current || next.latestReport?.id || next.reports[0]?.id || "");
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await loadOrganizations();
      if (selectedOrganizationId) await loadDashboard(selectedOrganizationId);
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }, [handleError, loadDashboard, loadOrganizations, selectedOrganizationId]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        await apiClient.getHealth();
        if (!cancelled) setHealth("ok");
        const session = await apiClient.getCurrentUser();
        if (!cancelled) {
          setAuth(session);
          if (session.authenticated) {
            const page = await apiClient.listOrganizations();
            setOrganizations(page.items);
            setSelectedOrganizationId(page.items[0]?.id ?? "");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setHealth("error");
          handleError(error);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleError]);
  useEffect(() => {
    let cancelled = false;
    if (!selectedOrganizationId) {
      setDashboard(undefined);
      return;
    }
    void (async () => {
      setLoading(true);
      try {
        const next = await apiClient.getDashboard(selectedOrganizationId);
        if (!cancelled) {
          setDashboard(next);
          setSelectedReportId(
            (current) => current || next.latestReport?.id || next.reports[0]?.id || "",
          );
        }
      } catch (error) {
        if (!cancelled) handleError(error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleError, selectedOrganizationId]);
  useEffect(() => {
    let cancelled = false;
    if (!selectedReportId || !selectedOrganizationId) {
      setReportDetail(undefined);
      return;
    }
    void apiClient
      .getReport(selectedReportId, selectedOrganizationId)
      .then((report) => {
        if (!cancelled) setReportDetail(report);
      })
      .catch((error) => {
        if (!cancelled) {
          setReportDetail(undefined);
          handleError(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [handleError, selectedOrganizationId, selectedReportId]);
  async function authenticate(email: string, password: string) {
    setLoading(true);
    try {
      const session = await apiClient.login({ email, password });
      if (!session.authenticated) throw new Error("Login did not establish a session.");
      setAuth(session);
      await loadOrganizations();
      void navigate("/dashboard", { replace: true });
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }
  async function bootstrapOrganization(request: BrowserCreateOrganizationRequest) {
    setLoading(true);
    try {
      const organization = await apiClient.createOrganization(request);
      const session = await apiClient.getCurrentUser();
      if (!session.authenticated)
        throw new Error("Bootstrap completed without establishing a session.");
      setAuth(session);
      await loadOrganizations();
      setSelectedOrganizationId(organization.id);
      showNotice({ tone: "success", text: `Created ${organization.name}.` });
      void navigate("/dashboard", { replace: true });
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }
  async function logout() {
    setLoading(true);
    try {
      await apiClient.logout();
      setAuth({ authenticated: false, bootstrapAllowed: false });
      setOrganizations([]);
      setSelectedOrganizationId("");
      setDashboard(undefined);
      setSelectedReportId("");
      setReportDetail(undefined);
      void navigate("/login", { replace: true });
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }
  if (!auth || !auth.authenticated)
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <AuthScreen
              health={health}
              loading={loading}
              bootstrapAllowed={auth?.bootstrapAllowed ?? false}
              onLogin={(email, password) => void authenticate(email, password)}
              onBootstrap={(request) => void bootstrapOrganization(request)}
            />
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  return (
    <AppShell header={{ height: 72 }} navbar={{ width: 235, breakpoint: "sm" }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Group gap="sm">
            <ThemeIcon variant="light" size="lg">
              <IconActivity size={20} />
            </ThemeIcon>
            <Box>
              <Title order={3}>TeamTales</Title>
              <Group gap={5}>
                <Badge
                  size="xs"
                  color={health === "ok" ? "teal" : health === "error" ? "red" : "gray"}
                  variant="dot"
                >
                  API {health}
                </Badge>
                {loading && (
                  <Text size="xs" c="dimmed">
                    Updating
                  </Text>
                )}
              </Group>
            </Box>
          </Group>
          <Group gap="xs">
            <NativeSelect
              className="desktop-only"
              aria-label="Select organization"
              value={selectedOrganizationId}
              onChange={(event) => setSelectedOrganizationId(event.target.value)}
              data={[
                { value: "", label: "No organization" },
                ...organizations.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            <ActionIcon
              variant="subtle"
              aria-label="Refresh data"
              loading={loading}
              onClick={() => void refresh()}
            >
              <IconRefresh size={18} />
            </ActionIcon>
            <Text size="sm" className="desktop-only">
              {auth.user.displayName || auth.user.email}
            </Text>
            <ActionIcon
              color="red"
              variant="subtle"
              aria-label="Sign out"
              onClick={() => void logout()}
            >
              <IconLogout size={18} />
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        <Stack gap={4}>
          {sections.map(([label, path, Icon]) => (
            <Button
              key={path}
              component={NavLink}
              to={path}
              variant="subtle"
              justify="flex-start"
              leftSection={<Icon size={18} />}
              style={({ isActive }: { isActive: boolean }) => ({
                fontWeight: isActive ? 700 : 400,
              })}
            >
              {label}
            </Button>
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardSection dashboard={dashboard} />} />
          <Route
            path="/setup"
            element={
              <SetupSection
                dashboard={dashboard}
                selectedOrganizationId={selectedOrganizationId}
                onCreatedOrganization={(id) => {
                  setSelectedOrganizationId(id);
                  void loadOrganizations()
                    .then(() => loadDashboard(id))
                    .catch(handleError);
                }}
                onChanged={() => void refresh()}
                onError={handleError}
                onNotice={showNotice}
              />
            }
          />
          <Route
            path="/providers"
            element={
              <ProvidersSection
                dashboard={dashboard}
                organizationId={selectedOrganizationId}
                onChanged={() => void refresh()}
                onError={handleError}
                onNotice={showNotice}
              />
            }
          />
          <Route
            path="/sync"
            element={
              <SyncSection
                dashboard={dashboard}
                selectedOrganizationId={selectedOrganizationId}
                onError={handleError}
                onNotice={showNotice}
              />
            }
          />
          <Route
            path="/reports"
            element={
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
            }
          />
          <Route
            path="/data"
            element={<DataSection dashboard={dashboard} reportDetail={reportDetail} />}
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}

function AuthScreen({
  health,
  loading,
  bootstrapAllowed,
  onLogin,
  onBootstrap,
}: {
  health: string;
  loading: boolean;
  bootstrapAllowed: boolean;
  onLogin: (email: string, password: string) => void;
  onBootstrap: (request: BrowserCreateOrganizationRequest) => void;
}): ReactElement {
  const [login, setLogin] = useState({ email: "", password: "" });
  const [form, setForm] = useState({
    organizationName: "",
    organizationSlug: "",
    ownerName: "",
    ownerEmail: "",
    ownerPassword: "",
  });
  return (
    <Center mih="100vh" p="md">
      <Stack w="100%" maw={940} gap="xl">
        <Stack gap={4} ta="center">
          <ThemeIcon size={48} radius="xl" mx="auto">
            <IconActivity size={28} />
          </ThemeIcon>
          <Title>TeamTales</Title>
          <Text c="dimmed">A calmer view of your team’s work.</Text>
          <Badge mx="auto" color={health === "ok" ? "teal" : "gray"} variant="light">
            API {health}
          </Badge>
        </Stack>
        <SimpleGrid cols={{ base: 1, md: bootstrapAllowed ? 2 : 1 }}>
          <Card withBorder radius="md" padding="xl">
            <Title order={2} size="h3" mb="lg">
              Sign in
            </Title>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onLogin(login.email.trim(), login.password);
              }}
            >
              <Stack>
                <TextInput
                  label="Email"
                  type="email"
                  required
                  autoComplete="email"
                  value={login.email}
                  onChange={(event) => setLogin({ ...login, email: event.currentTarget.value })}
                />
                <PasswordInput
                  label="Password"
                  required
                  autoComplete="current-password"
                  value={login.password}
                  onChange={(event) => setLogin({ ...login, password: event.currentTarget.value })}
                />
                <Button type="submit" loading={loading} rightSection={<IconArrowRight size={16} />}>
                  Sign in
                </Button>
              </Stack>
            </form>
          </Card>
          {bootstrapAllowed && (
            <Card withBorder radius="md" padding="xl">
              <Title order={2} size="h3">
                Create first organization
              </Title>
              <Text size="sm" c="dimmed" mb="lg">
                Set up the owner account and workspace.
              </Text>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onBootstrap({
                    name: form.organizationName.trim(),
                    slug: optionalText(form.organizationSlug),
                    owner: {
                      displayName: optionalText(form.ownerName),
                      primaryEmail: form.ownerEmail.trim(),
                      password: form.ownerPassword,
                    },
                  });
                }}
              >
                <Stack gap="sm">
                  <TextInput
                    label="Organization name"
                    required
                    value={form.organizationName}
                    onChange={(event) =>
                      setForm({ ...form, organizationName: event.currentTarget.value })
                    }
                  />
                  <TextInput
                    label="Organization slug"
                    value={form.organizationSlug}
                    onChange={(event) =>
                      setForm({ ...form, organizationSlug: event.currentTarget.value })
                    }
                  />
                  <TextInput
                    label="Owner name"
                    value={form.ownerName}
                    onChange={(event) => setForm({ ...form, ownerName: event.currentTarget.value })}
                  />
                  <TextInput
                    label="Owner email"
                    type="email"
                    required
                    value={form.ownerEmail}
                    onChange={(event) =>
                      setForm({ ...form, ownerEmail: event.currentTarget.value })
                    }
                  />
                  <PasswordInput
                    label="Owner password"
                    required
                    value={form.ownerPassword}
                    onChange={(event) =>
                      setForm({ ...form, ownerPassword: event.currentTarget.value })
                    }
                  />
                  <Button type="submit" loading={loading}>
                    Create organization
                  </Button>
                </Stack>
              </form>
            </Card>
          )}
        </SimpleGrid>
      </Stack>
    </Center>
  );
}

function DashboardSection({ dashboard }: { dashboard: DashboardDto | undefined }): ReactElement {
  return (
    <Stack>
      <PageTitle
        title="Dashboard"
        subtitle="A pulse check on the work flowing through your organization."
      />
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <StatCard
          label="Integrations"
          value={dashboard?.integrations.length ?? 0}
          icon={<IconPlugConnected size={18} />}
        />
        <StatCard
          label="Sync scopes"
          value={dashboard?.syncScopes.length ?? 0}
          icon={<IconRefresh size={18} />}
        />
        <StatCard
          label="Reports"
          value={dashboard?.reports.length ?? 0}
          icon={<IconChartBar size={18} />}
        />
        <StatCard
          label="Work items"
          value={dashboard?.workItems.length ?? 0}
          icon={<IconActivity size={18} />}
        />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Panel title="Highlights">
          <Stack gap="sm">
            {dashboard?.highlights.map((item, index) => (
              <Paper key={`${item.title}-${index}`} withBorder p="sm">
                <Text fw={600}>{item.title}</Text>
                <Text size="sm">{item.reason}</Text>
                <Text size="xs" c="dimmed">
                  {item.sourceRefs.join(", ") || "No sources"}
                </Text>
              </Paper>
            )) ?? <Empty text="No highlights yet." />}
            {(dashboard?.highlights.length ?? 0) === 0 && <Empty text="No highlights yet." />}
          </Stack>
        </Panel>
        <Panel title="Metrics">
          <DataTable
            columns={["Metric", "Value", "Dimensions"]}
            rows={(dashboard?.metrics ?? []).map((item) => [
              item.name,
              String(item.value),
              formatJsonSummary(item.dimensions),
            ])}
            empty="No metrics yet."
          />
        </Panel>
      </SimpleGrid>
      <Panel title="Work items">
        <DataTable
          columns={["Provider", "Status", "Title", "Facts"]}
          rows={(dashboard?.workItems ?? []).map((item) => [
            item.provider,
            item.status,
            item.url ? (
              <Anchor href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </Anchor>
            ) : (
              item.title
            ),
            item.summaryFacts.join("; "),
          ])}
          empty="No work items yet."
        />
      </Panel>
      <Panel title="People">
        <DataTable
          columns={["Person", "Activity", "Metrics", "Sources"]}
          rows={(dashboard?.people ?? []).map((item) => [
            item.displayName,
            item.activitySummary,
            formatJsonSummary(item.metrics),
            item.sourceRefs.join(", "),
          ])}
          empty="No people yet."
        />
      </Panel>
    </Stack>
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
  onCreatedOrganization: (id: string) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
  onNotice: (n: Notice) => void;
}): ReactElement {
  const [organization, setOrganization] = useState({ name: "", slug: "" });
  const [pat, setPat] = useState({ provider: "github" as Provider, displayName: "", token: "" });
  return (
    <Stack>
      <PageTitle title="Setup" subtitle="Create workspaces and connect personal access tokens." />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Panel title="Organization">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apiClient
                .createOrganization({
                  name: organization.name.trim(),
                  slug: optionalText(organization.slug),
                })
                .then((item) => {
                  setOrganization({ name: "", slug: "" });
                  onCreatedOrganization(item.id);
                  onNotice({ tone: "success", text: `Created ${item.name}.` });
                })
                .catch(onError);
            }}
          >
            <Stack>
              <TextInput
                label="Name"
                required
                value={organization.name}
                onChange={(e) => setOrganization({ ...organization, name: e.currentTarget.value })}
              />
              <TextInput
                label="Slug"
                value={organization.slug}
                onChange={(e) => setOrganization({ ...organization, slug: e.currentTarget.value })}
              />
              <Button type="submit" leftSection={<IconBuilding size={16} />}>
                Create organization
              </Button>
            </Stack>
          </form>
        </Panel>
        <Panel title="PAT integration">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const request: BrowserAddPatIntegrationRequest = {
                organizationId: selectedOrganizationId,
                provider: pat.provider,
                displayName: optionalText(pat.displayName),
                token: pat.token,
              };
              void apiClient
                .addPatIntegration(request)
                .then((item) => {
                  setPat({ ...pat, displayName: "", token: "" });
                  onChanged();
                  onNotice({ tone: "success", text: `Added ${item.provider} integration.` });
                })
                .catch(onError);
            }}
          >
            <Stack>
              <TextInput
                label="Organization"
                value={selectedOrganizationId || "No organization selected"}
                readOnly
              />
              <NativeSelect
                label="Provider"
                value={pat.provider}
                onChange={(e) => setPat({ ...pat, provider: e.currentTarget.value as Provider })}
                data={providerOptions}
              />
              <TextInput
                label="Display name"
                value={pat.displayName}
                onChange={(e) => setPat({ ...pat, displayName: e.currentTarget.value })}
              />
              <PasswordInput
                label="Token"
                required
                value={pat.token}
                onChange={(e) => setPat({ ...pat, token: e.currentTarget.value })}
              />
              <Button type="submit" disabled={!selectedOrganizationId}>
                Add PAT
              </Button>
            </Stack>
          </form>
        </Panel>
      </SimpleGrid>
      <Panel title="Integrations">
        <DataTable
          columns={["Provider", "Name", "Status", "Secret hint", "Updated"]}
          rows={(dashboard?.integrations ?? []).map((item) => [
            item.provider,
            item.displayName,
            <Badge>{item.status}</Badge>,
            item.secretHint ?? "Stored",
            formatDateTime(item.updatedAt),
          ])}
          empty="No integrations connected yet."
        />
      </Panel>
    </Stack>
  );
}

function SyncSection({
  dashboard,
  selectedOrganizationId,
  onError,
  onNotice,
}: {
  dashboard: DashboardDto | undefined;
  selectedOrganizationId: string;
  onError: (e: unknown) => void;
  onNotice: (n: Notice) => void;
}): ReactElement {
  const [form, setForm] = useState({
    provider: "github" as Provider,
    integrationId: "",
    syncScopeId: "",
  });
  const integrations = dashboard?.integrations ?? [],
    scopes = dashboard?.syncScopes ?? [];
  return (
    <Stack>
      <PageTitle title="Sync" subtitle="Run a manual sync and review the active resource scopes." />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Panel title="Trigger sync">
          <Alert color="blue" variant="light" mb="md">
            Choose a provider and optional scope to begin a manual sync.
          </Alert>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apiClient
                .triggerSync(form.provider, {
                  organizationId: selectedOrganizationId || undefined,
                  integrationId: optionalText(form.integrationId),
                  syncScopeId: optionalText(form.syncScopeId),
                })
                .then((result) =>
                  onNotice({
                    tone: "info",
                    text:
                      result.status === "not_implemented"
                        ? "Sync execution is not available for this provider."
                        : (result.message ?? `Sync status: ${result.status}.`),
                  }),
                )
                .catch((error) =>
                  error instanceof ApiClientError && error.code === "sync_not_implemented"
                    ? onNotice({
                        tone: "info",
                        text: "Sync execution is not available for this provider.",
                      })
                    : onError(error),
                );
            }}
          >
            <Stack>
              <TextInput
                label="Organization"
                readOnly
                value={selectedOrganizationId || "No organization selected"}
              />
              <NativeSelect
                label="Provider"
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.currentTarget.value as Provider })}
                data={providerOptions}
              />
              <NativeSelect
                label="Integration"
                value={form.integrationId}
                onChange={(e) => setForm({ ...form, integrationId: e.currentTarget.value })}
                data={[
                  { value: "", label: "Any integration" },
                  ...integrations.map((x) => ({ value: x.id, label: x.displayName })),
                ]}
              />
              <NativeSelect
                label="Sync scope"
                value={form.syncScopeId}
                onChange={(e) => setForm({ ...form, syncScopeId: e.currentTarget.value })}
                data={[
                  { value: "", label: "Any sync scope" },
                  ...scopes.map((x) => ({ value: x.id, label: x.externalName })),
                ]}
              />
              <Button type="submit" disabled={!selectedOrganizationId}>
                Run sync
              </Button>
            </Stack>
          </form>
        </Panel>
        <Panel title="Sync scopes">
          <DataTable
            columns={["Provider", "Type", "External", "Enabled", "Last success"]}
            rows={scopes.map((x) => [
              x.provider,
              x.scopeType,
              `${x.externalName}${x.externalId ? ` (${x.externalId})` : ""}`,
              x.enabled ? (
                <Badge color="teal">Enabled</Badge>
              ) : (
                <Badge color="gray">Disabled</Badge>
              ),
              formatDateTime(x.lastSuccessAt),
            ])}
            empty="No sync scopes yet."
          />
        </Panel>
      </SimpleGrid>
    </Stack>
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
  onSelectReport: (id: string) => void;
  onGenerated: (r: ReportDetailDto) => void;
  onError: (e: unknown) => void;
  onNotice: (n: Notice) => void;
}): ReactElement {
  const defaults = useMemo(getDefaultPeriod, []);
  const [form, setForm] = useState({
    periodStart: defaults.start,
    periodEnd: defaults.end,
    scopeType: "organization" as ReportScopeType,
    scopeId: "",
    scopeName: "",
    title: "",
    persist: true,
  });
  return (
    <Stack>
      <PageTitle
        title="Reports"
        subtitle="Generate a weekly narrative from the team’s synced work."
      />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Panel title="Weekly report">
          <form
            onSubmit={(e) => {
              e.preventDefault();
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
              void apiClient
                .generateWeeklyReport(request)
                .then((result) => {
                  onGenerated(result.report);
                  onNotice({ tone: "success", text: `Generated ${result.report.title}.` });
                })
                .catch(onError);
            }}
          >
            <Stack>
              <TextInput
                label="Organization"
                readOnly
                value={selectedOrganizationId || "No organization selected"}
              />
              <NativeSelect
                label="Scope type"
                value={form.scopeType}
                onChange={(e) =>
                  setForm({ ...form, scopeType: e.currentTarget.value as ReportScopeType })
                }
                data={reportScopeTypes}
              />
              <TextInput
                label="Scope ID"
                value={form.scopeId}
                onChange={(e) => setForm({ ...form, scopeId: e.currentTarget.value })}
              />
              <TextInput
                label="Scope name"
                value={form.scopeName}
                onChange={(e) => setForm({ ...form, scopeName: e.currentTarget.value })}
              />
              <SimpleGrid cols={2}>
                <TextInput
                  label="Period start"
                  type="date"
                  required
                  value={form.periodStart}
                  onChange={(e) => setForm({ ...form, periodStart: e.currentTarget.value })}
                />
                <TextInput
                  label="Period end"
                  type="date"
                  required
                  value={form.periodEnd}
                  onChange={(e) => setForm({ ...form, periodEnd: e.currentTarget.value })}
                />
              </SimpleGrid>
              <TextInput
                label="Title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
              />
              <Checkbox
                label="Save this report"
                checked={form.persist}
                onChange={(e) => setForm({ ...form, persist: e.currentTarget.checked })}
              />
              <Button type="submit" disabled={!selectedOrganizationId}>
                Generate report
              </Button>
            </Stack>
          </form>
        </Panel>
        <Panel title="Saved reports">
          <Stack gap="xs">
            {dashboard?.reports.map((report) => (
              <Button
                key={report.id}
                variant={selectedReportId === report.id ? "light" : "subtle"}
                color="gray"
                justify="flex-start"
                h="auto"
                py="sm"
                onClick={() => onSelectReport(report.id)}
              >
                <Box ta="left">
                  <Text fw={600}>{report.title}</Text>
                  <Text size="xs" c="dimmed">
                    {report.reportType} · {report.periodStart} to {report.periodEnd}
                  </Text>
                </Box>
              </Button>
            )) ?? <Empty text="No reports generated yet." />}
            {(dashboard?.reports.length ?? 0) === 0 && <Empty text="No reports generated yet." />}
          </Stack>
        </Panel>
      </SimpleGrid>
      <Panel title="Report detail">
        {reportDetail ? (
          <Stack>
            <SimpleGrid cols={{ base: 1, sm: 4 }}>
              {[
                ["Status", reportDetail.status],
                ["Scope", `${reportDetail.scopeType} / ${reportDetail.scopeId}`],
                ["Period", `${reportDetail.periodStart} to ${reportDetail.periodEnd}`],
                ["Updated", formatDateTime(reportDetail.updatedAt)],
              ].map(([label, value]) => (
                <Paper key={label} withBorder p="sm">
                  <Text size="xs" c="dimmed">
                    {label}
                  </Text>
                  <Text size="sm">{value}</Text>
                </Paper>
              ))}
            </SimpleGrid>
            {reportDetail.summary && <Text>{reportDetail.summary}</Text>}
            <Code block>{reportDetail.bodyMarkdown || "No report markdown."}</Code>
          </Stack>
        ) : (
          <Empty text="Select a report to see its detail." />
        )}
      </Panel>
    </Stack>
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
    <Stack>
      <PageTitle
        title="Data"
        subtitle="Raw API payloads for troubleshooting and integration work."
      />
      <Panel title="Dashboard DTO">
        <Code block>{JSON.stringify(dashboard ?? null, null, 2)}</Code>
      </Panel>
      <Panel title="Report DTO">
        <Code block>{JSON.stringify(reportDetail ?? null, null, 2)}</Code>
      </Panel>
    </Stack>
  );
}
function PageTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Box>
      <Title order={1}>{title}</Title>
      <Text c="dimmed">{subtitle}</Text>
    </Box>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={2} size="h4" mb="md">
        {title}
      </Title>
      {children}
    </Card>
  );
}
function StatCard({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <Card withBorder>
      <Group justify="space-between">
        <Box>
          <Text size="xs" c="dimmed">
            {label}
          </Text>
          <Text fw={700} size="xl">
            {value}
          </Text>
        </Box>
        <ThemeIcon variant="light">{icon}</ThemeIcon>
      </Group>
    </Card>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <Center p="xl">
      <Stack align="center" gap="xs">
        <ThemeIcon variant="light" color="gray" size="lg">
          <IconUsers size={18} />
        </ThemeIcon>
        <Text c="dimmed" size="sm">
          {text}
        </Text>
      </Stack>
    </Center>
  );
}
function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: ReactNode[][];
  empty: string;
}) {
  return rows.length === 0 ? (
    <Empty text={empty} />
  ) : (
    <Box style={{ overflowX: "auto" }}>
      <MantineTable striped highlightOnHover withTableBorder verticalSpacing="sm">
        <MantineTable.Thead>
          <MantineTable.Tr>
            {columns.map((column) => (
              <MantineTable.Th key={column}>{column}</MantineTable.Th>
            ))}
          </MantineTable.Tr>
        </MantineTable.Thead>
        <MantineTable.Tbody>
          {rows.map((row, rowIndex) => (
            <MantineTable.Tr key={rowIndex}>
              {columns.map((column, index) => (
                <MantineTable.Td key={`${column}-${index}`}>{row[index] ?? ""}</MantineTable.Td>
              ))}
            </MantineTable.Tr>
          ))}
        </MantineTable.Tbody>
      </MantineTable>
    </Box>
  );
}
function optionalText(value: string | undefined) {
  const next = value?.trim();
  return next || undefined;
}
function formatJsonSummary(value: unknown) {
  return value == null ? "" : JSON.stringify(value);
}
function formatDateTime(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function getDefaultPeriod() {
  const end = new Date(),
    start = new Date(end);
  start.setDate(end.getDate() - 7);
  return { start: endDate(start), end: endDate(end) };
}
function endDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
