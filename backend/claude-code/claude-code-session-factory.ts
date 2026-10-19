import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ModelSelection } from "../../shared/contracts.js";
import { writeFileAtomically } from "../atomic-file.js";
import { WispBackendError } from "../backend-error.js";
import type { ConversationAgentContext } from "../conversation-agent.js";
import { defaultToolRevision, type JobSessionSpec, type WispSessionBuilder } from "../wisp-session-plan.js";
import { ClaudeCodeJobSession } from "./claude-code-job-session.js";
import { claudeCodeQueryOptions, type ClaudeCodeQueryOptions } from "./claude-code-launch.js";
import { claudeCodeModel, type ClaudeCodeModel } from "./claude-code-models.js";
import { claudeCodeEffort, ClaudeCodeSession, type ClaudeCodeQuery } from "./claude-code-session.js";
import { claudeCodeUnavailableMessage, type ClaudeCodeStatusService } from "./claude-code-status.js";
import { createWispMcpServer, type WispMcpTool } from "./wisp-mcp-server.js";

/** Claude Code's session for a Wisp in a conversation, kept with the Wisp's session there. */
const SESSION_FILE = "claude-code-session.json";
const CONTEXT_SETTINGS_FILE = "context-settings.json";
const MAX_MEMORY_LENGTH = 8_000;

export interface ClaudeCodeSessionFactoryOptions {
  /** Builds the Wisp's system prompt and tools, the same as for a Pi session. */
  builder: Pick<WispSessionBuilder, "plan" | "tools">;
  status: ClaudeCodeStatusService;
  /** The Agent SDK's `query`; injected by tests. */
  query?: ClaudeCodeQuery;
  /** The server's environment, which Claude Code receives a few variables of. */
  environment?: NodeJS.ProcessEnv;
  /** The latest of a conversation's messages, carried into a session that replaces a lost one. */
  recentTranscript?: (conversationId: string) => Promise<string>;
  /** `search_history` for a Claude Code Wisp: Claude Code keeps its own history, so the Wisp's transcript is searched. */
  searchHistory?: (conversationId: string, query: string) => Promise<string>;
}

/** The memory the person keeps for the Wisp, as the Pi session reads it. */
async function readMemory(configDirectory: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(path.join(configDirectory, CONTEXT_SETTINGS_FILE), "utf8")) as {
      memory?: unknown;
    };
    return typeof data.memory === "string" && data.memory.length <= MAX_MEMORY_LENGTH && data.memory
      ? data.memory
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a process of a conversation or of a job run starts with. */
interface ProcessLaunch {
  model: string;
  effort?: ClaudeCodeQueryOptions["effort"];
  /** Null for a job run, which Claude Code keeps no session of. */
  session: { id: string; resume: boolean } | null;
  recoveredContext?: string;
}

/** What every Claude Code process of a Wisp shares: its query function, tools, and options. */
interface Prepared {
  model: ClaudeCodeModel;
  query: ClaudeCodeQuery;
  toolNames: string[];
  toolRevision: string;
  queryOptions: (launch: ProcessLaunch) => Promise<ClaudeCodeQueryOptions>;
}

/** Sessions for Wisps on the `claude-code` provider (ADR 026). */
export class ClaudeCodeSessionFactory {
  private readonly options: ClaudeCodeSessionFactoryOptions;

  constructor(options: ClaudeCodeSessionFactoryOptions) {
    this.options = options;
  }

  /** The model a selection names, when Claude Code is ready to run it; throws otherwise. */
  resolveModel(selection: ModelSelection): ClaudeCodeModel {
    const unavailable = claudeCodeUnavailableMessage(this.options.status.current());
    if (unavailable) throw new WispBackendError("configuration_required", unavailable);
    const model = claudeCodeModel(selection.modelId);
    if (!model) throw new WispBackendError("model_unavailable", "The selected model is no longer available.");
    return model;
  }

  async create(context: ConversationAgentContext, selection: ModelSelection): Promise<ClaudeCodeSession> {
    const prepared = await this.prepare(context, selection);
    const identity = await this.readSession(context);
    return new ClaudeCodeSession({
      query: prepared.query,
      sessionId: identity.sessionId,
      resume: identity.resume,
      model: prepared.model.id,
      thinkingLevel: selection.thinkingLevel ?? "off",
      toolNames: prepared.toolNames,
      toolRevision: prepared.toolRevision,
      queryOptions: (launch) =>
        prepared.queryOptions({
          model: launch.model,
          ...(launch.effort ? { effort: launch.effort } : {}),
          session: { id: launch.sessionId, resume: launch.resume },
          ...(launch.recoveredContext ? { recoveredContext: launch.recoveredContext } : {}),
        }),
      onSessionSaved: (sessionId) => this.writeSession(context, sessionId),
      ...(this.options.recentTranscript
        ? { recentTranscript: () => this.options.recentTranscript!(context.conversationId) }
        : {}),
    });
  }

  /**
   * One run of a job (ADR 019): the Wisp's identity, memory, and the job's
   * tools and skills, in a Claude Code process that keeps no session.
   */
  async createJobSession(
    context: ConversationAgentContext,
    selection: ModelSelection,
    job: JobSessionSpec,
  ): Promise<ClaudeCodeJobSession> {
    const prepared = await this.prepare(context, selection, job);
    const effort = claudeCodeEffort(selection.thinkingLevel ?? "off");
    return new ClaudeCodeJobSession({
      query: prepared.query,
      toolNames: prepared.toolNames,
      queryOptions: () =>
        prepared.queryOptions({ model: prepared.model.id, ...(effort ? { effort } : {}), session: null }),
    });
  }

  private async prepare(
    context: ConversationAgentContext,
    selection: ModelSelection,
    job?: JobSessionSpec,
  ): Promise<Prepared> {
    const status = await this.options.status.refresh();
    const unavailable = claudeCodeUnavailableMessage(status);
    const executable = this.options.status.executable();
    if (unavailable || !executable) {
      throw new WispBackendError("configuration_required", unavailable ?? claudeCodeUnavailableMessage(undefined)!);
    }
    const model = this.resolveModel(selection);
    const plan = await this.options.builder.plan(context, job);
    const tools = await this.options.builder.tools(context, plan, {
      ...(job ? { job } : {}),
      searchHistory: (query) => this.options.searchHistory?.(context.conversationId, query),
    });
    const { validateToolArguments } = await import("@earendil-works/pi-ai");
    const query =
      this.options.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as ClaudeCodeQuery);
    const offered = async (): Promise<ReadonlyArray<WispMcpTool>> => {
      const allowed = new Set(await tools.getAllowedTools());
      return tools.definitions.filter(({ name }) => allowed.has(name)) as unknown as WispMcpTool[];
    };
    return {
      model,
      query,
      toolNames: await tools.getAllowedTools(),
      toolRevision: plan.snapshot?.revision ?? defaultToolRevision,
      queryOptions: async (launch) =>
        claudeCodeQueryOptions({
          workspaceDirectory: context.workspaceDirectory,
          executable,
          model: launch.model,
          ...(launch.effort ? { effort: launch.effort } : {}),
          systemPrompt: [
            plan.systemPrompt(),
            ...(await plan.runSections(await readMemory(context.configDirectory))),
          ].join("\n\n"),
          session: launch.session,
          ...(launch.recoveredContext ? { recoveredContext: launch.recoveredContext } : {}),
          // A server instance connects once, so each process gets its own.
          wispTools: createWispMcpServer({
            tools: offered,
            workspaceDirectory: context.workspaceDirectory,
            validate: (tool, toolCall) => validateToolArguments(tool as never, toolCall as never),
          }),
          // No Claude Code tool that prompts is offered yet; anything that asks is refused.
          authorize: async () => ({ behavior: "deny", message: "This Wisp cannot use that tool." }),
          environment: this.options.environment ?? process.env,
        }),
    };
  }

  private async readSession(context: ConversationAgentContext): Promise<{ sessionId: string; resume: boolean }> {
    try {
      const data = JSON.parse(await readFile(path.join(context.sessionDirectory, SESSION_FILE), "utf8")) as {
        sessionId?: unknown;
      };
      if (typeof data.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(data.sessionId)) {
        return { sessionId: data.sessionId, resume: true };
      }
    } catch {
      // A new session.
    }
    // Saved once a turn in it succeeds.
    return { sessionId: randomUUID(), resume: false };
  }

  private async writeSession(context: ConversationAgentContext, sessionId: string): Promise<void> {
    await writeFileAtomically(
      path.join(context.sessionDirectory, SESSION_FILE),
      `${JSON.stringify({ sessionId }, null, 2)}\n`,
    );
  }
}
