import type { BackgroundProcessAction, TurnItem, TurnItemStatus } from "../shared/contracts.js";

/**
 * Reads what a tool call did from its arguments and result, for the
 * conversation to show. Pi and Claude Code call the same Wisp tools with the
 * same arguments and results, so one reader serves both. Everything here
 * comes from the model or the tools: it is bounded, stripped of control
 * characters, and has secret-looking values masked before it leaves.
 */

export const MAX_TURN_ITEM_OUTPUT_CHARACTERS = 4_000;
export const MAX_TURN_ITEM_DIFF_CHARACTERS = 16_000;
const MAX_COMMAND_CHARACTERS = 2_000;
const MAX_FIELD_CHARACTERS = 500;
const MAX_URL_CHARACTERS = 2_000;
const MAX_PURPOSE_CHARACTERS = 120;
const MAX_TITLE_CHARACTERS = 200;

/** A tool's result as Pi reports it; Claude Code's are shaped the same before they reach the reader. */
export interface ToolCallResult {
  content?: unknown;
  details?: unknown;
}

export interface ToolCall {
  id: string;
  toolName: string;
  args: unknown;
  status: TurnItemStatus;
  startedAt: string;
  completedAt?: string;
  label?: string;
  /** The result once the call ended, or a partial one while it runs. */
  result?: ToolCallResult;
}

const HIDDEN = "[hidden]";

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${HIDDEN}@`],
  [
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|credential|auth)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&|]+)/gi,
    `$1${HIDDEN}`,
  ],
];

/** Masks values that look like secrets: keys, tokens, passwords, credentials in URLs. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) masked = masked.replace(pattern, replacement);
  return masked;
}

// Terminal colors and other escape sequences, then the control characters left.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** One line of text, such as a path or a query. */
function line(value: unknown, maxLength = MAX_FIELD_CHARACTERS): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = maskSecrets(
    value
      .replace(ESCAPES, "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim(),
  );
  if (!clean) return undefined;
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`;
}

/** Several lines, such as a command or its output, kept from the end or the start. */
function block(
  value: string,
  maxLength: number,
  keep: "start" | "end",
): { text: string; truncated: boolean } | undefined {
  const clean = maskSecrets(value.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "")).replace(
    /^\n+|\s+$/g,
    "",
  );
  if (!clean) return undefined;
  if (clean.length <= maxLength) return { text: clean, truncated: false };
  return {
    text: keep === "end" ? clean.slice(clean.length - maxLength) : clean.slice(0, maxLength),
    truncated: true,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The text a result carries: Pi's content blocks, or Claude Code's plain string. */
export function resultText(result: ToolCallResult | undefined): string {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const part = record(item);
      return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
}

/** A path relative to the workspace, on the server or in the Wisp's container, when it is inside it. */
function workspacePath(value: unknown, workspaceDirectory: string): string | undefined {
  const path = line(value);
  if (!path) return undefined;
  const normalized = path.replaceAll("\\", "/");
  for (const root of [workspaceDirectory.replaceAll("\\", "/").replace(/\/+$/, ""), "/workspace"]) {
    if (!root) continue;
    if (normalized === root) return ".";
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return normalized;
}

/** Lines added and removed in a unified patch. */
function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of patch.split("\n")) {
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("+")) additions += 1;
    else if (row.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

const PROCESS_ACTIONS = new Set<string>(["start", "list", "log", "wait", "kill"]);

type ItemBody = DistributiveOmit<TurnItem, "id" | "toolName" | "status" | "startedAt" | "completedAt" | "label">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function commandItem(args: Record<string, unknown>, call: ToolCall): ItemBody {
  const command = typeof args.command === "string" ? block(args.command, MAX_COMMAND_CHARACTERS, "start") : undefined;
  const purpose = line(args.description, MAX_PURPOSE_CHARACTERS);
  const details = record(call.result?.details);
  const recorded = record(details?.commandResult)?.exitCode;
  const text = resultText(call.result);
  const exited = /Command exited with code (\d{1,3})\s*$/.exec(text)?.[1];
  const exitCode =
    typeof recorded === "number" && Number.isInteger(recorded) ? recorded : exited ? Number(exited) : undefined;
  const output = call.result ? block(text, MAX_TURN_ITEM_OUTPUT_CHARACTERS, "end") : undefined;
  return {
    type: "command_execution",
    command: command?.text ?? "",
    ...(purpose ? { purpose } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(output ? { output: output.text, ...(output.truncated ? { outputTruncated: true } : {}) } : {}),
  };
}

function processItem(args: Record<string, unknown>, call: ToolCall): ItemBody {
  const action = (
    typeof args.action === "string" && PROCESS_ACTIONS.has(args.action) ? args.action : "list"
  ) as BackgroundProcessAction;
  const text = resultText(call.result);
  const processId =
    (typeof args.id === "string" && /^[a-f0-9]{8}$/.test(args.id) ? args.id : undefined) ??
    /^Started process ([a-f0-9]{8})\./.exec(text)?.[1];
  const command =
    action === "start" && typeof args.command === "string"
      ? block(args.command, MAX_COMMAND_CHARACTERS, "start")?.text
      : undefined;
  let state: string | undefined;
  if (call.status === "completed") {
    if (action === "start") state = "running";
    else if (action === "kill") state = "stopped";
    else if (action === "wait") {
      state = /^Still running after/.test(text) ? "running" : line(/^Process ([a-z]+)\./.exec(text)?.[1], 40);
    }
  }
  const output = call.result ? block(text, MAX_TURN_ITEM_OUTPUT_CHARACTERS, "end") : undefined;
  return {
    type: "background_process",
    action,
    ...(processId ? { processId } : {}),
    ...(command ? { command } : {}),
    ...(state ? { state } : {}),
    ...(output ? { output: output.text, ...(output.truncated ? { outputTruncated: true } : {}) } : {}),
  };
}

function fileChangeItem(args: Record<string, unknown>, call: ToolCall, workspaceDirectory: string): ItemBody {
  const path = workspacePath(args.path ?? args.file_path, workspaceDirectory) ?? "";
  const patch = call.status === "completed" ? record(call.result?.details)?.patch : undefined;
  if (typeof patch === "string" && patch) {
    const diff = block(patch, MAX_TURN_ITEM_DIFF_CHARACTERS, "start");
    return {
      type: "file_change",
      path,
      ...patchCounts(patch),
      ...(diff ? { diff: diff.text, ...(diff.truncated ? { diffTruncated: true } : {}) } : {}),
    };
  }
  // write replaces the whole file: what it wrote is what was added.
  if (call.toolName === "write" && call.status === "completed" && typeof args.content === "string") {
    return { type: "file_change", path, additions: args.content ? args.content.split("\n").length : 0 };
  }
  return { type: "file_change", path };
}

/** The URL and title the browser tool reports at the top of its result. */
function browserPage(text: string): { url?: string; pageTitle?: string } {
  const url = line(/^URL: (.+)$/m.exec(text)?.[1], MAX_URL_CHARACTERS);
  const title = /^Title: (.+)$/m.exec(text)?.[1];
  const pageTitle = title === "(none)" ? undefined : line(title, MAX_TITLE_CHARACTERS);
  return { ...(url ? { url } : {}), ...(pageTitle ? { pageTitle } : {}) };
}

function itemBody(call: ToolCall, workspaceDirectory: string): ItemBody {
  const args = record(call.args) ?? {};
  switch (call.toolName) {
    case "run_command":
      return commandItem(args, call);
    case "process":
      return processItem(args, call);
    case "edit":
    case "write":
      return fileChangeItem(args, call, workspaceDirectory);
    case "read":
    case "ls":
      return { type: "file_read", paths: [workspacePath(args.path, workspaceDirectory) ?? "."] };
    case "grep":
    case "find": {
      const path = workspacePath(args.path, workspaceDirectory);
      return { type: "file_search", pattern: line(args.pattern) ?? "", ...(path ? { path } : {}) };
    }
    case "web_search":
      return { type: "web_search", query: line(args.query) ?? "" };
    case "web_read":
    case "firecrawl_scrape":
      return { type: "web_read", url: line(args.url, MAX_URL_CHARACTERS) ?? "" };
    case "browser": {
      const action = line(args.action, 40) ?? "";
      // Never what was typed: it may be a password.
      const page = call.status === "completed" ? browserPage(resultText(call.result)) : {};
      const opening = action === "open" ? line(args.url, MAX_URL_CHARACTERS) : undefined;
      return { type: "browser", action, ...(opening ? { url: opening } : {}), ...page };
    }
    default:
      return { type: "tool" };
  }
}

/** The conversation's view of a tool call so far. */
export function describeToolCall(call: ToolCall, workspaceDirectory: string): TurnItem {
  return {
    id: call.id,
    toolName: call.toolName,
    status: call.status,
    startedAt: call.startedAt,
    ...(call.completedAt ? { completedAt: call.completedAt } : {}),
    ...(call.label ? { label: call.label } : {}),
    ...itemBody(call, workspaceDirectory),
  } as TurnItem;
}
