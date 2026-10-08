/**
 * "integration_call" is the generic category for dynamically discovered MCP
 * tools. Server-supplied annotations are untrusted, so these calls never map to
 * "read" or "write". They ask unless the user always allowed that exact tool
 * for that Wisp; policy rules can block them but never allow them.
 *
 * "save_skill" creates or updates one of the Wisp's own skills. It always asks:
 * policy rules can neither allow nor block it.
 */
export type ToolActionCategory =
  | "read"
  | "search"
  | "create_file"
  | "modify_file"
  | "external_write"
  | "integration_call"
  | "save_skill"
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

export interface ToolApprovalRequest {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  scope: { kind: "workspace_path" | "integration" | "skill"; display: string };
  summary: string;
  /** Exact content to review, shown for skill changes; bounded and stripped of control characters. */
  preview?: string;
  /** The integration can remember this tool for this Wisp, so the card offers "Always allow". */
  alwaysAllowTool?: boolean;
  expiresAt: string;
}

/**
 * "allow_always" saves an Allow rule for workspace file changes while
 * auto-review is on, or always allows one integration tool for one Wisp when
 * the request offers it (alwaysAllowTool).
 */
export type ToolApprovalDecision = "allow_once" | "allow_always" | "deny" | "block";

export interface ResolveToolApprovalRequest {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  decision: ToolApprovalDecision;
}
