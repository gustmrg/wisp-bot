import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent" with {
  "resolution-mode": "import",
};

import type {
  SessionReportEvent,
  SessionReportModelUsage,
  SessionReportToolCall,
  SessionReportUsage,
  WispSessionReport,
} from "../shared/contracts.js";
import { AUXILIARY_USAGE_ENTRY } from "./image-transcriber.js";
import type { ModelPricing } from "./model-pricing-service.js";
import { safeId } from "./pi-event-translator.js";
import { getToolMetadata } from "../shared/tool-catalog.js";

const ALLOWED_ARGUMENT_KEYS = [
  "path",
  "pattern",
  "include",
  "glob",
  "query",
  "regex",
  "id",
  "issueId",
  "teamId",
  "stateId",
  "title",
  "description",
  "assigneeId",
] as const;
const MAX_TOOL_CALLS = 50;
const MAX_EVENTS = 50;
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
  /** Auxiliary rows count calls, and are priced only with the cost Pi recorded. */
  auxiliary?: { task: "imageUnderstanding"; calls: number };
  usage: SessionReportUsage;
  /** Cost Pi recorded with each turn, used when no current price is available. */
  recordedCostUsd: number | null;
}

interface SessionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
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
  // Safe tool identities persisted with the session keep old calls visible in
  // reports even after the MCP connection that provided them was removed.
  const historicalToolNames = new Set<string>();
  let totals = emptyUsage();
  let turns = 0;
  let compactionUsage = emptyUsage();
  let compactionCost: number | null = 0;
  let auxiliaryUsage = emptyUsage();
  let piVersion: string | undefined;

  for (const entry of entries) {
    if (entry.type !== "message") {
      if (entry.type === "custom" && entry.customType === "wisp:runtime") {
        const version = (entry.data as { version?: unknown } | undefined)?.version;
        if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) piVersion = version;
      }
      if (entry.type === "custom" && entry.customType === "wisp:mcp-tools") {
        const tools = (entry.data as { tools?: unknown } | undefined)?.tools;
        if (Array.isArray(tools)) {
          for (const tool of tools) {
            const name = (tool as { name?: unknown } | undefined)?.name;
            if (typeof name === "string" && /^mcp_[a-z0-9_]+$/.test(name)) historicalToolNames.add(name);
          }
        }
      }
      if (entry.type === "custom" && entry.customType === "wisp:retry") {
        const phase = (entry.data as { phase?: unknown } | undefined)?.phase;
        if (phase === "started" || phase === "finished")
          events.push({
            kind: phase === "started" ? "retry_started" : "retry_finished",
            timestamp: entry.timestamp,
            detail: phase === "started" ? "Retry started" : "Retry finished",
          });
      }
      if (entry.type === "custom" && entry.customType === AUXILIARY_USAGE_ENTRY) {
        const usage = auxiliaryEntryUsage(entry.data);
        if (usage) {
          totals = addUsage(totals, usage.usage);
          auxiliaryUsage = addUsage(auxiliaryUsage, usage.usage);
          accumulateAuxiliaryUsage(usage, usageByModel);
        }
      }
      if (entry.type === "compaction") {
        if (entry.usage) {
          totals = addUsage(totals, entry.usage);
          compactionUsage = addUsage(compactionUsage, entry.usage);
          const cost = entry.usage.cost?.total;
          compactionCost =
            compactionCost !== null && typeof cost === "number" && Number.isFinite(cost) && cost > 0
              ? compactionCost + cost
              : null;
        }
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
          detail: "The model request failed. Provider details are hidden for privacy.",
        });
      }
      for (const block of assistantMessage.content) {
        if (!block || typeof block !== "object" || block.type !== "toolCall") continue;
        if (!getToolMetadata(block.name) && !historicalToolNames.has(block.name)) continue;
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

  const normalCost = estimateCost(usageByModel, options.getPricing);
  return {
    sessionId,
    generatedAt: now().toISOString(),
    ...(piVersion ? { piVersion } : {}),
    turns,
    totals: { ...totals, costUsd: normalCost === null || compactionCost === null ? null : normalCost + compactionCost },
    compactionUsage,
    ...(auxiliaryUsage.totalTokens > 0 ? { auxiliaryUsage } : {}),
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
    parts.push(`${key}: ${key === "path" ? summarizeWorkspacePath(value, workspaceDirectory) : "[value hidden]"}`);
  }
  return truncate(parts.join("; "), MAX_ARGUMENT_SUMMARY_CHARACTERS);
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function emptyUsage(): SessionReportUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addUsage(current: SessionReportUsage, usage: SessionUsage): SessionReportUsage {
  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  return {
    inputTokens: current.inputTokens + input,
    outputTokens: current.outputTokens + output,
    cacheReadTokens: current.cacheReadTokens + tokenCount(usage.cacheRead),
    cacheWriteTokens: current.cacheWriteTokens + tokenCount(usage.cacheWrite),
    totalTokens:
      current.totalTokens +
      (usage.totalTokens === undefined
        ? input + output + tokenCount(usage.cacheRead) + tokenCount(usage.cacheWrite)
        : tokenCount(usage.totalTokens)),
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
    recordedCostUsd: 0,
  };
  bucket.turns += 1;
  bucket.usage = addUsage(bucket.usage, usage);
  const recorded = recordedCost(usage);
  bucket.recordedCostUsd =
    bucket.recordedCostUsd === null || recorded === null ? null : bucket.recordedCostUsd + recorded;
  usageByModel.set(key, bucket);
}

interface AuxiliaryEntryUsage {
  task: "imageUnderstanding";
  providerId: string;
  modelId: string;
  usage: SessionUsage;
}

/** Reads a `wisp:auxiliary-usage` entry, ignoring malformed ones rather than failing the report. */
function auxiliaryEntryUsage(data: unknown): AuxiliaryEntryUsage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { task?: unknown; providerId?: unknown; modelId?: unknown; usage?: unknown };
  if (record.task !== "imageUnderstanding") return null;
  if (typeof record.providerId !== "string" || !record.providerId || record.providerId.length > 256) return null;
  if (typeof record.modelId !== "string" || !record.modelId || record.modelId.length > 256) return null;
  if (!record.usage || typeof record.usage !== "object") return null;
  return {
    task: record.task,
    providerId: record.providerId,
    modelId: record.modelId,
    usage: record.usage as SessionUsage,
  };
}

/** Auxiliary calls get their own row, apart from the same model's conversation turns. */
function accumulateAuxiliaryUsage(entry: AuxiliaryEntryUsage, usageByModel: Map<string, ModelUsageBucket>): void {
  const key = `auxiliary:${entry.task}:${entry.providerId}:${entry.modelId}`;
  const bucket = usageByModel.get(key) ?? {
    providerId: entry.providerId,
    modelId: entry.modelId,
    turns: 0,
    auxiliary: { task: entry.task, calls: 0 },
    usage: emptyUsage(),
    recordedCostUsd: 0,
  };
  bucket.auxiliary!.calls += 1;
  bucket.usage = addUsage(bucket.usage, entry.usage);
  const recorded = recordedCost(entry.usage);
  bucket.recordedCostUsd =
    bucket.recordedCostUsd === null || recorded === null ? null : bucket.recordedCostUsd + recorded;
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
    costUsd: costForBucket(bucket, getPricing),
    ...(bucket.auxiliary ? { auxiliary: { ...bucket.auxiliary } } : {}),
  }));
}

function estimateCost(usageByModel: Map<string, ModelUsageBucket>, getPricing: SessionPricingLookup): number | null {
  let total = 0;
  for (const bucket of usageByModel.values()) {
    const cost = costForBucket(bucket, getPricing);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

// Current OpenRouter prices win; otherwise fall back to the cost Pi recorded
// from its own model catalog (e.g. direct providers such as Z.AI or Anthropic).
function costForBucket(bucket: ModelUsageBucket, getPricing: SessionPricingLookup): number | null {
  if (bucket.auxiliary) return bucket.recordedCostUsd;
  return costForUsage(bucket.usage, getPricing(bucket.providerId, bucket.modelId)) ?? bucket.recordedCostUsd;
}

// A zero recorded cost for a turn that used tokens means Pi had no price for
// the model, so it stays unknown rather than free.
function recordedCost(usage: SessionUsage): number | null {
  const tokens = addUsage(emptyUsage(), usage).totalTokens;
  if (tokens === 0) return 0;
  const total = usage.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
}

function costForUsage(usage: SessionReportUsage, pricing: ModelPricing | null): number | null {
  if (!pricing || (usage.cacheWriteTokens > 0 && pricing.cacheWritePerMillionTokens === undefined)) return null;
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokens +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillionTokens +
    (usage.cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMillionTokens ?? 0)
  );
}

function summarizeWorkspacePath(value: string, workspaceDirectory: string): string {
  const normalized = value.replaceAll("\\", "/");
  const workspace = workspaceDirectory.replaceAll("\\", "/").replace(/\/$/, "");
  const relative =
    workspace && normalized.startsWith(`${workspace}/`) ? `./${normalized.slice(workspace.length + 1)}` : normalized;
  if (
    /^(?:[a-z]:|\/)|[\r\n\x00-\x1f]|(?:^|\/)\.\.(?:\/|$)|(?:sk-|key[=_-]|token[=_-]|secret[=_-]|bearer)/i.test(relative)
  )
    return "[path hidden]";
  return "[workspace path]";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function formatTokenCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : String(value);
}
