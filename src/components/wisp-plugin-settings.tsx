import { useEffect, useId, useState } from "react";

import {
  PLUGIN_CATEGORIES,
  PLUGIN_CATALOG,
  type PluginAccess,
  type PluginGrant,
  type PluginSettingsView,
} from "../../shared/plugins";
import type { McpAccess, McpGrant, McpSettingsView } from "../../shared/mcp";
import { PluginLogo } from "@/components/plugin-logo";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

export function WispPluginSettings({ conversationId }: { conversationId: string }) {
  return <WispAccessForm key={conversationId} conversationId={conversationId} />;
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

function WispAccessForm({ conversationId }: { conversationId: string }) {
  const formId = useId();
  const [settings, setSettings] = useState<PluginSettingsView | null>(null);
  const [grants, setGrants] = useState<ReadonlyArray<PluginGrant>>([]);
  const [savedGrants, setSavedGrants] = useState<ReadonlyArray<PluginGrant>>([]);
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

  const dirty = grants.some(
    (grant) => grant.access !== savedGrants.find((savedGrant) => savedGrant.pluginId === grant.pluginId)?.access,
  );
  const mcpDirty = mcpGrants.some(
    (grant) => grant.access !== savedMcpGrants.find((savedGrant) => savedGrant.serverId === grant.serverId)?.access,
  );

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      if (dirty) {
        const result = await window.wisp.saveWispPluginAccess({ conversationId, grants, revision });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const nextGrants = completeGrants(result.value.grants);
        setGrants(nextGrants);
        setSavedGrants(nextGrants);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
        <p className="leading-relaxed text-dim">
          Choose the services this Wisp can use. Connections are managed in Settings → Integrations. Every Wisp starts
          with no access.
        </p>
        {loaded ? (
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
                            : "Connect this plugin in Settings → Integrations."}{" "}
                          You can still remove existing access.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            ))}
            <section aria-label="MCP servers" className="flex flex-col gap-3">
              <h3 className="font-semibold">MCP servers</h3>
              {mcpView.servers.length === 0 ? (
                <p className="leading-relaxed text-dim">
                  No MCP servers connected yet. Add one in Settings → Integrations.
                </p>
              ) : (
                mcpView.servers.map((server) => {
                  const available = server.enabled && server.state !== "needs_sign_in";
                  const access = mcpGrants.find((grant) => grant.serverId === server.serverId)?.access ?? "none";
                  return (
                    <div key={server.serverId} className="flex flex-col gap-2 rounded-[10px] bg-popover p-3.5">
                      <div className="flex items-center gap-3">
                        <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-muted text-[11px]">
                          {server.name.slice(0, 2).toUpperCase()}
                        </span>
                        <label htmlFor={`${formId}-mcp-${server.serverId}`} className="font-medium">
                          {server.name} access
                        </label>
                      </div>
                      <p className="leading-relaxed text-dim">
                        {server.tools.length} reviewed tool{server.tools.length === 1 ? "" : "s"} · every call asks for
                        approval
                      </p>
                      {access !== "none" && server.tools.length ? (
                        <p className="leading-relaxed text-dim">
                          Reviewed tools:{" "}
                          {server.tools
                            .slice(0, MAX_PREVIEW_TOOLS)
                            .map(({ label }) => label)
                            .join(", ")}
                          {server.tools.length > MAX_PREVIEW_TOOLS
                            ? ` + ${server.tools.length - MAX_PREVIEW_TOOLS} more`
                            : ""}
                          .
                        </p>
                      ) : null}
                      <Select
                        value={access}
                        items={MCP_ACCESS_OPTIONS}
                        disabled={saving}
                        onValueChange={(value) => {
                          if (!value || (!available && value !== "none")) return;
                          setMcpGrants((current) =>
                            current.map((grant) =>
                              grant.serverId === server.serverId ? { ...grant, access: value as McpAccess } : grant,
                            ),
                          );
                          setError("");
                          setSaved(false);
                        }}
                      >
                        <SelectTrigger id={`${formId}-mcp-${server.serverId}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start" alignItemWithTrigger={false}>
                          <SelectGroup>
                            {MCP_ACCESS_OPTIONS.map((option) => (
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
                          {server.state === "needs_sign_in"
                            ? "Sign in to this connection in Settings → Integrations first."
                            : "This server is disabled globally."}{" "}
                          You can still remove existing access.
                        </p>
                      ) : null}
                    </div>
                  );
                })
              )}
            </section>
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
