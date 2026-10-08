import { useCallback, useEffect, useId, useState } from "react";

import type { McpAccess, McpServerSummary, SaveWispMcpAccessRequest, WispMcpAccessView } from "../../shared/mcp";
import { AccessRow, InitialsBadge } from "@/components/access-row";
import { SettingsGroup } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import type { WispOption } from "@/lib/plugin-access";

const MCP_ACCESS_OPTIONS: ReadonlyArray<{ value: McpAccess; label: string }> = [
  { value: "none", label: "No access" },
  { value: "use_with_approval", label: "Use with approval" },
];

export interface McpAccessIndex {
  views: Readonly<Record<string, WispMcpAccessView>>;
  error: string;
  reload: () => void;
  update: (view: WispMcpAccessView) => void;
}

/**
 * Loads every Wisp's MCP access so Settings can count and edit grants per
 * server. `serversKey` reloads it whenever the servers change in a way that
 * revokes grants or moves the access revision (identity, enablement, tools).
 */
export function useMcpAccessIndex(wisps: ReadonlyArray<WispOption>, serversKey: string): McpAccessIndex {
  const [views, setViews] = useState<Record<string, WispMcpAccessView>>({});
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const ids = wisps.map(({ id }) => id).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: serversKey and attempt explicitly reload after connection changes.
  useEffect(() => {
    let cancelled = false;
    const conversationIds = ids ? ids.split("\n") : [];
    void Promise.all(conversationIds.map((conversationId) => window.wisp.getWispMcpAccess({ conversationId })))
      .then((results) => {
        if (cancelled) return;
        const next: Record<string, WispMcpAccessView> = {};
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
  }, [ids, serversKey, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);
  const update = useCallback(
    (view: WispMcpAccessView) => setViews((current) => ({ ...current, [view.conversationId]: view })),
    [],
  );
  return { views, error, reload, update };
}

/** Changes that reload the access index: anything that revokes grants or moves the revision. */
export function mcpServersKey(servers: ReadonlyArray<McpServerSummary>): string {
  return JSON.stringify(
    servers.map((server) => [
      server.serverId,
      server.enabled,
      server.authMode,
      server.endpoint,
      server.state === "needs_sign_in",
      server.tools.map(({ fingerprint }) => fingerprint),
    ]),
  );
}

export function mcpAccessChoice(view: WispMcpAccessView, serverId: string): McpAccess {
  return view.grants.find((grant) => grant.serverId === serverId)?.access ?? "none";
}

export function countWispsWithMcpAccess(index: McpAccessIndex, serverId: string): number {
  return Object.values(index.views).filter((view) => mcpAccessChoice(view, serverId) !== "none").length;
}

/** The backend replaces a Wisp's MCP grants as a whole, so every other server keeps its current access. */
export function applyMcpChoice(view: WispMcpAccessView, serverId: string, access: McpAccess): SaveWispMcpAccessRequest {
  const others = view.grants.filter((grant) => grant.serverId !== serverId);
  return {
    conversationId: view.conversationId,
    revision: view.revision,
    grants: [...others, { serverId, access }],
  };
}

/** Lets the user choose which Wisps can use a server, without visiting each Wisp. */
export function McpWispAccessPanel({
  server,
  wisps,
  index,
}: {
  server: McpServerSummary;
  wisps: ReadonlyArray<WispOption>;
  index: McpAccessIndex;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<Record<string, McpAccess>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Matches the backend: grants need an enabled connection, signed in when it uses OAuth.
  const available = server.enabled && server.state !== "needs_sign_in";
  const options = MCP_ACCESS_OPTIONS.map((option) => ({
    ...option,
    disabled: !available && option.value !== "none",
  }));
  const changes = wisps.filter(({ id }) => {
    const view = index.views[id];
    return view && draft[id] !== undefined && draft[id] !== mcpAccessChoice(view, server.serverId);
  });

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      for (const wisp of changes) {
        const result = await window.wisp.saveWispMcpAccess(
          applyMcpChoice(index.views[wisp.id]!, server.serverId, draft[wisp.id]!),
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
        <p className="text-dim">Create a Wisp to give it access to {server.name}.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {!available ? (
            <p className="text-dim">
              {server.enabled
                ? "Sign in to this connection before giving Wisps access."
                : "Enable this connection before giving Wisps access. Wisps keep their access while it is disabled."}
            </p>
          ) : !server.tools.length ? (
            <p className="text-dim">No tools discovered yet. Use Refresh tools so Wisps with access can use them.</p>
          ) : null}
          <div className="divide-y divide-border rounded-[10px] bg-popover px-3">
            {wisps.map((wisp) => {
              const view = index.views[wisp.id];
              if (!view) return null;
              return (
                <AccessRow
                  key={wisp.id}
                  id={`${formId}-${wisp.id}`}
                  icon={<InitialsBadge name={wisp.name} />}
                  label={wisp.name}
                  value={draft[wisp.id] ?? mcpAccessChoice(view, server.serverId)}
                  options={options}
                  disabled={saving}
                  onChange={(next) => {
                    setDraft((current) => ({ ...current, [wisp.id]: next as McpAccess }));
                    setError("");
                    setMessage("");
                  }}
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
