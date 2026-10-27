import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { CLAUDE_CODE_PROVIDER } from "../../shared/claude-code.js";
import type { ModelSelection } from "../../shared/contracts.js";
import { WEB_SEARCH_METADATA } from "../../shared/plugin-tools/web.js";
import { writeFileAtomically } from "../atomic-file.js";
import { WispBackendError } from "../backend-error.js";
import { systemTimeZone } from "../../shared/time-zone.js";
import { CONTEXT_SETTINGS_FILE, loadContextSettings, saveContextSettings } from "../context-session.js";
import type { ConversationAgentContext } from "../conversation-agent.js";
import type { ModelHolds } from "../model-holds.js";
import type { RuntimeSession } from "../runtime-session.js";
import { defaultToolRevision, type JobSessionSpec, type WispSessionBuilder } from "../wisp-session-plan.js";
import { ClaudeCodeJobSession } from "./claude-code-job-session.js";
import { claudeCodeEnvironment, claudeCodeQueryOptions, type ClaudeCodeQueryOptions } from "./claude-code-launch.js";
import { purgeClaudeCodeProject, type ClaudeCodeProcesses } from "./claude-code-processes.js";
import { claudeCodeModel, type ClaudeCodeModel } from "./claude-code-models.js";
import {
  claudeCodeEffort,
  ClaudeCodeSession,
  type ClaudeCodeQuery,
  type ClaudeCodeSavedSession,
} from "./claude-code-session.js";
import { claudeCodeUnavailableMessage, type ClaudeCodeStatusService } from "./claude-code-status.js";
import type { ClaudeCodeEventConverter, ClaudeCodeTurnResult } from "./claude-code-events.js";
import {
  appendClaudeCodeUsage,
  CLAUDE_CODE_USAGE_FILE,
  claudeCodeFallbackEntry,
  claudeCodeUsageEntry,
} from "./claude-code-usage-log.js";
import { createWispMcpServer, type WispMcpTool, type WispToolObserver } from "./wisp-mcp-server.js";

/** Claude Code's own web search tool. */
const CLAUDE_CODE_WEB_SEARCH_TOOL = "WebSearch";

/** Claude Code's session for a Wisp in a conversation, kept with the Wisp's session there. */
const SESSION_FILE = "claude-code-session.json";
/** How many replaced Claude Code sessions a session file remembers. */
const MAX_PAST_SESSIONS = 200;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

/** The session file's fields, or none when it is missing or unreadable. */
async function readSessionFile(sessionDirectory: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(sessionDirectory, SESSION_FILE), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // A new session.
  }
  return {};
}

export interface ClaudeCodeSessionFactoryOptions {
  /** Builds the Wisp's system prompt and tools, the same as for a Pi session. */
  builder: Pick<WispSessionBuilder, "plan" | "tools">;
  status: ClaudeCodeStatusService;
  /** The Agent SDK's `query`; injected by tests. */
  query?: ClaudeCodeQuery;
  /** The server's environment, which Claude Code receives a few variables of. */
  environment?: NodeJS.ProcessEnv;
  /** The latest of a conversation's messages, as the Wisp is told them, carried into a session that replaces a lost one. */
  recentTranscript?: (context: ConversationAgentContext) => Promise<string>;
  /** `search_history` for a Claude Code Wisp: Claude Code keeps its own history, so the Wisp's transcript is searched. */
  searchHistory?: (conversationId: string, query: string) => Promise<string>;
  /** Tracks the processes, so a deleted Wisp's data is purged once they exited. */
  processes?: ClaudeCodeProcesses;
  /** Deletes what Claude Code keeps for a workspace; injected by tests. */
  purgeProject?: (executable: string, workspaceDirectory: string, env: Record<string, string>) => Promise<void>;
  /** Deletes one Claude Code session of a workspace: the Agent SDK's `deleteSession`; injected by tests. */
  deleteSession?: (sessionId: string, options: { dir: string }) => Promise<void>;
  /** Whether the Wisp searches with Claude Code's own WebSearch instead of a plugin's web_search. */
  webSearch?: (wispId: string) => boolean;
  /** A session on the Wisp's fallback model for a turn Claude Code failed for good (ADR 021), or null. */
  fallback?: (context: ConversationAgentContext) => Promise<{ name: string; session: RuntimeSession } | null>;
  /** Models on hold after a rate limit or an outage, shared with Pi's sessions (ADR 035). */
  holds?: ModelHolds;
}

/** What a process of a conversation or of a job run starts with. */
interface ProcessLaunch {
  model: string;
  effort?: ClaudeCodeQueryOptions["effort"];
  /** Null for a job run, which Claude Code keeps no session of. */
  session: { id: string; resume: boolean } | null;
  recoveredContext?: string;
  /** Told what the Wisp's tools report; a job run's process has none. */
  observer?: WispToolObserver;
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
  /** Claude Code's cumulative cost estimate per process, by the process's converter. */
  private readonly processCosts = new WeakMap<ClaudeCodeEventConverter, number>();

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
    const saved = await this.readSession(context);
    const settingsPath = path.join(context.configDirectory, CONTEXT_SETTINGS_FILE);
    return new ClaudeCodeSession({
      query: prepared.query,
      sessionId: saved.sessionId ?? randomUUID(),
      resume: saved.sessionId !== null,
      state: { lastActivityAt: saved.lastActivityAt, lastRenewedAt: saved.lastRenewedAt, tokens: saved.tokens },
      context: {
        load: () => loadContextSettings(settingsPath),
        save: (settings) => saveContextSettings(settingsPath, settings),
        timeZone: () => context.userTimeZone?.() ?? systemTimeZone(),
        onRenewed: (kind, at) => context.onContextRenewed?.(kind, at),
      },
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
          observer: launch.observer,
        }),
      onSessionSaved: (session) => this.writeSession(context, session),
      onTurnResult: (result, converter) => this.recordTurn(context, prepared.model.id, result, converter),
      onFallback: (model) => this.appendUsage(context, claudeCodeFallbackEntry(model, new Date())),
      ...(this.options.holds ? { hold: modelHold(this.options.holds, prepared.model.id) } : {}),
      ...(this.options.fallback ? { fallback: () => this.options.fallback!(context) } : {}),
      ...(this.options.recentTranscript ? { recentTranscript: () => this.options.recentTranscript!(context) } : {}),
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
    const searchesWithClaude = () => this.options.webSearch?.(context.wispId) ?? false;
    const tools = await this.options.builder.tools(context, plan, {
      ...(job ? { job } : {}),
      searchHistory: (query) => this.options.searchHistory?.(context.conversationId, query),
      runtimeTools: () => (searchesWithClaude() ? [WEB_SEARCH_METADATA.name] : []),
    });
    // A job run searches only when the job has web_search, as on Pi.
    const webSearch = async () =>
      searchesWithClaude() && (await tools.getAllowedTools()).includes(WEB_SEARCH_METADATA.name);
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
          systemPrompt: [plan.systemPrompt(), ...(await plan.runSections())].join("\n\n"),
          session: launch.session,
          ...(launch.recoveredContext ? { recoveredContext: launch.recoveredContext } : {}),
          // A server instance connects once, so each process gets its own.
          wispTools: createWispMcpServer({
            tools: offered,
            workspaceDirectory: context.workspaceDirectory,
            validate: (tool, toolCall) => validateToolArguments(tool as never, toolCall as never),
            ...(launch.observer ? { observer: launch.observer } : {}),
          }),
          ...((await webSearch()) ? { webSearch: true } : {}),
          // WebSearch asks before each search; it is allowed as a plugin's web_search is, while it is still chosen.
          authorize: async (toolName, input) =>
            toolName === CLAUDE_CODE_WEB_SEARCH_TOOL && (await webSearch())
              ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: "This Wisp cannot use that tool." },
          environment: this.options.environment ?? process.env,
          ...(this.options.processes ? { spawn: this.options.processes.spawn } : {}),
        }),
    };
  }

  /** Whether a Wisp's conversation ran on Claude Code, so Claude Code keeps data for it. */
  async usedClaudeCode(sessionDirectory: string): Promise<boolean> {
    for (const file of [SESSION_FILE, CLAUDE_CODE_USAGE_FILE]) {
      if (
        await access(path.join(sessionDirectory, file)).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  }

  /**
   * Deletes what Claude Code keeps for a deleted Wisp's workspace, its
   * transcripts among them, once its processes exited (ADR 026).
   */
  async purge(workspaceDirectory: string): Promise<void> {
    const executable = this.options.status.executable();
    if (!executable) return;
    await this.options.processes?.whenExited(workspaceDirectory);
    await (this.options.purgeProject ?? purgeClaudeCodeProject)(
      executable,
      workspaceDirectory,
      claudeCodeEnvironment(this.options.environment ?? process.env),
    );
  }

  /**
   * Every Claude Code session a Wisp's session folder used: the current one,
   * and those a new topic or a lost session replaced.
   */
  async sessionIds(sessionDirectory: string): Promise<string[]> {
    const data = await readSessionFile(sessionDirectory);
    const current = isSessionId(data.sessionId) ? [data.sessionId] : [];
    const past = Array.isArray(data.pastSessionIds) ? data.pastSessionIds.filter(isSessionId) : [];
    return [...new Set([...current, ...past])];
  }

  /**
   * Deletes some of a workspace's Claude Code sessions and leaves the others,
   * as when one member leaves a circle (ADR 011), once the processes there
   * exited. A session Claude Code no longer has is skipped.
   */
  async deleteSessions(workspaceDirectory: string, sessionIds: ReadonlyArray<string>): Promise<void> {
    if (!sessionIds.length) return;
    await this.options.processes?.whenExited(workspaceDirectory);
    const deleteSession = this.options.deleteSession ?? (await import("@anthropic-ai/claude-agent-sdk")).deleteSession;
    for (const sessionId of sessionIds) {
      await deleteSession(sessionId, { dir: workspaceDirectory }).catch(() => undefined);
    }
  }

  /**
   * Records a turn's usage for the session report, and the plan's usage for
   * the status. Claude Code's cost estimate adds up over a process's turns,
   * so a turn's cost is what it added.
   */
  private recordTurn(
    context: ConversationAgentContext,
    alias: string,
    result: ClaudeCodeTurnResult,
    converter: ClaudeCodeEventConverter,
  ): void {
    this.options.status.recordPlanUsage(converter.planUsage);
    const status = this.options.status.current();
    const billing = status?.state === "ready" ? status.billing : "subscription";
    const previous = this.processCosts.get(converter) ?? 0;
    const cost = result.estimatedCostUsd === null ? null : Math.max(0, result.estimatedCostUsd - previous);
    if (result.estimatedCostUsd !== null) this.processCosts.set(converter, result.estimatedCostUsd);
    if (result.usage.totalTokens === 0 && result.ok === false) return;
    this.appendUsage(context, claudeCodeUsageEntry(result, converter.model ?? alias, billing, cost, new Date()));
  }

  private appendUsage(context: ConversationAgentContext, entry: object): void {
    // The report misses a turn it could not record; the conversation goes on.
    void appendClaudeCodeUsage(context.sessionDirectory, entry).catch(() => undefined);
  }

  /** The saved session, or a new one's state; the ID is null until a turn in the session succeeded. */
  private async readSession(context: ConversationAgentContext): Promise<ClaudeCodeSavedSession> {
    const data = await readSessionFile(context.sessionDirectory);
    const timestamp = (value: unknown) =>
      typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
    return {
      sessionId: isSessionId(data.sessionId) ? data.sessionId : null,
      lastActivityAt: timestamp(data.lastActivityAt),
      lastRenewedAt: timestamp(data.lastRenewedAt),
      tokens:
        typeof data.tokens === "number" && Number.isSafeInteger(data.tokens) && data.tokens >= 0 ? data.tokens : 0,
    };
  }

  /** Saves the session, remembering the one it replaced, so the Wisp's sessions can be deleted later. */
  private async writeSession(context: ConversationAgentContext, session: ClaudeCodeSavedSession): Promise<void> {
    const previous = await readSessionFile(context.sessionDirectory);
    const past = Array.isArray(previous.pastSessionIds) ? previous.pastSessionIds.filter(isSessionId) : [];
    if (isSessionId(previous.sessionId) && previous.sessionId !== session.sessionId) past.push(previous.sessionId);
    const pastSessionIds = [...new Set(past)].slice(-MAX_PAST_SESSIONS);
    await writeFileAtomically(
      path.join(context.sessionDirectory, SESSION_FILE),
      `${JSON.stringify({ ...session, ...(pastSessionIds.length ? { pastSessionIds } : {}) }, null, 2)}\n`,
    );
  }
}

/** The hold on one of Claude Code's models, as a session reads and sets it. */
function modelHold(holds: ModelHolds, modelId: string): { until(): number | undefined; set(until: number): void } {
  const model = { provider: CLAUDE_CODE_PROVIDER, id: modelId };
  return { until: () => holds.heldUntil(model), set: (until) => holds.hold(model, until) };
}
