import { useCallback, useEffect, useId, useMemo, useState } from "react";

import type { PluginId, PluginSummary, WispPluginAccessView } from "../../shared/plugins";
import { AccessRow, InitialsBadge } from "@/components/access-row";
import { SettingsGroup } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import {
  applyPluginChoice,
  pluginChoice,
  pluginChoiceOptions,
  replacedProviders,
  type WispOption,
} from "@/lib/plugin-access";

export interface WispAccessIndex {
  views: Readonly<Record<string, WispPluginAccessView>>;
  error: string;
  reload: () => void;
  update: (view: WispPluginAccessView) => void;
}

/** Loads every Wisp's plugin access so Settings can count and edit grants per plugin. */
export function useWispAccessIndex(wisps: ReadonlyArray<WispOption>): WispAccessIndex {
  const [views, setViews] = useState<Record<string, WispPluginAccessView>>({});
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const ids = wisps.map(({ id }) => id).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly reloads after connection changes.
  useEffect(() => {
    let cancelled = false;
    const conversationIds = ids ? ids.split("\n") : [];
    void Promise.all(conversationIds.map((conversationId) => window.wisp.getWispPluginAccess({ conversationId })))
      .then((results) => {
        if (cancelled) return;
        const next: Record<string, WispPluginAccessView> = {};
        for (const result of results) if (result.ok) next[result.value.conversationId] = result.value;
        setViews(next);
        setError(results.some((result) => !result.ok) ? "Could not load access for some Wisps." : "");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load Wisp access.");
      });
    return () => {
      cancelled = true;
    };
  }, [ids, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  const update = useCallback(
    (view: WispPluginAccessView) => setViews((current) => ({ ...current, [view.conversationId]: view })),
    [],
  );
  return { views, error, reload, update };
}

export function countWispsWithAccess(index: WispAccessIndex, pluginId: PluginId): number {
  return Object.values(index.views).filter((view) => pluginChoice(view, pluginId) !== "none").length;
}

/** Lets the user give Wisps access right after connecting a plugin, without visiting each Wisp. */
export function PluginWispAccessPanel({
  plugin,
  plugins,
  wisps,
  index,
}: {
  plugin: PluginSummary;
  plugins: ReadonlyArray<PluginSummary>;
  wisps: ReadonlyArray<WispOption>;
  index: WispAccessIndex;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const options = useMemo(() => pluginChoiceOptions(plugin.id), [plugin.id]);
  const changes = wisps.filter(({ id }) => {
    const view = index.views[id];
    return view && draft[id] !== undefined && draft[id] !== pluginChoice(view, plugin.id);
  });

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      for (const wisp of changes) {
        const result = await window.wisp.saveWispPluginAccess(
          applyPluginChoice(index.views[wisp.id]!, plugin.id, draft[wisp.id]!),
        );
        if (!result.ok) {
          setError(`${wisp.name}: ${result.error.message}`);
          index.reload();
          return;
        }
        index.update(result.value);
      }
      setDraft({});
      setMessage("Wisp access saved.");
    } catch {
      setError("Could not save Wisp access.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup label="Wisp access">
      {wisps.length === 0 ? (
        <p className="text-dim">Create a Wisp to give it access to {plugin.name}.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="divide-y divide-border rounded-[10px] bg-popover px-3">
            {wisps.map((wisp) => {
              const view = index.views[wisp.id];
              if (!view) return null;
              const value = draft[wisp.id] ?? pluginChoice(view, plugin.id);
              const replaced = replacedProviders(view, plugin.id, value, plugins);
              return (
                <AccessRow
                  key={wisp.id}
                  id={`${formId}-${wisp.id}`}
                  icon={<InitialsBadge name={wisp.name} />}
                  label={wisp.name}
                  value={value}
                  options={options}
                  disabled={saving}
                  onChange={(next) => {
                    setDraft((current) => ({ ...current, [wisp.id]: next }));
                    setError("");
                    setMessage("");
                  }}
                  notice={replaced.length ? `Replaces ${replaced.join(" and ")}.` : undefined}
                />
              );
            })}
          </div>
          {index.error ? (
            <p role="alert" className="text-destructive">
              {index.error}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {message ? <p role="status">{message}</p> : null}
          <div>
            <Button type="button" disabled={!changes.length || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save Wisp access"}
            </Button>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
