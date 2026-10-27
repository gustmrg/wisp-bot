import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { ConversationAgentEvent } from "../shared/contracts.js";
import { getToolMetadata } from "../shared/tool-catalog.js";
import {
  ALLOW_EVERYTHING_CATEGORIES,
  isWorkspaceFileCategory,
  ruleMatchesCategory,
  workspaceFileBehavior,
  type ResolveToolApprovalRequest,
  type ToolActionCategory,
  type JobApprovalDetails,
  type ToolApprovalRequest,
  type WispApprovalDetails,
  type ToolPolicyBehavior,
  type ToolPolicySettings,
  type SaveWispToolPolicyRequest,
  type WispToolPolicy,
  type WispToolPolicyView,
  type WorkspaceFileCategory,
} from "../shared/tool-policy.js";
import { WispBackendError } from "./backend-error.js";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { NullToolAuditSink, type ToolAuditSink } from "./tool-audit-store.js";
import { defaultWispToolPolicy } from "./wisp-tool-policy-store.js";

/**
 * How long a card waits for the person. The request deadline is paused while
 * a card waits (AgentRegistry), so this, not the deadline, bounds the wait.
 */
export const DEFAULT_APPROVAL_TTL_MS = 30 * 60_000;
const MAX_SUMMARY_LENGTH = 240;
const MAX_PREVIEW_LENGTH = 20_000;

export interface ToolAuthorizationRequest {
  /** Where the approval card shows. */
  conversationId: string;
  /** The Wisp acting, whose permissions apply; the conversation's ID in a Wisp's own conversation. */
  wispId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  summary: string;
  scope: {
    kind: "workspace_path" | "integration" | "skill" | "memory" | "container" | "browser" | "job" | "wisp";
    value: string;
  };
  /** Content the user must see to decide; only sent for skill and memory changes. */
  preview?: string;
  /** The job the user must see to decide; only sent for job approvals. */
  job?: JobApprovalDetails;
  /** The Wisp the user must see to decide; only sent for Wisp approvals. */
  wisp?: WispApprovalDetails;
  /**
   * The user already always allowed this integration tool, or the whole
   * integration, for this Wisp. Honored for integration calls and external
   * writes only, and never over a Block rule.
   */
  alwaysAllowed?: boolean;
  /** Remembers this integration tool for this Wisp; offering it adds "Always allow" to the card. */
  rememberApproval?: () => Promise<void>;
  /** Lets this Wisp use the whole integration without asking; offering it adds that choice to the card. */
  rememberIntegration?: () => Promise<void>;
}

/** Each Wisp's own permissions (ADR 023). */
export interface WispToolPolicySource {
  /** Synchronous, so an approval card is published in the same tick as its action. */
  get(wispId: string): WispToolPolicy;
  save(wispId: string, policy: WispToolPolicy): Promise<WispToolPolicy>;
  setFileBehavior(wispId: string, category: WorkspaceFileCategory, behavior: ToolPolicyBehavior): Promise<unknown>;
}

const NO_WISP_POLICIES: WispToolPolicySource = {
  get: () => defaultWispToolPolicy(),
  save: async () => {
    throw new WispBackendError("unavailable", "This Wisp's permissions cannot be saved.");
  },
  setFileBehavior: async () => {
    throw new WispBackendError("unavailable", "This Wisp's permissions cannot be saved.");
  },
};

/**
 * Actions that reach outside Wisp and cannot be taken back, such as a sent
 * email, a created issue, or a submitted form (ADR 033). Every MCP call
 * counts, since server annotations are untrusted and any tool may write.
 * Container commands do not: the container is the boundary, and counting
 * them would end retries for almost every job that works on code.
 */
export const EXTERNAL_ACTION_CATEGORIES: ReadonlySet<ToolActionCategory> = new Set([
  "external_write",
  "integration_call",
  "browser_submit",
]);

/**
 * What the person approved for a run with no one present, such as a job's
 * run (ADR 019): the tools approved with the job.
 */
export interface UnattendedGrant {
  conversationId: string;
  approvedTools: ReadonlySet<string>;
  /** Told of each external action allowed in the run, before it runs, by tool name. */
  onExternalAction?: (toolName: string) => void;
}

interface PendingApproval {
  request: ToolApprovalRequest;
  windowId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
  rememberApproval?: () => Promise<void>;
  rememberIntegration?: () => Promise<void>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface ToolAuthorizationBrokerOptions {
  approvalTtlMs?: number;
  createId?: () => string;
  now?: () => Date;
  selectWindowId?: () => number | null;
  audit?: ToolAuditSink;
  wispPolicies?: WispToolPolicySource;
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
  private readonly wispPolicies: WispToolPolicySource;
  private readonly unattended = new AsyncLocalStorage<UnattendedGrant>();

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
    this.wispPolicies = options.wispPolicies ?? NO_WISP_POLICIES;
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

  getWispPolicy(conversationId: string): WispToolPolicyView {
    return this.wispPolicyView(conversationId, this.wispPolicies.get(conversationId));
  }

  async saveWispPolicy(request: SaveWispToolPolicyRequest): Promise<WispToolPolicyView> {
    const { conversationId, ...policy } = request;
    return this.wispPolicyView(conversationId, await this.wispPolicies.save(conversationId, policy));
  }

  /** An unknown Wisp, or one whose permissions cannot be read, has none of its own. */
  private readWispPolicy(wispId: string): WispToolPolicy {
    try {
      return this.wispPolicies.get(wispId);
    } catch {
      return defaultWispToolPolicy();
    }
  }

  private wispPolicyView(conversationId: string, policy: WispToolPolicy): WispToolPolicyView {
    const settings = this.store.get();
    return {
      conversationId,
      ...policy,
      defaults: {
        create_file: evaluateToolPolicy(settings, "create_file"),
        modify_file: evaluateToolPolicy(settings, "modify_file"),
      },
    };
  }

  /**
   * Runs `run` with no one present: inside it, an action that would ask is
   * allowed when its tool was approved in `grant`, and refused at once
   * otherwise, so nothing ever waits for an approval card. Block rules still
   * win. Tool calls made anywhere within `run` inherit this.
   */
  runUnattended<T>(grant: UnattendedGrant, run: () => Promise<T>): Promise<T> {
    return this.unattended.run(grant, run);
  }

  authorize(action: ToolAuthorizationRequest, signal?: AbortSignal): Promise<void> {
    const actionId = this.createId();
    if (signal?.aborted) {
      this.auditDecision(actionId, action, "ask", "cancelled", "system", "cancelled");
      return Promise.reject(new WispBackendError("aborted", "The tool action was cancelled."));
    }
    let behavior = evaluateToolPolicy(this.store.get(), action.category, action.scope.kind);
    let everything = false;
    if (behavior !== "block") {
      // A Block rule is final; otherwise the Wisp's own permissions may answer.
      const wisp = this.readWispPolicy(action.wispId);
      behavior = applyWispToolPolicy(behavior, wisp, action.category, action.scope.kind);
      everything = behavior === "ask" && allowsEverything(wisp, action.category);
    }
    if (everything) {
      this.auditDecision(actionId, action, behavior, "allow_everything", "user", "allowed");
      this.noteExternalAction(action);
      return Promise.resolve();
    }
    if (behavior === "allow") {
      this.auditDecision(actionId, action, behavior, "allow", "policy", "allowed");
      this.noteExternalAction(action);
      return Promise.resolve();
    }
    if (behavior === "block") {
      this.auditDecision(actionId, action, behavior, "block", "policy", "blocked");
      return Promise.reject(new WispBackendError("tool_blocked", "This tool action is blocked by policy."));
    }
    const unattended = this.unattended.getStore();
    if (unattended) {
      // Skill, memory, job and Wisp changes are reviewed one by one, so no grant covers them.
      const approved =
        unattended.conversationId === action.conversationId &&
        action.category !== "save_skill" &&
        action.category !== "save_memory" &&
        action.category !== "schedule_job" &&
        action.category !== "manage_wisp" &&
        unattended.approvedTools.has(action.toolName);
      if (approved) {
        this.auditDecision(actionId, action, behavior, "allow", "user", "allowed");
        this.noteExternalAction(action);
        return Promise.resolve();
      }
      this.auditDecision(actionId, action, behavior, "block", "system", "blocked");
      return Promise.reject(
        new WispBackendError(
          "tool_blocked",
          "No one is present to approve this action, and it was not approved with the job.",
        ),
      );
    }
    const integrationTool =
      (action.category === "integration_call" || action.category === "external_write") &&
      action.scope.kind === "integration";
    if (integrationTool && action.alwaysAllowed) {
      // The user's earlier "Always allow" for this tool or integration and Wisp answers the prompt.
      this.auditDecision(actionId, action, behavior, "allow_always", "user", "allowed");
      return Promise.resolve();
    }
    const rememberApproval = integrationTool ? action.rememberApproval : undefined;
    const rememberIntegration = integrationTool ? action.rememberIntegration : undefined;
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
      // Only a circle names its Wisp: in a Wisp's own conversation it is the conversation's.
      ...(action.wispId === action.conversationId ? {} : { wispId: action.wispId }),
      toolCallId: safeId(action.toolCallId),
      toolName: safeToolName(action.toolName),
      category: action.category,
      scope: { kind: action.scope.kind, display: sanitizeSummary(action.scope.value) },
      summary: sanitizeSummary(action.summary),
      ...(action.preview ? { preview: sanitizePreview(action.preview) } : {}),
      ...(action.job && action.category === "schedule_job" ? { job: sanitizeJob(action.job) } : {}),
      ...(action.wisp && action.category === "manage_wisp" ? { wisp: sanitizeWisp(action.wisp) } : {}),
      ...(rememberApproval ? { alwaysAllowTool: true } : {}),
      ...(rememberIntegration ? { alwaysAllowIntegration: true } : {}),
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
        ...(rememberIntegration ? { rememberIntegration } : {}),
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
    const fileCategory =
      isWorkspaceFileCategory(category) && pending.request.scope.kind === "workspace_path" ? category : null;
    if (request.decision === "allow_always" && !fileCategory && !pending.rememberApproval) {
      throw new WispBackendError(
        "invalid_request",
        "Always allow is available only for workspace file changes, or for an integration tool that offers it.",
      );
    }
    if (request.decision === "allow_integration" && !pending.rememberIntegration) {
      throw new WispBackendError("invalid_request", "This integration cannot be always allowed.");
    }
    if (request.decision === "block" && category === "save_skill") {
      throw new WispBackendError("invalid_request", "Skill changes can only be allowed once or denied.");
    }
    if (request.decision === "block" && category === "save_memory") {
      throw new WispBackendError("invalid_request", "Memory changes can only be allowed once or denied.");
    }
    if (request.decision === "block" && category === "schedule_job") {
      throw new WispBackendError("invalid_request", "Jobs can only be allowed once or denied.");
    }
    if (request.decision === "block" && category === "manage_wisp") {
      throw new WispBackendError("invalid_request", "Wisp changes can only be allowed once or denied.");
    }
    // Claim the approval before awaiting anything, so a repeated decision, an
    // expiry, or a cancellation during the policy write cannot settle it twice.
    this.pending.delete(request.approvalId);
    this.cleanup(pending);
    let policyError: unknown;
    const remember = (operation: () => Promise<unknown>) =>
      operation().catch((error: unknown) => {
        policyError = error;
      });
    // File changes are remembered for this Wisp; an integration block applies to every Wisp.
    if (request.decision === "block" && fileCategory) {
      await remember(() => this.wispPolicies.setFileBehavior(wispOf(pending.request), fileCategory, "block"));
    } else if (request.decision === "block") {
      await remember(() => this.store.blockCategory(category, this.createId));
    }
    if (request.decision === "allow_always" && fileCategory) {
      await remember(() => this.wispPolicies.setFileBehavior(wispOf(pending.request), fileCategory, "allow"));
    } else if (request.decision === "allow_always" && pending.rememberApproval) {
      await remember(pending.rememberApproval);
    }
    if (request.decision === "allow_integration" && pending.rememberIntegration) {
      await remember(pending.rememberIntegration);
    }
    const allowed =
      request.decision === "allow_once" ||
      request.decision === "allow_always" ||
      request.decision === "allow_integration";
    this.audit.append({
      actionId: request.approvalId,
      conversationId: request.conversationId,
      ...(pending.request.wispId ? { wispId: pending.request.wispId } : {}),
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

  /** Tells an unattended run of an external action it may now take; no approval card shows in such a run. */
  private noteExternalAction(action: ToolAuthorizationRequest): void {
    if (EXTERNAL_ACTION_CATEGORIES.has(action.category))
      this.unattended.getStore()?.onExternalAction?.(action.toolName);
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
    decision: "allow" | "ask" | "block" | "allow_always" | "allow_everything" | "cancelled",
    actor: "policy" | "user" | "system",
    outcome: "pending" | "allowed" | "blocked" | "cancelled",
  ): void {
    this.audit.append({
      actionId,
      conversationId: action.conversationId,
      ...(action.wispId === action.conversationId ? {} : { wispId: action.wispId }),
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
      ...(pending.request.wispId ? { wispId: pending.request.wispId } : {}),
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
  if (category === "browser" || category === "browser_submit") {
    // Reading and moving around the web runs like commands do; sending something asks.
    if (scopeKind !== "browser") return "block";
    if (settings.rules.some((rule) => ruleMatchesCategory(rule.action, category) && rule.behavior === "block")) {
      return "block";
    }
    return category === "browser" ? "allow" : "ask";
  }
  if (category === "schedule_job") {
    // A job runs unattended with the tools approved with it, so the user
    // approves every job and every widening of one; nothing approves it for them.
    return scopeKind === "job" ? "ask" : "block";
  }
  if (category === "save_skill") {
    // Skills become standing instructions, so each change is reviewed by the
    // user; no rule or auto-review setting can approve or suppress the prompt.
    return scopeKind === "skill" ? "ask" : "block";
  }
  if (category === "save_memory") {
    // Memory is in every request, and the person's reaches every Wisp, so the
    // user reviews each change; no rule or auto-review setting suppresses it.
    return scopeKind === "memory" ? "ask" : "block";
  }
  if (category === "manage_wisp") {
    // A soul becomes another Wisp's standing instructions, and a deleted Wisp
    // takes its conversation with it, so the user reviews every change.
    return scopeKind === "wisp" ? "ask" : "block";
  }
  if (category !== "create_file" && category !== "modify_file") return "block";
  if (!settings.autoReview || scopeKind !== "workspace_path") return "ask";
  return workspaceFileBehavior(settings.rules, category);
}

/**
 * The Wisp's own setting for a kind of file change replaces the app-wide one,
 * which still decides when the Wisp has none. Called only when no Block rule matched.
 */
export function applyWispToolPolicy(
  behavior: ToolPolicyBehavior,
  wisp: WispToolPolicy,
  category: ToolActionCategory | string,
  scopeKind: string,
): ToolPolicyBehavior {
  if (scopeKind === "workspace_path" && isWorkspaceFileCategory(category)) return wisp.files[category] ?? behavior;
  return behavior;
}

/** Risk mode covers only what it lists; skills, jobs and commands keep their own rules. */
function allowsEverything(wisp: WispToolPolicy, category: ToolActionCategory): boolean {
  return wisp.allowEverything && ALLOW_EVERYTHING_CATEGORIES.includes(category);
}

function sanitizePreview(value: string): string {
  const preview = value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return preview.length > MAX_PREVIEW_LENGTH ? `${preview.slice(0, MAX_PREVIEW_LENGTH)}\n…` : preview;
}

function sanitizeJob(job: JobApprovalDetails): JobApprovalDetails {
  return {
    title: sanitizeSummary(job.title),
    schedule: sanitizeSummary(job.schedule),
    ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
    instructions: sanitizePreview(job.instructions),
    skills: job.skills.slice(0, 50).map(sanitizeSummary),
    tools: job.tools.slice(0, 100).map(sanitizeSummary),
  };
}

function sanitizeWisp(wisp: WispApprovalDetails): WispApprovalDetails {
  const changes = wisp.changes;
  return {
    action: wisp.action,
    name: sanitizeSummary(wisp.name),
    ...(changes
      ? {
          changes: {
            ...(changes.name !== undefined ? { name: sanitizeSummary(changes.name) } : {}),
            // A role may be cleared, which the summary's fallback text would hide.
            ...(changes.role !== undefined ? { role: changes.role.trim() ? sanitizeSummary(changes.role) : "" } : {}),
            ...(changes.soul !== undefined ? { soul: sanitizePreview(changes.soul) } : {}),
          },
        }
      : {}),
  };
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

/** The Wisp asking for an approval: the one it names, or the one whose own conversation it is in. */
function wispOf(request: ToolApprovalRequest): string {
  return request.wispId ?? request.conversationId;
}
