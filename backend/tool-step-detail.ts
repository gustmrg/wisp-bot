import type { SessionReportToolCall, ToolStepDetail } from "../shared/contracts.js";
import type { CommandResultDetails } from "../shared/execution.js";
import { outlineCommand } from "./command-outline.js";

/**
 * Summaries of what a tool call works on, for the steps a turn shows and for
 * the session report (ADR 003). They keep to a few argument fields, bounded
 * and with secret-looking values dropped: never file contents, command
 * arguments or tool output.
 */

const MAX_PURPOSE_CHARACTERS = 120;
const MAX_TARGET_CHARACTERS = 120;
const SECRET_LIKE_PATTERN = /sk-|key[=_-]|token[=_-]|secret[=_-]|bearer|passw/i;
/** Tools that run commands; their `command` is outlined, and shown only with verbose steps. */
const COMMAND_TOOLS = new Set(["run_command", "process"]);

export function isCommandTool(toolName: string): boolean {
  return COMMAND_TOOLS.has(toolName);
}
/** The argument a step names as its target, in order of preference. */
const TARGET_KEYS = ["path", "url", "query", "pattern", "glob"] as const;

type ToolResultLike = { content?: unknown; details?: unknown };

/** What a tool call works on, from its arguments; undefined when nothing can be shown. */
export function toolStepDetail(
  toolName: string,
  args: unknown,
  workspaceDirectory: string,
): ToolStepDetail | undefined {
  const record = plainRecord(args);
  if (!record) return undefined;
  const detail: ToolStepDetail = COMMAND_TOOLS.has(toolName) ? summarizeCommand(record) : {};
  if (!COMMAND_TOOLS.has(toolName)) {
    const target = targetOf(record, workspaceDirectory);
    if (target) detail.target = target;
  }
  return Object.keys(detail).length ? detail : undefined;
}

/** How a finished tool call ended, for commands; undefined for other tools. */
export function toolStepResult(toolName: string, result: unknown): ToolStepDetail | undefined {
  if (toolName !== "run_command") return undefined;
  const commandResult = commandResultOf((plainRecord(result) ?? {}) as ToolResultLike);
  return commandResult ? { commandResult } : undefined;
}

const MAX_COMMAND_CHARACTERS = 2_000;
const MAX_OUTPUT_CHARACTERS = 4_000;
const MAX_OUTPUT_LINES = 40;
// Terminal escape sequences, such as colors, which the chat cannot draw.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;

/**
 * With verbose steps (ADR 029): the command as the Wisp wrote it, bounded.
 * Unlike the summaries above, its arguments and any secret in them show.
 */
export function verboseStepCommand(toolName: string, args: unknown): string | undefined {
  if (!COMMAND_TOOLS.has(toolName)) return undefined;
  const command = plainRecord(args)?.command;
  if (typeof command !== "string") return undefined;
  const clean = printable(command).trim();
  return clean ? truncate(clean, MAX_COMMAND_CHARACTERS) : undefined;
}

/** With verbose steps (ADR 029): the end of the text a tool returned, its last lines. */
export function verboseStepOutput(result: unknown): string | undefined {
  const text = printable(textBlocks(plainRecord(result)?.content).join("\n")).trimEnd();
  if (!text.trim()) return undefined;
  let tail = text.split("\n").slice(-MAX_OUTPUT_LINES).join("\n");
  if (tail.length > MAX_OUTPUT_CHARACTERS) {
    tail = tail.slice(-MAX_OUTPUT_CHARACTERS);
    // Starts at a whole line when there is one.
    tail = tail.slice(tail.indexOf("\n") + 1);
  }
  return tail.length < text.length ? `…\n${tail}` : tail;
}

/** The text blocks of a tool result's content. */
function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
      ? [block.text as string]
      : [],
  );
}

/** Text without terminal escapes or control characters, keeping lines and tabs. */
function printable(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
}

/** What a command ran and what the Wisp said it was for; never its arguments. */
export function summarizeCommand(args: unknown): Pick<SessionReportToolCall, "commandOutline" | "purpose"> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const { command, description } = args as Record<string, unknown>;
  const commandOutline = typeof command === "string" ? outlineCommand(command) : "";
  const purpose = typeof description === "string" ? truncate(singleLine(description), MAX_PURPOSE_CHARACTERS) : "";
  return {
    ...(commandOutline ? { commandOutline } : {}),
    ...(purpose && !SECRET_LIKE_PATTERN.test(purpose) ? { purpose } : {}),
  };
}

/**
 * How a command ended: from the details the run_command tool records, or,
 * for sessions from before it did, from the status line Pi appends to the
 * output. Nothing else of the output is read.
 */
export function commandResultOf(toolResult: ToolResultLike): SessionReportToolCall["commandResult"] {
  const recorded = (toolResult.details as { commandResult?: CommandResultDetails } | undefined)?.commandResult;
  const result: NonNullable<SessionReportToolCall["commandResult"]> = {};
  if (recorded && typeof recorded === "object") {
    if (Number.isInteger(recorded.exitCode)) result.exitCode = recorded.exitCode;
    if (typeof recorded.durationMs === "number" && Number.isFinite(recorded.durationMs) && recorded.durationMs >= 0)
      result.durationMs = Math.round(recorded.durationMs);
  }
  const text = textBlocks(toolResult.content).at(-1) ?? "";
  const status = text.trimEnd().split("\n").at(-1)?.trim() ?? "";
  const exited = /^Command exited with code (\d{1,3})$/.exec(status);
  if (exited && result.exitCode === undefined) result.exitCode = Number(exited[1]);
  if (/^Command timed out after \d+ seconds$/.test(status)) result.stopped = "timeout";
  if (status === "Command aborted") result.stopped = "aborted";
  return Object.keys(result).length ? result : undefined;
}

function targetOf(args: Record<string, unknown>, workspaceDirectory: string): string | undefined {
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const target =
      key === "path" ? workspacePath(value, workspaceDirectory) : key === "url" ? pageOf(value) : singleLine(value);
    if (!target || SECRET_LIKE_PATTERN.test(target)) return undefined;
    return truncate(target, MAX_TARGET_CHARACTERS);
  }
  return undefined;
}

/** A path relative to the workspace; undefined for one outside it. */
function workspacePath(value: string, workspaceDirectory: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const workspace = workspaceDirectory.replaceAll("\\", "/").replace(/\/$/, "");
  const relative =
    workspace && (normalized === workspace || normalized.startsWith(`${workspace}/`))
      ? normalized.slice(workspace.length + 1) || "."
      : normalized.replace(/^\.\//, "");
  if (/^(?:[a-z]:|\/|~)|[\x00-\x1f\x7f]|(?:^|\/)\.\.(?:\/|$)/i.test(relative)) return undefined;
  return relative;
}

/** A page's host and path, without its query or fragment, which may carry tokens. */
function pageOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined;
}

function singleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}
