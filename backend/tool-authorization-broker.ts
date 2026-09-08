import { randomUUID } from "node:crypto";

import type { ConversationAgentEvent } from "../shared/contracts.js";
import type {
  ResolveToolApprovalRequest,
  ToolActionCategory,
  ToolApprovalRequest,
  ToolPolicyBehavior,
  ToolPolicySettings,
} from "../shared/tool-policy.js";
import { WispBackendError } from "./backend-error.js";
import { normalizeRuleAction, ToolPolicyStore } from "./tool-policy-store.js";
import { NullToolAuditSink, type ToolAuditSink } from "./tool-audit-store.js";

const DEFAULT_APPROVAL_TTL_MS = 60_000;
const MAX_SUMMARY_LENGTH = 240;

export interface ToolAuthorizationRequest {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  summary: string;
  scope: { kind: "workspace_path"; value: string };
}

interface PendingApproval {
  request: ToolApprovalRequest;
  principal: number | string;
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
  selectPrincipal?: () => number | string | null;
  persistRequest?: (request: ToolApprovalRequest) => void;
  commitDecision?: (
    request: ResolveToolApprovalRequest,
    pending: ToolApprovalRequest,
    principal: number | string,
  ) => void;
  audit?: ToolAuditSink;
}

export class ToolAuthorizationBroker {
  private readonly store: Pick<ToolPolicyStore, "get" | "save" | "blockCategory">;
  private readonly publish: (event: ConversationAgentEvent) => void;
  private readonly approvalTtlMs: number;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly selectPrincipal: () => number | string | null;
  private readonly options: ToolAuthorizationBrokerOptions;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly audit: ToolAuditSink;

  constructor(
    store: Pick<ToolPolicyStore, "get" | "save" | "blockCategory">,
    publish: (event: ConversationAgentEvent) => void,
    options: ToolAuthorizationBrokerOptions = {},
  ) {
    this.store = store;
    this.publish = publish;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.options = options;
    this.selectPrincipal = options.selectPrincipal ?? options.selectWindowId ?? (() => null);
    this.audit = options.audit ?? new NullToolAuditSink();
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
    const actionId = this.createId();
    if (signal?.aborted) {
      this.auditDecision(actionId, action, "ask", "cancelled", "system", "cancelled");
      return Promise.reject(new WispBackendError("aborted", "The tool action was cancelled."));
    }
    const behavior = evaluateToolPolicy(this.store.get(), action.category, action.scope.kind);
    if (behavior === "allow") {
      this.auditDecision(actionId, action, behavior, "allow", "policy", "allowed");
      return Promise.resolve();
    }
    if (behavior === "block") {
      this.auditDecision(actionId, action, behavior, "block", "policy", "blocked");
      return Promise.reject(new WispBackendError("tool_blocked", "This tool action is blocked by policy."));
    }
    const principal = this.selectPrincipal();
    if (principal === null) {
      this.auditDecision(actionId, action, behavior, "block", "system", "blocked");
      return Promise.reject(new WispBackendError("tool_blocked", "This tool action requires an open approval window."));
    }

    const approvalId = actionId;
    const expiresAt = new Date(this.now().getTime() + this.approvalTtlMs).toISOString();
    const request: ToolApprovalRequest = {
      approvalId,
      conversationId: action.conversationId,
      toolCallId: safeId(action.toolCallId),
      toolName: safeToolName(action.toolName),
      category: action.category,
      scope: { kind: action.scope.kind, display: sanitizeSummary(action.scope.value) },
      summary: sanitizeSummary(action.summary),
      expiresAt,
    };
    this.auditDecision(actionId, action, behavior, "ask", "policy", "pending");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(approvalId), this.approvalTtlMs);
      const abortListener = signal ? () => this.cancel(approvalId) : undefined;
      signal?.addEventListener("abort", abortListener!, { once: true });
      try {
        this.options.persistRequest?.(request);
      } catch (error) {
        clearTimeout(timer);
        if (abortListener) signal?.removeEventListener("abort", abortListener);
        reject(error);
        return;
      }
      this.pending.set(approvalId, { request, principal, timer, resolve, reject, signal, abortListener });
      this.publish({ type: "tool_approval_requested", conversationId: action.conversationId, request });
    });
  }

  async resolve(request: ResolveToolApprovalRequest, senderPrincipal: number | string): Promise<void> {
    const pending = this.pending.get(request.approvalId);
    if (!pending) throw new WispBackendError("not_found", "This approval request is no longer available.");
    if (
      pending.principal !== senderPrincipal ||
      pending.request.conversationId !== request.conversationId ||
      pending.request.toolCallId !== request.toolCallId
    ) {
      throw new WispBackendError("invalid_request", "The approval response does not match the pending action.");
    }
    if (Date.parse(pending.request.expiresAt) <= this.now().getTime()) {
      this.expire(request.approvalId);
      throw new WispBackendError("approval_expired", "The tool approval request expired.");
    }
    // Claim before any await so two windows/devices cannot authorize the same action.
    this.pending.delete(request.approvalId);
    this.cleanup(pending);
    try {
      if (this.options.commitDecision) this.options.commitDecision(request, pending.request, senderPrincipal);
      else if (request.decision === "block") await this.store.blockCategory(pending.request.category, this.createId);
    } catch (error) {
      pending.reject(new WispBackendError("tool_blocked", "The approval decision could not be persisted."));
      throw error;
    }
    this.audit.append({
      actionId: request.approvalId,
      conversationId: request.conversationId,
      toolCallId: request.toolCallId,
      category: pending.request.category,
      scope: pending.request.scope.display,
      matchedPolicy: "ask",
      decision: request.decision,
      actor: "user",
      outcome: request.decision === "allow_once" ? "allowed" : "blocked",
      timestamp: this.now().toISOString(),
    });
    this.pending.delete(request.approvalId);
    this.cleanup(pending);
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
      this.auditPending(pending, "cancelled", "system", "cancelled");
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
    this.auditPending(pending, "expired", "system", "blocked");
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
    this.auditPending(pending, "cancelled", "system", "cancelled");
    pending.reject(new WispBackendError("aborted", "The tool action was cancelled."));
  }

  private cleanup(pending: PendingApproval): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  private auditDecision(
    actionId: string,
    action: ToolAuthorizationRequest,
    matchedPolicy: ToolPolicyBehavior,
    decision: "allow" | "ask" | "block" | "cancelled",
    actor: "policy" | "system",
    outcome: "pending" | "allowed" | "blocked" | "cancelled",
  ): void {
    this.audit.append({
      actionId,
      conversationId: action.conversationId,
      toolCallId: action.toolCallId,
      category: action.category,
      scope: action.scope.value,
      matchedPolicy,
      decision,
      actor,
      outcome,
      timestamp: this.now().toISOString(),
    });
  }

  private auditPending(
    pending: PendingApproval,
    decision: "expired" | "cancelled",
    actor: "system",
    outcome: "blocked" | "cancelled",
  ): void {
    this.audit.append({
      actionId: pending.request.approvalId,
      conversationId: pending.request.conversationId,
      toolCallId: pending.request.toolCallId,
      category: pending.request.category,
      scope: pending.request.scope.display,
      matchedPolicy: "ask",
      decision,
      actor,
      outcome,
      timestamp: this.now().toISOString(),
    });
  }
}

export function evaluateToolPolicy(
  settings: ToolPolicySettings,
  category: ToolActionCategory | string,
  scopeKind: string = "workspace_path",
): ToolPolicyBehavior {
  if (category === "shell") return "block";
  if (category === "read" || category === "search") return "allow";
  if (category !== "create_file" && category !== "modify_file") return "block";
  if (!settings.autoReview) return "ask";
  const matches = settings.rules
    .filter(
      (rule) =>
        rule.scope === "workspace" && scopeKind === "workspace_path" && ruleMatchesCategory(rule.action, category),
    )
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
