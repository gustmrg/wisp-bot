import { useEffect, useId, useState } from "react";

import type {
  McpAuthMode,
  McpConnectionState,
  McpServerSummary,
  McpSettingsView,
  SaveMcpServerRequest,
} from "../../shared/mcp";
import { Plus, RefreshCw, ServerIcon, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

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

export function McpSettingsSection() {
  const [view, setView] = useState<McpSettingsView | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

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
      <h2 id="mcp-settings-title" className="mb-1 mt-0 text-[17px]">
        MCP servers
      </h2>
      <p className="mb-4 text-[11.5px] leading-relaxed text-dim">
        Connect remote MCP servers over HTTPS, then choose access in each Wisp's Access tab. Adding a server never gives
        any Wisp access automatically, and every tool call requires approval.
      </p>
      {view ? (
        <>
          {!view.secureStorageAvailable ? (
            <p role="alert" className="mb-3 text-[11.5px] text-destructive">
              Secure credential storage is unavailable. New connections cannot be saved on this device.
            </p>
          ) : null}
          {view.credentialError ? (
            <p role="alert" className="mb-3 text-[11.5px] text-destructive">
              {view.credentialError}
            </p>
          ) : null}
          {view.servers.length === 0 ? (
            <p className="text-[11.5px] text-dim">No MCP servers connected yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
              {view.servers.map((server) => (
                <McpServerCard
                  key={server.serverId}
                  server={server}
                  secureStorageAvailable={view.secureStorageAvailable}
                  onSaved={setView}
                />
              ))}
            </div>
          )}
          <McpServerCard secureStorageAvailable={view.secureStorageAvailable} onSaved={setView} />
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
          Loading MCP connections…
        </p>
      )}
    </section>
  );
}

function McpServerCard({
  server,
  secureStorageAvailable,
  onSaved,
}: {
  server?: McpServerSummary;
  secureStorageAvailable: boolean;
  onSaved: (view: McpSettingsView) => void;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<McpDraft>(server ? draftFrom(server) : emptyDraft());
  const [operation, setOperation] = useState<"save" | "test" | "remove" | "refresh" | "signin" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busy = operation !== null;
  const isNew = !server;

  function reset() {
    setDraft(server ? draftFrom(server) : emptyDraft());
    setError("");
    setMessage("");
  }

  function draftRequest() {
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

  async function run(action: "save" | "test" | "remove" | "refresh" | "signin") {
    if (!server && (action === "remove" || action === "refresh" || action === "signin")) return;
    setOperation(action);
    setError("");
    setMessage("");
    try {
      if (action === "test") {
        const result = await window.wisp.testMcpConnection(draftRequest());
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setMessage(result.value.message);
        return;
      }
      if (action === "save") {
        const payload = draftRequest();
        const result = await window.wisp.saveMcpServer({ ...payload, enabled: draft.enabled });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setDraft((current) => ({ ...current, headerValue: "" }));
        setMessage("Connection saved.");
        onSaved(result.value);
        const saved = result.value.servers.find((candidate) => candidate.name === draft.name.trim());
        if (saved) setDraft(draftFrom(saved));
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
        setError(result.error.message);
        return;
      }
      onSaved(result.value);
      if (action === "remove") {
        setOpen(false);
        setMessage("");
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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (busy) return;
        setOpen(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogTrigger
        aria-label={server ? `Manage ${server.name}` : "Add MCP server"}
        className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-4 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
          <ServerIcon className="size-4 text-dim" aria-hidden="true" />
        </span>
        {server ? (
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">{server.name}</span>
            <span className="mt-1 block truncate text-[12px] text-dim">{safeHost(server.endpoint)}</span>
            <span className="mt-1.5 block text-[10.5px] text-dim">
              {STATE_LABELS[server.state]} · {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
              {server.enabled ? "" : " · disabled"}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">Add MCP server</span>
            <span className="mt-1 block text-[12px] text-dim">Connect a remote MCP server over HTTPS.</span>
          </span>
        )}
        {server ? (
          <Settings2 className="size-5 shrink-0 text-dim" aria-hidden="true" />
        ) : (
          <Plus className="size-5 shrink-0 text-dim group-hover:text-foreground" aria-hidden="true" />
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto" showCloseButton={!busy}>
        <DialogHeader>
          <div className="mb-2 flex items-center gap-3">
            <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
              <ServerIcon className="size-4 text-dim" aria-hidden="true" />
            </span>
            <DialogTitle>{server ? server.name : "Add MCP server"}</DialogTitle>
          </div>
          <DialogDescription>
            Remote servers only. Local stdio servers and command-based configuration are not supported.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[11.5px]">
          {server ? (
            <p>
              {STATE_LABELS[server.state]}
              {server.lastDiscoveredAt ? ` · tools discovered ${formatDate(server.lastDiscoveredAt)}` : ""}
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
            <span className="text-dim">Only HTTPS endpoints are allowed.</span>
          </label>
          <label htmlFor={`${formId}-auth`} className="flex flex-col gap-1.5">
            <strong>Authentication</strong>
            <select
              id={`${formId}-auth`}
              className="rounded-md border border-border bg-transparent px-2 py-1.5"
              value={draft.authMode}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, authMode: event.target.value as McpAuthMode });
                setError("");
                setMessage("");
              }}
            >
              {AUTH_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
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
                <span className="text-dim">
                  {server?.headerConfigured ? "Leave blank to keep the saved value. " : ""}
                  Values are encrypted on this device and never shown to Wisps.
                </span>
              </label>
            </>
          ) : null}
          {draft.authMode === "oauth" ? (
            <p className="text-dim">
              {server
                ? "Use Sign in to connect through your browser. Token renewal never removes Wisp access; replacing the account does."
                : "Save the connection first, then use Sign in to connect through your browser."}
            </p>
          ) : null}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={busy}
              onChange={(event) => {
                setDraft({ ...draft, enabled: event.target.checked });
                setError("");
              }}
            />
            Enable {server?.name ?? "this server"}
          </label>
          <p className="text-dim">
            Disabling blocks this server for every Wisp while keeping grants. Changing the endpoint or credentials
            revokes Wisp access; removing the connection deletes its grants and saved secrets.
          </p>
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
              <Button variant="secondary" type="button" disabled={busy} onClick={() => void run("signin")}>
                {operation === "signin" ? "Waiting for browser…" : "Sign in"}
              </Button>
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
              <Button variant="ghost" type="button" disabled={busy} onClick={() => void run("remove")}>
                {operation === "remove" ? "Removing…" : "Remove connection"}
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
