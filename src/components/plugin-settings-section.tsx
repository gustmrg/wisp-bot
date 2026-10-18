import { useEffect, useId, useState, type ReactNode } from "react";

import {
  PLUGIN_CATEGORIES,
  WEB_CAPABILITIES,
  pluginCatalogEntry,
  type PluginId,
  type PluginSettingsView,
  type PluginServerAddressInfo,
  type PluginSummary,
  type WebCapability,
} from "../../shared/plugins";
import type { McpServerSummary, McpSettingsView } from "../../shared/mcp";
import { MCP_PRESETS, isMcpPresetId, type McpPreset, type McpPresetId } from "../../shared/mcp-presets";
import { ChevronLeftIcon, ExternalLinkIcon, Plus } from "lucide-react";
import { McpServerForm } from "@/components/mcp-settings-section";
import { countWispsWithMcpAccess, mcpServersKey, useMcpAccessIndex } from "@/components/mcp-wisp-access";
import { ManualSignInForm } from "@/components/manual-sign-in";
import { PluginLogo } from "@/components/plugin-logo";
import {
  PluginWispAccessPanel,
  countWispsWithAccess,
  useWispAccessIndex,
  type WispAccessIndex,
} from "@/components/plugin-wisp-access";
import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
  StatusDot,
  type StatusTone,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { isPluginAvailable, type SettingsPluginId, type WispOption } from "@/lib/plugin-access";

const NO_WISPS: ReadonlyArray<WispOption> = [];

function pluginStatus(plugin: PluginSummary): { tone: StatusTone; label: string } {
  if (!plugin.configured) return { tone: "muted", label: "Not connected" };
  if (plugin.needsSignIn) return { tone: "warning", label: "Needs sign-in" };
  return plugin.enabled
    ? { tone: "success", label: "Connected · enabled" }
    : { tone: "muted", label: "Connected · disabled" };
}

/** What a plugin offers: its web capabilities, or its category for other services. */
function pluginTags(pluginId: PluginId): string[] {
  const entry = pluginCatalogEntry(pluginId);
  if (!entry.capabilities.length) return [PLUGIN_CATEGORIES.find(({ id }) => id === entry.category)?.name ?? ""];
  return WEB_CAPABILITIES.filter(({ id }) => entry.capabilities.includes(id)).map(({ shortName }) => shortName);
}

/** Plugins that run over MCP look like any other plugin; how they connect is not the user's concern. */
function presetTags(preset: McpPreset): string[] {
  return [preset.category];
}

/** The enabled line of a connected card; an MCP connection also reports when it cannot be reached. */
function presetStatus(server: McpServerSummary): { tone: StatusTone; label: string } {
  if (!server.enabled) return { tone: "muted", label: "Disabled" };
  if (server.state === "needs_sign_in") return { tone: "warning", label: "Needs sign-in" };
  if (server.state === "unavailable") return { tone: "danger", label: "Unavailable" };
  return { tone: "success", label: "Enabled" };
}

function PluginTags({ tags }: { tags: ReadonlyArray<string> }) {
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="rounded-full bg-muted px-1.5 py-px text-2xs leading-4 text-dim">
          {tag}
        </span>
      ))}
    </span>
  );
}

export function PluginSettingsSection({
  wisps = NO_WISPS,
  initialPluginId,
  onOpenMcpSettings,
}: {
  wisps?: ReadonlyArray<WispOption>;
  initialPluginId?: SettingsPluginId;
  onOpenMcpSettings?: () => void;
}) {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  /** Connections behind the plugins that run over MCP; null until loaded or when they cannot be. */
  const [mcpView, setMcpView] = useState<McpSettingsView | null>(null);
  /** Drill-in editor for one plugin ID, or null for the plugin list. */
  const [editing, setEditing] = useState<SettingsPluginId | null>(initialPluginId ?? null);
  const [toggling, setToggling] = useState<SettingsPluginId | null>(null);
  const [listError, setListError] = useState("");
  /** Plugin connected in this visit; its manage view prompts for Wisp access. */
  const [justConnected, setJustConnected] = useState<SettingsPluginId | null>(null);
  /** A plugin that signs in through the browser, connected in one step: its sign-in starts when it opens. */
  const [signInOnOpen, setSignInOnOpen] = useState<McpPresetId | null>(null);
  const index = useWispAccessIndex(wisps);
  const mcpIndex = useMcpAccessIndex(wisps, mcpView ? mcpServersKey(mcpView.servers) : "");

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed load.
  useEffect(() => {
    let cancelled = false;
    setError("");
    void window.wisp
      .getPluginSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setView(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load plugins.");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Sign-ins started here or in another window report their progress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reloads the subscription with the view.
  useEffect(() => {
    if (!view) return;
    const unsubscribe = window.wisp.subscribeToPluginSettings((next) => setView(next));
    return () => {
      unsubscribe();
    };
  }, [attempt, Boolean(view)]);

  // MCP plugins load on their own, so a failure there leaves the bundled plugins usable.
  useEffect(() => {
    let cancelled = false;
    void window.wisp
      .getMcpSettings()
      .then((result) => {
        if (!cancelled && result.ok) setMcpView(result.value);
      })
      .catch(() => undefined);
    const unsubscribe = window.wisp.subscribeToMcpSettings((next) => setMcpView(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function togglePreset(server: McpServerSummary) {
    if (!server.preset) return;
    setToggling(server.preset);
    setListError("");
    try {
      // Saving without a credential or headers keeps the saved ones, so access is kept too.
      const result = await window.wisp.saveMcpServer({
        serverId: server.serverId,
        name: server.name,
        endpoint: server.endpoint,
        authMode: server.authMode,
        ...(server.headerName ? { headerName: server.headerName } : {}),
        enabled: !server.enabled,
      });
      if (result.ok) setMcpView(result.value);
      else setListError(result.error.message);
    } catch {
      setListError(`Could not update ${server.name}.`);
    } finally {
      setToggling(null);
    }
  }

  async function toggle(plugin: PluginSummary) {
    setToggling(plugin.id);
    setListError("");
    try {
      const result = await window.wisp.savePluginSettings({ pluginId: plugin.id, enabled: !plugin.enabled });
      if (result.ok) setView(result.value);
      else setListError(result.error.message);
    } catch {
      setListError(`Could not update ${plugin.name}.`);
    } finally {
      setToggling(null);
    }
  }

  // With unreadable credentials nothing reports as configured, but every plugin must stay manageable.
  const connected = (plugin: PluginSummary) => plugin.configured || Boolean(view?.credentialError);
  const editingPlugin = editing ? view?.plugins.find(({ id }) => id === editing) : undefined;
  const presetServer = (presetId: McpPresetId) => mcpView?.servers.find((server) => server.preset === presetId);
  const presets = mcpView ? Object.values(MCP_PRESETS) : [];
  const connectedPresets = presets.filter(({ id }) => presetServer(id));
  const availablePresets = presets.filter(({ id }) => !presetServer(id));
  const editingPreset = editing && isMcpPresetId(editing) && mcpView ? MCP_PRESETS[editing] : undefined;

  return (
    <section
      className="@container overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
      id="plugin-settings-panel"
      aria-labelledby="plugin-settings-title"
    >
      <h2 id="plugin-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Plugins
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Connect services on this device, then choose which Wisps can use them. Connecting a plugin does not give any
        Wisp access automatically.
      </p>
      {view ? (
        <div className="animate-tab-forward">
          {!view.secureStorageAvailable ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              Secure credential storage is unavailable. New API keys cannot be saved on this device.
            </p>
          ) : null}
          {view.credentialError ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {view.credentialError}
            </p>
          ) : null}
          {editingPreset && mcpView ? (
            <McpServerForm
              key={`${editingPreset.id}:${presetServer(editingPreset.id)?.serverId ?? "new"}`}
              server={presetServer(editingPreset.id)}
              newPreset={editingPreset.id}
              backLabel="Back to plugins"
              secureStorageAvailable={mcpView.secureStorageAvailable}
              wisps={wisps}
              index={mcpIndex}
              initialMessage={
                // A sign-in plugin is connected only once its sign-in completes; the form says so then.
                justConnected === editingPreset.id && editingPreset.auth.mode === "header"
                  ? wisps.length
                    ? `Connected to ${editingPreset.name}. Choose which Wisps can use it.`
                    : `Connected to ${editingPreset.name}.`
                  : ""
              }
              signInOnOpen={signInOnOpen === editingPreset.id}
              onSaved={setMcpView}
              onCreated={(next, options) => {
                setJustConnected(editingPreset.id);
                setSignInOnOpen(options?.signIn ? editingPreset.id : null);
                setMcpView(next);
              }}
              onBack={() => {
                setSignInOnOpen(null);
                setEditing(null);
              }}
            />
          ) : editingPlugin ? (
            connected(editingPlugin) ? (
              <PluginManageView
                key={editingPlugin.id}
                plugin={editingPlugin}
                view={view}
                wisps={wisps}
                index={index}
                initialMessage={
                  justConnected === editingPlugin.id
                    ? wisps.length
                      ? `Connected to ${editingPlugin.name}. Choose which Wisps can use it.`
                      : `Connected to ${editingPlugin.name}.`
                    : ""
                }
                onSaved={setView}
                onBack={() => setEditing(null)}
              />
            ) : pluginCatalogEntry(editingPlugin.id).signIn ? (
              <section aria-label={editingPlugin.name} className="flex flex-col gap-2">
                <PluginHeader plugin={editingPlugin} busy={false} onBack={() => setEditing(null)} />
                <PluginSignIn
                  plugin={editingPlugin}
                  secureStorageAvailable={view.secureStorageAvailable}
                  requireClient
                  onSignedIn={(next) => {
                    setJustConnected(editingPlugin.id);
                    setView(next);
                    index.reload();
                  }}
                  onChanged={setView}
                />
              </section>
            ) : (
              <PluginConnectForm
                key={editingPlugin.id}
                plugin={editingPlugin}
                secureStorageAvailable={view.secureStorageAvailable}
                onConnected={(next) => {
                  setJustConnected(editingPlugin.id);
                  setView(next);
                  index.reload();
                }}
                onBack={() => setEditing(null)}
              />
            )
          ) : (
            <>
              {listError ? (
                <p role="alert" className="mb-3 text-xs text-destructive">
                  {listError}
                </p>
              ) : null}
              {view.plugins.some(connected) || connectedPresets.length ? (
                <section aria-label="Connected" className="mb-6">
                  <h3 className="mb-3 mt-2 border-b border-border pb-3 text-md font-medium">Connected</h3>
                  <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                    {view.plugins.filter(connected).map((plugin) => (
                      <ConnectedPluginCard
                        key={plugin.id}
                        pluginId={plugin.id}
                        name={plugin.name}
                        enabled={plugin.enabled}
                        status={
                          plugin.needsSignIn && plugin.enabled
                            ? { tone: "warning", label: "Needs sign-in" }
                            : plugin.enabled
                              ? { tone: "success", label: "Enabled" }
                              : { tone: "muted", label: "Disabled" }
                        }
                        tags={pluginTags(plugin.id)}
                        wispCount={wisps.length ? countWispsWithAccess(index, plugin.id) : undefined}
                        busy={toggling === plugin.id}
                        onToggle={() => void toggle(plugin)}
                        onSelect={() => setEditing(plugin.id)}
                      />
                    ))}
                    {connectedPresets.map((preset) => {
                      const server = presetServer(preset.id)!;
                      return (
                        <ConnectedPluginCard
                          key={preset.id}
                          pluginId={preset.id}
                          name={preset.name}
                          enabled={server.enabled}
                          status={presetStatus(server)}
                          tags={presetTags(preset)}
                          wispCount={wisps.length ? countWispsWithMcpAccess(mcpIndex, server.serverId) : undefined}
                          busy={toggling === preset.id}
                          onToggle={() => void togglePreset(server)}
                          onSelect={() => setEditing(preset.id)}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : null}
              <DefaultProviders view={view} onSaved={setView} />
              {view.plugins.some((plugin) => !connected(plugin)) || availablePresets.length ? (
                <section aria-label="Available" className="mb-6">
                  <h3 className="mb-3 mt-7 border-b border-border pb-3 text-md font-medium">Available</h3>
                  <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                    {view.plugins
                      .filter((plugin) => !connected(plugin))
                      .map((plugin) => (
                        <AvailablePluginCard
                          key={plugin.id}
                          pluginId={plugin.id}
                          name={plugin.name}
                          description={plugin.description}
                          tags={pluginTags(plugin.id)}
                          onSelect={() => setEditing(plugin.id)}
                        />
                      ))}
                    {availablePresets.map((preset) => (
                      <AvailablePluginCard
                        key={preset.id}
                        pluginId={preset.id}
                        name={preset.name}
                        description={preset.description}
                        tags={presetTags(preset)}
                        onSelect={() => setEditing(preset.id)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {onOpenMcpSettings ? (
                <p className="text-xs text-dim">
                  Need a service that is not listed?{" "}
                  <Button variant="link" size="xs" type="button" className="h-auto p-0" onClick={onOpenMcpSettings}>
                    Add an MCP server
                  </Button>
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <Button type="button" onClick={() => setAttempt((current) => current + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <p role="status" className="text-sm text-dim">
          Loading plugins…
        </p>
      )}
    </section>
  );
}

function AvailablePluginCard({
  pluginId,
  name,
  description,
  tags,
  onSelect,
}: {
  pluginId: SettingsPluginId;
  name: string;
  description: ReactNode;
  tags: ReadonlyArray<string>;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Connect ${name}`}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-4 py-4 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PluginLogo pluginId={pluginId} />
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{name}</span>
        <span className="mt-1 block text-sm leading-relaxed text-dim">{description}</span>
        <PluginTags tags={tags} />
      </span>
      <Plus className="size-5 shrink-0 text-dim group-hover:text-foreground" aria-hidden="true" />
    </button>
  );
}

function ConnectedPluginCard({
  pluginId,
  name,
  enabled,
  status,
  tags,
  wispCount,
  busy,
  onToggle,
  onSelect,
}: {
  pluginId: SettingsPluginId;
  name: string;
  enabled: boolean;
  status: { tone: StatusTone; label: string };
  tags: ReadonlyArray<string>;
  wispCount?: number;
  busy: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl px-4 py-4 transition-colors hover:bg-popover">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Manage ${name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PluginLogo pluginId={pluginId} />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{name}</span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-dim">
            <StatusDot tone={status.tone} />
            {status.label}
            {wispCount !== undefined ? ` · ${wispCount === 1 ? "1 Wisp" : `${wispCount} Wisps`} with access` : ""}
          </span>
          <PluginTags tags={tags} />
        </span>
      </button>
      <ToggleSwitch checked={enabled} label={`Enable ${name}`} disabled={busy} onChange={onToggle} />
    </div>
  );
}

/** Lets the user pick which connected provider is suggested first for each web capability. */
function DefaultProviders({
  view,
  onSaved,
}: {
  view: PluginSettingsView;
  onSaved: (view: PluginSettingsView) => void;
}) {
  const formId = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const choices = WEB_CAPABILITIES.map((capability) => ({
    capability,
    providers: view.plugins.filter(
      (plugin) => isPluginAvailable(plugin) && pluginCatalogEntry(plugin.id).capabilities.includes(capability.id),
    ),
  })).filter(({ providers }) => providers.length > 1);
  if (!choices.length) return null;

  async function save(capability: WebCapability, pluginId: PluginId) {
    setSaving(true);
    setError("");
    try {
      const result = await window.wisp.savePluginDefaults({
        defaultProviders: { ...view.defaultProviders, [capability]: pluginId },
      });
      if (result.ok) onSaved(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not save the default provider.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup label="Default web providers" className="mb-6">
      <SettingsCard variant="stacked">
        {choices.map(({ capability, providers }) => (
          <SettingsRow key={capability.id}>
            <SettingsRowCopy>
              <label htmlFor={`${formId}-${capability.id}`}>
                <SettingsRowTitle>{capability.name}</SettingsRowTitle>
              </label>
              <SettingsRowDescription>
                Suggested first in each Wisp's Access tab. Wisps keep the provider they already use.
              </SettingsRowDescription>
            </SettingsRowCopy>
            <Select
              value={view.defaultProviders[capability.id] ?? providers[0]!.id}
              items={providers.map(({ id, name }) => ({ value: id, label: name }))}
              disabled={saving}
              onValueChange={(value) => {
                if (typeof value === "string") void save(capability.id, value as PluginId);
              }}
            >
              <SelectTrigger
                id={`${formId}-${capability.id}`}
                aria-label={`Default for ${capability.name}`}
                className="w-[150px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {providers.map(({ id, name }) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        ))}
      </SettingsCard>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

function PluginHeader({ plugin, busy, onBack }: { plugin: PluginSummary; busy: boolean; onBack: () => void }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" type="button" aria-label="Back to plugins" disabled={busy} onClick={onBack}>
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <PluginLogo pluginId={plugin.id} />
        <h3 className="m-0 text-md font-medium">{plugin.name}</h3>
      </div>
      <p className="mb-1 mt-0 text-xs text-dim">{plugin.description}</p>
    </>
  );
}

function KeyLink({ pluginId }: { pluginId: PluginId }) {
  const entry = pluginCatalogEntry(pluginId);
  return (
    <a
      href={entry.credentialUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
    >
      {entry.serverAddress ? `Create a ${entry.credentialLabel.toLowerCase()}` : `Get a ${entry.name} API key`}
      <ExternalLinkIcon className="size-3" aria-hidden="true" />
    </a>
  );
}

/** The address of the user's own server, for a plugin that connects to one. */
function PluginAddressField({
  id,
  info,
  value,
  disabled,
  onChange,
}: {
  id: string;
  info: PluginServerAddressInfo;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{info.label}</FieldLabel>
      <Input
        id={id}
        type="url"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        placeholder={info.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>{info.help}</FieldDescription>
    </Field>
  );
}

/** First connection: one action that tests the key and saves it only if it works. */
function PluginConnectForm({
  plugin,
  secureStorageAvailable,
  onConnected,
  onBack,
}: {
  plugin: PluginSummary;
  secureStorageAvailable: boolean;
  onConnected: (view: PluginSettingsView) => void;
  onBack: () => void;
}) {
  const formId = useId();
  const [apiKey, setApiKey] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = apiKey.trim();
  const serverAddress = pluginCatalogEntry(plugin.id).serverAddress;
  const endpoint = serverAddress ? { endpoint: address.trim() } : {};
  const ready = Boolean(key && (!serverAddress || address.trim()));

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const tested = await window.wisp.testPluginConnection({ pluginId: plugin.id, apiKey: key, ...endpoint });
      if (!tested.ok) {
        setError(tested.error.message);
        return;
      }
      const result = await window.wisp.savePluginSettings({
        pluginId: plugin.id,
        enabled: true,
        apiKey: key,
        ...endpoint,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setApiKey("");
      onConnected(result.value);
    } catch {
      setError(`Could not connect ${plugin.name}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={plugin.name} className="flex flex-col gap-2">
      <PluginHeader plugin={plugin} busy={busy} onBack={onBack} />
      <form
        className="flex flex-col gap-3 text-xs"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && secureStorageAvailable && !busy) void connect();
        }}
      >
        {serverAddress ? (
          <PluginAddressField
            id={`${formId}-address`}
            info={serverAddress}
            value={address}
            disabled={busy || !secureStorageAvailable}
            onChange={(value) => {
              setAddress(value);
              setError("");
            }}
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${formId}-key`}>{pluginCatalogEntry(plugin.id).credentialLabel}</FieldLabel>
          <Input
            id={`${formId}-key`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            disabled={busy || !secureStorageAvailable}
            placeholder={serverAddress ? "Enter token" : "Enter API key"}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError("");
            }}
          />
          <FieldDescription>
            <KeyLink pluginId={plugin.id} /> · Keys are encrypted on this device and never shown to Wisps.
          </FieldDescription>
        </Field>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={busy || !ready || !secureStorageAvailable}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function PluginManageView({
  plugin,
  view,
  wisps,
  index,
  initialMessage,
  onSaved,
  onBack,
}: {
  plugin: PluginSummary;
  view: PluginSettingsView;
  wisps: ReadonlyArray<WispOption>;
  index: WispAccessIndex;
  initialMessage: string;
  onSaved: (view: PluginSettingsView) => void;
  onBack: () => void;
}) {
  const formId = useId();
  const [apiKey, setApiKey] = useState("");
  const [address, setAddress] = useState(plugin.endpoint ?? "");
  const [replacing, setReplacing] = useState(!plugin.configured);
  const [operation, setOperation] = useState<"toggle" | "test" | "replace" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const key = apiKey.trim();
  const busy = operation !== null;
  const status = pluginStatus(plugin);
  const signIn = pluginCatalogEntry(plugin.id).signIn;
  const serverAddress = pluginCatalogEntry(plugin.id).serverAddress;
  // The address is replaced together with the key, since both identify the account.
  const endpoint = serverAddress ? { endpoint: address.trim() } : {};
  const ready = Boolean(key && (!serverAddress || address.trim()));

  async function run(action: "toggle" | "test" | "replace" | "remove") {
    setOperation(action);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        const result = await window.wisp.testPluginConnection({ pluginId: plugin.id });
        if (result.ok) setMessage(result.value.message);
        else setError(result.error.message);
        return;
      }
      if (action === "replace") {
        const tested = await window.wisp.testPluginConnection({ pluginId: plugin.id, apiKey: key, ...endpoint });
        if (!tested.ok) {
          setError(tested.error.message);
          return;
        }
      }
      const result =
        action === "remove"
          ? await window.wisp.removePlugin({ pluginId: plugin.id })
          : action === "replace"
            ? await window.wisp.savePluginSettings({ pluginId: plugin.id, enabled: true, apiKey: key, ...endpoint })
            : await window.wisp.savePluginSettings({ pluginId: plugin.id, enabled: !plugin.enabled });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (action === "replace") {
        setApiKey("");
        setReplacing(false);
        setMessage("Key replaced. Choose which Wisps can use the new key.");
      }
      // Replacing or removing a key revokes Wisp access, so refresh the per-Wisp choices.
      if (action !== "toggle") index.reload();
      onSaved(result.value);
    } catch {
      setError(
        action === "test"
          ? "Could not test the connection."
          : action === "remove"
            ? "Could not remove the connection."
            : action === "replace"
              ? "Could not replace the key."
              : "Could not update the plugin.",
      );
    } finally {
      setOperation(null);
    }
  }

  return (
    <section aria-label={plugin.name} className="flex flex-col gap-2">
      <PluginHeader plugin={plugin} busy={busy} onBack={onBack} />
      <div className="flex flex-col gap-3 text-xs">
        <p className="flex items-center gap-1.5">
          <StatusDot tone={status.tone} />
          {status.label}
        </p>
        {plugin.endpoint ? <p className="text-dim break-all">{plugin.endpoint}</p> : null}
        <SettingsCard>
          <SettingsRow className="min-h-0">
            <SettingsRowCopy>
              <SettingsRowTitle>Enabled</SettingsRowTitle>
              <SettingsRowDescription>
                Disabling blocks this plugin for every Wisp but keeps their access choices.
              </SettingsRowDescription>
            </SettingsRowCopy>
            <ToggleSwitch
              checked={plugin.enabled}
              label={`Enable ${plugin.name}`}
              disabled={busy}
              onChange={() => void run("toggle")}
            />
          </SettingsRow>
        </SettingsCard>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {isPluginAvailable(plugin) ? (
          <PluginWispAccessPanel plugin={plugin} plugins={view.plugins} wisps={wisps} index={index} />
        ) : null}
        {signIn ? (
          <PluginAccount
            plugin={plugin}
            secureStorageAvailable={view.secureStorageAvailable}
            onSaved={(next) => {
              index.reload();
              onSaved(next);
            }}
            onChanged={onSaved}
          />
        ) : (
          <SettingsGroup label="API key">
            {replacing ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (ready && view.secureStorageAvailable && !busy) void run("replace");
                }}
              >
                {serverAddress ? (
                  <PluginAddressField
                    id={`${formId}-address`}
                    info={serverAddress}
                    value={address}
                    disabled={busy || !view.secureStorageAvailable}
                    onChange={(value) => {
                      setAddress(value);
                      setError("");
                      setMessage("");
                    }}
                  />
                ) : null}
                <Field>
                  <FieldLabel
                    htmlFor={`${formId}-key`}
                  >{`New ${pluginCatalogEntry(plugin.id).credentialLabel}`}</FieldLabel>
                  <Input
                    id={`${formId}-key`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={apiKey}
                    disabled={busy || !view.secureStorageAvailable}
                    placeholder={serverAddress ? "Enter token" : "Enter API key"}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setError("");
                      setMessage("");
                    }}
                  />
                </Field>
                {key && plugin.configured ? (
                  <p className="text-warning">
                    Replacing the key removes {plugin.name} from every Wisp, because the new key may belong to a
                    different account.
                  </p>
                ) : null}
                <p className="text-dim">
                  <KeyLink pluginId={plugin.id} />
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy || !ready || !view.secureStorageAvailable}>
                    {operation === "replace" ? "Testing…" : "Test and replace key"}
                  </Button>
                  {plugin.configured ? (
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setReplacing(false);
                        setApiKey("");
                        setAddress(plugin.endpoint ?? "");
                      }}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" disabled={busy} onClick={() => void run("test")}>
                  {operation === "test" ? "Testing…" : "Test connection"}
                </Button>
                <Button variant="secondary" type="button" disabled={busy} onClick={() => setReplacing(true)}>
                  Replace key
                </Button>
              </div>
            )}
          </SettingsGroup>
        )}
        {plugin.configured ? (
          <div>
            <ConfirmAction
              label="Remove connection"
              confirmLabel="Remove connection"
              pendingLabel="Removing…"
              pending={operation === "remove"}
              disabled={busy}
              description={
                signIn
                  ? `Signs ${plugin.name} out on this device and removes every Wisp's access to it.`
                  : `Removes the saved ${plugin.name} key and every Wisp's access to it.`
              }
              onConfirm={() => void run("remove")}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** A sign-in plugin's account: sign in again, use another OAuth client, or test the connection. */
function PluginAccount({
  plugin,
  secureStorageAvailable,
  onSaved,
  onChanged,
}: {
  plugin: PluginSummary;
  secureStorageAvailable: boolean;
  /** A completed sign-in, which may have changed every Wisp's access. */
  onSaved: (view: PluginSettingsView) => void;
  onChanged: (view: PluginSettingsView) => void;
}) {
  const [replacingClient, setReplacingClient] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function test() {
    setTesting(true);
    setMessage("");
    setError("");
    try {
      const result = await window.wisp.testPluginConnection({ pluginId: plugin.id });
      if (result.ok) setMessage(result.value.message);
      else setError(result.error.message);
    } catch {
      setError("Could not test the connection.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsGroup label="Account">
      <div className="flex flex-col gap-3">
        <p className="m-0">
          {plugin.account ? `Signed in as ${plugin.account}.` : "Signed in."}
          {plugin.needsSignIn ? " Its access expired or was revoked: sign in again to turn it back on." : ""}
        </p>
        {error ? (
          <p role="alert" className="m-0 text-destructive">
            {error}
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {replacingClient ? (
          <p className="m-0 text-warning">
            Signing in with another client or account removes {plugin.name} from every Wisp.
          </p>
        ) : null}
        <PluginSignIn
          key={replacingClient ? "client" : "again"}
          plugin={plugin}
          secureStorageAvailable={secureStorageAvailable}
          requireClient={replacingClient}
          onSignedIn={(next) => {
            setReplacingClient(false);
            setMessage(`Signed in to ${plugin.name}.`);
            onSaved(next);
          }}
          onChanged={onChanged}
          extraActions={
            <>
              <Button
                variant="secondary"
                type="button"
                disabled={testing || plugin.signInPending || plugin.needsSignIn}
                onClick={() => void test()}
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={plugin.signInPending}
                onClick={() => setReplacingClient((current) => !current)}
              >
                {replacingClient ? "Keep the current client" : "Use another OAuth client"}
              </Button>
            </>
          }
        />
      </div>
    </SettingsGroup>
  );
}

/**
 * Signs a plugin in through the browser. With `requireClient` it asks for the
 * user's OAuth client first (the first connection, or a replacement); without
 * it, it signs in again with the saved one. A waiting sign-in started here or
 * in another window can be cancelled, or finished with a pasted address.
 */
function PluginSignIn({
  plugin,
  secureStorageAvailable,
  requireClient,
  onSignedIn,
  onChanged,
  extraActions,
}: {
  plugin: PluginSummary;
  secureStorageAvailable: boolean;
  requireClient: boolean;
  onSignedIn: (view: PluginSettingsView) => void;
  onChanged: (view: PluginSettingsView) => void;
  extraActions?: ReactNode;
}) {
  const formId = useId();
  const entry = pluginCatalogEntry(plugin.id);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const waiting = signingIn || Boolean(plugin.signInPending);
  const clientReady = clientId.trim() !== "" && clientSecret.trim() !== "";

  async function signIn() {
    if (waiting) return;
    setSigningIn(true);
    setError("");
    setMessage("");
    try {
      const result = await window.wisp.startPluginSignIn({
        pluginId: plugin.id,
        ...(requireClient ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : {}),
      });
      if (result.ok) {
        setClientSecret("");
        onSignedIn(result.value);
      } else if (result.error.code === "aborted") setMessage(result.error.message);
      else setError(result.error.message);
    } catch {
      setError("Sign-in did not complete.");
    } finally {
      setSigningIn(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    try {
      const result = await window.wisp.cancelPluginSignIn({ pluginId: plugin.id });
      if (result.ok) onChanged(result.value);
    } catch {
      // The waiting sign-in reports the outcome either way.
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <form
        aria-label={requireClient ? `Connect ${plugin.name}` : `Sign in to ${plugin.name}`}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!requireClient || clientReady) void signIn();
        }}
      >
        {requireClient ? (
          <>
            <p className="m-0 text-dim">
              {entry.signIn?.clientHelp}{" "}
              <a
                href={entry.signIn?.setupUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                Setup guide
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </a>
            </p>
            <Field>
              <FieldLabel htmlFor={`${formId}-client-id`}>Client ID</FieldLabel>
              <Input
                id={`${formId}-client-id`}
                value={clientId}
                disabled={waiting || !secureStorageAvailable}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-client-secret`}>Client secret</FieldLabel>
              <Input
                id={`${formId}-client-secret`}
                type="password"
                value={clientSecret}
                disabled={waiting || !secureStorageAvailable}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => {
                  setClientSecret(event.target.value);
                  setError("");
                }}
              />
              <FieldDescription>
                <a
                  href={entry.credentialUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  Open {entry.credentialLabel}
                  <ExternalLinkIcon className="size-3" aria-hidden="true" />
                </a>{" "}
                · Encrypted on this device and never shown to Wisps.
              </FieldDescription>
            </Field>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="m-0 text-destructive">
            {error}
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant={requireClient || plugin.needsSignIn ? "default" : "secondary"}
            disabled={waiting || !secureStorageAvailable || (requireClient && !clientReady)}
          >
            {waiting ? "Waiting for browser…" : requireClient ? "Connect" : "Sign in again"}
          </Button>
          {waiting ? (
            <Button variant="secondary" type="button" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? "Cancelling…" : "Cancel sign-in"}
            </Button>
          ) : null}
          {extraActions}
        </div>
      </form>
      {plugin.signInUrl ? (
        <ManualSignInForm
          signInUrl={plugin.signInUrl}
          onFinish={async (redirectUrl) => {
            const result = await window.wisp.finishPluginSignIn({ pluginId: plugin.id, redirectUrl });
            if (!result.ok) return result.error.message;
            onChanged(result.value);
            return undefined;
          }}
        />
      ) : null}
    </div>
  );
}
