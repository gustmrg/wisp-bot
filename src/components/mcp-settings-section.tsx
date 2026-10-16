import { Checkbox } from "@base-ui/react/checkbox";
import { useEffect, useId, useState } from "react";

import type {
  McpAuthMode,
  McpConnectionState,
  McpServerSummary,
  McpSettingsView,
  SaveMcpServerRequest,
} from "../../shared/mcp";
import {
  MCP_PRESETS,
  presetToolsetHeaderValue,
  presetToolsetsFromHeader,
  type McpPreset,
  type McpPresetId,
} from "../../shared/mcp-presets";
import {
  CheckIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  Plus,
  RefreshCw,
  ServerIcon,
  Settings2,
  XIcon,
} from "lucide-react";
import {
  McpWispAccessPanel,
  countWispsWithMcpAccess,
  mcpServersKey,
  useMcpAccessIndex,
  type McpAccessIndex,
} from "@/components/mcp-wisp-access";
import { PluginLogo } from "@/components/plugin-logo";
import {
  ConfirmAction,
  SettingsCard,
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

interface HeaderRow {
  /** Stable key for the list; never sent. */
  key: number;
  name: string;
  value: string;
}

interface McpDraft {
  name: string;
  endpoint: string;
  authMode: McpAuthMode;
  headerName: string;
  headerValue: string;
  extraHeaders: HeaderRow[];
  /** Selected optional toolsets, for preset connections. */
  toolsets: string[];
  enabled: boolean;
}

let nextHeaderKey = 0;

function headerRows(headers: Readonly<Record<string, string>> | undefined, skip?: string): HeaderRow[] {
  return Object.entries(headers ?? {})
    .filter(([name]) => name !== skip)
    .map(([name, value]) => ({ key: nextHeaderKey++, name, value }));
}

function emptyDraft(preset?: McpPreset): McpDraft {
  if (preset) {
    return {
      name: preset.name,
      endpoint: preset.endpoint,
      authMode: preset.auth.mode,
      headerName: preset.auth.mode === "header" ? preset.auth.header.name : "",
      headerValue: "",
      extraHeaders: [],
      toolsets: preset.toolsets ? presetToolsetsFromHeader(preset.toolsets, undefined) : [],
      enabled: true,
    };
  }
  return {
    name: "",
    endpoint: "",
    authMode: "none",
    headerName: "",
    headerValue: "",
    extraHeaders: [],
    toolsets: [],
    enabled: true,
  };
}

function draftFrom(server: McpServerSummary, preset?: McpPreset): McpDraft {
  return {
    name: server.name,
    endpoint: server.endpoint,
    authMode: server.authMode,
    headerName: server.headerName ?? "",
    headerValue: "",
    extraHeaders: headerRows(server.extraHeaders, preset?.toolsets?.header),
    toolsets: preset?.toolsets
      ? presetToolsetsFromHeader(preset.toolsets, server.extraHeaders?.[preset.toolsets.header])
      : [],
    enabled: server.enabled,
  };
}

/** The credential as the header expects it; a pasted value that already has the prefix is kept. */
function presetCredential(preset: McpPreset, value: string): string {
  const prefix = preset.auth.mode === "header" ? preset.auth.header.valuePrefix : "";
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix}${trimmed}`;
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
  // Connections made from a preset are plugins and are managed in Settings → Plugins.
  const customServers = view?.servers.filter((server) => !server.preset) ?? [];

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
              key={editing}
              server={view.servers.find((candidate) => candidate.serverId === editing)}
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
              {customServers.length === 0 ? <p className="text-xs text-dim">No MCP servers connected yet.</p> : null}
              <div className="grid grid-cols-1 gap-x-7 gap-y-1 @min-[560px]:grid-cols-2">
                {customServers.map((server) => (
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

function McpServerIcon({ presetId }: { presetId?: McpPresetId }) {
  if (presetId) return <PluginLogo pluginId={presetId} />;
  return (
    <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
      <ServerIcon className="size-4 text-dim" aria-hidden="true" />
    </span>
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
      <McpServerIcon />
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
 * Settings → Plugins renders it for connections made from a preset.
 */
export function McpServerForm({
  server,
  newPreset,
  backLabel = "Back to MCP servers",
  secureStorageAvailable,
  wisps,
  index,
  initialMessage,
  signInOnOpen = false,
  onSaved,
  onCreated,
  onBack,
}: {
  server?: McpServerSummary;
  /** Adds a connection from this preset; ignored when a server is shown. */
  newPreset?: McpPresetId;
  /** Starts the browser sign-in as soon as the saved connection opens, after a one-step Connect. */
  signInOnOpen?: boolean;
  backLabel?: string;
  secureStorageAvailable: boolean;
  wisps: ReadonlyArray<WispOption>;
  index: McpAccessIndex;
  initialMessage: string;
  onSaved: (view: McpSettingsView) => void;
  /**
   * Receives the view after an add; the section opens the new server to choose
   * Wisp access, and starts its sign-in when `signIn` is set.
   */
  onCreated: (view: McpSettingsView, options?: { signIn?: boolean }) => void;
  onBack: () => void;
}) {
  const formId = useId();
  const presetId = server ? server.preset : newPreset;
  const preset = presetId ? MCP_PRESETS[presetId] : undefined;
  const [draft, setDraft] = useState<McpDraft>(server ? draftFrom(server, preset) : emptyDraft(preset));
  const timeZone = useTimeZone();
  const [operation, setOperation] = useState<
    "save" | "test" | "remove" | "refresh" | "signin" | "connect" | "toggle" | null
  >(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [cancellingSignIn, setCancellingSignIn] = useState(false);
  // The backend reports a waiting sign-in with the server, so it stays visible
  // and cancellable after this form was left and reopened, or from another window.
  const signingIn = operation === "signin" || Boolean(server?.signInPending);
  const busy = operation !== null || signingIn;
  const isNew = !server;
  // A preset that signs in through the browser has nothing to fill in: it connects in one step.
  const signInPreset = preset?.auth.mode === "oauth";
  const editable = !signInPreset || Boolean(preset?.toolsets);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, for the Connect that opened this form.
  useEffect(() => {
    if (signInOnOpen && server?.authMode === "oauth" && !server.signInPending) void run("signin");
  }, []);

  function reset() {
    setDraft(server ? draftFrom(server, preset) : emptyDraft(preset));
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

  /** Additional headers as sent: the rows with a name, plus a preset's toolset selection. */
  function extraHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const row of draft.extraHeaders) {
      const name = row.name.trim();
      if (name) headers[name] = row.value.trim();
    }
    if (preset?.toolsets) headers[preset.toolsets.header] = presetToolsetHeaderValue(preset.toolsets, draft.toolsets);
    return headers;
  }

  function saveRequest() {
    const headerValue =
      draft.authMode === "header" && draft.headerValue.trim()
        ? preset
          ? presetCredential(preset, draft.headerValue)
          : draft.headerValue
        : undefined;
    const headers = extraHeaders();
    const request: Omit<SaveMcpServerRequest, "enabled" | "serverId"> & { serverId?: string; enabled?: boolean } = {
      name: draft.name.trim(),
      endpoint: draft.endpoint.trim(),
      authMode: draft.authMode,
      ...(draft.authMode === "header" && draft.headerName.trim() ? { headerName: draft.headerName.trim() } : {}),
      ...(headerValue !== undefined ? { headerValue } : {}),
      // A saved server always sends its headers, so removing the last one is saved too.
      ...(server || Object.keys(headers).length ? { extraHeaders: headers } : {}),
      ...(isNew && preset ? { preset: preset.id } : {}),
    };
    if (!isNew && server) request.serverId = server.serverId;
    return request;
  }

  /** The test endpoint accepts a narrower payload than the save endpoint. */
  function testRequest() {
    const { name: _name, preset: _preset, ...request } = saveRequest();
    return request;
  }

  function updateHeader(key: number, change: Partial<Pick<HeaderRow, "name" | "value">>) {
    setDraft({
      ...draft,
      extraHeaders: draft.extraHeaders.map((row) => (row.key === key ? { ...row, ...change } : row)),
    });
    setError("");
  }

  async function run(action: "save" | "test" | "remove" | "refresh" | "signin" | "connect" | "toggle") {
    if (!server && (action === "remove" || action === "refresh" || action === "signin" || action === "toggle")) return;
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
      if (action === "toggle" && server) {
        // Nothing else to save on a sign-in preset: the switch applies at once, keeping access and tokens.
        const result = await window.wisp.saveMcpServer({ ...saveRequest(), enabled: !draft.enabled });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setDraft((current) => ({ ...current, enabled: !current.enabled }));
        onSaved(result.value);
        return;
      }
      if (action === "connect") {
        const result = await window.wisp.saveMcpServer({ ...saveRequest(), enabled: true });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        onCreated(result.value, { signIn: true });
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
      setMessage(
        action === "refresh"
          ? "Tools refreshed."
          : signInPreset && wisps.length
            ? `Connected to ${preset!.name}. Choose which Wisps can use it.`
            : signInPreset
              ? `Connected to ${preset!.name}.`
              : "Signed in.",
      );
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
                : action === "connect"
                  ? `Could not connect ${preset?.name ?? "the connection"}.`
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
        <Button variant="ghost" size="icon" type="button" aria-label={backLabel} onClick={close}>
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <McpServerIcon presetId={preset?.id} />
        <h3 className="m-0 text-md font-medium">
          {server ? server.name : preset ? `Add ${preset.name}` : "Add MCP server"}
        </h3>
      </div>
      <p className="mb-1 mt-0 text-xs text-dim">
        {preset
          ? `${preset.description} Wisps with access also get instructions for using it well.`
          : "Remote servers only. Local stdio servers and command-based configuration are not supported."}
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
        {preset ? null : (
          <Field>
            <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
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
          </Field>
        )}
        {preset ? (
          <>
            {preset.auth.mode === "header" ? (
              <Field>
                <FieldLabel htmlFor={`${formId}-credential`}>{preset.auth.label}</FieldLabel>
                <Input
                  id={`${formId}-credential`}
                  type="password"
                  value={draft.headerValue}
                  disabled={busy || !secureStorageAvailable}
                  placeholder={server?.headerConfigured ? "Saved — enter a replacement" : "Paste your token"}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => {
                    setDraft({ ...draft, headerValue: event.target.value });
                    setError("");
                  }}
                />
                <FieldDescription>
                  {server?.headerConfigured ? "Leave blank to keep the saved token. " : ""}
                  {preset.auth.help} Encrypted on this device and never shown to Wisps.{" "}
                  <a
                    href={preset.auth.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                  >
                    Create a token
                    <ExternalLinkIcon className="size-3" aria-hidden="true" />
                  </a>
                </FieldDescription>
              </Field>
            ) : (
              <p className="m-0 text-dim">{preset.auth.help}</p>
            )}
            {preset.toolsets ? (
              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                <legend className="mb-1 p-0 font-medium">Toolsets</legend>
                <div className="grid grid-cols-1 gap-x-4 gap-y-2 @min-[560px]:grid-cols-2">
                  {preset.toolsets.options.map((toolset) => (
                    <label key={toolset.id} className="flex min-w-0 cursor-pointer items-start gap-2">
                      <Checkbox.Root
                        className="mt-px inline-flex size-4 flex-none items-center justify-center rounded-[4px] border border-border bg-background focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 data-checked:border-foreground data-checked:bg-foreground data-checked:text-background data-disabled:opacity-50 [&_svg]:size-3"
                        checked={draft.toolsets.includes(toolset.id)}
                        disabled={busy}
                        onCheckedChange={(checked) => {
                          setDraft({
                            ...draft,
                            toolsets: checked
                              ? [...draft.toolsets, toolset.id]
                              : draft.toolsets.filter((id) => id !== toolset.id),
                          });
                          setError("");
                        }}
                      >
                        <Checkbox.Indicator>
                          <CheckIcon aria-hidden="true" />
                        </Checkbox.Indicator>
                      </Checkbox.Root>
                      <span className="min-w-0">
                        <span className="block">{toolset.label}</span>
                        <span className="block text-dim">{toolset.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="m-0 text-dim">
                  Fewer toolsets keep the Wisp's tool list short. Changing them keeps Wisp access and finds the tools
                  again.
                </p>
              </fieldset>
            ) : null}
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor={`${formId}-endpoint`}>Endpoint URL</FieldLabel>
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
              <FieldDescription>Only HTTPS endpoints are allowed.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-auth`}>Authentication</FieldLabel>
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
            </Field>
            {draft.authMode === "header" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`${formId}-header-name`}>Header name</FieldLabel>
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
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${formId}-header-value`}>Header value</FieldLabel>
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
                  <FieldDescription>
                    {server?.headerConfigured ? "Leave blank to keep the saved value. " : ""}
                    Values are encrypted on this device and never shown to Wisps.
                  </FieldDescription>
                </Field>
              </>
            ) : null}
            {draft.authMode === "oauth" ? (
              <p className="text-dim">
                {server
                  ? "Use Sign in to connect through your browser. Token renewal never removes Wisp access; replacing the account does."
                  : "Save the connection first, then use Sign in to connect through your browser."}
              </p>
            ) : null}
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-1 p-0 font-medium">Additional headers</legend>
              {draft.extraHeaders.map((row, index) => (
                <div key={row.key} className="flex min-w-0 gap-2">
                  <Input
                    aria-label={`Header ${index + 1} name`}
                    className="min-w-0 flex-1"
                    value={row.name}
                    disabled={busy}
                    placeholder="X-Option"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => updateHeader(row.key, { name: event.target.value })}
                  />
                  <Input
                    aria-label={`Header ${index + 1} value`}
                    className="min-w-0 flex-1"
                    value={row.value}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => updateHeader(row.key, { value: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    aria-label={`Remove header ${index + 1}`}
                    disabled={busy}
                    onClick={() => {
                      setDraft({ ...draft, extraHeaders: draft.extraHeaders.filter(({ key }) => key !== row.key) });
                      setError("");
                    }}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={busy || draft.extraHeaders.length >= 8}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      extraHeaders: [...draft.extraHeaders, { key: nextHeaderKey++, name: "", value: "" }],
                    })
                  }
                >
                  <Plus aria-hidden="true" className="mr-1 size-3" />
                  Add header
                </Button>
              </div>
              <p className="m-0 text-dim">
                Sent with every request, for options such as which tools a server offers. They are not encrypted: put
                secrets in the authentication header.
              </p>
            </fieldset>
          </>
        )}
        <SettingsCard>
          <SettingsRow className="min-h-0">
            <SettingsRowCopy>
              <SettingsRowTitle>Enabled</SettingsRowTitle>
              <SettingsRowDescription>
                {signInPreset
                  ? `Disabling blocks ${preset!.name} for every Wisp but keeps their access choices. Signing in with another account removes ${preset!.name} from every Wisp.`
                  : preset
                    ? `Disabling blocks ${preset.name} for every Wisp but keeps their access choices. Replacing the token removes ${preset.name} from every Wisp.`
                    : "Disabling blocks this server for every Wisp while keeping grants. Changing the endpoint or credentials revokes Wisp access."}
              </SettingsRowDescription>
            </SettingsRowCopy>
            <ToggleSwitch
              checked={draft.enabled}
              label={`Enable ${server?.name ?? "this server"}`}
              disabled={busy || (signInPreset && !server)}
              onChange={() => {
                if (signInPreset && !editable) {
                  void run("toggle");
                  return;
                }
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
        {server?.signInUrl ? <ManualSignIn server={server} signInUrl={server.signInUrl} onSaved={onSaved} /> : null}
        <div className="flex flex-wrap gap-2">
          {signInPreset && isNew ? (
            <Button type="button" disabled={busy || !secureStorageAvailable} onClick={() => void run("connect")}>
              {operation === "connect" ? "Connecting…" : "Connect"}
            </Button>
          ) : null}
          {signInPreset ? null : (
            <Button variant="secondary" type="button" disabled={busy || !canTest} onClick={() => void run("test")}>
              {operation === "test" ? "Testing…" : "Test connection"}
            </Button>
          )}
          {editable && !(signInPreset && isNew) ? (
            <Button type="button" disabled={busy || !canSave} onClick={() => void run("save")}>
              {operation === "save" ? "Saving…" : "Save connection"}
            </Button>
          ) : null}
          {server && server.authMode === "oauth" ? (
            <>
              <Button
                variant={signInPreset && server.state === "needs_sign_in" ? "default" : "secondary"}
                type="button"
                disabled={busy}
                onClick={() => void run("signin")}
              >
                {signingIn
                  ? "Waiting for browser…"
                  : signInPreset && server.state !== "needs_sign_in"
                    ? "Sign in again"
                    : "Sign in"}
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

/**
 * A sign-in this device cannot receive the browser's redirect for, such as the
 * browser app or a phone: the user opens the page, approves, and pastes back
 * the address the browser could not load.
 */
function ManualSignIn({
  server,
  signInUrl,
  onSaved,
}: {
  server: McpServerSummary;
  signInUrl: string;
  onSaved: (view: McpSettingsView) => void;
}) {
  const formId = useId();
  const [redirectUrl, setRedirectUrl] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  async function finish() {
    setFinishing(true);
    setError("");
    try {
      const result = await window.wisp.finishMcpSignIn({ serverId: server.serverId, redirectUrl: redirectUrl.trim() });
      if (result.ok) onSaved(result.value);
      else setError(result.error.message);
    } catch {
      setError("Could not finish the sign-in.");
    } finally {
      setFinishing(false);
    }
  }

  return (
    <form
      aria-label="Finish sign-in"
      className="flex flex-col gap-2 rounded-[10px] bg-popover p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (redirectUrl.trim() && !finishing) void finish();
      }}
    >
      <p className="m-0">
        <a
          href={signInUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
        >
          Open the sign-in page
          <ExternalLinkIcon className="size-3" aria-hidden="true" />
        </a>
      </p>
      <p className="m-0 text-dim">
        After you approve, the browser goes to an address starting with http://127.0.0.1 that does not load. Copy that
        address from the address bar and paste it here.
      </p>
      <Field>
        <FieldLabel htmlFor={`${formId}-redirect`}>Address after sign-in</FieldLabel>
        <Input
          id={`${formId}-redirect`}
          value={redirectUrl}
          disabled={finishing}
          placeholder="http://127.0.0.1:…/callback?code=…"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setRedirectUrl(event.target.value);
            setError("");
          }}
        />
      </Field>
      {error ? (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={finishing || !redirectUrl.trim()}>
          {finishing ? "Finishing…" : "Finish sign-in"}
        </Button>
      </div>
    </form>
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
