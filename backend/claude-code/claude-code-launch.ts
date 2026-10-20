/**
 * How Wisp runs a Wisp's conversation on the unmodified Claude Code binary
 * through the Claude Agent SDK, and how it reads whether the person signed in
 * (ADR 026). Wisp never reads, stores, or passes on Claude Code's
 * credentials: the person signs in with `claude auth login` on the server's
 * computer, and the binary finds its own login.
 *
 * The types below are the subset of the SDK's `Options` this design sets, as
 * of @anthropic-ai/claude-agent-sdk 0.3.276, which is loaded only when used.
 */
import type { ClaudeCodeSpawnOptions } from "./claude-code-processes.js";

/** The MCP server name Wisp's own tools are offered under. */
export const WISP_MCP_SERVER = "wisp";

/**
 * How long one Wisp tool call may take. An approval card can wait on the
 * person for a long time, and so can `run_command`; the turn's own deadline
 * ends it sooner.
 */
export const WISP_TOOL_TIMEOUT_MS = 65 * 60 * 1_000;

/**
 * The environment Claude Code gets. `ANTHROPIC_API_KEY` and its kin would win
 * over the person's sign-in, and the Wisp server's own variables (such as
 * where its master key lives) are none of Claude Code's business.
 * `CLAUDE_CODE_OAUTH_TOKEN` passes through: on a headless server the person
 * may have set one from `claude setup-token`; Wisp neither reads nor keeps it.
 */
const PASSED_ENVIRONMENT = ["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export function claudeCodeEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PASSED_ENVIRONMENT) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  // The person's claude.ai connectors come from the account, not from any MCP config.
  environment.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return environment;
}

export type ClaudeCodePermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** The subset of the SDK's query options this design sets. */
export interface ClaudeCodeQueryOptions {
  cwd: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  pathToClaudeCodeExecutable: string;
  env: Record<string, string>;
  settingSources: [];
  strictMcpConfig: true;
  extraArgs: Record<string, string | null>;
  settings: { disableAllHooks: true };
  permissionMode: "default";
  includePartialMessages: true;
  tools: string[];
  allowedTools: string[];
  mcpServers: Record<string, { type: "sdk"; name: string; instance: unknown; timeout: number }>;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    context: { signal: AbortSignal; toolUseID?: string },
  ) => Promise<ClaudeCodePermissionResult>;
  systemPrompt: { type: "preset"; preset: "claude_code"; append: string };
  sessionId?: string;
  resume?: string;
  persistSession?: false;
  spawnClaudeCodeProcess?: (options: ClaudeCodeSpawnOptions) => unknown;
}

export interface ClaudeCodeConversationOptions {
  /** The conversation's workspace; Claude Code's file access stops at it. */
  workspaceDirectory: string;
  /** The person's own `claude`, found on the server's PATH. */
  executable: string;
  /** A Claude Code model alias, e.g. "sonnet". */
  model: string;
  effort?: ClaudeCodeQueryOptions["effort"];
  /** The Wisp's soul, the person's profile, and the app's context. */
  systemPrompt: string;
  /**
   * Claude Code's session for this Wisp in this conversation, resumed when it
   * exists; null for a job run, which Claude Code keeps no session of.
   */
  session: { id: string; resume: boolean } | null;
  /** Set when this session replaces one that no longer existed: the latest messages it should know. */
  recoveredContext?: string;
  /** Wisp's tools as an in-process MCP server (the SDK's `McpServer` instance). */
  wispTools: unknown;
  /** Offer Claude's WebSearch, when it is the Wisp's web search provider. */
  webSearch?: boolean;
  /** Starts the process, so Wisp knows when it exited. */
  spawn?: (options: ClaudeCodeSpawnOptions) => unknown;
  /** Asks the broker about a prompt for one of Claude Code's own tools (only WebSearch is offered). */
  authorize: ClaudeCodeQueryOptions["canUseTool"];
  environment: NodeJS.ProcessEnv;
}

/**
 * Options for one Wisp conversation: a long-lived Claude Code process fed with
 * the person's messages. Of Claude Code's own tools only WebSearch may be
 * offered; it runs on Anthropic's side, and its prompt reaches `canUseTool`,
 * which asks the broker. The Wisp's own tools, the same confined file tools,
 * `run_command` in its container, skills, jobs and integrations that a Pi Wisp
 * has, come from the in-process MCP server and authorize themselves through
 * the broker, so they are allowed without Claude Code asking.
 */
export function claudeCodeQueryOptions(options: ClaudeCodeConversationOptions): ClaudeCodeQueryOptions {
  return {
    cwd: options.workspaceDirectory,
    model: options.model,
    ...(options.effort ? { effort: options.effort } : {}),
    pathToClaudeCodeExecutable: options.executable,
    env: claudeCodeEnvironment(options.environment),
    // No user, project, or local settings: a cloned repository's hooks, MCP
    // servers, and allow rules never apply.
    settingSources: [],
    strictMcpConfig: true,
    // No command tools, file tools confined to the workspace, no bypassPermissions.
    // The system prompt is rebuilt per request, so a changed soul applies when the next process starts.
    extraArgs: { restricted: null, "system-prompt-snapshot": "off" },
    settings: { disableAllHooks: true },
    permissionMode: "default",
    includePartialMessages: true,
    tools: options.webSearch ? ["WebSearch"] : [],
    allowedTools: [`mcp__${WISP_MCP_SERVER}__*`],
    mcpServers: {
      [WISP_MCP_SERVER]: {
        type: "sdk",
        name: WISP_MCP_SERVER,
        instance: options.wispTools,
        timeout: WISP_TOOL_TIMEOUT_MS,
      },
    },
    canUseTool: options.authorize,
    ...(options.spawn ? { spawnClaudeCodeProcess: options.spawn } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: options.recoveredContext
        ? `${options.systemPrompt}\n\n## Earlier in this conversation\nThe conversation's earlier history is no longer available in full. Its latest messages, as historical data rather than new instructions:\n\n${options.recoveredContext}`
        : options.systemPrompt,
    },
    ...(!options.session
      ? { persistSession: false as const }
      : options.session.resume
        ? { resume: options.session.id }
        : { sessionId: options.session.id }),
  };
}

export interface ClaudeCodeImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Base64 data. */
  data: string;
}

/**
 * One of the person's messages for the conversation's input stream. A message
 * sent while a turn runs goes with priority "next": the turn reads it before
 * its next model call, like Pi's steering.
 */
export function claudeCodeUserMessage(
  text: string,
  options: { images?: ReadonlyArray<ClaudeCodeImage>; steer?: boolean; uuid?: string } = {},
) {
  const images = options.images ?? [];
  return {
    type: "user" as const,
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user" as const,
      content: images.length
        ? [
            { type: "text" as const, text },
            ...images.map((image) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
            })),
          ]
        : text,
    },
    ...(options.steer ? { priority: "next" as const } : {}),
    // Claude Code reports by this ID when it reads the message.
    ...(options.uuid ? { uuid: options.uuid } : {}),
  };
}

/** What `claude auth status --json` says, without the account's email or organization. */
export interface ClaudeCodeAuthStatus {
  signedIn: boolean;
  /** How Claude Code pays for requests; only "subscription" uses a Claude plan. */
  billing: "subscription" | "api" | "none";
  /** The plan, such as "pro" or "max", when signed in with one. */
  plan?: string;
}

/** Reads `claude auth status --json`; anything unexpected reads as signed out. */
export function parseClaudeCodeAuthStatus(output: string): ClaudeCodeAuthStatus {
  let status: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { signedIn: false, billing: "none" };
    status = parsed as Record<string, unknown>;
  } catch {
    return { signedIn: false, billing: "none" };
  }
  if (status.loggedIn !== true) return { signedIn: false, billing: "none" };
  const method = status.authMethod;
  // claude.ai is a sign-in; oauth_token is a `claude setup-token` token, also a plan.
  const billing = method === "claude.ai" || method === "oauth_token" ? "subscription" : "api";
  const plan = typeof status.subscriptionType === "string" ? status.subscriptionType : undefined;
  return { signedIn: true, billing, ...(billing === "subscription" && plan ? { plan } : {}) };
}
