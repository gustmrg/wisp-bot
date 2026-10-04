import { useEffect, useId, useState } from "react";

import { PLUGIN_CATEGORIES, PLUGIN_CATALOG, type PluginSettingsView, type PluginSummary } from "../../shared/plugins";
import { ChevronLeftIcon, Plus, Settings2 } from "lucide-react";
import { PluginLogo } from "@/components/plugin-logo";
import {
  ConfirmAction,
  SettingsCard,
  SettingsRow,
  SettingsRowCopy,
  StatusDot,
  type StatusTone,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

function pluginStatus(plugin: PluginSummary): { tone: StatusTone; label: string } | null {
  if (!plugin.configured) return null;
  return plugin.enabled ? { tone: "success", label: "Connected" } : { tone: "muted", label: "Disabled" };
}

export function PluginSettingsSection() {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  /** Drill-in editor for one plugin ID, or null for the plugin list. */
  const [editing, setEditing] = useState<string | null>(null);

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

  return (
    <section
      className="@container overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
      id="plugin-settings-panel"
      aria-labelledby="plugin-settings-title"
    >
      <h2 id="plugin-settings-title" className="mb-1 mt-0 text-[17px]">
        Plugins
      </h2>
      <p className="mb-4 text-[11.5px] leading-relaxed text-dim">
        Connect services on this device, then choose access in each Wisp's Access tab. Connecting a plugin does not give
        any Wisp access automatically.
      </p>
      {view ? (
        <>
          {!view.secureStorageAvailable ? (
            <p role="alert" className="mb-3 text-[11.5px] text-destructive">
              Secure credential storage is unavailable. New API keys cannot be saved on this device.
            </p>
          ) : null}
          {view.credentialError ? (
            <p role="alert" className="mb-3 text-[11.5px] text-destructive">
              {view.credentialError}
            </p>
          ) : null}
          {editing && view.plugins.some(({ id }) => id === editing) ? (
            <PluginConnectionForm
              key={editing}
              plugin={view.plugins.find(({ id }) => id === editing) as PluginSummary}
              secureStorageAvailable={view.secureStorageAvailable}
              credentialsUnavailable={Boolean(view.credentialError)}
              onSaved={setView}
              onBack={() => setEditing(null)}
            />
          ) : (
            PLUGIN_CATEGORIES.map((category) => (
              <section key={category.id} aria-label={category.name} className="mb-6">
                <h3 className="mb-3 mt-7 border-b border-border pb-3 text-[15px] font-medium">{category.name}</h3>
                <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                  {view.plugins
                    .filter((plugin) => PLUGIN_CATALOG.find(({ id }) => id === plugin.id)?.category === category.id)
                    .map((plugin) => (
                      <PluginCard
                        key={plugin.id}
                        plugin={plugin}
                        manageable={plugin.configured || Boolean(view.credentialError)}
                        onSelect={() => setEditing(plugin.id)}
                      />
                    ))}
                </div>
              </section>
            ))
          )}
        </>
      ) : error ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-[11.5px] text-destructive">
            {error}
          </p>
          <Button type="button" onClick={() => setAttempt((current) => current + 1)}>
            Retry
          </Button>
        </div>
      ) : (
        <p role="status" className="text-xs text-dim">
          Loading plugins…
        </p>
      )}
    </section>
  );
}

function PluginCard({
  plugin,
  manageable,
  onSelect,
}: {
  plugin: PluginSummary;
  manageable: boolean;
  onSelect: () => void;
}) {
  const status = pluginStatus(plugin);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${manageable ? "Manage" : "Connect"} ${plugin.name}`}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-4 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PluginLogo pluginId={plugin.id} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{plugin.name}</span>
        <span className="mt-1 block text-[12px] leading-relaxed text-dim">{plugin.description}</span>
        {status ? (
          <span className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-dim">
            <StatusDot tone={status.tone} />
            {status.label}
          </span>
        ) : null}
      </span>
      {manageable ? (
        <Settings2 className="size-5 shrink-0 text-dim" aria-hidden="true" />
      ) : (
        <Plus className="size-5 shrink-0 text-dim group-hover:text-foreground" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Connect/manage form for one plugin, rendered in place of the plugin list
 * like the MCP server form, instead of stacking a second dialog.
 */
function PluginConnectionForm({
  plugin,
  secureStorageAvailable,
  credentialsUnavailable,
  onSaved,
  onBack,
}: {
  plugin: PluginSummary;
  secureStorageAvailable: boolean;
  credentialsUnavailable: boolean;
  onSaved: (view: PluginSettingsView) => void;
  onBack: () => void;
}) {
  const formId = useId();
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(plugin.configured || credentialsUnavailable ? plugin.enabled : true);
  const [operation, setOperation] = useState<"save" | "test" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const key = apiKey.trim();
  const hasKey = plugin.configured || Boolean(key);
  const busy = operation !== null;
  const status = pluginStatus(plugin);

  async function run(action: "save" | "test" | "remove") {
    setOperation(action);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        const result = await window.wisp.testPluginConnection({ pluginId: plugin.id, ...(key ? { apiKey: key } : {}) });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setMessage(`${result.value.message}${key ? " Save to use this key." : ""}`);
      } else {
        const result =
          action === "save"
            ? await window.wisp.savePluginSettings({ pluginId: plugin.id, enabled, ...(key ? { apiKey: key } : {}) })
            : await window.wisp.removePlugin({ pluginId: plugin.id });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setApiKey("");
        const connection = result.value.plugins.find(({ id }) => id === plugin.id);
        setEnabled(action === "save" ? (connection?.enabled ?? false) : true);
        setMessage(action === "save" ? "Plugin settings saved." : "Connection removed.");
        onSaved(result.value);
      }
    } catch {
      setError(
        action === "test"
          ? "Could not test the connection."
          : action === "remove"
            ? "Could not remove the connection."
            : "Could not save plugin settings.",
      );
    } finally {
      setOperation(null);
    }
  }

  return (
    <section aria-label={plugin.name} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" type="button" aria-label="Back to plugins" disabled={busy} onClick={onBack}>
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <PluginLogo pluginId={plugin.id} />
        <h3 className="m-0 text-[15px] font-medium">{plugin.name}</h3>
      </div>
      <p className="mb-1 mt-0 text-[11.5px] text-dim">{plugin.description}</p>
      <div className="flex flex-col gap-3 text-[11.5px]">
        <p className="flex items-center gap-1.5">
          <StatusDot tone={status?.tone ?? "muted"} />
          {plugin.configured ? (plugin.enabled ? "Connected · enabled" : "Connected · disabled") : "Not connected"}
        </p>
        <label htmlFor={`${formId}-key`} className="flex flex-col gap-1.5">
          <strong>{PLUGIN_CATALOG.find(({ id }) => id === plugin.id)?.credentialLabel}</strong>
          <Input
            id={`${formId}-key`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            disabled={busy || !secureStorageAvailable}
            placeholder={plugin.configured ? "Saved — enter a replacement" : "Enter API key"}
            onChange={(event) => {
              setApiKey(event.target.value);
              setError("");
              setMessage("");
            }}
          />
        </label>
        <p className="text-dim">
          {plugin.configured ? "Leave blank to keep the saved key. " : ""}
          Keys are encrypted on this device and never shown to Wisps.
        </p>
        <SettingsCard>
          <SettingsRow className="min-h-0">
            <SettingsRowCopy>
              <strong>Enabled</strong>
              <small>
                Disabling blocks this plugin for every Wisp. Replacing the key or removing the connection clears its
                Wisp access grants.
              </small>
            </SettingsRowCopy>
            <ToggleSwitch
              checked={enabled}
              label={`Enable ${plugin.name}`}
              disabled={busy}
              onChange={() => {
                setEnabled((current) => !current);
                setError("");
                setMessage("");
              }}
            />
          </SettingsRow>
        </SettingsCard>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" type="button" disabled={busy || !hasKey} onClick={() => void run("test")}>
            {operation === "test" ? "Testing…" : "Test connection"}
          </Button>
          <Button
            type="button"
            disabled={busy || (enabled && !hasKey) || (Boolean(key) && !secureStorageAvailable)}
            onClick={() => void run("save")}
          >
            {operation === "save" ? "Saving…" : "Save plugin"}
          </Button>
          {plugin.configured ? (
            <ConfirmAction
              label="Remove connection"
              confirmLabel="Remove connection"
              pendingLabel="Removing…"
              pending={operation === "remove"}
              disabled={busy}
              description={`Removes the saved ${plugin.name} key and every Wisp's access to it.`}
              onConfirm={() => void run("remove")}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
