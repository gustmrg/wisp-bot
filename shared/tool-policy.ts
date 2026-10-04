/**
 * "integration_call" is the generic category for dynamically discovered MCP
 * tools. Server-supplied annotations are untrusted, so these calls never map to
 * "read" or "write"; the initial behavior is always to ask.
 */
export type ToolActionCategory =
  | "read"
  | "search"
  | "create_file"
  | "modify_file"
  | "external_write"
  | "integration_call"
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

export interface ToolApprovalRequest {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  category: ToolActionCategory;
  scope: { kind: "workspace_path" | "integration"; display: string };
  summary: string;
  expiresAt: string;
}

export type ToolApprovalDecision = "allow_once" | "deny" | "block";

export interface ResolveToolApprovalRequest {
  approvalId: string;
  conversationId: string;
  toolCallId: string;
  decision: ToolApprovalDecision;
}
