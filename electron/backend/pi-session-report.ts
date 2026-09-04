import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent" with {
  "resolution-mode": "import",
};

import type {
  SessionReportEvent,
  SessionReportModelUsage,
  SessionReportToolCall,
  SessionReportUsage,
  WispSessionReport,
} from "../../shared/contracts.js";
import type { ModelPricing } from "./model-pricing-service.js";
import { safeId, sanitizeErrorMessage } from "./pi-event-translator.js";

const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const ALLOWED_ARGUMENT_KEYS = ["path", "pattern", "include", "glob", "query", "regex"] as const;
const MAX_TOOL_CALLS = 50;
const MAX_EVENTS = 50;
const MAX_ARGUMENT_VALUE_CHARACTERS = 120;
const MAX_ARGUMENT_SUMMARY_CHARACTERS = 200;

export type SessionPricingLookup = (providerId: string, modelId: string) => ModelPricing | null;

export interface BuildSessionReportOptions {
  workspaceDirectory: string;
  getPricing: SessionPricingLookup;
  now?: () => Date;
}

type AssistantSessionMessage = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
type ToolResultSessionMessage = Extract<SessionMessageEntry["message"], { role: "toolResult" }>;

interface ModelUsageBucket {
  providerId: string;
  modelId: string;
  turns: number;
  usage: SessionReportUsage;
}

interface SessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export function buildSessionReport(
  sessionId: string,
  entries: ReadonlyArray<SessionEntry>,
  options: BuildSessionReportOptions,
): WispSessionReport {
  const now = options.now ?? (() => new Date());
  const usageByModel = new Map<string, ModelUsageBucket>();
  const toolCalls: SessionReportToolCall[] = [];
  const toolCallIndexById = new Map<string, number>();
  const events: SessionReportEvent[] = [];
  let totals = emptyUsage();
  let turns = 0;

  for (const entry of entries) {
    if (entry.type !== "message") {
      if (entry.type === "compaction") {
        events.push({
          kind: "compaction",
          timestamp: entry.timestamp,
          detail:
            typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore)
              ? `Context compacted (${formatTokenCount(entry.tokensBefore)} tokens before)`
              : "Context compacted",
        });
      }
      continue;
    }
    const message = entry.message as SessionMessageEntry["message"];
    if (message.role === "assistant") {
      const assistantMessage = message as AssistantSessionMessage;
      turns += 1;
      if (assistantMessage.usage) {
        totals = addUsage(totals, assistantMessage.usage);
        accumulateModelUsage(assistantMessage, usageByModel);
      }
      if (assistantMessage.stopReason === "error") {
        events.push({
          kind: "error",
          timestamp: entry.timestamp,
          detail: sanitizeErrorMessage(assistantMessage.errorMessage) || "The model request failed.",
        });
      }
      for (const block of assistantMessage.content) {
        if (!block || typeof block !== "object" || block.type !== "toolCall") continue;
        if (!ALLOWED_TOOLS.has(block.name)) continue;
        const toolCall: SessionReportToolCall = {
          toolCallId: safeId(typeof block.id === "string" ? block.id : "tool-call"),
          toolName: block.name,
          argumentSummary: summarizeToolArguments(block.arguments, options.workspaceDirectory),
          status: "pending",
          timestamp: entry.timestamp,
        };
        toolCalls.push(toolCall);
        toolCallIndexById.set(toolCall.toolCallId, toolCalls.length - 1);
      }
      continue;
    }
    const toolResult = message as ToolResultSessionMessage;
    if (toolResult.role === "toolResult") {
      const index = toolCallIndexById.get(safeId(toolResult.toolCallId));
      const existing = index === undefined ? undefined : toolCalls[index];
      if (existing && index !== undefined) {
        toolCalls[index] = { ...existing, status: toolResult.isError ? "error" : "completed" };
      }
    }
  }

  return {
    sessionId,
    generatedAt: now().toISOString(),
    turns,
    totals: { ...totals, costUsd: estimateCost(usageByModel, options.getPricing) },
    models: summarizeModelUsage(usageByModel, options.getPricing),
    toolCalls: toolCalls.slice(-MAX_TOOL_CALLS),
    events: events.slice(-MAX_EVENTS),
  };
}

export function summarizeToolArguments(args: unknown, workspaceDirectory: string): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) return "";
  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ALLOWED_ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    parts.push(
      `${key}: ${truncate(relativizeWorkspacePath(value, workspaceDirectory), MAX_ARGUMENT_VALUE_CHARACTERS)}`,
    );
  }
  return truncate(parts.join("; "), MAX_ARGUMENT_SUMMARY_CHARACTERS);
}

function emptyUsage(): SessionReportUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addUsage(current: SessionReportUsage, usage: SessionUsage): SessionReportUsage {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  return {
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
    cacheReadTokens: current.cacheReadTokens + (usage.cacheRead ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (usage.cacheWrite ?? 0),
    totalTokens: current.totalTokens + (usage.totalTokens ?? input + output),
  };
}

function accumulateModelUsage(message: AssistantSessionMessage, usageByModel: Map<string, ModelUsageBucket>): void {
  const usage = message.usage;
  if (!usage) return;
  const key = `${message.provider}:${message.model}`;
  const bucket = usageByModel.get(key) ?? {
    providerId: message.provider,
    modelId: message.model,
    turns: 0,
    usage: emptyUsage(),
  };
  bucket.turns += 1;
  bucket.usage = addUsage(bucket.usage, usage);
  usageByModel.set(key, bucket);
}

function summarizeModelUsage(
  usageByModel: Map<string, ModelUsageBucket>,
  getPricing: SessionPricingLookup,
): ReadonlyArray<SessionReportModelUsage> {
  return [...usageByModel.values()].map((bucket) => ({
    providerId: bucket.providerId,
    modelId: bucket.modelId,
    turns: bucket.turns,
    usage: bucket.usage,
    costUsd: costForUsage(bucket.usage, getPricing(bucket.providerId, bucket.modelId)),
  }));
}

function estimateCost(usageByModel: Map<string, ModelUsageBucket>, getPricing: SessionPricingLookup): number | null {
  let total = 0;
  for (const bucket of usageByModel.values()) {
    const pricing = getPricing(bucket.providerId, bucket.modelId);
    if (!pricing) return null;
    total += costForUsage(bucket.usage, pricing) ?? 0;
  }
  return total;
}

function costForUsage(usage: SessionReportUsage, pricing: ModelPricing | null): number | null {
  if (!pricing) return null;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokens +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillionTokens
  );
}

function relativizeWorkspacePath(value: string, workspaceDirectory: string): string {
  if (!workspaceDirectory) return value;
  let sanitized = value;
  for (const sensitivePath of new Set([workspaceDirectory, workspaceDirectory.replaceAll("\\", "/")])) {
    if (!sensitivePath) continue;
    sanitized = sanitized.split(sensitivePath).join(".");
  }
  return sanitized;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function formatTokenCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}
