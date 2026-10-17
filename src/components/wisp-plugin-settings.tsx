import { useEffect, useId, useState, type ReactNode } from "react";
import { FilePenIcon, FilePlusIcon, GlobeIcon, TriangleAlertIcon, XIcon } from "lucide-react";

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
import type { McpAccess, McpGrant, McpServerSummary, McpSettingsView } from "../../shared/mcp";
import { MCP_PRESETS } from "../../shared/mcp-presets";
import { getToolMetadata } from "../../shared/tool-catalog";
import type {
  ToolPolicyBehavior,
  WispToolPolicy,
  WispToolPolicyView,
  WorkspaceFileCategory,
} from "../../shared/tool-policy";
import { AccessRow, McpServerBadge, type AccessOption } from "@/components/access-row";
import { SettingsActions } from "@/components/settings/settings-primitives";
import { PluginLogo } from "@/components/plugin-logo";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { buildAccessRequest, isPluginAvailable, type IntegrationSettingsTarget } from "@/lib/plugin-access";

const ACCESS_OPTIONS = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
  // Write access whose actions never ask; saved as alwaysAllowAll on a "write" grant.
  { value: "write_all", label: "Write without asking" },
] as const;

const MCP_ACCESS_OPTIONS = [
  { value: "none", label: "No access" },
  { value: "use_with_approval", label: "Use with approval" },
  { value: "allow_all", label: "Use without asking" },
] as const;

const FILE_CATEGORIES: ReadonlyArray<{ value: WorkspaceFileCategory; label: string; icon: ReactNode }> = [
  {
    value: "create_file",
    label: "Create files",
    icon: <FilePlusIcon className="size-3.5 text-dim" aria-hidden="true" />,
  },
  { value: "modify_file", label: "Edit files", icon: <FilePenIcon className="size-3.5 text-dim" aria-hidden="true" /> },
];

const BEHAVIOR_LABELS: Record<ToolPolicyBehavior, string> = { allow: "Allow", ask: "Ask", block: "Block" };

const NO_POLICY: WispToolPolicy = { files: {}, allowEverything: false };

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
  return PLUGIN_CATALOG.map(({ id }) => {
    const grant = grants.find((entry) => entry.pluginId === id);
    return {
      pluginId: id,
      access: grant?.access ?? "none",
      alwaysAllowAll: grant?.alwaysAllowAll === true,
      // Left out when there are none, so a save sends a list only to remove from it.
      ...(grant?.alwaysAllowedTools?.length ? { alwaysAllowedTools: grant.alwaysAllowedTools } : {}),
    };
  });
}

function sameList(left: ReadonlyArray<string> = [], right: ReadonlyArray<string> = []): boolean {
  return left.length === right.length && left.every((name) => right.includes(name));
}

function samePluginGrant(left: PluginGrant, right: PluginGrant | undefined): boolean {
  return (
    left.access === right?.access &&
    Boolean(left.alwaysAllowAll) === Boolean(right.alwaysAllowAll) &&
    sameList(left.alwaysAllowedTools, right.alwaysAllowedTools)
  );
}

function samePolicy(left: WispToolPolicy, right: WispToolPolicy): boolean {
  return (
    left.allowEverything === right.allowEverything &&
    FILE_CATEGORIES.every(({ value }) => left.files[value] === right.files[value])
  );
}

function pluginChoice(grant: PluginGrant | undefined): string {
  if (grant?.access === "write" && grant.alwaysAllowAll) return "write_all";
  return grant?.access ?? "none";
}

function completeMcpGrants(view: McpSettingsView, grants: ReadonlyArray<McpGrant>): McpGrant[] {
  return view.servers.map((server) => {
    const grant = grants.find(({ serverId }) => serverId === server.serverId);
    return {
      serverId: server.serverId,
      access: grant?.access ?? "none",
      alwaysAllowedTools: grant?.alwaysAllowedTools ?? [],
    };
  });
}

function sameMcpGrant(left: McpGrant, right: McpGrant | undefined): boolean {
  return left.access === right?.access && sameList(left.alwaysAllowedTools, right?.alwaysAllowedTools);
}

/** Tools a Wisp runs without asking, each a chip that makes it ask again. */
function AlwaysAllowedChips({
  names,
  label,
  disabled,
  onRemove,
}: {
  names: ReadonlyArray<string>;
  label: (name: string) => string;
  disabled: boolean;
  onRemove: (name: string) => void;
}) {
  if (!names.length) return null;
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      Always allowed:
      {names.map((name) => (
        <Button
          key={name}
          type="button"
          size="xs"
          variant="secondary"
          disabled={disabled}
          aria-label={`Ask again before ${label(name)}`}
          title="Ask again before every call"
          onClick={() => onRemove(name)}
        >
          {label(name)}
          <XIcon aria-hidden="true" />
        </Button>
      ))}
    </span>
  );
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
  const [policy, setPolicy] = useState<WispToolPolicy>(NO_POLICY);
  const [savedPolicy, setSavedPolicy] = useState<WispToolPolicy>(NO_POLICY);
  const [policyDefaults, setPolicyDefaults] = useState<WispToolPolicyView["defaults"] | null>(null);
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
      window.wisp.getWispToolPolicy({ conversationId }),
    ])
      .then(([plugins, access, mcp, mcpAccess, wispPolicy]) => {
        if (cancelled) return;
        if (!plugins.ok) {
          setError(plugins.error.message);
          return;
        }
        if (!access.ok) {
          setError(access.error.message);
          return;
        }
        if (!wispPolicy.ok) {
          setError(wispPolicy.error.message);
          return;
        }
        if (access.value.conversationId !== conversationId || wispPolicy.value.conversationId !== conversationId) {
          setError("Could not load this Wisp's access settings.");
          return;
        }
        const { defaults, conversationId: _policyConversation, ...nextPolicy } = wispPolicy.value;
        setPolicy(nextPolicy);
        setSavedPolicy(nextPolicy);
        setPolicyDefaults(defaults);
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
        !samePluginGrant(
          grant,
          savedGrants.find((savedGrant) => savedGrant.pluginId === grant.pluginId),
        ),
    );
  const policyDirty = !samePolicy(policy, savedPolicy);
  const mcpDirty = mcpGrants.some(
    (grant) =>
      !sameMcpGrant(
        grant,
        savedMcpGrants.find((savedGrant) => savedGrant.serverId === grant.serverId),
      ),
  );

  // The footer shows only while there is something to save or report, like the profile's.
  const unsaved = dirty || mcpDirty || policyDirty || saving;

  function changed() {
    setError("");
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      if (policyDirty) {
        const result = await window.wisp.saveWispToolPolicy({ conversationId, ...policy });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const { defaults, conversationId: _policyConversation, ...nextPolicy } = result.value;
        setPolicy(nextPolicy);
        setSavedPolicy(nextPolicy);
        setPolicyDefaults(defaults);
      }
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

  const loaded = settings !== null && mcpView !== null && policyDefaults !== null;
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

  /** One MCP connection; a plugin's connection links to Settings → Plugins instead of MCP servers. */
  function mcpRow(server: McpServerSummary) {
    const serverAvailable = server.enabled && server.state !== "needs_sign_in";
    const grant = mcpGrants.find(({ serverId }) => serverId === server.serverId);
    const access = grant?.access ?? "none";
    const alwaysAllowed = access === "use_with_approval" ? (grant?.alwaysAllowedTools ?? []) : [];
    return (
      <AccessRow
        key={server.serverId}
        id={`${formId}-mcp-${server.serverId}`}
        icon={server.preset ? <PluginLogo pluginId={server.preset} size="sm" /> : <McpServerBadge />}
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
                  server.tools.length > MAX_PREVIEW_TOOLS ? ` + ${server.tools.length - MAX_PREVIEW_TOOLS} more` : ""
                }.`
              : "."}
            {!serverAvailable ? (
              <>
                {" "}
                {server.state === "needs_sign_in"
                  ? "Sign in to this server first."
                  : server.preset
                    ? `${server.name} is disabled for every Wisp.`
                    : "This server is disabled for every Wisp."}{" "}
                <SettingsLink
                  target={server.preset ? { section: "plugins", pluginId: server.preset } : { section: "mcp" }}
                  label={server.preset ? `Manage ${server.name}` : "Manage MCP servers"}
                  onOpenSettings={onOpenSettings}
                />{" "}
                You can still remove existing access.
              </>
            ) : null}
            <AlwaysAllowedChips
              names={alwaysAllowed}
              label={(name) => server.tools.find((tool) => tool.name === name)?.label ?? name}
              disabled={saving}
              onRemove={(name) => {
                setMcpGrants((current) =>
                  current.map((entry) =>
                    entry.serverId === server.serverId
                      ? {
                          ...entry,
                          alwaysAllowedTools: (entry.alwaysAllowedTools ?? []).filter((tool) => tool !== name),
                        }
                      : entry,
                  ),
                );
                changed();
              }}
            />
          </>
        }
      />
    );
  }

  // Connections made from a preset are plugins: listed with the apps, under their logo.
  const presetRows = mcpView?.servers.filter((server) => server.preset).map(mcpRow) ?? [];
  const customServers = mcpView?.servers.filter((server) => !server.preset) ?? [];
  const missingPresets = mcpView
    ? Object.values(MCP_PRESETS).filter(({ id }) => !mcpView.servers.some((server) => server.preset === id))
    : [];

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
    const grant = grants.find(({ pluginId }) => pluginId === entry.id);
    const access = grant?.access ?? "none";
    const savedAccess = savedGrants.find(({ pluginId }) => pluginId === entry.id)?.access ?? "none";
    if (!available(entry.id) && savedAccess === "none") return [];
    const alwaysAllowed = access === "write" && !grant?.alwaysAllowAll ? (grant?.alwaysAllowedTools ?? []) : [];
    return [
      <AccessRow
        key={entry.id}
        id={`${formId}-${entry.id}`}
        icon={<PluginLogo pluginId={entry.id} size="sm" />}
        label={entry.name}
        value={pluginChoice(grant)}
        options={ACCESS_OPTIONS.filter(
          (option) => entry.supportsWrite || (option.value !== "write" && option.value !== "write_all"),
        ).map((option) => ({
          ...option,
          disabled: !available(entry.id) && option.value !== "none",
        }))}
        disabled={saving}
        onChange={(value) => {
          setGrants((current) =>
            current.map((item) =>
              item.pluginId === entry.id
                ? {
                    ...item,
                    access: (value === "write_all" ? "write" : value) as PluginAccess,
                    alwaysAllowAll: value === "write_all",
                  }
                : item,
            ),
          );
          changed();
        }}
        notice={
          !available(entry.id) || alwaysAllowed.length ? (
            <>
              {!available(entry.id) ? unavailableNotice(entry.id) : null}
              <AlwaysAllowedChips
                names={alwaysAllowed}
                label={(name) => getToolMetadata(name)?.label ?? name}
                disabled={saving}
                onRemove={(name) => {
                  setGrants((current) =>
                    current.map((item) =>
                      item.pluginId === entry.id
                        ? {
                            ...item,
                            alwaysAllowedTools: (item.alwaysAllowedTools ?? []).filter((tool) => tool !== name),
                          }
                        : item,
                    ),
                  );
                  changed();
                }}
              />
            </>
          ) : undefined
        }
      />,
    ];
  });

  // Plugins with nothing to choose are summarized in one line instead of a disabled row each.
  const unavailable = PLUGIN_CATALOG.filter(
    ({ id }) => !available(id) && !Object.values(savedProviders).includes(id) && !appRows.some((row) => row.key === id),
  );
  const unavailableEntries = [...unavailable, ...missingPresets];
  const onlyUnavailable = unavailableEntries.length === 1 ? unavailableEntries[0] : undefined;
  const missingCapabilities = WEB_CAPABILITIES.filter(
    ({ id }) => webRows.length > 0 && !webRows.some((row) => row.key === id),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
        <p className="leading-relaxed text-dim">
          Choose the services this Wisp can use. Every Wisp starts with no access.
        </p>
        {loaded ? (
          <>
            <AccessSection label="Without asking">
              <div className="flex flex-col gap-1.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-7 flex-none items-center justify-center rounded-lg bg-muted">
                    <TriangleAlertIcon className="size-3.5 text-warning" aria-hidden="true" />
                  </span>
                  <span id={`${formId}-everything`} className="min-w-0 flex-1 leading-snug font-medium break-words">
                    Allow everything
                  </span>
                  <ToggleSwitch
                    label="Allow everything"
                    checked={policy.allowEverything}
                    disabled={saving}
                    onChange={() => {
                      setPolicy((current) => ({ ...current, allowEverything: !current.allowEverything }));
                      changed();
                    }}
                  />
                </div>
                <p className={policy.allowEverything ? "leading-relaxed text-warning" : "leading-relaxed text-dim"}>
                  {policy.allowEverything
                    ? "Risk mode: this Wisp creates and edits files, writes to connected apps and calls MCP tools, including ones that send workspace files, without asking you first. Block rules still apply, and skills and jobs still need your review."
                    : "Turn on to let this Wisp act on its own: no approval cards for files, apps or MCP tools. Skills and jobs still need your review."}
                </p>
              </div>
              {FILE_CATEGORIES.map((category) => {
                const own = policy.files[category.value];
                return (
                  <AccessRow
                    key={category.value}
                    id={`${formId}-${category.value}`}
                    icon={
                      <span className="flex size-7 flex-none items-center justify-center rounded-lg bg-muted">
                        {category.icon}
                      </span>
                    }
                    label={category.label}
                    value={own ?? "default"}
                    options={[
                      { value: "default", label: `Default (${BEHAVIOR_LABELS[policyDefaults[category.value]]})` },
                      ...(["allow", "ask", "block"] as const).map((value) => ({
                        value,
                        label: BEHAVIOR_LABELS[value],
                      })),
                    ]}
                    disabled={saving}
                    onChange={(value) => {
                      setPolicy((current) => {
                        const files = { ...current.files };
                        if (value === "default") delete files[category.value];
                        else files[category.value] = value as ToolPolicyBehavior;
                        return { ...current, files };
                      });
                      changed();
                    }}
                    notice={
                      policy.allowEverything && own !== "block"
                        ? "Allowed by Allow everything."
                        : own === undefined
                          ? "Follows Settings → General → Auto-review."
                          : undefined
                    }
                  />
                );
              })}
            </AccessSection>
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
            {appRows.length || presetRows.length ? (
              <AccessSection label="Apps">
                {appRows}
                {presetRows}
              </AccessSection>
            ) : null}
            {unavailable.length || missingPresets.length ? (
              <p className="leading-relaxed text-dim">
                Unavailable:{" "}
                {[
                  ...unavailable.map(({ id, name }) => (plugin(id)?.configured ? `${name} (turned off)` : name)),
                  ...missingPresets.map(({ name }) => name),
                ].join(", ")}
                .{" "}
                <SettingsLink
                  target={{ section: "plugins", ...(onlyUnavailable ? { pluginId: onlyUnavailable.id } : {}) }}
                  label={onlyUnavailable ? `Set up ${onlyUnavailable.name}` : "Set up plugins"}
                  onOpenSettings={onOpenSettings}
                />
              </p>
            ) : null}
            {customServers.length === 0 ? (
              <section aria-label="MCP servers" className="flex flex-col gap-1.5">
                <h3 className="font-semibold">MCP servers</h3>
                <p className="leading-relaxed text-dim">
                  No MCP servers connected yet.{" "}
                  <SettingsLink target={{ section: "mcp" }} label="Add an MCP server" onOpenSettings={onOpenSettings} />
                </p>
              </section>
            ) : (
              <AccessSection label="MCP servers">{customServers.map(mcpRow)}</AccessSection>
            )}
            <p className="leading-relaxed text-dim">
              With approval, MCP tool calls ask first, with a preview of the arguments, unless you chose Always allow
              for that tool on an approval card; a tool that changes asks again. Without asking covers every tool of the
              server, including new ones, except calls that send workspace files. Revoking access blocks new calls
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
      {loaded && (unsaved || error || saved) ? (
        <footer className="flex flex-none flex-col gap-3 border-t border-border p-3.5">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {saved ? <p role="status">Access settings saved for this Wisp.</p> : null}
          <SettingsActions align="end">
            {error ? (
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
                  setPolicy(NO_POLICY);
                  setSavedPolicy(NO_POLICY);
                  setPolicyDefaults(null);
                  setSaved(false);
                  setAttempt((current) => current + 1);
                }}
              >
                Reload access settings
              </Button>
            ) : null}
            {unsaved || error ? (
              <Button
                type="button"
                disabled={(!dirty && !mcpDirty && !policyDirty) || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save access"}
              </Button>
            ) : null}
          </SettingsActions>
        </footer>
      ) : null}
    </div>
  );
}
