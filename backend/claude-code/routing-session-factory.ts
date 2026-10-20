import type { ModelSelection } from "../../shared/contracts.js";
import type { ConversationAgentContext } from "../conversation-agent.js";
import type { AgentScope } from "../integration-tool-source.js";
import type { JobSessionFactory } from "../job-runner.js";
import type { RuntimeJobSession, RuntimeModel, RuntimeSession, RuntimeSessionFactory } from "../runtime-session.js";
import type { JobSessionSpec } from "../wisp-session-plan.js";
import { CLAUDE_CODE_PROVIDER } from "./claude-code-models.js";
import type { ClaudeCodeSessionFactory } from "./claude-code-session-factory.js";

function isClaudeCode(selection: ModelSelection): boolean {
  return selection.providerId === CLAUDE_CODE_PROVIDER;
}

/**
 * Gives Wisps on the `claude-code` provider Claude Code sessions, for their
 * conversations and their job runs, and every other Wisp Pi's (ADR 026).
 */
export class RoutingSessionFactory implements RuntimeSessionFactory, JobSessionFactory {
  constructor(
    private readonly pi: RuntimeSessionFactory & JobSessionFactory,
    private readonly claudeCode: Pick<ClaudeCodeSessionFactory, "resolveModel" | "create" | "createJobSession">,
  ) {}

  resolveModel(selection: ModelSelection): RuntimeModel {
    return isClaudeCode(selection)
      ? (this.claudeCode.resolveModel(selection) as unknown as RuntimeModel)
      : this.pi.resolveModel(selection);
  }

  create(context: ConversationAgentContext, selection: ModelSelection): Promise<RuntimeSession> {
    return isClaudeCode(selection) ? this.claudeCode.create(context, selection) : this.pi.create(context, selection);
  }

  createJobSession(
    context: ConversationAgentContext,
    selection: ModelSelection,
    job: JobSessionSpec,
  ): Promise<RuntimeJobSession> {
    return isClaudeCode(selection)
      ? this.claudeCode.createJobSession(context, selection, job)
      : this.pi.createJobSession(context, selection, job);
  }

  getToolRevision(scope: AgentScope): Promise<string | null> {
    return this.pi.getToolRevision(scope);
  }

  sameRuntime(current: ModelSelection, next: ModelSelection): boolean {
    return isClaudeCode(current) === isClaudeCode(next);
  }
}
