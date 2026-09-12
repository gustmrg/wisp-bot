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
