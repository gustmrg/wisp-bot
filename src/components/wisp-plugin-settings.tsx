import { useEffect, useId, useState, type ReactNode } from "react";
import { GlobeIcon } from "lucide-react";

import {
  PLUGIN_CATALOG,
  WEB_CAPABILITIES,
  isWebProvider,
  type PluginAccess,
  type PluginGrant,
  type PluginId,
  type PluginSettingsView,
  type WebProviders,
} from "../../shared/plugins";
import type { McpAccess, McpGrant, McpSettingsView } from "../../shared/mcp";
import { AccessRow, InitialsBadge, type AccessOption } from "@/components/access-row";
import { PluginLogo } from "@/components/plugin-logo";
import { Button } from "@/components/ui/button";
import { buildAccessRequest, isPluginAvailable, type IntegrationSettingsTarget } from "@/lib/plugin-access";

const ACCESS_OPTIONS = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
] as const;

const MCP_ACCESS_OPTIONS = [
  { value: "none", label: "No access" },
  { value: "use_with_approval", label: "Use with approval" },
] as const;

const MAX_PREVIEW_TOOLS = 6;
const NO_PROVIDERS: WebProviders = { search: null, read: null };

export function WispPluginSettings({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  return <WispAccessForm key={conversationId} conversationId={conversationId} onOpenSettings={onOpenSettings} />;
}

function completeGrants(grants: ReadonlyArray<PluginGrant>): PluginGrant[] {
  return PLUGIN_CATALOG.map(({ id }) => ({
    pluginId: id,
    access: grants.find((grant) => grant.pluginId === id)?.access ?? "none",
  }));
}

function completeMcpGrants(view: McpSettingsView, grants: ReadonlyArray<McpGrant>): McpGrant[] {
  return view.servers.map((server) => ({
    serverId: server.serverId,
    access: grants.find((grant) => grant.serverId === server.serverId)?.access ?? "none",
  }));
}

function sameProviders(left: WebProviders, right: WebProviders): boolean {
  return WEB_CAPABILITIES.every(({ id }) => left[id] === right[id]);
}

/** Opens Settings at a connection, or names the place when no opener is available. */
function SettingsLink({
  target,
  label,
  onOpenSettings,
}: {
  target: IntegrationSettingsTarget;
  label: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  if (!onOpenSettings) return <span>{target.section === "mcp" ? "Settings → MCP servers" : "Settings → Plugins"}</span>;
  return (
    <Button variant="link" size="xs" type="button" className="h-auto p-0" onClick={() => onOpenSettings(target)}>
      {label}
    </Button>
  );
}

function AccessSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <h3 className="font-semibold">{label}</h3>
      <div className="divide-y divide-border rounded-[10px] bg-popover px-3">{children}</div>
    </section>
  );
}

function WispAccessForm({
  conversationId,
  onOpenSettings,
}: {
  conversationId: string;
  onOpenSettings?: (target: IntegrationSettingsTarget) => void;
}) {
  const formId = useId();
  const [settings, setSettings] = useState<PluginSettingsView | null>(null);
  const [grants, setGrants] = useState<ReadonlyArray<PluginGrant>>([]);
  const [savedGrants, setSavedGrants] = useState<ReadonlyArray<PluginGrant>>([]);
  const [providers, setProviders] = useState<WebProviders>(NO_PROVIDERS);
  const [savedProviders, setSavedProviders] = useState<WebProviders>(NO_PROVIDERS);
  const [revision, setRevision] = useState("");
  const [mcpView, setMcpView] = useState<McpSettingsView | null>(null);
  const [mcpGrants, setMcpGrants] = useState<ReadonlyArray<McpGrant>>([]);
  const [savedMcpGrants, setSavedMcpGrants] = useState<ReadonlyArray<McpGrant>>([]);
  const [mcpRevision, setMcpRevision] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed load.
  useEffect(() => {
    let cancelled = false;
    setError("");
    void Promise.all([
      window.wisp.getPluginSettings(),
      window.wisp.getWispPluginAccess({ conversationId }),
      window.wisp.getMcpSettings(),
      window.wisp.getWispMcpAccess({ conversationId }),
    ])
      .then(([plugins, access, mcp, mcpAccess]) => {
        if (cancelled) return;
        if (!plugins.ok) {
          setError(plugins.error.message);
          return;
        }
        if (!access.ok) {
          setError(access.error.message);
          return;
        }
        if (access.value.conversationId !== conversationId) {
          setError("Could not load this Wisp's access settings.");
          return;
        }
        const nextGrants = completeGrants(access.value.grants);
        setSettings(plugins.value);
        setGrants(nextGrants);
        setSavedGrants(nextGrants);
        setProviders(access.value.webProviders);
        setSavedProviders(access.value.webProviders);
        setRevision(access.value.revision);
        if (mcp.ok && mcpAccess.ok && mcpAccess.value.conversationId === conversationId) {
          const nextMcpGrants = completeMcpGrants(mcp.value, mcpAccess.value.grants);
          setMcpView(mcp.value);
          setMcpGrants(nextMcpGrants);
          setSavedMcpGrants(nextMcpGrants);
          setMcpRevision(mcpAccess.value.revision);
        } else if (!mcp.ok) {
          setMcpView({ secureStorageAvailable: true, servers: [] });
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this Wisp's access settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, attempt]);

  const dirty =
    !sameProviders(providers, savedProviders) ||
    grants.some(
      (grant) =>
        !isWebProvider(grant.pluginId) &&
        grant.access !== savedGrants.find((savedGrant) => savedGrant.pluginId === grant.pluginId)?.access,
    );
  const mcpDirty = mcpGrants.some(
    (grant) => grant.access !== savedMcpGrants.find((savedGrant) => savedGrant.serverId === grant.serverId)?.access,
  );

  function changed() {
    setError("");
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      if (dirty) {
        const result = await window.wisp.saveWispPluginAccess(
          buildAccessRequest({ conversationId, revision }, grants, providers),
        );
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const nextGrants = completeGrants(result.value.grants);
        setGrants(nextGrants);
        setSavedGrants(nextGrants);
        setProviders(result.value.webProviders);
        setSavedProviders(result.value.webProviders);
        setRevision(result.value.revision);
      }
      if (mcpDirty && mcpView) {
        const result = await window.wisp.saveWispMcpAccess({
          conversationId,
          grants: mcpGrants,
          revision: mcpRevision,
        });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const nextMcpGrants = completeMcpGrants(mcpView, result.value.grants);
        setMcpGrants(nextMcpGrants);
        setSavedMcpGrants(nextMcpGrants);
        setMcpRevision(result.value.revision);
      }
      setSaved(true);
    } catch {
      setError("Could not save this Wisp's access settings.");
    } finally {
      setSaving(false);
    }
  }

  const loaded = settings !== null && mcpView !== null;
  const plugin = (pluginId: PluginId) => settings?.plugins.find(({ id }) => id === pluginId);
  const available = (pluginId: PluginId) => isPluginAvailable(plugin(pluginId));

  function unavailableNotice(pluginId: PluginId) {
    const connection = plugin(pluginId);
    const name = connection?.name ?? pluginId;
    return (
      <>
        {connection?.configured ? `${name} is disabled for every Wisp.` : `${name} is not connected.`}{" "}
        <SettingsLink
          target={{ section: "plugins", pluginId }}
          label={connection?.configured ? `Manage ${name}` : `Connect ${name}`}
          onOpenSettings={onOpenSettings}
        />{" "}
        You can still remove existing access.
      </>
    );
  }

  const webRows = WEB_CAPABILITIES.flatMap((capability) => {
    const current = providers[capability.id];
    // Saved choices stay listed while unavailable so the row does not vanish mid-edit.
    const saved = savedProviders[capability.id];
    const candidates = PLUGIN_CATALOG.filter(
      ({ id, capabilities }) => capabilities.includes(capability.id) && (available(id) || id === saved),
    );
    if (!candidates.length) return [];
    // The Settings default is listed first so it is the obvious choice.
    const defaultProvider = settings?.defaultProviders[capability.id];
    candidates.sort((left, right) => Number(right.id === defaultProvider) - Number(left.id === defaultProvider));
    const options: AccessOption[] = [
      { value: "none", label: "No access" },
      ...candidates.map(({ id, name }) => ({
        value: id,
        label: id === defaultProvider && candidates.length > 1 ? `${name} (default)` : name,
        disabled: !available(id),
      })),
    ];
    return [
      <AccessRow
        key={capability.id}
        id={`${formId}-web-${capability.id}`}
        icon={
          current ? (
            <PluginLogo pluginId={current} size="sm" />
          ) : (
            <span className="flex size-7 flex-none items-center justify-center rounded-lg bg-muted">
              <GlobeIcon className="size-3.5 text-dim" aria-hidden="true" />
            </span>
          )
        }
        label={capability.name}
        value={current ?? "none"}
        options={options}
        disabled={saving}
        onChange={(value) => {
          setProviders((previous) => ({ ...previous, [capability.id]: value === "none" ? null : (value as PluginId) }));
          changed();
        }}
        notice={saved && !available(saved) ? unavailableNotice(saved) : undefined}
      />,
    ];
  });

  const appRows = PLUGIN_CATALOG.filter(({ id }) => !isWebProvider(id)).flatMap((entry) => {
    const access = grants.find(({ pluginId }) => pluginId === entry.id)?.access ?? "none";
    const savedAccess = savedGrants.find(({ pluginId }) => pluginId === entry.id)?.access ?? "none";
    if (!available(entry.id) && savedAccess === "none") return [];
    return [
      <AccessRow
        key={entry.id}
        id={`${formId}-${entry.id}`}
        icon={<PluginLogo pluginId={entry.id} size="sm" />}
        label={entry.name}
        value={access}
        options={ACCESS_OPTIONS.filter((option) => entry.supportsWrite || option.value !== "write").map((option) => ({
          ...option,
          disabled: !available(entry.id) && option.value !== "none",
        }))}
        disabled={saving}
        onChange={(value) => {
          setGrants((current) =>
            current.map((grant) => (grant.pluginId === entry.id ? { ...grant, access: value as PluginAccess } : grant)),
          );
          changed();
        }}
        notice={!available(entry.id) ? unavailableNotice(entry.id) : undefined}
      />,
    ];
  });

  // Plugins with nothing to choose are summarized in one line instead of a disabled row each.
  const unavailable = PLUGIN_CATALOG.filter(
    ({ id }) => !available(id) && !Object.values(savedProviders).includes(id) && !appRows.some((row) => row.key === id),
  );
  const missingCapabilities = WEB_CAPABILITIES.filter(
    ({ id }) => webRows.length > 0 && !webRows.some((row) => row.key === id),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
        <p className="leading-relaxed text-dim">
          Choose the services this Wisp can use. Every Wisp starts with no access.
        </p>
        {loaded ? (
          <>
            {webRows.length ? (
              <AccessSection label="Web">
                {webRows}
                {missingCapabilities.map(({ id, name }) => (
                  <p key={id} className="py-2.5 leading-relaxed text-dim">
                    {name}: no connected plugin provides this.{" "}
                    <SettingsLink target={{ section: "plugins" }} label="Connect one" onOpenSettings={onOpenSettings} />
                  </p>
                ))}
              </AccessSection>
            ) : null}
            {appRows.length ? <AccessSection label="Apps">{appRows}</AccessSection> : null}
            {unavailable.length ? (
              <p className="leading-relaxed text-dim">
                Unavailable:{" "}
                {unavailable.map(({ id, name }) => (plugin(id)?.configured ? `${name} (turned off)` : name)).join(", ")}
                .{" "}
                <SettingsLink
                  target={{
                    section: "plugins",
                    ...(unavailable.length === 1 ? { pluginId: unavailable[0]!.id } : {}),
                  }}
                  label={unavailable.length === 1 ? `Set up ${unavailable[0]!.name}` : "Set up plugins"}
                  onOpenSettings={onOpenSettings}
                />
              </p>
            ) : null}
            {mcpView.servers.length === 0 ? (
              <section aria-label="MCP servers" className="flex flex-col gap-1.5">
                <h3 className="font-semibold">MCP servers</h3>
                <p className="leading-relaxed text-dim">
                  No MCP servers connected yet.{" "}
                  <SettingsLink target={{ section: "mcp" }} label="Add an MCP server" onOpenSettings={onOpenSettings} />
                </p>
              </section>
            ) : (
              <AccessSection label="MCP servers">
                {mcpView.servers.map((server) => {
                  const serverAvailable = server.enabled && server.state !== "needs_sign_in";
                  const access = mcpGrants.find((grant) => grant.serverId === server.serverId)?.access ?? "none";
                  return (
                    <AccessRow
                      key={server.serverId}
                      id={`${formId}-mcp-${server.serverId}`}
                      icon={<InitialsBadge name={server.name} />}
                      label={server.name}
                      value={access}
                      options={MCP_ACCESS_OPTIONS.map((option) => ({
                        ...option,
                        disabled: !serverAvailable && option.value !== "none",
                      }))}
                      disabled={saving}
                      onChange={(value) => {
                        setMcpGrants((current) =>
                          current.map((grant) =>
                            grant.serverId === server.serverId ? { ...grant, access: value as McpAccess } : grant,
                          ),
                        );
                        changed();
                      }}
                      notice={
                        <>
                          {server.tools.length} reviewed tool{server.tools.length === 1 ? "" : "s"}
                          {access !== "none" && server.tools.length
                            ? `: ${server.tools
                                .slice(0, MAX_PREVIEW_TOOLS)
                                .map(({ label }) => label)
                                .join(", ")}${
                                server.tools.length > MAX_PREVIEW_TOOLS
                                  ? ` + ${server.tools.length - MAX_PREVIEW_TOOLS} more`
                                  : ""
                              }.`
                            : "."}
                          {!serverAvailable ? (
                            <>
                              {" "}
                              {server.state === "needs_sign_in"
                                ? "Sign in to this server first."
                                : "This server is disabled for every Wisp."}{" "}
                              <SettingsLink
                                target={{ section: "mcp" }}
                                label="Manage MCP servers"
                                onOpenSettings={onOpenSettings}
                              />{" "}
                              You can still remove existing access.
                            </>
                          ) : null}
                        </>
                      }
                    />
                  );
                })}
              </AccessSection>
            )}
            <p className="leading-relaxed text-dim">
              MCP tool calls always require approval, with a preview of the arguments. Revoking access blocks new calls
              immediately; calls already in progress may finish.
            </p>
          </>
        ) : error ? (
          <>
            <p role="alert" className="text-destructive">
              {error}
            </p>
            <Button type="button" onClick={() => setAttempt((current) => current + 1)}>
              Retry
            </Button>
          </>
        ) : (
          <p role="status" className="text-dim">
            Loading access settings…
          </p>
        )}
      </div>
      {loaded ? (
        <footer className="flex flex-none flex-col gap-3 border-t border-border p-3.5">
          {error ? (
            <>
              <p role="alert" className="text-destructive">
                {error}
              </p>
              <Button
                variant="secondary"
                type="button"
                disabled={saving}
                onClick={() => {
                  setSettings(null);
                  setGrants([]);
                  setSavedGrants([]);
                  setProviders(NO_PROVIDERS);
                  setSavedProviders(NO_PROVIDERS);
                  setRevision("");
                  setMcpView(null);
                  setMcpGrants([]);
                  setSavedMcpGrants([]);
                  setMcpRevision("");
                  setSaved(false);
                  setAttempt((current) => current + 1);
                }}
              >
                Reload access settings
              </Button>
            </>
          ) : null}
          {saved ? <p role="status">Access settings saved for this Wisp.</p> : null}
          <Button type="button" disabled={(!dirty && !mcpDirty) || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save access"}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
