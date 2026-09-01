import { randomUUID } from "node:crypto";

import type { ConversationAgentEvent } from "../../shared/contracts.js";
import type {
  ResolveToolApprovalRequest,
  ToolActionCategory,
  ToolApprovalRequest,
  ToolPolicyBehavior,
  ToolPolicySettings,
} from "../../shared/tool-policy.js";
import { WispBackendError } from "./backend-error.js";
import { normalizeRuleAction, ToolPolicyStore } from "./tool-policy-store.js";

const DEFAULT_APPROVAL_TTL_MS = 60_000;
const MAX_SUMMARY_LENGTH = 240;

export interface ToolAuthorizationRequest {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  summary: string;
}

interface PendingApproval {
  request: ToolApprovalRequest;
  windowId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ToolAuthorizationBrokerOptions {
  approvalTtlMs?: number;
  createId?: () => string;
  now?: () => Date;
  selectWindowId?: () => number | null;
}

export class ToolAuthorizationBroker {
  private readonly store: ToolPolicyStore;
  private readonly publish: (event: ConversationAgentEvent) => void;
  private readonly approvalTtlMs: number;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly selectWindowId: () => number | null;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    store: ToolPolicyStore,
    publish: (event: ConversationAgentEvent) => void,
    options: ToolAuthorizationBrokerOptions = {},
  ) {
    this.store = store;
    this.publish = publish;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.selectWindowId = options.selectWindowId ?? (() => null);
  }

  getPolicy(): ToolPolicySettings {
    return this.store.get();
  }

  listPending(): ReadonlyArray<ToolApprovalRequest> {
    return [...this.pending.values()].map(({ request }) => structuredClone(request));
  }

  savePolicy(value: unknown): Promise<ToolPolicySettings> {
    return this.store.save(value);
  }

  authorize(action: ToolAuthorizationRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new WispBackendError("aborted", "The tool action was cancelled."));
    }
    const behavior = evaluateToolPolicy(this.store.get(), action.category);
    if (behavior === "allow") return Promise.resolve();
    if (behavior === "block") {
      return Promise.reject(new WispBackendError("tool_blocked", "This tool action is blocked by policy."));
    }
    const windowId = this.selectWindowId();
    if (windowId === null) {
      return Promise.reject(new WispBackendError("tool_blocked", "This tool action requires an open approval window."));
    }

    const approvalId = this.createId();
    const expiresAt = new Date(this.now().getTime() + this.approvalTtlMs).toISOString();
    const request: ToolApprovalRequest = {
      approvalId,
      conversationId: action.conversationId,
      toolCallId: safeId(action.toolCallId),
      toolName: safeToolName(action.toolName),
      category: action.category,
      summary: sanitizeSummary(action.summary),
      expiresAt,
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(approvalId), this.approvalTtlMs);
      const abortListener = signal ? () => this.cancel(approvalId) : undefined;
      signal?.addEventListener("abort", abortListener!, { once: true });
      this.pending.set(approvalId, { request, windowId, timer, resolve, reject, signal, abortListener });
      this.publish({ type: "tool_approval_requested", conversationId: action.conversationId, request });
    });
  }

  async resolve(request: ResolveToolApprovalRequest, senderWindowId: number): Promise<void> {
    const pending = this.pending.get(request.approvalId);
    if (!pending) throw new WispBackendError("not_found", "This approval request is no longer available.");
    if (
      pending.windowId !== senderWindowId ||
      pending.request.conversationId !== request.conversationId ||
      pending.request.toolCallId !== request.toolCallId
    ) {
      throw new WispBackendError("invalid_request", "The approval response does not match the pending action.");
    }
    this.pending.delete(request.approvalId);
    this.cleanup(pending);
    if (request.decision === "block") {
      try {
        await this.store.blockCategory(pending.request.category, this.createId);
      } catch (error) {
        pending.reject(error);
        throw error;
      }
    }
    this.publish({
      type: "tool_approval_resolved",
      conversationId: request.conversationId,
      approvalId: request.approvalId,
      toolCallId: request.toolCallId,
      decision: request.decision,
    });
    if (request.decision === "allow_once") pending.resolve();
    else pending.reject(new WispBackendError("tool_blocked", "The tool action was denied."));
  }

  dispose(): void {
    for (const [approvalId, pending] of this.pending) {
      this.cleanup(pending);
      pending.reject(new WispBackendError("disposed", "The approval request was cancelled."));
      this.pending.delete(approvalId);
    }
  }

  cancelConversation(conversationId: string): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.request.conversationId === conversationId) this.cancel(approvalId);
    }
  }

  private expire(approvalId: string): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.pending.delete(approvalId);
    this.cleanup(pending);
    this.publish({
      type: "tool_approval_resolved",
      conversationId: pending.request.conversationId,
      approvalId,
      toolCallId: pending.request.toolCallId,
      decision: "expired",
    });
    pending.reject(new WispBackendError("approval_expired", "The tool approval request expired."));
  }

  private cancel(approvalId: string): void {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.pending.delete(approvalId);
    this.cleanup(pending);
    this.publish({
      type: "tool_approval_resolved",
      conversationId: pending.request.conversationId,
      approvalId,
      toolCallId: pending.request.toolCallId,
      decision: "deny",
    });
    pending.reject(new WispBackendError("aborted", "The tool action was cancelled."));
  }

  private cleanup(pending: PendingApproval): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }
}

export function evaluateToolPolicy(
  settings: ToolPolicySettings,
  category: ToolActionCategory | string,
): ToolPolicyBehavior {
  if (category === "shell") return "block";
  if (category === "read" || category === "search") return "allow";
  if (category !== "create_file" && category !== "modify_file") return "block";
  if (!settings.autoReview) return "ask";
  const matches = settings.rules
    .filter((rule) => ruleMatchesCategory(rule.action, category))
    .map(({ behavior }) => behavior);
  if (matches.includes("block")) return "block";
  if (matches.includes("ask")) return "ask";
  if (matches.includes("allow")) return "allow";
  return "ask";
}

function ruleMatchesCategory(action: string, category: ToolActionCategory): boolean {
  const normalized = normalizeRuleAction(action);
  if (normalized === category) return true;
  if (category === "create_file") {
    return ["create", "create_files", "write", "write_files", "file_changes", "all_file_changes"].includes(normalized);
  }
  if (category === "modify_file") {
    return ["edit", "edit_files", "modify", "modify_files", "file_changes", "all_file_changes"].includes(normalized);
  }
  return false;
}

function sanitizeSummary(value: string): string {
  const summary = value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return summary.slice(0, MAX_SUMMARY_LENGTH) || "Perform a file action";
}

function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : "tool-call";
}

function safeToolName(value: string): string {
  return /^(read|grep|find|ls|edit|write)$/.test(value) ? value : "unknown";
}
