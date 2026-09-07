import { useEffect, useId, useState } from "react";

import type { PluginSettingsView, PluginSummary } from "../../shared/plugins";
import { SettingsCard, SettingsGroup } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PluginSettingsSection() {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

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
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
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
            <p role="alert" className="text-[11.5px] text-destructive">
              Secure credential storage is unavailable. New API keys cannot be saved on this device.
            </p>
          ) : null}
          {view.credentialError ? (
            <p role="alert" className="text-[11.5px] text-destructive">
              {view.credentialError}
            </p>
          ) : null}
          {view.plugins.map((plugin) => (
            <PluginConnectionCard
              key={plugin.id}
              plugin={plugin}
              secureStorageAvailable={view.secureStorageAvailable}
              credentialsUnavailable={Boolean(view.credentialError)}
              onSaved={setView}
            />
          ))}
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

function PluginConnectionCard({
  plugin,
  secureStorageAvailable,
  credentialsUnavailable,
  onSaved,
}: {
  plugin: PluginSummary;
  secureStorageAvailable: boolean;
  credentialsUnavailable: boolean;
  onSaved: (view: PluginSettingsView) => void;
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
    <SettingsGroup label={plugin.name}>
      <SettingsCard>
        <div className="flex flex-col gap-3 p-3.5 text-[11.5px]">
          <div>
            <p className="text-dim">{plugin.description}</p>
            <p className="mt-1">
              {plugin.configured ? (plugin.enabled ? "Connected · enabled" : "Connected · disabled") : "Not connected"}
            </p>
          </div>
          <label htmlFor={`${formId}-key`} className="flex flex-col gap-1.5">
            <strong>{plugin.id === "web-search" ? "Brave Search API key" : "Linear personal API key"}</strong>
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setError("");
                setMessage("");
              }}
            />
            Enable {plugin.name}
          </label>
          <p className="text-dim">
            Disabling blocks this plugin for every Wisp. Replacing the key or removing the connection clears its Wisp
            access grants; grant access again after connecting a new key.
          </p>
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
              <Button variant="ghost" type="button" disabled={busy} onClick={() => void run("remove")}>
                {operation === "remove" ? "Removing…" : "Remove connection"}
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsCard>
    </SettingsGroup>
  );
}
