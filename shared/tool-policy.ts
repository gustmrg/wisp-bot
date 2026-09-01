export type ToolActionCategory = "read" | "search" | "create_file" | "modify_file" | "shell";
export type ToolPolicyBehavior = "allow" | "ask" | "block";

export interface ToolPolicyRule {
  id: string;
  action: string;
  behavior: ToolPolicyBehavior;
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
