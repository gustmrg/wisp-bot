import type { ModelSelection } from "../../shared/contracts.js";
import type { ConversationAgentContext } from "../conversation-agent.js";
import type { PiSessionFactory, PiSessionLike } from "../pi-conversation-agent.js";
import { CLAUDE_CODE_PROVIDER } from "./claude-code-models.js";
import type { ClaudeCodeSessionFactory } from "./claude-code-session-factory.js";

type PiModel = ReturnType<PiSessionFactory["resolveModel"]>;

function isClaudeCode(selection: ModelSelection): boolean {
  return selection.providerId === CLAUDE_CODE_PROVIDER;
}

/** Gives Wisps on the `claude-code` provider Claude Code sessions, and every other Wisp Pi's (ADR 026). */
export class RoutingSessionFactory implements PiSessionFactory {
  constructor(
    private readonly pi: PiSessionFactory,
    private readonly claudeCode: Pick<ClaudeCodeSessionFactory, "resolveModel" | "create">,
  ) {}

  resolveModel(selection: ModelSelection): PiModel {
    return isClaudeCode(selection)
      ? (this.claudeCode.resolveModel(selection) as unknown as PiModel)
      : this.pi.resolveModel(selection);
  }

  create(context: ConversationAgentContext, selection: ModelSelection): Promise<PiSessionLike> {
    return isClaudeCode(selection) ? this.claudeCode.create(context, selection) : this.pi.create(context, selection);
  }

  getToolRevision(conversationId: string): Promise<string | null> {
    return this.pi.getToolRevision(conversationId);
  }

  sameRuntime(current: ModelSelection, next: ModelSelection): boolean {
    return isClaudeCode(current) === isClaudeCode(next);
  }
}
