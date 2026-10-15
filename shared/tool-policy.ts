/**
 * "integration_call" is the generic category for dynamically discovered MCP
 * tools. Server-supplied annotations are untrusted, so these calls never map to
 * "read" or "write". They ask unless the user always allowed that exact tool
 * for that Wisp; policy rules can block them but never allow them.
 *
 * "save_skill" creates or updates one of the Wisp's own skills. It always asks:
 * policy rules can neither allow nor block it.
 *
 * "schedule_job" creates a job, or changes what one does (ADR 019). It always
 * asks, like skills: approving the card authorizes the job's tools for its runs.
 */
export type ToolActionCategory =
  | "read"
  | "search"
  | "create_file"
  | "modify_file"
  | "external_write"
  | "integration_call"
  | "save_skill"
  | "schedule_job"
  | "container_command"
  | "shell";
export type ToolPolicyBehavior = "allow" | "ask" | "block";

export interface ToolPolicyRule {
  id: string;
  action: string;
  behavior: ToolPolicyBehavior;
  scope?: "workspace" | "integration";
}

export interface ToolPolicySettings {
  autoReview: boolean;
  rules: ReadonlyArray<ToolPolicyRule>;
}

export type WorkspaceFileCategory = "create_file" | "modify_file";

const WORKSPACE_FILE_CATEGORIES: ReadonlyArray<WorkspaceFileCategory> = ["create_file", "modify_file"];

export function isWorkspaceFileCategory(value: string): value is WorkspaceFileCategory {
  return (WORKSPACE_FILE_CATEGORIES as ReadonlyArray<string>).includes(value);
}

export function normalizeRuleAction(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

export function ruleMatchesCategory(action: string, category: ToolActionCategory | string): boolean {
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

/** Effective workspace rule for a file category: block wins over ask, ask over allow; no rule means ask. */
export function workspaceFileBehavior(
  rules: ReadonlyArray<ToolPolicyRule>,
  category: WorkspaceFileCategory,
): ToolPolicyBehavior {
  const matches = rules
    .filter((rule) => (rule.scope ?? "workspace") === "workspace" && ruleMatchesCategory(rule.action, category))
    .map(({ behavior }) => behavior);
  if (matches.includes("block")) return "block";
  if (matches.includes("ask")) return "ask";
  if (matches.includes("allow")) return "allow";
  return "ask";
}

/**
 * Rewrites the workspace rules for one file category as a single explicit rule.
 * "Ask" is the default when no rule matches, so it needs no rule of its own.
 * The other category keeps its effective behavior, including one that came
 * from a shared rule such as "all file changes".
 */
export function withWorkspaceFileBehavior<Rule extends ToolPolicyRule>(
  rules: ReadonlyArray<Rule>,
  category: WorkspaceFileCategory,
  behavior: ToolPolicyBehavior,
  createId: () => string,
): Array<Rule | ToolPolicyRule> {
  const untouched = rules.filter(
    (rule) =>
      (rule.scope ?? "workspace") !== "workspace" ||
      !WORKSPACE_FILE_CATEGORIES.some((value) => ruleMatchesCategory(rule.action, value)),
  );
  const rewritten: ToolPolicyRule[] = [];
  for (const value of WORKSPACE_FILE_CATEGORIES) {
    const next = value === category ? behavior : workspaceFileBehavior(rules, value);
    if (next !== "ask") rewritten.push({ id: createId(), action: value, behavior: next, scope: "workspace" });
  }
  return [...untouched, ...rewritten];
}

/**
 * A Wisp's own permissions, kept in its config folder (ADR 023). Block rules
 * in the app-wide policy still win over everything here.
 */
export interface WispToolPolicy {
  /** File changes in the Wisp's workspace; a category left out follows the app-wide setting. */
  files: Partial<Record<WorkspaceFileCategory, ToolPolicyBehavior>>;
  /**
   * Risk mode: every action in ALLOW_EVERYTHING_CATEGORIES runs without
   * asking. Skills, jobs and commands outside a container are never covered.
   */
  allowEverything: boolean;
}

/** What risk mode allows without asking. */
export const ALLOW_EVERYTHING_CATEGORIES: ReadonlyArray<ToolActionCategory> = [
  "create_file",
  "modify_file",
  "external_write",
  "integration_call",
];

export interface WispToolPolicyView extends WispToolPolicy {
  conversationId: string;
  /** The app-wide behavior a file category follows when the Wisp sets none. */
  defaults: Record<WorkspaceFileCategory, ToolPolicyBehavior>;
}

export interface SaveWispToolPolicyRequest extends WispToolPolicy {
  conversationId: string;
}

export interface ToolApprovalRequest {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  scope: { kind: "workspace_path" | "integration" | "skill" | "container" | "job"; display: string };
  summary: string;
  /** What a job will do, shown for job approvals. */
  job?: JobApprovalDetails;
  /** Exact content to review, shown for skill changes; bounded and stripped of control characters. */
  preview?: string;
  /** The integration can remember this tool for this Wisp, so the card offers "Always allow". */
  alwaysAllowTool?: boolean;
  /** The integration can let this Wisp use all of it without asking, so the card offers that too. */
  alwaysAllowIntegration?: boolean;
  expiresAt: string;
}

/** A job as its approval card shows it: everything it may do while no one is present. */
export interface JobApprovalDetails {
  title: string;
  /** The schedule in words. */
  schedule: string;
  /** When it would run first (ISO 8601), absent when its schedule has ended. */
  nextRunAt?: string;
  instructions: string;
  skills: ReadonlyArray<string>;
  /** Tool names; the card shows their labels. */
  tools: ReadonlyArray<string>;
}

/**
 * "allow_always" lets this Wisp make that kind of workspace file change
 * without asking, or always allows one integration tool for this Wisp when the
 * request offers it (alwaysAllowTool). "allow_integration" lets this Wisp use
 * the whole integration without asking (alwaysAllowIntegration). "block"
 * blocks file changes of that kind for this Wisp, and integration calls for
 * every Wisp.
 */
export type ToolApprovalDecision = "allow_once" | "allow_always" | "allow_integration" | "deny" | "block";

export interface ResolveToolApprovalRequest {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  decision: ToolApprovalDecision;
}
