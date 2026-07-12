import type { FormEvent, ReactElement } from "react";
import { useEffect, useState } from "react";
import type { DashboardDto, DiscoveredResourceDto } from "@teamtales/common/api";
import type { Provider } from "@teamtales/common/domain";
import { apiClient } from "./api";

type Notice = { tone: "success" | "error" | "info"; text: string };
export function ProvidersSection({ dashboard, organizationId, onChanged, onError, onNotice }: { dashboard: DashboardDto | undefined; organizationId: string; onChanged: () => void; onError: (error: unknown) => void; onNotice: (notice: Notice) => void }): ReactElement {
  const [integrationId, setIntegrationId] = useState<string>(); const [provider, setProvider] = useState<Provider>("github"); const [token, setToken] = useState(""); const [displayName, setDisplayName] = useState(""); const [resources, setResources] = useState<DiscoveredResourceDto[]>([]); const [selected, setSelected] = useState<Set<string>>(new Set()); const [filter, setFilter] = useState("");
  const integration = dashboard?.integrations.find(item => item.id === integrationId);
  useEffect(() => {
    if (!integrationId || !organizationId) return;
    void (async () => {
      try {
        const response = await apiClient.listIntegrationResources(integrationId, organizationId);
        setResources(response.resources);
        const scopes = dashboard?.syncScopes.filter(scope => scope.integrationId === integrationId && scope.enabled) ?? [];
        setSelected(new Set(response.resources.filter(resource => scopes.some(scope => scope.scopeType === resource.scopeType && (scope.externalId === resource.externalId || scope.externalName === resource.externalName))).map(key)));
      } catch (error) { onError(error); }
    })();
  }, [dashboard?.syncScopes, integrationId, onError, organizationId]);
  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> { event.preventDefault(); try { const result = await apiClient.addPatIntegration({ organizationId, provider, token, displayName: displayName || undefined }); setToken(""); setDisplayName(""); setIntegrationId(result.id); onChanged(); } catch (error) { onError(error); } }
  async function save(): Promise<void> { if (!integrationId) return; try { await apiClient.setSyncScopeSelection(integrationId, { organizationId, selections: resources.filter(resource => selected.has(key(resource))) }); onChanged(); onNotice({ tone: "success", text: "Provider resource selection saved." }); setIntegrationId(undefined); } catch (error) { onError(error); } }
  const visible = resources.filter(resource => `${resource.externalName} ${resource.group ?? ""} ${resource.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  if (integrationId) return <div className="grid"><section className="panel"><h2>Select resources{integration ? `: ${integration.displayName}` : ""}</h2><label>Filter<input value={filter} onChange={event => setFilter(event.target.value)} /></label>{[...new Set(visible.map(resource => resource.group ?? "Other"))].map(group => { const items = visible.filter(resource => (resource.group ?? "Other") === group); const all = items.every(resource => selected.has(key(resource))); return <fieldset key={group}><legend>{group} <button type="button" onClick={() => setSelected(current => { const next = new Set(current); for (const item of items) all ? next.delete(key(item)) : next.add(key(item)); return next; })}>{all ? "Clear all" : "Select all"}</button></legend>{items.map(resource => <label className="check-row" key={key(resource)}><input type="checkbox" checked={selected.has(key(resource))} onChange={() => setSelected(current => { const next = new Set(current); next.has(key(resource)) ? next.delete(key(resource)) : next.add(key(resource)); return next; })} />{resource.externalName}{resource.description ? ` (${resource.description})` : ""}</label>)}</fieldset>; })}<button type="button" onClick={() => void save()}>Save selection</button> <button type="button" onClick={() => setIntegrationId(undefined)}>Cancel</button></section></div>;
  return <div className="grid two"><section className="panel"><h2>Connect provider</h2><form className="form-grid" onSubmit={event => void connect(event)}><label>Provider<select value={provider} onChange={event => setProvider(event.target.value as Provider)}><option value="github">GitHub</option><option value="linear">Linear</option></select></label><label>Token<input type="password" required value={token} onChange={event => setToken(event.target.value)} /></label><label>Display name (optional)<input value={displayName} onChange={event => setDisplayName(event.target.value)} /></label><p>{provider === "github" ? "Classic PAT: repo + read:org, or a fine-grained token." : "Create a personal API key in Linear Settings > API."}</p><button disabled={!organizationId}>Connect and select resources</button></form></section><section className="panel"><h2>Integrations</h2>{(dashboard?.integrations ?? []).map(item => <div className="meta-row" key={item.id}><strong>{item.provider} / {item.displayName}</strong><span>{dashboard?.syncScopes.filter(scope => scope.integrationId === item.id && scope.enabled).length ?? 0} selected</span><button type="button" onClick={() => setIntegrationId(item.id)}>Edit selection</button></div>) || "No integrations."}</section></div>;
}
function key(resource: DiscoveredResourceDto): string { return `${resource.scopeType}:${resource.externalId}`; }
