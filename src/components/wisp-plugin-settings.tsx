import { useEffect, useId, useState } from "react";

import {
  PLUGIN_CATEGORIES,
  PLUGIN_CATALOG,
  type PluginAccess,
  type PluginGrant,
  type PluginSettingsView,
} from "../../shared/plugins";
import { PluginLogo } from "@/components/plugin-logo";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ACCESS_OPTIONS = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
] as const;

export function WispPluginSettings({ conversationId }: { conversationId: string }) {
  return <WispPluginSettingsForm key={conversationId} conversationId={conversationId} />;
}

function completeGrants(grants: ReadonlyArray<PluginGrant>): PluginGrant[] {
  return PLUGIN_CATALOG.map(({ id }) => ({
    pluginId: id,
    access: grants.find((grant) => grant.pluginId === id)?.access ?? "none",
  }));
}

function WispPluginSettingsForm({ conversationId }: { conversationId: string }) {
  const formId = useId();
  const [settings, setSettings] = useState<PluginSettingsView | null>(null);
  const [grants, setGrants] = useState<ReadonlyArray<PluginGrant>>([]);
  const [savedGrants, setSavedGrants] = useState<ReadonlyArray<PluginGrant>>([]);
  const [revision, setRevision] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed load.
  useEffect(() => {
    let cancelled = false;
    setError("");
    void Promise.all([window.wisp.getPluginSettings(), window.wisp.getWispPluginAccess({ conversationId })])
      .then(([plugins, access]) => {
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
          setError("Could not load this Wisp's plugin access.");
          return;
        }
        const nextGrants = completeGrants(access.value.grants);
        setSettings(plugins.value);
        setGrants(nextGrants);
        setSavedGrants(nextGrants);
        setRevision(access.value.revision);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this Wisp's plugin access.");
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, attempt]);

  const dirty = grants.some(
    (grant) => grant.access !== savedGrants.find((savedGrant) => savedGrant.pluginId === grant.pluginId)?.access,
  );

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await window.wisp.saveWispPluginAccess({ conversationId, grants, revision });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const nextGrants = completeGrants(result.value.grants);
      setGrants(nextGrants);
      setSavedGrants(nextGrants);
      setRevision(result.value.revision);
      setSaved(true);
    } catch {
      setError("Could not save this Wisp's plugin access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
        <p className="leading-relaxed text-dim">
          Choose the services this Wisp can use. Connections are managed in Settings → Plugins. Every Wisp starts with
          no plugin access.
        </p>
        {settings ? (
          <>
            {PLUGIN_CATEGORIES.map((category) => (
              <section key={category.id} aria-label={category.name} className="flex flex-col gap-3">
                <h3 className="font-semibold">{category.name}</h3>
                {PLUGIN_CATALOG.filter((plugin) => plugin.category === category.id).map((plugin) => {
                  const connection = settings.plugins.find(({ id }) => id === plugin.id);
                  const available = Boolean(connection?.configured && connection.enabled);
                  const access = grants.find(({ pluginId }) => pluginId === plugin.id)?.access ?? "none";
                  const options = ACCESS_OPTIONS.filter((option) => plugin.supportsWrite || option.value !== "write");
                  return (
                    <div key={plugin.id} className="flex flex-col gap-2 rounded-[10px] bg-popover p-3.5">
                      <div className="flex items-center gap-3">
                        <PluginLogo pluginId={plugin.id} />
                        <label htmlFor={`${formId}-${plugin.id}`} className="font-medium">
                          {plugin.name} access
                        </label>
                      </div>
                      <p className="leading-relaxed text-dim">{plugin.description}</p>
                      <Select
                        value={access}
                        items={options}
                        disabled={saving}
                        onValueChange={(value) => {
                          if (!value || (!available && value !== "none")) return;
                          setGrants((current) =>
                            current.map((grant) =>
                              grant.pluginId === plugin.id ? { ...grant, access: value as PluginAccess } : grant,
                            ),
                          );
                          setError("");
                          setSaved(false);
                        }}
                      >
                        <SelectTrigger id={`${formId}-${plugin.id}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start" alignItemWithTrigger={false}>
                          <SelectGroup>
                            {options.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                                disabled={!available && option.value !== "none"}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {!available ? (
                        <p className="leading-relaxed text-dim">
                          {connection?.configured
                            ? "This plugin is disabled globally."
                            : "Connect this plugin in Settings → Plugins."}{" "}
                          You can still remove existing access.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            ))}
            <p className="leading-relaxed text-dim">
              Read and write allows Linear issue creation and updates, with your approval for each change. Revoking
              access blocks new calls immediately; calls already in progress may finish.
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
            Loading plugin access…
          </p>
        )}
      </div>
      {settings ? (
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
                  setRevision("");
                  setSaved(false);
                  setAttempt((current) => current + 1);
                }}
              >
                Reload access settings
              </Button>
            </>
          ) : null}
          {saved ? <p role="status">Plugin access saved for this Wisp.</p> : null}
          <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save access"}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
