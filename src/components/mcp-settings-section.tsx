import { useEffect, useId, useState } from "react";

import type {
  McpAuthMode,
  McpConnectionState,
  McpServerSummary,
  McpSettingsView,
  SaveMcpServerRequest,
} from "../../shared/mcp";
import { ChevronLeftIcon, Plus, RefreshCw, ServerIcon, Settings2 } from "lucide-react";
import {
  McpWispAccessPanel,
  countWispsWithMcpAccess,
  mcpServersKey,
  useMcpAccessIndex,
  type McpAccessIndex,
} from "@/components/mcp-wisp-access";
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTimeZone } from "@/hooks/use-time-zone";
import type { WispOption } from "@/lib/plugin-access";

const NO_WISPS: ReadonlyArray<WispOption> = [];

const AUTH_MODE_OPTIONS: ReadonlyArray<{ value: McpAuthMode; label: string }> = [
  { value: "none", label: "No authentication" },
  { value: "header", label: "Authentication header" },
  { value: "oauth", label: "Browser sign-in (OAuth)" },
];

const STATE_LABELS: Record<McpConnectionState, string> = {
  configured: "Configured",
  connected: "Connected",
  needs_sign_in: "Needs sign-in",
  unavailable: "Unavailable",
};

function stateTone(server: McpServerSummary): StatusTone {
  if (!server.enabled) return "muted";
  if (server.state === "connected") return "success";
  if (server.state === "needs_sign_in") return "warning";
  if (server.state === "unavailable") return "danger";
  return "muted";
}

interface McpDraft {
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  headerName: string;
  headerValue: string;
  enabled: boolean;
}

function emptyDraft(): McpDraft {
  return { name: "", endpoint: "", authMode: "none", headerName: "", headerValue: "", enabled: true };
}

function draftFrom(server: McpServerSummary): McpDraft {
  return {
    name: server.name,
    endpoint: server.endpoint,
    authMode: server.authMode,
    headerName: server.headerName ?? "",
    headerValue: "",
    enabled: server.enabled,
  };
}

export function McpSettingsSection({ wisps = NO_WISPS }: { wisps?: ReadonlyArray<WispOption> }) {
  const [view, setView] = useState<McpSettingsView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  /** Drill-in editor: "new", a server ID, or null for the server list. */
  const [editing, setEditing] = useState<"new" | string | null>(null);
  /** Server added in this visit; its form prompts for Wisp access. */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const index = useMcpAccessIndex(wisps, view ? mcpServersKey(view.servers) : "");

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed load.
  useEffect(() => {
    let cancelled = false;
    setError("");
    void window.wisp
      .getMcpSettings()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setView(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load MCP connections.");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Health updates pushed by the backend after tests, refreshes, or sign-ins.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reloads the subscription with the view.
  useEffect(() => {
    if (!view) return;
    const unsubscribe = window.wisp.subscribeToMcpSettings((next) => setView(next));
    return () => {
      unsubscribe();
    };
  }, [attempt, Boolean(view)]);

  return (
    <section
      className="@container overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
      id="mcp-settings-panel"
      aria-labelledby="mcp-settings-title"
    >
      <h2 id="mcp-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        MCP servers
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Connect remote MCP servers over HTTPS, then choose which Wisps can use them, here or in each Wisp's Access tab.
        Adding a server never gives any Wisp access automatically, and every tool call requires approval.
      </p>
      {view ? (
        <div className="animate-tab-forward">
          {!view.secureStorageAvailable ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              Secure credential storage is unavailable. New connections cannot be saved on this device.
            </p>
          ) : null}
          {view.credentialError ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {view.credentialError}
            </p>
          ) : null}
          {editing && (editing === "new" || view.servers.some((candidate) => candidate.serverId === editing)) ? (
            <McpServerForm
              key={editing === "new" ? "new" : editing}
              server={editing === "new" ? undefined : view.servers.find((candidate) => candidate.serverId === editing)}
              secureStorageAvailable={view.secureStorageAvailable}
              wisps={wisps}
              index={index}
              initialMessage={
                justAdded === editing
                  ? wisps.length
                    ? "Connection saved. Choose which Wisps can use it."
                    : "Connection saved."
                  : ""
              }
              onSaved={setView}
              onCreated={(next) => {
                const created = next.servers.find(
                  (candidate) => !view.servers.some(({ serverId }) => serverId === candidate.serverId),
                );
                setView(next);
                setJustAdded(created?.serverId ?? null);
                setEditing(created?.serverId ?? null);
              }}
              onBack={() => setEditing(null)}
            />
          ) : (
            <>
              {view.servers.length === 0 ? <p className="text-xs text-dim">No MCP servers connected yet.</p> : null}
              <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                {view.servers.map((server) => (
                  <McpServerCard
                    key={server.serverId}
                    server={server}
                    wispCount={wisps.length ? countWispsWithMcpAccess(index, server.serverId) : undefined}
                    onSelect={() => setEditing(server.serverId)}
                  />
                ))}
                <McpServerCard onSelect={() => setEditing("new")} />
              </div>
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
          Loading MCP connections…
        </p>
      )}
    </section>
  );
}

function McpServerCard({
  server,
  wispCount,
  onSelect,
}: {
  server?: McpServerSummary;
  wispCount?: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={server ? `Manage ${server.name}` : "Add MCP server"}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-4 py-4 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
        <ServerIcon className="size-4 text-dim" aria-hidden="true" />
      </span>
      {server ? (
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{server.name}</span>
          <span className="mt-1 block truncate text-sm text-dim">{safeHost(server.endpoint)}</span>
          <span className="mt-1.5 flex items-center gap-1.5 text-2xs text-dim">
            <StatusDot tone={stateTone(server)} />
            {STATE_LABELS[server.state]} · {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
            {server.enabled ? "" : " · disabled"}
            {wispCount !== undefined ? ` · ${wispCount === 1 ? "1 Wisp" : `${wispCount} Wisps`} with access` : ""}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">Add MCP server</span>
          <span className="mt-1 block text-sm text-dim">Connect a remote MCP server over HTTPS.</span>
        </span>
      )}
      {server ? (
        <Settings2 className="size-5 shrink-0 text-dim" aria-hidden="true" />
      ) : (
        <Plus className="size-5 shrink-0 text-dim group-hover:text-foreground" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Add/manage form for one MCP server, rendered in place of the server list.
 * Lives inside the settings dialog instead of stacking a second modal on top.
 */
function McpServerForm({
  server,
  secureStorageAvailable,
  wisps,
  index,
  initialMessage,
  onSaved,
  onCreated,
  onBack,
}: {
  server?: McpServerSummary;
  secureStorageAvailable: boolean;
  wisps: ReadonlyArray<WispOption>;
  index: McpAccessIndex;
  initialMessage: string;
  onSaved: (view: McpSettingsView) => void;
  /** Receives the view after an add; the section opens the new server to choose Wisp access. */
  onCreated: (view: McpSettingsView) => void;
  onBack: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<McpDraft>(server ? draftFrom(server) : emptyDraft());
  const timeZone = useTimeZone();
  const [operation, setOperation] = useState<"save" | "test" | "remove" | "refresh" | "signin" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [cancellingSignIn, setCancellingSignIn] = useState(false);
  // The backend reports a waiting sign-in with the server, so it stays visible
  // and cancellable after this form was left and reopened, or from another window.
  const signingIn = operation === "signin" || Boolean(server?.signInPending);
  const busy = operation !== null || signingIn;
  const isNew = !server;

  function reset() {
    setDraft(server ? draftFrom(server) : emptyDraft());
    setError("");
    setMessage("");
  }

  /** Leaves the form; a waiting sign-in keeps running and is still cancellable on return. */
  function close() {
    reset();
    onBack();
  }

  async function cancelSignIn() {
    if (!server || cancellingSignIn) return;
    setCancellingSignIn(true);
    try {
      const result = await window.wisp.cancelMcpSignIn({ serverId: server.serverId });
      if (result.ok) onSaved(result.value);
    } catch {
      // The pending sign-in call reports the outcome either way.
    } finally {
      setCancellingSignIn(false);
    }
  }

  function saveRequest() {
    const request: Omit<SaveMcpServerRequest, "enabled" | "serverId"> & { serverId?: string; enabled?: boolean } = {
      name: draft.name.trim(),
      endpoint: draft.endpoint.trim(),
      authMode: draft.authMode,
      ...(draft.authMode === "header" && draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
      ...(draft.authMode === "header" && draft.headerValue ? { headerValue: draft.headerValue } : {}),
    };
    if (!isNew && server) request.serverId = server.serverId;
    return request;
  }

  /** The test endpoint accepts a narrower payload than the save endpoint. */
  function testRequest() {
    const { name: _name, ...request } = saveRequest();
    return request;
  }

  async function run(action: "save" | "test" | "remove" | "refresh" | "signin") {
    if (!server && (action === "remove" || action === "refresh" || action === "signin")) return;
    setOperation(action);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        const result = await window.wisp.testMcpConnection(testRequest());
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setMessage(result.value.message);
        return;
      }
      if (action === "save") {
        const payload = saveRequest();
        const result = await window.wisp.saveMcpServer({ ...payload, enabled: draft.enabled });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        if (isNew) {
          // Leave add mode so a second save cannot create a duplicate: the
          // section reopens the form on the new server to choose Wisp access.
          onCreated(result.value);
          return;
        }
        onSaved(result.value);
        setDraft((current) => ({ ...current, headerValue: "" }));
        setMessage("Connection saved.");
        return;
      }
      if (!server) return;
      const result =
        action === "remove"
          ? await window.wisp.removeMcpServer({ serverId: server.serverId })
          : action === "refresh"
            ? await window.wisp.refreshMcpTools({ serverId: server.serverId })
            : await window.wisp.startMcpSignIn({ serverId: server.serverId });
      if (!result.ok) {
        // A cancel the user asked for is an outcome, not a failure.
        if (action === "signin" && result.error.code === "aborted") setMessage(result.error.message);
        else setError(result.error.message);
        return;
      }
      onSaved(result.value);
      if (action === "remove") {
        close();
        return;
      }
      setMessage(action === "refresh" ? "Tools refreshed." : "Signed in.");
    } catch {
      setError(
        action === "test"
          ? "Could not test the connection."
          : action === "remove"
            ? "Could not remove the connection."
            : action === "refresh"
              ? "Could not refresh tools."
              : action === "signin"
                ? "Sign-in did not complete."
                : "Could not save the connection.",
      );
    } finally {
      setOperation(null);
    }
  }

  const endpoint = draft.endpoint.trim();
  const canTest = endpoint !== "" && (draft.authMode !== "header" || draft.headerName.trim() !== "");
  const canSave =
    draft.name.trim() !== "" &&
    endpoint !== "" &&
    (draft.authMode !== "header" ||
      (draft.headerName.trim() !== "" && (draft.headerValue !== "" || Boolean(server?.headerConfigured))));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" type="button" aria-label="Back to MCP servers" onClick={close}>
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
          <ServerIcon className="size-4 text-dim" aria-hidden="true" />
        </span>
        <h3 className="m-0 text-md font-medium">{server ? server.name : "Add MCP server"}</h3>
      </div>
      <p className="mb-1 mt-0 text-xs text-dim">
        Remote servers only. Local stdio servers and command-based configuration are not supported.
      </p>
      <div className="flex flex-col gap-3 text-xs">
        {server ? (
          <p className="flex items-center gap-1.5">
            <StatusDot tone={stateTone(server)} />
            {STATE_LABELS[server.state]}
            {server.lastDiscoveredAt ? ` · tools discovered ${formatDate(server.lastDiscoveredAt, timeZone)}` : ""}
            {server.tools.length ? ` · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}` : ""}
          </p>
        ) : null}
        <label htmlFor={`${formId}-name`} className="flex flex-col gap-1.5">
          <strong>Name</strong>
          <Input
            id={`${formId}-name`}
            value={draft.name}
            disabled={busy}
            placeholder="Linear MCP"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setError("");
            }}
          />
        </label>
        <label htmlFor={`${formId}-endpoint`} className="flex flex-col gap-1.5">
          <strong>Endpoint URL</strong>
          <Input
            id={`${formId}-endpoint`}
            type="url"
            value={draft.endpoint}
            disabled={busy}
            placeholder="https://example.com/mcp"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft({ ...draft, endpoint: event.target.value });
              setError("");
            }}
          />
        </label>
        <p className="text-dim">Only HTTPS endpoints are allowed.</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${formId}-auth`}>
            <strong>Authentication</strong>
          </label>
          <Select
            items={AUTH_MODE_OPTIONS}
            value={draft.authMode}
            disabled={busy}
            onValueChange={(value) => {
              if (value === null) return;
              setDraft({ ...draft, authMode: value as McpAuthMode });
              setError("");
              setMessage("");
            }}
          >
            <SelectTrigger id={`${formId}-auth`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              <SelectGroup>
                {AUTH_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {draft.authMode === "header" ? (
          <>
            <label htmlFor={`${formId}-header-name`} className="flex flex-col gap-1.5">
              <strong>Header name</strong>
              <Input
                id={`${formId}-header-name`}
                value={draft.headerName}
                disabled={busy}
                placeholder="Authorization"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setDraft({ ...draft, headerName: event.target.value });
                  setError("");
                }}
              />
            </label>
            <label htmlFor={`${formId}-header-value`} className="flex flex-col gap-1.5">
              <strong>Header value</strong>
              <Input
                id={`${formId}-header-value`}
                type="password"
                value={draft.headerValue}
                disabled={busy || !secureStorageAvailable}
                placeholder={server?.headerConfigured ? "Saved — enter a replacement" : "Enter secret value"}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => {
                  setDraft({ ...draft, headerValue: event.target.value });
                  setError("");
                }}
              />
            </label>
            <p className="text-dim">
              {server?.headerConfigured ? "Leave blank to keep the saved value. " : ""}
              Values are encrypted on this device and never shown to Wisps.
            </p>
          </>
        ) : null}
        {draft.authMode === "oauth" ? (
          <p className="text-dim">
            {server
              ? "Use Sign in to connect through your browser. Token renewal never removes Wisp access; replacing the account does."
              : "Save the connection first, then use Sign in to connect through your browser."}
          </p>
        ) : null}
        <SettingsCard>
          <SettingsRow className="min-h-0">
            <SettingsRowCopy>
              <strong>Enabled</strong>
              <small>
                Disabling blocks this server for every Wisp while keeping grants. Changing the endpoint or credentials
                revokes Wisp access.
              </small>
            </SettingsRowCopy>
            <ToggleSwitch
              checked={draft.enabled}
              label={`Enable ${server?.name ?? "this server"}`}
              disabled={busy}
              onChange={() => {
                setDraft({ ...draft, enabled: !draft.enabled });
                setError("");
              }}
            />
          </SettingsRow>
        </SettingsCard>
        {server && server.tools.length ? (
          <details className="rounded-[10px] bg-popover p-3">
            <summary className="cursor-pointer">Reviewed tools ({server.tools.length})</summary>
            <ul className="mt-2 flex list-none flex-col gap-1 p-0">
              {server.tools.slice(0, 12).map((tool) => (
                <li key={tool.alias} className="min-w-0 truncate">
                  <span className="font-medium">{tool.label}</span>
                  {tool.description ? <span className="text-dim"> — {tool.description}</span> : null}
                </li>
              ))}
              {server.tools.length > 12 ? <li className="text-dim">+ {server.tools.length - 12} more</li> : null}
            </ul>
          </details>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" type="button" disabled={busy || !canTest} onClick={() => void run("test")}>
            {operation === "test" ? "Testing…" : "Test connection"}
          </Button>
          <Button type="button" disabled={busy || !canSave} onClick={() => void run("save")}>
            {operation === "save" ? "Saving…" : "Save connection"}
          </Button>
          {server && server.authMode === "oauth" ? (
            <>
              <Button variant="secondary" type="button" disabled={busy} onClick={() => void run("signin")}>
                {signingIn ? "Waiting for browser…" : "Sign in"}
              </Button>
              {signingIn ? (
                <Button
                  variant="secondary"
                  type="button"
                  disabled={cancellingSignIn}
                  onClick={() => void cancelSignIn()}
                >
                  {cancellingSignIn ? "Cancelling…" : "Cancel sign-in"}
                </Button>
              ) : null}
            </>
          ) : null}
          {server ? (
            <Button
              variant="secondary"
              type="button"
              disabled={busy || !server.enabled}
              onClick={() => void run("refresh")}
            >
              <RefreshCw aria-hidden="true" className="mr-1 size-3" />
              {operation === "refresh" ? "Refreshing…" : "Refresh tools"}
            </Button>
          ) : null}
          {server ? (
            <ConfirmAction
              label="Remove connection"
              confirmLabel="Remove connection"
              pendingLabel="Removing…"
              pending={operation === "remove"}
              disabled={busy}
              description={`Removes ${server.name}, its saved secrets and every Wisp's access to it.`}
              onConfirm={() => void run("remove")}
            />
          ) : null}
        </div>
        {server ? <McpWispAccessPanel server={server} wisps={wisps} index={index} /> : null}
      </div>
    </div>
  );
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function formatDate(value: string, timeZone: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { timeZone });
}
