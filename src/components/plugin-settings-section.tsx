import { useEffect, useId, useState } from "react";

import {
  PLUGIN_CATEGORIES,
  WEB_CAPABILITIES,
  pluginCatalogEntry,
  type PluginId,
  type PluginSettingsView,
  type PluginSummary,
  type WebCapability,
} from "../../shared/plugins";
import { ChevronLeftIcon, ExternalLinkIcon, Plus } from "lucide-react";
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
  StatusDot,
  type StatusTone,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { isPluginAvailable, type WispOption } from "@/lib/plugin-access";

const NO_WISPS: ReadonlyArray<WispOption> = [];

function pluginStatus(plugin: PluginSummary): { tone: StatusTone; label: string } {
  if (!plugin.configured) return { tone: "muted", label: "Not connected" };
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

function PluginTags({ pluginId }: { pluginId: PluginId }) {
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {pluginTags(pluginId).map((tag) => (
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
  initialPluginId?: PluginId;
  onOpenMcpSettings?: () => void;
}) {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  /** Drill-in editor for one plugin ID, or null for the plugin list. */
  const [editing, setEditing] = useState<PluginId | null>(initialPluginId ?? null);
  const [toggling, setToggling] = useState<PluginId | null>(null);
  const [listError, setListError] = useState("");
  /** Plugin connected in this visit; its manage view prompts for Wisp access. */
  const [justConnected, setJustConnected] = useState<PluginId | null>(null);
  const index = useWispAccessIndex(wisps);

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
          {editingPlugin ? (
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
              {view.plugins.some(connected) ? (
                <section aria-label="Connected" className="mb-6">
                  <h3 className="mb-3 mt-2 border-b border-border pb-3 text-md font-medium">Connected</h3>
                  <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                    {view.plugins.filter(connected).map((plugin) => (
                      <ConnectedPluginCard
                        key={plugin.id}
                        plugin={plugin}
                        wispCount={wisps.length ? countWispsWithAccess(index, plugin.id) : undefined}
                        busy={toggling === plugin.id}
                        onToggle={() => void toggle(plugin)}
                        onSelect={() => setEditing(plugin.id)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              <DefaultProviders view={view} onSaved={setView} />
              {view.plugins.some((plugin) => !connected(plugin)) ? (
                <section aria-label="Available" className="mb-6">
                  <h3 className="mb-3 mt-7 border-b border-border pb-3 text-md font-medium">Available</h3>
                  <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                    {view.plugins
                      .filter((plugin) => !connected(plugin))
                      .map((plugin) => (
                        <button
                          key={plugin.id}
                          type="button"
                          onClick={() => setEditing(plugin.id)}
                          aria-label={`Connect ${plugin.name}`}
                          className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-4 py-4 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <PluginLogo pluginId={plugin.id} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-base font-medium">{plugin.name}</span>
                            <span className="mt-1 block text-sm leading-relaxed text-dim">{plugin.description}</span>
                            <PluginTags pluginId={plugin.id} />
                          </span>
                          <Plus className="size-5 shrink-0 text-dim group-hover:text-foreground" aria-hidden="true" />
                        </button>
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

function ConnectedPluginCard({
  plugin,
  wispCount,
  busy,
  onToggle,
  onSelect,
}: {
  plugin: PluginSummary;
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
        aria-label={`Manage ${plugin.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PluginLogo pluginId={plugin.id} />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{plugin.name}</span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-dim">
            <StatusDot tone={plugin.enabled ? "success" : "muted"} />
            {plugin.enabled ? "Enabled" : "Disabled"}
            {wispCount !== undefined ? ` · ${wispCount === 1 ? "1 Wisp" : `${wispCount} Wisps`} with access` : ""}
          </span>
          <PluginTags pluginId={plugin.id} />
        </span>
      </button>
      <ToggleSwitch checked={plugin.enabled} label={`Enable ${plugin.name}`} disabled={busy} onChange={onToggle} />
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
                <strong>{capability.name}</strong>
              </label>
              <small>Suggested first in each Wisp's Access tab. Wisps keep the provider they already use.</small>
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
      Get a {entry.name} API key
      <ExternalLinkIcon className="size-3" aria-hidden="true" />
    </a>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = apiKey.trim();

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const tested = await window.wisp.testPluginConnection({ pluginId: plugin.id, apiKey: key });
      if (!tested.ok) {
        setError(tested.error.message);
        return;
      }
      const result = await window.wisp.savePluginSettings({ pluginId: plugin.id, enabled: true, apiKey: key });
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
          if (key && secureStorageAvailable && !busy) void connect();
        }}
      >
        <label htmlFor={`${formId}-key`} className="flex flex-col gap-1.5">
          <strong>{pluginCatalogEntry(plugin.id).credentialLabel}</strong>
          <Input
            id={`${formId}-key`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            disabled={busy || !secureStorageAvailable}
            placeholder="Enter API key"
            onChange={(event) => {
              setApiKey(event.target.value);
              setError("");
            }}
          />
        </label>
        <p className="text-dim">
          <KeyLink pluginId={plugin.id} /> · Keys are encrypted on this device and never shown to Wisps.
        </p>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={busy || !key || !secureStorageAvailable}>
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
  const [replacing, setReplacing] = useState(!plugin.configured);
  const [operation, setOperation] = useState<"toggle" | "test" | "replace" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const key = apiKey.trim();
  const busy = operation !== null;
  const status = pluginStatus(plugin);

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
        const tested = await window.wisp.testPluginConnection({ pluginId: plugin.id, apiKey: key });
        if (!tested.ok) {
          setError(tested.error.message);
          return;
        }
      }
      const result =
        action === "remove"
          ? await window.wisp.removePlugin({ pluginId: plugin.id })
          : action === "replace"
            ? await window.wisp.savePluginSettings({ pluginId: plugin.id, enabled: true, apiKey: key })
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
        <SettingsCard>
          <SettingsRow className="min-h-0">
            <SettingsRowCopy>
              <strong>Enabled</strong>
              <small>Disabling blocks this plugin for every Wisp but keeps their access choices.</small>
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
        <SettingsGroup label="API key">
          {replacing ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (key && view.secureStorageAvailable && !busy) void run("replace");
              }}
            >
              <label htmlFor={`${formId}-key`} className="flex flex-col gap-1.5">
                <strong>{`New ${pluginCatalogEntry(plugin.id).credentialLabel}`}</strong>
                <Input
                  id={`${formId}-key`}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={apiKey}
                  disabled={busy || !view.secureStorageAvailable}
                  placeholder="Enter API key"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setError("");
                    setMessage("");
                  }}
                />
              </label>
              {key && plugin.configured ? (
                <p className="text-warning">
                  Replacing the key removes {plugin.name} from every Wisp, because the new key may belong to a different
                  account.
                </p>
              ) : null}
              <p className="text-dim">
                <KeyLink pluginId={plugin.id} />
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !key || !view.secureStorageAvailable}>
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
        {plugin.configured ? (
          <div>
            <ConfirmAction
              label="Remove connection"
              confirmLabel="Remove connection"
              pendingLabel="Removing…"
              pending={operation === "remove"}
              disabled={busy}
              description={`Removes the saved ${plugin.name} key and every Wisp's access to it.`}
              onConfirm={() => void run("remove")}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
