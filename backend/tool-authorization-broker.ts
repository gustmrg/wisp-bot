import { randomUUID } from "node:crypto";

import type { ConversationAgentEvent } from "../shared/contracts.js";
import { getToolMetadata } from "../shared/tool-catalog.js";
import {
  isWorkspaceFileCategory,
  ruleMatchesCategory,
  workspaceFileBehavior,
  type ResolveToolApprovalRequest,
  type ToolActionCategory,
  type ToolApprovalRequest,
  type ToolPolicyBehavior,
  type ToolPolicySettings,
} from "../shared/tool-policy.js";
import { WispBackendError } from "./backend-error.js";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { NullToolAuditSink, type ToolAuditSink } from "./tool-audit-store.js";

const DEFAULT_APPROVAL_TTL_MS = 60_000;
const MAX_SUMMARY_LENGTH = 240;
const MAX_PREVIEW_LENGTH = 20_000;

export interface ToolAuthorizationRequest {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  summary: string;
  scope: { kind: "workspace_path" | "integration" | "skill" | "container"; value: string };
  /** Content the user must see to decide; only sent for skill changes. */
  preview?: string;
  /**
   * The user already always allowed this exact integration tool for this Wisp.
   * Honored for integration calls only, and never over a Block rule.
   */
  alwaysAllowed?: boolean;
  /** Remembers this integration tool for this Wisp; offering it adds "Always allow" to the card. */
  rememberApproval?: () => Promise<void>;
}

interface PendingApproval {
  request: ToolApprovalRequest;
  windowId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
  rememberApproval?: () => Promise<void>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ToolAuthorizationBrokerOptions {
  approvalTtlMs?: number;
  createId?: () => string;
  now?: () => Date;
  selectWindowId?: () => number | null;
  audit?: ToolAuditSink;
}

export class ToolAuthorizationBroker {
  private readonly store: ToolPolicyStore;
  private readonly publish: (event: ConversationAgentEvent) => void;
  private readonly approvalTtlMs: number;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly selectWindowId: () => number | null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly audit: ToolAuditSink;

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
    const integrationTool = action.category === "integration_call" && action.scope.kind === "integration";
    if (integrationTool && action.alwaysAllowed) {
      // The user's earlier "Always allow" for this tool and Wisp answers the prompt.
      this.auditDecision(actionId, action, behavior, "allow_always", "user", "allowed");
      return Promise.resolve();
    }
    const rememberApproval = integrationTool ? action.rememberApproval : undefined;
    const windowId = this.selectWindowId();
    if (windowId === null) {
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
      ...(action.preview ? { preview: sanitizePreview(action.preview) } : {}),
      ...(rememberApproval ? { alwaysAllowTool: true } : {}),
      expiresAt,
    };
    this.auditDecision(actionId, action, behavior, "ask", "policy", "pending");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(approvalId), this.approvalTtlMs);
      const abortListener = signal ? () => this.cancel(approvalId) : undefined;
      signal?.addEventListener("abort", abortListener!, { once: true });
      this.pending.set(approvalId, {
        request,
        windowId,
        timer,
        resolve,
        reject,
        signal,
        abortListener,
        ...(rememberApproval ? { rememberApproval } : {}),
      });
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
    const { category } = pending.request;
    const alwaysAllowFiles =
      isWorkspaceFileCategory(category) &&
      pending.request.scope.kind === "workspace_path" &&
      this.store.get().autoReview;
    if (request.decision === "allow_always" && !alwaysAllowFiles && !pending.rememberApproval) {
      throw new WispBackendError(
        "invalid_request",
        "Always allow is available only for workspace file changes while auto-review is on, or for an integration tool that offers it.",
      );
    }
    if (request.decision === "block" && category === "save_skill") {
      throw new WispBackendError("invalid_request", "Skill changes can only be allowed once or denied.");
    }
    // Claim the approval before awaiting anything, so a repeated decision, an
    // expiry, or a cancellation during the policy write cannot settle it twice.
    this.pending.delete(request.approvalId);
    this.cleanup(pending);
    let policyError: unknown;
    if (request.decision === "block") {
      await this.store.blockCategory(category, this.createId).catch((error: unknown) => {
        policyError = error;
      });
    }
    if (request.decision === "allow_always" && isWorkspaceFileCategory(category)) {
      await this.store.allowFileCategory(category, this.createId).catch((error: unknown) => {
        policyError = error;
      });
    }
    if (request.decision === "allow_always" && pending.rememberApproval) {
      await pending.rememberApproval().catch((error: unknown) => {
        policyError = error;
      });
    }
    const allowed = request.decision === "allow_once" || request.decision === "allow_always";
    this.audit.append({
      actionId: request.approvalId,
      conversationId: request.conversationId,
      toolCallId: request.toolCallId,
      category: pending.request.category,
      scope: pending.request.scope.display,
      matchedPolicy: "ask",
      decision: request.decision,
      actor: "user",
      outcome: allowed ? "allowed" : "blocked",
      timestamp: this.now().toISOString(),
    });
    this.publish({
      type: "tool_approval_resolved",
      conversationId: request.conversationId,
      approvalId: request.approvalId,
      toolCallId: request.toolCallId,
      decision: request.decision,
    });
    if (allowed) pending.resolve();
    else pending.reject(new WispBackendError("tool_blocked", "The tool action was denied."));
    // The decision applies to this action either way; still report that the lasting rule was not saved.
    if (policyError !== undefined) throw policyError;
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
    decision: "allow" | "ask" | "block" | "allow_always" | "cancelled",
    actor: "policy" | "user" | "system",
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
  if (category === "external_write") {
    if (scopeKind !== "integration") return "block";
    // External writes always require a one-time approval. Workspace allow rules
    // and the file auto-review toggle cannot grant integration permissions.
    return settings.rules.some(
      (rule) => rule.scope === "integration" && ruleMatchesCategory(rule.action, category) && rule.behavior === "block",
    )
      ? "block"
      : "ask";
  }
  if (category === "integration_call") {
    // Dynamically discovered MCP tools are unclassified: server annotations are
    // untrusted, so these calls ask by default and can only be blocked, never
    // allowed, by policy rules. A tool the user always allowed for one Wisp is
    // answered in authorize(), after this check, so a Block rule still wins.
    if (scopeKind !== "integration") return "block";
    return settings.rules.some(
      (rule) => rule.scope === "integration" && ruleMatchesCategory(rule.action, category) && rule.behavior === "block",
    )
      ? "block"
      : "ask";
  }
  if (category === "container_command") {
    // The container is the boundary, so its commands run without asking, as
    // in a terminal; a Block rule still stops every command.
    if (scopeKind !== "container") return "block";
    return settings.rules.some((rule) => ruleMatchesCategory(rule.action, category) && rule.behavior === "block")
      ? "block"
      : "allow";
  }
  if (category === "save_skill") {
    // Skills become standing instructions, so each change is reviewed by the
    // user; no rule or auto-review setting can approve or suppress the prompt.
    return scopeKind === "skill" ? "ask" : "block";
  }
  if (category !== "create_file" && category !== "modify_file") return "block";
  if (!settings.autoReview || scopeKind !== "workspace_path") return "ask";
  return workspaceFileBehavior(settings.rules, category);
}

function sanitizePreview(value: string): string {
  const preview = value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return preview.length > MAX_PREVIEW_LENGTH ? `${preview.slice(0, MAX_PREVIEW_LENGTH)}\n…` : preview;
}

function sanitizeSummary(value: string): string {
  const summary = value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return summary.slice(0, MAX_SUMMARY_LENGTH) || "Perform a tool action";
}

function safeId(value: string): string {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : "tool-call";
}

function safeToolName(value: string): string {
  return getToolMetadata(value) ? value : "unknown";
}
