import type { ModelSelection } from "../../shared/contracts.js";
import type { ConversationAgentContext } from "../conversation-agent.js";
import type { RuntimeModel, RuntimeSession, RuntimeSessionFactory } from "../runtime-session.js";
import { CLAUDE_CODE_PROVIDER } from "./claude-code-models.js";
import type { ClaudeCodeSessionFactory } from "./claude-code-session-factory.js";

function isClaudeCode(selection: ModelSelection): boolean {
  return selection.providerId === CLAUDE_CODE_PROVIDER;
}

/** Gives Wisps on the `claude-code` provider Claude Code sessions, and every other Wisp Pi's (ADR 026). */
export class RoutingSessionFactory implements RuntimeSessionFactory {
  constructor(
    private readonly pi: RuntimeSessionFactory,
    private readonly claudeCode: Pick<ClaudeCodeSessionFactory, "resolveModel" | "create">,
  ) {}

  resolveModel(selection: ModelSelection): RuntimeModel {
    return isClaudeCode(selection)
      ? (this.claudeCode.resolveModel(selection) as unknown as RuntimeModel)
      : this.pi.resolveModel(selection);
  }

  create(context: ConversationAgentContext, selection: ModelSelection): Promise<RuntimeSession> {
    return isClaudeCode(selection) ? this.claudeCode.create(context, selection) : this.pi.create(context, selection);
  }

  getToolRevision(conversationId: string): Promise<string | null> {
    return this.pi.getToolRevision(conversationId);
  }

  sameRuntime(current: ModelSelection, next: ModelSelection): boolean {
    return isClaudeCode(current) === isClaudeCode(next);
  }
}
