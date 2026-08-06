import type { FormEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router";
import {
  ActionIcon,
  Alert,
  Anchor,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  Group,
  NativeSelect,
  Paper,
  PasswordInput,
  Pagination,
  Progress,
  SimpleGrid,
  Stack,
  Table as MantineTable,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
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
  AnalyticsScopeType,
  DashboardDto,
  GitHubAnalyticsDto,
  ListSourceObjectsResponseDto,
  OrganizationSyncStatusDto,
  ReportDetailDto,
  SourceObjectDto,
  SourceObjectSummaryDto,
  SyncRunProgressDto,
  SyncRunResourceProgressDto,
  SyncRunDto,
} from "@teamtales/common/api";
import type { Provider, ReportScopeType } from "@teamtales/common/domain";
import type {
  AuthSession,
  BrowserCreateOrganizationRequest,
} from "./api";
import { ApiClientError, apiClient } from "./api";
import { ProvidersSection } from "./ProvidersSection";

const sections = [
  ["Dashboard", "/dashboard", IconLayoutDashboard],
  ["GitHub insights", "/analytics", IconChartBar],
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
  const [mobileNavigationOpened, mobileNavigation] = useDisclosure(false);
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
  const selectOrganization = useCallback(
    (organizationId: string) => {
      if (organizationId === selectedOrganizationId) return;
      setSelectedOrganizationId(organizationId);
      setSelectedReportId("");
      setReportDetail(undefined);
    },
    [selectedOrganizationId],
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const initialize = async (): Promise<void> => {
      setLoading(true);
      try {
        await apiClient.getHealth();
        if (!cancelled) setHealth("ok");
        const session = await apiClient.getCurrentUser();
        if (cancelled) return;

        setAuth(session);
        if (session.authenticated) {
          const page = await apiClient.listOrganizations();
          if (!cancelled) {
            setOrganizations(page.items);
            setSelectedOrganizationId(page.items[0]?.id ?? "");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setHealth("error");
          // Keep the current location and session state while the API is restarting.
          // A failed request does not prove that the session has expired.
          retryTimer = setTimeout(() => void initialize(), 1_000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);
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
  if (!auth)
    return (
      <Center mih="100vh">
        <Stack align="center" gap="xs">
          <Text fw={600}>Restoring your session…</Text>
          <Text size="sm" c="dimmed">
            {health === "error" ? "Waiting for the API to restart." : "Checking authentication."}
          </Text>
        </Stack>
      </Center>
    );
  if (!auth.authenticated)
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
    <AppShell
      header={{ height: 72 }}
      navbar={{
        width: 235,
        breakpoint: "sm",
        collapsed: { mobile: !mobileNavigationOpened },
      }}
      padding="md"
    >
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between">
          <Group gap="sm">
            <Burger
              hiddenFrom="sm"
              opened={mobileNavigationOpened}
              onClick={mobileNavigation.toggle}
              aria-label={mobileNavigationOpened ? "Close navigation" : "Open navigation"}
            />
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
              onChange={(event) => selectOrganization(event.target.value)}
              data={[
                { value: "", label: "No organization" },
                ...organizations.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
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
          <NativeSelect
            hiddenFrom="sm"
            label="Organization"
            value={selectedOrganizationId}
            onChange={(event) => {
              selectOrganization(event.target.value);
              mobileNavigation.close();
            }}
            data={[
              { value: "", label: "No organization" },
              ...organizations.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
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
              onClick={mobileNavigation.close}
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
            path="/analytics"
            element={
              <AnalyticsSection organizationId={selectedOrganizationId} onError={handleError} />
            }
          />
          <Route
            path="/setup"
            element={
              <SetupSection
                dashboard={dashboard}
                selectedOrganizationId={selectedOrganizationId}
                onCreatedOrganization={(id) => {
                  selectOrganization(id);
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
            element={<DataSection organizationId={selectedOrganizationId} onError={handleError} />}
          />
          <Route
            path="/data/:sourceObjectId"
            element={
              <DataDetailSection organizationId={selectedOrganizationId} onError={handleError} />
            }
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
                      setForm({
                        ...form,
                        organizationName: event.currentTarget.value,
                      })
                    }
                  />
                  <TextInput
                    label="Organization slug"
                    value={form.organizationSlug}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        organizationSlug: event.currentTarget.value,
                      })
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
                      setForm({
                        ...form,
                        ownerEmail: event.currentTarget.value,
                      })
                    }
                  />
                  <PasswordInput
                    label="Owner password"
                    required
                    value={form.ownerPassword}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        ownerPassword: event.currentTarget.value,
                      })
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

function AnalyticsSection({
  organizationId,
  onError,
}: {
  organizationId: string;
  onError: (error: unknown) => void;
}): ReactElement {
  const [preset, setPreset] = useState("30d");
  const [start, setStart] = useState(() => dateInput(new Date(Date.now() - 30 * 86400000)));
  const [end, setEnd] = useState(() => dateInput(new Date()));
  const [scope, setScope] = useState("");
  const [data, setData] = useState<GitHubAnalyticsDto>();
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    try {
      const [scopeType, scopeId] = scope.split(":");
      setData(
        await apiClient.getGitHubAnalytics(organizationId, {
          start: analyticsPeriodStart(start),
          end: analyticsPeriodEnd(end),
          ...(scopeType && scopeId ? { scopeType: scopeType as AnalyticsScopeType, scopeId } : {}),
        }),
      );
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [end, onError, organizationId, scope, start]);
  useEffect(() => {
    void load();
  }, [load]);
  function setRange(value: string) {
    setPreset(value);
    if (value === "custom") return;
    const days = value === "7d" ? 7 : value === "90d" ? 90 : value === "365d" ? 365 : 30;
    setStart(dateInput(new Date(Date.now() - days * 86400000)));
    setEnd(dateInput(new Date()));
  }
  return (
    <Stack>
      <PageTitle
        title="GitHub insights"
        subtitle="Understand delivery volume, ownership, and code movement over time."
      />
      <Paper withBorder p="md">
        <Group align="end" wrap="wrap">
          <NativeSelect
            label="Period"
            value={preset}
            onChange={(event) => setRange(event.target.value)}
            data={[
              { value: "7d", label: "Last 7 days" },
              { value: "30d", label: "Last 30 days" },
              { value: "90d", label: "Last 90 days" },
              { value: "365d", label: "Last year" },
              { value: "custom", label: "Custom range" },
            ]}
          />
          <TextInput
            label="From"
            type="date"
            required
            value={start}
            onChange={(event) => {
              setPreset("custom");
              setStart(event.target.value);
            }}
          />
          <TextInput
            label="To"
            type="date"
            required
            value={end}
            onChange={(event) => {
              setPreset("custom");
              setEnd(event.target.value);
            }}
          />
          <NativeSelect
            label="Scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            data={[
              { value: "", label: "All GitHub activity" },
              ...(data?.scopes ?? []).map((item) => ({
                value: `${item.type}:${item.id}`,
                label: `${item.type === "developer" ? "Developer" : item.type === "github_repository" ? "Repository" : "Organization"}: ${item.name}`,
              })),
            ]}
          />
          <Button loading={loading} onClick={() => void load()}>
            Apply
          </Button>
        </Group>
      </Paper>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
        <StatCard
          label="PRs opened"
          value={data?.totals.opened ?? 0}
          icon={<IconActivity size={18} />}
        />
        <StatCard
          label="PRs merged"
          value={data?.totals.merged ?? 0}
          icon={<IconChartBar size={18} />}
        />
        <StatCard
          label="PRs in dataset"
          value={data?.totals.pullRequests ?? 0}
          icon={<IconFileText size={18} />}
        />
        <StatCard
          label="Lines added"
          value={data?.totals.additions ?? 0}
          icon={<IconArrowRight size={18} />}
        />
        <StatCard
          label="Lines removed"
          value={data?.totals.deletions ?? 0}
          icon={<IconArrowRight size={18} />}
        />
        <StatCard
          label="Reviews / comments"
          value={(data?.totals.reviews ?? 0) + (data?.totals.comments ?? 0)}
          icon={<IconUsers size={18} />}
        />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Panel title="By developer">
          <AnalyticsTable items={data?.developers ?? []} />
        </Panel>
        <Panel title="By repository">
          <AnalyticsTable items={data?.repositories ?? []} />
        </Panel>
      </SimpleGrid>
      <Panel title="Daily activity">
        <DataTable
          columns={["Date", "Opened", "Merged", "Added", "Removed"]}
          rows={(data?.trend ?? []).map((item) => [
            item.date,
            item.opened,
            item.merged,
            item.additions,
            item.deletions,
          ])}
          empty="No GitHub activity in this period."
        />
      </Panel>
      {!loading && data?.totals.pullRequests === 0 && (
        <Alert color="blue" title="No pull requests found">
          Try a wider date range or sync the relevant GitHub repository first.
        </Alert>
      )}
    </Stack>
  );
}

function AnalyticsTable({ items }: { items: GitHubAnalyticsDto["developers"] }): ReactElement {
  return (
    <DataTable
      columns={["Name", "Opened", "Merged", "Added", "Removed"]}
      rows={items.map((item) => [
        item.name,
        item.opened,
        item.merged,
        item.additions,
        item.deletions,
      ])}
      empty="No data for this scope."
    />
  );
}

function dateInput(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function analyticsPeriodStart(value: string): string {
  return analyticsDayBoundary(value).toISOString();
}

function analyticsPeriodEnd(value: string): string {
  const nextDay = analyticsDayBoundary(value);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay.toISOString();
}

function analyticsDayBoundary(value: string): Date {
  const boundary = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(boundary.valueOf()) ||
    boundary.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Choose a valid analytics date.");
  }
  return boundary;
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
            ))}
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
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [pat, setPat] = useState({
    provider: "github" as Provider,
    displayName: "",
    token: "",
  });
  const [addingPat, setAddingPat] = useState(false);
  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingOrganization) return;
    setCreatingOrganization(true);
    try {
      const item = await apiClient.createOrganization({
        name: organization.name.trim(),
        slug: optionalText(organization.slug),
      });
      setOrganization({ name: "", slug: "" });
      onCreatedOrganization(item.id);
      onNotice({ tone: "success", text: `Created ${item.name}.` });
    } catch (error) {
      onError(error);
    } finally {
      setCreatingOrganization(false);
    }
  }
  async function addPat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addingPat || !selectedOrganizationId) return;
    setAddingPat(true);
    try {
      const item = await apiClient.addPatIntegration({
        organizationId: selectedOrganizationId,
        provider: pat.provider,
        displayName: optionalText(pat.displayName),
        token: pat.token,
      });
      setPat({ ...pat, displayName: "", token: "" });
      onChanged();
      onNotice({
        tone: "success",
        text: `Added ${item.provider} integration.`,
      });
    } catch (error) {
      onError(error);
    } finally {
      setAddingPat(false);
    }
  }
  return (
    <Stack>
      <PageTitle title="Setup" subtitle="Create workspaces and connect personal access tokens." />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Panel title="Organization">
          <form onSubmit={(event) => void createOrganization(event)}>
            <Stack>
              <TextInput
                label="Name"
                required
                value={organization.name}
                onChange={(e) =>
                  setOrganization({
                    ...organization,
                    name: e.currentTarget.value,
                  })
                }
              />
              <TextInput
                label="Slug"
                value={organization.slug}
                onChange={(e) =>
                  setOrganization({
                    ...organization,
                    slug: e.currentTarget.value,
                  })
                }
              />
              <Button
                type="submit"
                loading={creatingOrganization}
                leftSection={<IconBuilding size={16} />}
              >
                Create organization
              </Button>
            </Stack>
          </form>
        </Panel>
        <Panel title="PAT integration">
          <form onSubmit={(event) => void addPat(event)}>
            <Stack>
              <TextInput
                label="Organization"
                value={selectedOrganizationId || "No organization selected"}
                readOnly
              />
              <NativeSelect
                label="Provider"
                value={pat.provider}
                onChange={(e) =>
                  setPat({
                    ...pat,
                    provider: e.currentTarget.value as Provider,
                  })
                }
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
              <Button type="submit" loading={addingPat} disabled={!selectedOrganizationId}>
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
  const [progressRefresh, setProgressRefresh] = useState(0);
  const [activeRuns, setActiveRuns] = useState<SyncRunDto[]>([]);
  const [triggering, setTriggering] = useState(false);
  const integrations = dashboard?.integrations ?? [],
    scopes = dashboard?.syncScopes ?? [];
  const providerIntegrations = integrations.filter(
    (integration) => integration.provider === form.provider,
  );
  const providerScopes = scopes.filter(
    (scope) =>
      scope.provider === form.provider &&
      (!form.integrationId || scope.integrationId === form.integrationId),
  );
  const hasConflictingRun = activeRuns.some(
    (run) =>
      run.provider === form.provider &&
      (!form.integrationId || run.integrationId === form.integrationId) &&
      (!form.syncScopeId || run.syncScopeId === form.syncScopeId),
  );
  return (
    <Stack>
      <PageTitle title="Sync" subtitle="Run a manual sync and review the active resource scopes." />
      <ActiveSyncProgress
        organizationId={selectedOrganizationId}
        refreshSignal={progressRefresh}
        onActiveRunsChange={setActiveRuns}
      />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Panel title="Trigger sync">
          <Alert color="blue" variant="light" mb="md">
            Choose a provider and optional scope to begin a manual sync.
          </Alert>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTriggering(true);
              void apiClient
                .triggerSync(form.provider, {
                  organizationId: selectedOrganizationId || undefined,
                  integrationId: optionalText(form.integrationId),
                  syncScopeId: optionalText(form.syncScopeId),
                })
                .then((result) => {
                  setProgressRefresh((current) => current + 1);
                  onNotice({
                    tone: "info",
                    text:
                      result.status === "not_implemented"
                        ? "Sync execution is not available for this provider."
                        : (result.message ?? `Sync status: ${result.status}.`),
                  });
                })
                .catch((error) =>
                  error instanceof ApiClientError && error.code === "sync_not_implemented"
                    ? onNotice({
                        tone: "info",
                        text: "Sync execution is not available for this provider.",
                      })
                    : onError(error),
                )
                .finally(() => setTriggering(false));
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
                onChange={(e) =>
                  setForm({
                    ...form,
                    provider: e.currentTarget.value as Provider,
                    integrationId: "",
                    syncScopeId: "",
                  })
                }
                data={providerOptions}
              />
              <NativeSelect
                label="Integration"
                value={form.integrationId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    integrationId: e.currentTarget.value,
                    syncScopeId: "",
                  })
                }
                data={[
                  { value: "", label: "Any integration" },
                  ...providerIntegrations.map((x) => ({
                    value: x.id,
                    label: x.displayName,
                  })),
                ]}
              />
              <NativeSelect
                label="Sync scope"
                value={form.syncScopeId}
                onChange={(e) => setForm({ ...form, syncScopeId: e.currentTarget.value })}
                data={[
                  { value: "", label: "Any sync scope" },
                  ...providerScopes.map((x) => ({
                    value: x.id,
                    label: x.externalName,
                  })),
                ]}
              />
              <Button
                type="submit"
                loading={triggering}
                disabled={!selectedOrganizationId || hasConflictingRun}
              >
                {hasConflictingRun ? "Sync already active" : "Run sync"}
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

type ActiveSyncRun = {
  progress: SyncRunProgressDto;
  resources: SyncRunResourceProgressDto[];
  resourcePage: number;
};

const syncResourcePageSize = 1_000;

async function loadSyncRunResourcePage(
  syncRunId: string,
  targetPage: number,
): Promise<SyncRunResourceProgressDto[]> {
  let cursor: string | undefined;
  for (let page = 1; page <= targetPage; page += 1) {
    const result = await apiClient.listSyncRunResources(syncRunId, cursor, syncResourcePageSize);
    if (page === targetPage || !result.nextCursor) return result.items;
    cursor = result.nextCursor;
  }
  return [];
}

function ActiveSyncProgress({
  organizationId,
  refreshSignal,
  onActiveRunsChange,
}: {
  organizationId: string;
  refreshSignal: number;
  onActiveRunsChange: (runs: SyncRunDto[]) => void;
}): ReactElement {
  const [status, setStatus] = useState<OrganizationSyncStatusDto>();
  const [runs, setRuns] = useState<ActiveSyncRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [cancellingRunId, setCancellingRunId] = useState<string>();
  const [resourcePages, setResourcePages] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    if (!organizationId) {
      setStatus(undefined);
      setRuns([]);
      onActiveRunsChange([]);
      return;
    }
    const load = async () => {
      setLoading(true);
      try {
        const nextStatus = await apiClient.getOrganizationSyncStatus(organizationId);
        const nextRuns = await Promise.all(
          nextStatus.activeRuns.map(async (run) => {
            const resourcePage = resourcePages[run.id] ?? 1;
            const [progress, resources] = await Promise.all([
              apiClient.getSyncRun(run.id),
              loadSyncRunResourcePage(run.id, resourcePage),
            ]);
            return { progress, resources, resourcePage };
          }),
        );
        if (cancelled) return;
        setStatus(nextStatus);
        setRuns(nextRuns);
        onActiveRunsChange(nextStatus.activeRuns);
        setError(undefined);
        timer = window.setTimeout(load, nextStatus.activeRuns.length > 0 ? 3_000 : 15_000);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Could not load sync progress.");
        timer = window.setTimeout(load, 10_000);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onActiveRunsChange, organizationId, refreshSignal, refreshNonce, resourcePages]);

  const cancelRun = (syncRunId: string) => {
    setCancellingRunId(syncRunId);
    void apiClient
      .cancelSyncRun(syncRunId)
      .then(() => setRefreshNonce((value) => value + 1))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Could not cancel the sync."),
      )
      .finally(() => setCancellingRunId(undefined));
  };

  const resourceCounts = Object.entries(status?.resourceStatusCounts ?? {});
  return (
    <Panel title="Sync activity">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Group gap="xs">
            <Badge color={runs.length > 0 ? "blue" : "gray"} variant="light">
              {runs.length > 0 ? `${runs.length} active` : "No active syncs"}
            </Badge>
            {loading && (
              <Text size="xs" c="dimmed">
                Updating…
              </Text>
            )}
          </Group>
          {resourceCounts.length > 0 && (
            <Group gap={6}>
              {resourceCounts.map(([state, count]) => (
                <Badge key={state} size="sm" color={syncStatusColor(state)} variant="outline">
                  {count} {state}
                </Badge>
              ))}
            </Group>
          )}
        </Group>
        {error && (
          <Alert color="red" variant="light" title="Progress temporarily unavailable">
            {error}
          </Alert>
        )}
        {runs.map(({ progress, resources, resourcePage }) => (
          <SyncRunProgressCard
            key={progress.run.id}
            progress={progress}
            resources={resources}
            resourcePage={resourcePage}
            cancelling={cancellingRunId === progress.run.id}
            onCancel={() => cancelRun(progress.run.id)}
            onResourcePageChange={(page) =>
              setResourcePages((pages) => ({
                ...pages,
                [progress.run.id]: page,
              }))
            }
          />
        ))}
        {!error && !loading && runs.length === 0 && (
          <Text size="sm" c="dimmed">
            Queued and running syncs will appear here automatically.
          </Text>
        )}
      </Stack>
    </Panel>
  );
}

function SyncRunProgressCard({
  progress,
  resources,
  resourcePage,
  cancelling,
  onCancel,
  onResourcePageChange,
}: {
  progress: SyncRunProgressDto;
  resources: SyncRunResourceProgressDto[];
  resourcePage: number;
  cancelling: boolean;
  onCancel: () => void;
  onResourcePageChange: (page: number) => void;
}): ReactElement {
  const { run, childRunCounts } = progress;
  const total = Object.values(childRunCounts).reduce((sum, count) => sum + count, 0);
  const complete =
    (childRunCounts.completed ?? 0) +
    (childRunCounts.failed ?? 0) +
    (childRunCounts.cancelled ?? 0);
  const percent = total === 0 ? 0 : Math.round((complete / total) * 100);
  const resourcePageCount = Math.ceil(total / syncResourcePageSize);
  const firstResource = (resourcePage - 1) * syncResourcePageSize + 1;
  const lastResource = Math.min(firstResource + resources.length - 1, total);
  const counters = resources.length
    ? resources.reduce(
        (sum, item) => ({
          fetched: sum.fetched + item.run.objectsFetched,
          changed: sum.changed + item.run.objectsInserted + item.run.objectsUpdated,
          failed: sum.failed + item.run.objectsFailed,
        }),
        { fetched: 0, changed: 0, failed: 0 },
      )
    : {
        fetched: run.objectsFetched,
        changed: run.objectsInserted + run.objectsUpdated,
        failed: run.objectsFailed,
      };
  return (
    <Card withBorder radius="sm" padding="md" bg="var(--mantine-color-gray-0)">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Box>
            <Group gap="xs">
              <Text fw={600} tt="capitalize">
                {run.provider} sync
              </Text>
              <Badge color={syncStatusColor(run.status)} variant="light">
                {run.status}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed" mt={3}>
              Started {formatDateTime(run.startedAt)} · attempt {run.attempt}
            </Text>
          </Box>
          <Text size="sm" fw={600} c="dimmed">
            {total > 0 ? `${complete}/${total} resources` : "Preparing resources"}
          </Text>
        </Group>
        <Group justify="flex-end">
          <Button
            size="compact-xs"
            color="red"
            variant="light"
            loading={cancelling}
            onClick={onCancel}
          >
            Abort sync
          </Button>
        </Group>
        <Progress
          value={percent}
          color={run.status === "queued" ? "gray" : "blue"}
          animated={run.status === "running"}
        />
        <Text size="xs" c="dimmed">
          {counters.fetched} fetched · {counters.changed} changed · {counters.failed} failed
        </Text>
        {resources.length > 0 && (
          <Stack gap={4}>
            {resources.map(({ resource, run: resourceRun }) => (
              <Group key={resourceRun.id} justify="space-between" gap="sm" wrap="nowrap">
                <Box style={{ minWidth: 0 }}>
                  <Text size="sm" truncate="end">
                    {resource?.displayName ?? "Sync resource"}
                  </Text>
                  {resourceRun.error && (
                    <Text size="xs" c="red" truncate="end">
                      {resourceRun.error}
                    </Text>
                  )}
                </Box>
                <Badge size="sm" color={syncStatusColor(resourceRun.status)} variant="light">
                  {resourceRun.status}
                </Badge>
              </Group>
            ))}
            <Group justify="space-between" gap="sm">
              <Text size="xs" c="dimmed">
                Showing {firstResource}-{lastResource} of {total} resources
              </Text>
              {resourcePageCount > 1 && (
                <Pagination
                  size="sm"
                  value={resourcePage}
                  onChange={onResourcePageChange}
                  total={resourcePageCount}
                />
              )}
            </Group>
          </Stack>
        )}
      </Stack>
    </Card>
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
  const [generating, setGenerating] = useState(false);
  async function generateReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generating || !selectedOrganizationId) return;
    setGenerating(true);
    try {
      const organizationName = selectedOrganization?.name ?? dashboard?.organization.name;
      const result = await apiClient.generateWeeklyReport({
        organizationId: selectedOrganizationId,
        organizationName,
        scopeType: form.scopeType,
        scopeId: optionalText(form.scopeId) ?? selectedOrganizationId,
        scopeName: optionalText(form.scopeName) ?? organizationName,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        title: optionalText(form.title),
        persist: form.persist,
      });
      onGenerated(result.report);
      onNotice({
        tone: "success",
        text: `Generated ${result.report.title}.`,
      });
    } catch (error) {
      onError(error);
    } finally {
      setGenerating(false);
    }
  }
  return (
    <Stack>
      <PageTitle
        title="Reports"
        subtitle="Generate a weekly narrative from the team’s synced work."
      />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Panel title="Weekly report">
          <form onSubmit={(event) => void generateReport(event)}>
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
                  setForm({
                    ...form,
                    scopeType: e.currentTarget.value as ReportScopeType,
                  })
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
              <Button type="submit" loading={generating} disabled={!selectedOrganizationId}>
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
            ))}
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
  organizationId,
  onError,
}: {
  organizationId: string;
  onError: (error: unknown) => void;
}): ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<SourceObjectSummaryDto[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [objectType, setObjectType] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingItems, setLoadingItems] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!organizationId) {
      setItems([]);
      setTypes([]);
      return;
    }
    setLoadingItems(true);
    void apiClient
      .listSourceObjects(organizationId, { type: objectType, search, cursor })
      .then((page) => {
        if (!cancelled) {
          setItems(page.items);
          setTypes(page.types);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((error) => !cancelled && onError(error))
      .finally(() => !cancelled && setLoadingItems(false));
    return () => {
      cancelled = true;
    };
  }, [cursor, objectType, onError, organizationId, search]);
  const resetPagination = () => {
    setCursor(undefined);
    setPreviousCursors([]);
  };
  return (
    <Stack>
      <PageTitle title="Data" subtitle="Explore every item synced from your connected providers." />
      <Panel title="Synced items">
        <Group align="end" mb="md">
          <NativeSelect
            label="Type"
            value={objectType}
            onChange={(event) => {
              setObjectType(event.target.value);
              resetPagination();
            }}
            data={[
              { value: "", label: "All types" },
              ...types.map((type) => ({ value: type, label: type })),
            ]}
          />
          <TextInput
            label="Search"
            placeholder="Repository, ID, or payload text"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPagination();
            }}
            style={{ flex: 1 }}
          />
        </Group>
        {loadingItems ? (
          <Text c="dimmed">Loading synced items…</Text>
        ) : (
          <DataTable
            columns={["Type", "Provider", "External ID", "State", "Last seen", "Open"]}
            rows={items.map((item) => [
              item.objectType,
              item.provider,
              item.externalId,
              item.sourceState,
              formatDateTime(item.lastSeenAt),
              <Button
                key={item.id}
                size="xs"
                variant="light"
                onClick={() => void navigate(`/data/${encodeURIComponent(item.id)}`)}
              >
                Inspect
              </Button>,
            ])}
            empty="No synced items yet. Items appear here as each provider sync completes."
          />
        )}
        <Group justify="space-between" mt="md">
          <Button
            variant="default"
            disabled={previousCursors.length === 0}
            onClick={() => {
              const previous = previousCursors.at(-1);
              setPreviousCursors((values) => values.slice(0, -1));
              setCursor(previous || undefined);
            }}
          >
            Previous
          </Button>
          <Text size="sm" c="dimmed">
            {items.length} items on this page
          </Text>
          <Button
            disabled={!nextCursor}
            onClick={() => {
              if (!nextCursor) return;
              setPreviousCursors((values) => [...values, cursor ?? ""]);
              setCursor(nextCursor);
            }}
          >
            Next
          </Button>
        </Group>
      </Panel>
    </Stack>
  );
}
function DataDetailSection({
  organizationId,
  onError,
}: {
  organizationId: string;
  onError: (error: unknown) => void;
}): ReactElement {
  const navigate = useNavigate();
  const { sourceObjectId = "" } = useParams();
  const [item, setItem] = useState<SourceObjectDto>();
  useEffect(() => {
    let cancelled = false;
    setItem(undefined);
    if (!organizationId || !sourceObjectId) return;
    void apiClient
      .getSourceObject(sourceObjectId, organizationId)
      .then((value) => !cancelled && setItem(value))
      .catch((error) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [onError, organizationId, sourceObjectId]);
  return (
    <Stack>
      <Group>
        <Button variant="subtle" onClick={() => void navigate("/data")}>
          Back to data
        </Button>
        <PageTitle
          title={item ? `${item.objectType}: ${item.externalId}` : "Data item"}
          subtitle="Synced provider payload"
        />
      </Group>
      {item ? (
        <Panel title="Payload">
          <Stack gap="sm">
            {item.externalUrl && (
              <Anchor href={item.externalUrl} target="_blank" rel="noreferrer">
                Open in provider
              </Anchor>
            )}
            <JsonViewer value={item.raw} />
          </Stack>
        </Panel>
      ) : (
        <Empty text="Loading synced item…" />
      )}
    </Stack>
  );
}
function JsonViewer({ value, name, depth = 0 }: { value: unknown; name?: string; depth?: number }) {
  if (value === null) return <JsonValue name={name} value="null" color="dimmed" />;
  if (Array.isArray(value)) {
    return (
      <JsonBranch name={name} label={`Array (${value.length})`} depth={depth}>
        {value.map((item, index) => (
          <JsonViewer key={index} name={`[${index}]`} value={item} depth={depth + 1} />
        ))}
      </JsonBranch>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <JsonBranch name={name} label={`Object (${entries.length})`} depth={depth}>
        {entries.map(([key, item]) => (
          <JsonViewer key={key} name={key} value={item} depth={depth + 1} />
        ))}
      </JsonBranch>
    );
  }
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    return (
      <Group gap="xs" wrap="nowrap">
        {name && <Text fw={600}>{name}</Text>}
        <Anchor href={value} target="_blank" rel="noreferrer" truncate>
          {value}
        </Anchor>
      </Group>
    );
  }
  return (
    <JsonValue
      name={name}
      value={JSON.stringify(value)}
      color={typeof value === "string" ? "blue" : "orange"}
    />
  );
}
function JsonBranch({
  name,
  label,
  depth,
  children,
}: {
  name?: string;
  label: string;
  depth: number;
  children: ReactNode;
}) {
  return (
    <Box
      pl={depth ? "md" : 0}
      style={{
        borderLeft: depth ? "2px solid var(--mantine-color-gray-3)" : undefined,
      }}
    >
      <details open={depth < 2}>
        <summary style={{ cursor: "pointer" }}>
          <Text component="span" fw={600} mr="xs">
            {name ?? "payload"}
          </Text>
          <Badge component="span" size="xs" variant="light" color="gray">
            {label}
          </Badge>
        </summary>
        <Stack gap={4} mt="xs">
          {children}
        </Stack>
      </details>
    </Box>
  );
}
function JsonValue({ name, value, color }: { name?: string; value: string; color: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      {name && <Text fw={600}>{name}</Text>}
      <Code c={color} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {value}
      </Code>
    </Group>
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
function syncStatusColor(status: string) {
  switch (status) {
    case "running":
      return "blue";
    case "completed":
    case "succeeded":
      return "teal";
    case "completed_with_errors":
    case "blocked":
      return "orange";
    case "failed":
    case "error":
      return "red";
    case "queued":
    case "pending":
      return "yellow";
    default:
      return "gray";
  }
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
