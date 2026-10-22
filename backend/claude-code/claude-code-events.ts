import type { SessionReportUsage } from "../../shared/contracts.js";
import type { PiAgentEvent } from "../pi-event-translator.js";
import { WISP_MCP_SERVER } from "./claude-code-launch.js";

/**
 * Turns the messages the Claude Agent SDK yields for one Claude Code
 * conversation into the agent events Pi sessions emit, so a Claude Code Wisp
 * reuses the conversation agent and its translator (ADR 026). Shapes follow
 * Claude Code 2.1.303; unknown messages and fields are ignored, so newer
 * versions degrade to fewer events rather than failures.
 */

const WISP_TOOL_PREFIX = `mcp__${WISP_MCP_SERVER}__`;

/** Claude Code's own tools a Wisp may get, named as Wisp's tool catalog names them. */
const CLAUDE_CODE_TOOL_NAMES: Readonly<Record<string, string>> = { WebSearch: "web_search" };

/** How full the person's plan is, from Claude Code's `rate_limit_event`. */
export interface ClaudeCodePlanUsage {
  status: string;
  /** Fraction of each window used, 0 to 1, and when it resets (Unix seconds). */
  windows: Partial<Record<"five_hour" | "seven_day", { utilization: number; resetsAt: number }>>;
}

/** How a turn ended, from its `result` message. */
export interface ClaudeCodeTurnResult {
  sessionId: string;
  ok: boolean;
  usage: SessionReportUsage;
  /** Claude Code's own client-side estimate; with a subscription it is not billed. */
  estimatedCostUsd: number | null;
  /** Claude Code's error texts, for logs and for telling failures apart; never shown as is. */
  errors: string[];
  /** The turn's final reply, when it succeeded; a job run delivers it. */
  reply: string;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Wisp's name for a tool Claude Code called: the Wisp tool's own name, or its catalog name. */
export function wispToolName(claudeToolName: string): string {
  if (claudeToolName.startsWith(WISP_TOOL_PREFIX)) return claudeToolName.slice(WISP_TOOL_PREFIX.length);
  return CLAUDE_CODE_TOOL_NAMES[claudeToolName] ?? claudeToolName;
}

function usageOf(value: unknown): SessionReportUsage {
  const usage = record(value) ?? {};
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  const cacheReadTokens = count(usage.cache_read_input_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/** Whether a turn failed because the session it resumed no longer exists. */
export function isMissingSession(result: ClaudeCodeTurnResult): boolean {
  return !result.ok && result.errors.some((error) => error.startsWith("No conversation found"));
}

export class ClaudeCodeEventConverter {
  /** Tool calls that started and have no result yet, with their Wisp names. */
  private readonly openTools = new Map<string, string>();
  /**
   * Results of Wisp tools as they returned them, with the details Claude
   * Code's MCP result leaves out, until Claude Code reports the call ended.
   */
  private readonly toolResultsById = new Map<string, unknown>();
  private retrying = false;
  private planUsageValue: ClaudeCodePlanUsage | undefined;
  private modelValue: string | undefined;
  private capabilitiesValue: ReadonlySet<string> = new Set();
  private contextTokensValue: number | undefined;

  /**
   * How many tokens the conversation's context holds: the input of the latest
   * model call, or what a compaction left. Undefined until Claude Code says.
   */
  get contextTokens(): number | undefined {
    return this.contextTokensValue;
  }

  /** The latest plan usage Claude Code reported. */
  get planUsage(): ClaudeCodePlanUsage | undefined {
    return this.planUsageValue;
  }

  /** The model the session's alias resolved to, from `system/init`. */
  get model(): string | undefined {
    return this.modelValue;
  }

  /** The protocol features this Claude Code reports, from `system/init`. */
  get capabilities(): ReadonlySet<string> {
    return this.capabilitiesValue;
  }

  /** Keeps a Wisp tool's own result, read when Claude Code reports the call ended. */
  recordToolResult(toolCallId: string, result: unknown): void {
    if (this.openTools.has(toolCallId)) this.toolResultsById.set(toolCallId, result);
  }

  /** A Wisp tool's progress while it runs, such as which page a document reader is on. */
  toolProgress(toolCallId: string, partialResult: unknown): PiAgentEvent[] {
    const toolName = this.openTools.get(toolCallId);
    return toolName === undefined ? [] : [{ type: "tool_execution_update", toolCallId, toolName, partialResult }];
  }

  /**
   * The agent events for one message, and the turn's result when the message
   * ends the turn. Messages from subagents, which carry the tool call that
   * started them, belong to that tool call, not to the reply.
   */
  convert(message: unknown): { events: PiAgentEvent[]; result?: ClaudeCodeTurnResult } {
    const event = record(message);
    if (!event) return { events: [] };
    if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) return { events: [] };
    switch (event.type) {
      case "stream_event":
        return { events: this.streamEvent(record(event.event)) };
      case "assistant":
        return { events: this.toolCalls(record(event.message)) };
      case "user":
        return { events: this.toolResults(record(event.message)) };
      case "system":
        return { events: this.system(event) };
      case "rate_limit_event":
        this.readRateLimit(record(event.rate_limit_info));
        return { events: [] };
      case "result":
        return { events: this.endTools(), result: this.result(event) };
      default:
        return { events: [] };
    }
  }

  private streamEvent(event: Json | undefined): PiAgentEvent[] {
    if (!event) return [];
    if (event.type === "message_start") {
      const usage = record(record(event.message)?.usage);
      if (usage) {
        this.contextTokensValue =
          count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
      }
      const events: PiAgentEvent[] = [];
      if (this.retrying) {
        this.retrying = false;
        events.push({ type: "auto_retry_end", success: true });
      }
      events.push({ type: "message_start", message: { role: "assistant" } });
      return events;
    }
    if (event.type !== "content_block_delta") return [];
    const delta = record(event.delta);
    if (delta?.type !== "text_delta" || typeof delta.text !== "string" || !delta.text) return [];
    return [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: delta.text } }];
  }

  /** Text arrives as stream deltas; complete assistant messages only announce tool calls. */
  private toolCalls(message: Json | undefined): PiAgentEvent[] {
    const events: PiAgentEvent[] = [];
    for (const item of Array.isArray(message?.content) ? message.content : []) {
      const block = record(item);
      if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      const toolName = wispToolName(block.name);
      this.openTools.set(block.id, toolName);
      events.push({ type: "tool_execution_start", toolCallId: block.id, toolName, args: block.input });
    }
    return events;
  }

  private toolResults(message: Json | undefined): PiAgentEvent[] {
    const events: PiAgentEvent[] = [];
    for (const item of Array.isArray(message?.content) ? message.content : []) {
      const block = record(item);
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const toolName = this.openTools.get(block.tool_use_id);
      if (toolName === undefined) continue;
      this.openTools.delete(block.tool_use_id);
      const result = this.toolResultsById.get(block.tool_use_id) ?? { content: block.content };
      this.toolResultsById.delete(block.tool_use_id);
      events.push({
        type: "tool_execution_end",
        toolCallId: block.tool_use_id,
        toolName,
        isError: block.is_error === true,
        result,
      });
    }
    return events;
  }

  /** A turn that ends while tools still run (an interrupt) ends them too. */
  private endTools(): PiAgentEvent[] {
    const events: PiAgentEvent[] = [...this.openTools].map(([toolCallId, toolName]) => ({
      type: "tool_execution_end" as const,
      toolCallId,
      toolName,
      isError: true,
    }));
    this.openTools.clear();
    this.toolResultsById.clear();
    if (this.retrying) {
      this.retrying = false;
      events.push({ type: "auto_retry_end", success: false });
    }
    return events;
  }

  private system(event: Json): PiAgentEvent[] {
    switch (event.subtype) {
      case "init":
        if (typeof event.model === "string") this.modelValue = event.model;
        if (Array.isArray(event.capabilities)) {
          this.capabilitiesValue = new Set(event.capabilities.filter((item) => typeof item === "string"));
        }
        return [];
      case "api_retry":
        if (this.retrying) return [];
        this.retrying = true;
        return [
          { type: "auto_retry_start", ...(typeof event.error === "string" ? { errorMessage: event.error } : {}) },
        ];
      case "status":
        return event.status === "compacting" ? [{ type: "compaction_start" }] : [];
      case "compact_boundary": {
        const after = record(event.compact_metadata)?.post_tokens;
        if (typeof after === "number" && Number.isFinite(after)) this.contextTokensValue = after;
        return [{ type: "compaction_end" }];
      }
      default:
        return [];
    }
  }

  private readRateLimit(info: Json | undefined): void {
    if (!info || typeof info.status !== "string") return;
    const windows: ClaudeCodePlanUsage["windows"] = {};
    const unified = record(info.unifiedWindows) ?? {};
    for (const name of ["five_hour", "seven_day"] as const) {
      const window = record(unified[name]);
      if (window && typeof window.utilization === "number" && typeof window.resetsAt === "number") {
        windows[name] = { utilization: window.utilization, resetsAt: window.resetsAt };
      }
    }
    this.planUsageValue = { status: info.status, windows };
  }

  private result(event: Json): ClaudeCodeTurnResult {
    const cost = event.total_cost_usd;
    const ok = event.subtype === "success" && event.is_error !== true;
    return {
      sessionId: typeof event.session_id === "string" ? event.session_id : "",
      ok,
      reply: ok && typeof event.result === "string" ? event.result : "",
      usage: usageOf(event.usage),
      estimatedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      errors: Array.isArray(event.errors)
        ? event.errors.filter((error): error is string => typeof error === "string")
        : typeof event.result === "string" && event.is_error === true
          ? [event.result]
          : [],
    };
  }
}
