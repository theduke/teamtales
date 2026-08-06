import type { FormEvent, ReactElement } from "react";
import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconPlugConnected, IconSearch } from "@tabler/icons-react";
import type { DashboardDto, GitHubDiscoveryDto, LinearDiscoveryDto } from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";
import { apiClient } from "./api";
type Notice = { tone: "success" | "error" | "info"; text: string };

export function ProvidersSection({
  dashboard,
  organizationId,
  onChanged,
  onError,
  onNotice,
}: {
  dashboard: DashboardDto | undefined;
  organizationId: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
  onNotice: (notice: Notice) => void;
}): ReactElement {
  const [integrationId, setIntegrationId] = useState<string>();
  const [provider, setProvider] = useState<Provider>("github");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [discovery, setDiscovery] = useState<GitHubDiscoveryDto | LinearDiscoveryDto>();
  const [filter, setFilter] = useState("");
  const [githubModes, setGithubModes] = useState<Map<string, "all" | "selected">>(new Map());
  const [repositoryIds, setRepositoryIds] = useState<Set<string>>(new Set());
  const [linearMode, setLinearMode] = useState<"all" | "selected">("all");
  const [teamIds, setTeamIds] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const integration = dashboard?.integrations.find((item) => item.id === integrationId);
  useEffect(() => {
    if (!integrationId) return;
    setDiscovery(undefined);
    void apiClient
      .listIntegrationResources(integrationId, organizationId)
      .then((response) => {
        setDiscovery(response.discovery);
        const scopes =
          dashboard?.syncScopes.filter(
            (scope) => scope.integrationId === integrationId && scope.enabled,
          ) ?? [];
        if (response.provider === "github") {
          setGithubModes(
            new Map(
              scopes
                .filter((scope) => scope.scopeType === "github.organization")
                .map((scope) => [scope.externalId, scope.selectionMode as "all" | "selected"]),
            ),
          );
          setRepositoryIds(
            new Set(
              scopes
                .filter((scope) => scope.scopeType === "github.repository")
                .map((scope) => scope.externalId),
            ),
          );
        } else {
          const workspace = scopes.find((scope) => scope.scopeType === "linear.workspace");
          setLinearMode(workspace?.selectionMode === "selected" ? "selected" : "all");
          setTeamIds(
            new Set(
              scopes
                .filter((scope) => scope.scopeType === "linear.team")
                .map((scope) => scope.externalId),
            ),
          );
        }
      })
      .catch(onError);
  }, [dashboard?.syncScopes, integrationId, onError, organizationId]);
  const toggle = (id: string, values: Set<string>, set: (value: Set<string>) => void) => {
    const next = new Set(values);
    next.has(id) ? next.delete(id) : next.add(id);
    set(next);
  };
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (connecting || !organizationId) return;
    setConnecting(true);
    try {
      const result = await apiClient.addPatIntegration({
        organizationId,
        provider,
        token,
        displayName: displayName || undefined,
      });
      setToken("");
      setDisplayName("");
      setIntegrationId(result.id);
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setConnecting(false);
    }
  }
  const hasEmptySelectedScope =
    discovery && "organizations" in discovery
      ? [...githubModes].some(
          ([organizationId, mode]) =>
            mode === "selected" &&
            !discovery.repositories.some(
              (repository) =>
                repository.organizationId === organizationId && repositoryIds.has(repository.id),
            ),
        )
      : discovery && "workspace" in discovery && linearMode === "selected" && teamIds.size === 0;
  async function save() {
    if (!integrationId || !discovery || saving) return;
    if (hasEmptySelectedScope) {
      onNotice({
        tone: "error",
        text: "Choose at least one resource for every selected scope before saving.",
      });
      return;
    }
    setSaving(true);
    try {
      if ("organizations" in discovery) {
        await apiClient.setSyncScopeSelection(integrationId, {
          organizationId,
          selection: {
            organizations: [...githubModes].map(([organizationId, mode]) =>
              mode === "all"
                ? { organizationId, mode }
                : {
                    organizationId,
                    mode,
                    repositoryIds: discovery.repositories
                      .filter(
                        (repo) =>
                          repo.organizationId === organizationId && repositoryIds.has(repo.id),
                      )
                      .map((repo) => repo.id),
                  },
            ),
            repositoryIds: discovery.repositories
              .filter((repo) => !repo.organizationId && repositoryIds.has(repo.id))
              .map((repo) => repo.id),
          },
        });
      } else if ("workspace" in discovery) {
        await apiClient.setSyncScopeSelection(integrationId, {
          organizationId,
          selection:
            linearMode === "all" ? { mode: "all" } : { mode: "selected", teamIds: [...teamIds] },
        });
      }
      onChanged();
      onNotice({ tone: "success", text: "Provider scopes saved." });
      setIntegrationId(undefined);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }
  if (integrationId)
    return (
      <Stack>
        <Group justify="space-between">
          <Box>
            <Title order={1}>Configure scopes</Title>
            <Text c="dimmed">
              {integration ? integration.displayName : "Loading integration resources"}
            </Text>
          </Box>
          <Button variant="subtle" onClick={() => setIntegrationId(undefined)}>
            Back to providers
          </Button>
        </Group>
        {!discovery ? (
          <Alert color="blue">Loading available resources…</Alert>
        ) : (
          <Card withBorder radius="md" padding="lg">
            <Stack>
              <TextInput
                label="Search resources"
                leftSection={<IconSearch size={16} />}
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
              {"organizations" in discovery ? (
                <GitHubScopes
                  discovery={discovery}
                  filter={filter}
                  modes={githubModes}
                  setModes={setGithubModes}
                  repositoryIds={repositoryIds}
                  setRepositoryIds={setRepositoryIds}
                />
              ) : (
                <LinearScopes
                  discovery={discovery}
                  filter={filter}
                  mode={linearMode}
                  setMode={setLinearMode}
                  teamIds={teamIds}
                  setTeamIds={setTeamIds}
                />
              )}
              {hasEmptySelectedScope && (
                <Alert color="yellow" variant="light">
                  Selected scopes need at least one resource. Choose a repository or team, or switch the
                  scope back to all resources.
                </Alert>
              )}
              <Group justify="flex-end">
                <Button variant="default" disabled={saving} onClick={() => setIntegrationId(undefined)}>
                  Cancel
                </Button>
                <Button loading={saving} disabled={hasEmptySelectedScope} onClick={() => void save()}>
                  Save scopes
                </Button>
              </Group>
            </Stack>
          </Card>
        )}
      </Stack>
    );
  const integrations = dashboard?.integrations ?? [];
  return (
    <Stack>
      <Box>
        <Title order={1}>Providers</Title>
        <Text c="dimmed">Connect data sources, then decide exactly what TeamTales can sync.</Text>
      </Box>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder radius="md" padding="lg">
          <Title order={2} size="h4" mb="md">
            Connect provider
          </Title>
          <form onSubmit={(event) => void connect(event)}>
            <Stack>
              <NativeSelect
                label="Provider"
                value={provider}
                onChange={(event) => setProvider(event.currentTarget.value as Provider)}
                data={["github", "linear"]}
              />
              <TextInput
                label="Access token"
                type="password"
                required
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
              />
              <TextInput
                label="Display name"
                description="Optional, helps your team identify this connection."
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
              <Alert color="blue" variant="light">
                {provider === "github"
                  ? "GitHub tokens need repository and organization access."
                  : "Create a personal API key in Linear Settings → API."}
              </Alert>
              <Button
                type="submit"
                loading={connecting}
                disabled={!organizationId}
                leftSection={<IconPlugConnected size={16} />}
              >
                Connect and choose scopes
              </Button>
            </Stack>
          </form>
        </Card>
        <Card withBorder radius="md" padding="lg">
          <Title order={2} size="h4" mb="md">
            Connected integrations
          </Title>
          <Stack gap="sm">
            {integrations.length === 0 ? (
              <Text c="dimmed" size="sm">
                No integrations connected yet.
              </Text>
            ) : (
              integrations.map((item) => (
                <Paper key={item.id} withBorder p="sm">
                  <Group justify="space-between" wrap="nowrap">
                    <Box>
                      <Group gap="xs">
                        <Text fw={600}>{item.displayName}</Text>
                        <Badge variant="light">{item.provider}</Badge>
                      </Group>
                      <Text size="xs" c="dimmed">
                        {item.status}
                      </Text>
                    </Box>
                    <Button size="xs" variant="light" onClick={() => setIntegrationId(item.id)}>
                      Edit scopes
                    </Button>
                  </Group>
                </Paper>
              ))
            )}
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
function GitHubScopes({
  discovery,
  filter,
  modes,
  setModes,
  repositoryIds,
  setRepositoryIds,
}: {
  discovery: GitHubDiscoveryDto;
  filter: string;
  modes: Map<string, "all" | "selected">;
  setModes: (value: Map<string, "all" | "selected">) => void;
  repositoryIds: Set<string>;
  setRepositoryIds: (value: Set<string>) => void;
}) {
  const update = (id: string, value: "all" | "selected") => setModes(new Map(modes).set(id, value));
  const toggle = (id: string) => {
    const next = new Set(repositoryIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setRepositoryIds(next);
  };
  return (
    <Stack gap="md">
      {discovery.organizations.map((org) => {
        const mode = modes.get(org.id) ?? "all";
        const repositories = discovery.repositories.filter(
          (repo) =>
            repo.organizationId === org.id &&
            repo.fullName.toLowerCase().includes(filter.toLowerCase()),
        );
        return (
          <Paper key={org.id} withBorder p="md">
            <Text fw={600} mb="xs">
              {org.name ?? org.login}
            </Text>
            <Radio.Group
              value={mode}
              onChange={(value) => update(org.id, value as "all" | "selected")}
            >
              <Group>
                <Radio value="all" label="All repositories" />
                <Radio value="selected" label="Selected repositories" />
              </Group>
            </Radio.Group>
            {mode === "selected" && (
              <Stack mt="sm" gap={4}>
                {repositories.map((repo) => (
                  <Checkbox
                    key={repo.id}
                    label={repo.fullName}
                    checked={repositoryIds.has(repo.id)}
                    onChange={() => toggle(repo.id)}
                  />
                ))}
              </Stack>
            )}
          </Paper>
        );
      })}
      <Paper withBorder p="md">
        <Text fw={600} mb="sm">
          Other repositories
        </Text>
        <Stack gap={4}>
          {discovery.repositories
            .filter(
              (repo) =>
                !repo.organizationId && repo.fullName.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((repo) => (
              <Checkbox
                key={repo.id}
                label={repo.fullName}
                checked={repositoryIds.has(repo.id)}
                onChange={() => toggle(repo.id)}
              />
            ))}
        </Stack>
      </Paper>
    </Stack>
  );
}
function LinearScopes({
  discovery,
  filter,
  mode,
  setMode,
  teamIds,
  setTeamIds,
}: {
  discovery: LinearDiscoveryDto;
  filter: string;
  mode: "all" | "selected";
  setMode: (value: "all" | "selected") => void;
  teamIds: Set<string>;
  setTeamIds: (value: Set<string>) => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(teamIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setTeamIds(next);
  };
  return (
    <Stack>
      <Text fw={600}>{discovery.workspace.name}</Text>
      <Radio.Group value={mode} onChange={(value) => setMode(value as "all" | "selected")}>
        <Group>
          <Radio value="all" label="All teams" />
          <Radio value="selected" label="Selected teams" />
        </Group>
      </Radio.Group>
      {mode === "selected" && (
        <Stack>
          {discovery.teams
            .filter((team) =>
              `${team.name} ${team.key}`.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((team) => (
              <Checkbox
                key={team.id}
                label={`${team.name} (${team.key})`}
                checked={teamIds.has(team.id)}
                onChange={() => toggle(team.id)}
              />
            ))}
        </Stack>
      )}
    </Stack>
  );
}
