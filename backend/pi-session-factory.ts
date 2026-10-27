/** Pi sessions for Wisps on API-key providers (ADR 001). */

import { access } from "node:fs/promises";
import path from "node:path";

import { ContextSession } from "./context-session.js";
import type {
  AgentSession,
  AgentSessionEvent,
  InlineExtension,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import type { ModelSelection, ThinkingLevel } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { AgentScope, IntegrationToolSource } from "./integration-tool-source.js";
import type { JobToolHost } from "./job-tools.js";
import type { WispToolHost } from "./wisp-tools.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import type { ModelRuntimeLike } from "./model-service.js";
import { systemTimeZone } from "../shared/time-zone.js";
import type { PiAgentEvent } from "./pi-event-translator.js";
import { AUXILIARY_USAGE_ENTRY, ImageTranscriber } from "./image-transcriber.js";
import { TRANSCRIPTION_CACHE_DIRECTORY, TranscriptionCache } from "./transcription-cache.js";
import { FALLBACK_ENTRY, ModelFallback } from "./model-fallback.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import type { RuntimeJobSession, RuntimeModel, RuntimeSession, RuntimeSessionFactory } from "./runtime-session.js";
import {
  BlockMutationAuthorizer,
  defaultToolRevision,
  WispSessionBuilder,
  type JobSessionSpec,
} from "./wisp-session-plan.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
/** Pi's retries of a model call that may pass; after them the call goes to the fallback, if any. */
const MODEL_RETRIES = 2;

/** A model's name for people, without control characters. */
function displayModelName(model: { id: string; name?: string }): string {
  const name = (model.name || model.id).replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return name.slice(0, 256) || model.id.slice(0, 256);
}

interface BuiltSession {
  session: AgentSession;
  sessionManager: SessionManager;
  fallback: ModelFallback;
  /** Listeners told the name of the fallback model when a turn moves to it. */
  fallbackListeners: Set<(model: string) => void>;
  continuity: ContextSession;
  refreshTools: () => Promise<void>;
  snapshot: Awaited<ReturnType<IntegrationToolSource["getSnapshot"]>> | undefined;
  version: string;
}

export class SdkPiSessionFactory implements RuntimeSessionFactory {
  private readonly modelRuntime: ModelRuntimeLike;
  private readonly toolSource?: IntegrationToolSource;
  private readonly getImageModel?: () => Promise<ModelSelection | null>;
  private readonly getFallbackModel?: (wispId: string) => Promise<ModelSelection | null>;
  private readonly builder: WispSessionBuilder;

  constructor(
    modelRuntime: ModelRuntimeLike,
    authorizationBroker: Pick<ToolAuthorizationBroker, "authorize"> = new BlockMutationAuthorizer(),
    toolSource?: IntegrationToolSource,
    /** The auxiliary image model for Wisps whose model cannot see images, or null when that task is off. */
    getImageModel?: () => Promise<ModelSelection | null>,
    /** Where the Wisp's jobs live; without it, Wisps have no job tools. */
    jobs?: JobToolHost,
    /** The model a Wisp answers with when its own fails for good, or null when it has none. */
    getFallbackModel?: (wispId: string) => Promise<ModelSelection | null>,
    /** Where the person's Wisps live; without it, Wisps have no Wisp tools. */
    wisps?: WispToolHost,
  ) {
    this.modelRuntime = modelRuntime;
    this.toolSource = toolSource;
    this.getImageModel = getImageModel;
    this.getFallbackModel = getFallbackModel;
    this.builder = new WispSessionBuilder({ authorizationBroker, toolSource, jobs, wisps });
  }

  async getToolRevision(scope: AgentScope): Promise<string | null> {
    if (!this.toolSource) return null;
    try {
      return (await this.toolSource.getSnapshot(scope)).revision;
    } catch {
      return null;
    }
  }

  resolveModel(selection: ModelSelection): RuntimeModel {
    if (!this.modelRuntime.hasConfiguredAuth(selection.providerId)) {
      throw new WispBackendError(
        "configuration_required",
        "Configure an API key for the selected provider before sending a message.",
      );
    }
    const model = this.modelRuntime.getModel(selection.providerId, selection.modelId);
    if (!model) {
      throw new WispBackendError("model_unavailable", "The selected model is no longer available.");
    }
    const maxOutputTokens = selection.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    return model.maxTokens > maxOutputTokens ? { ...model, maxTokens: maxOutputTokens } : model;
  }

  async create(context: ConversationAgentContext, selection: ModelSelection): Promise<RuntimeSession> {
    const { session, sessionManager, fallback, fallbackListeners, continuity, refreshTools, snapshot, version } =
      await this.build(context, selection);
    try {
      await context.savePiSessionIdentity?.({
        sessionId: session.sessionId,
        sessionFile: session.sessionFile ?? null,
      });
    } catch (error) {
      session.dispose();
      throw error;
    }
    recordSessionIdentity(sessionManager, version, snapshot?.metadata ?? []);
    const unsubscribeTelemetry = session.subscribe((event) => {
      if (event.type === "compaction_end" && event.result && !event.aborted) continuity.renewed("compacted");
      if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
        sessionManager.appendCustomEntry("wisp:retry", {
          phase: event.type === "auto_retry_start" ? "started" : "finished",
        });
      }
    });
    return adaptSession(
      session,
      unsubscribeTelemetry,
      continuity,
      refreshTools,
      snapshot?.revision ?? defaultToolRevision,
      fallback,
      fallbackListeners,
    );
  }

  /**
   * A session for one run of a job (ADR 019): the Wisp's model, identity,
   * memory, plugins, MCP servers, workspace and container, with the job's
   * skills and tools, but none of the conversation's history.
   */
  async createJobSession(
    context: ConversationAgentContext,
    selection: ModelSelection,
    job: JobSessionSpec,
  ): Promise<RuntimeJobSession> {
    const { session, sessionManager, snapshot, version } = await this.build(context, selection, job);
    recordSessionIdentity(sessionManager, version, snapshot?.metadata ?? []);
    return adaptJobSession(session);
  }

  private async build(
    context: ConversationAgentContext,
    selection: ModelSelection,
    job?: JobSessionSpec,
  ): Promise<BuiltSession> {
    const model = this.resolveModel(selection);
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, VERSION } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const fallbackListeners = new Set<(model: string) => void>();
    let recordFallback: ((model: string) => void) | undefined;
    const fallback = new ModelFallback({
      pi: await import("@earendil-works/pi-ai"),
      resolve: async () => {
        const choice = await this.getFallbackModel?.(context.wispId);
        return choice ? this.resolveModel(choice) : null;
      },
      onFallback: (model) => {
        const name = displayModelName(model);
        recordFallback?.(name);
        for (const listener of fallbackListeners) listener(name);
      },
      retries: MODEL_RETRIES,
    });
    let continuity: ContextSession | undefined;
    const plan = await this.builder.plan(context, job);
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.workspaceDirectory,
      agentDir: context.configDirectory,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => plan.systemPrompt(),
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        providerRequestExtension(
          context.workspaceDirectory,
          () => fallback.fallbackRequest?.thinkingLevel ?? session?.thinkingLevel ?? "off",
          () => fallback.fallbackRequest?.provider,
        ),
        {
          name: "wisp-continuity",
          hidden: true,
          factory: (pi) => {
            pi.on("before_agent_start", async (event) => {
              const sections = await plan.runSections();
              return sections.length ? { systemPrompt: [event.systemPrompt, ...sections].join("\n\n") } : undefined;
            });
          },
        },
      ],
    });
    await resourceLoader.reload();

    let sessionManager;
    if (job) {
      sessionManager = SessionManager.create(context.workspaceDirectory, job.runDirectory, { id: job.runId });
    } else if (context.piSessionFile && (await fileExists(context.piSessionFile))) {
      sessionManager = SessionManager.open(context.piSessionFile, context.sessionDirectory, context.workspaceDirectory);
    } else {
      const recent = SessionManager.continueRecent(context.workspaceDirectory, context.sessionDirectory);
      sessionManager =
        recent.getSessionFile() && (await fileExists(recent.getSessionFile()!))
          ? recent
          : SessionManager.create(context.workspaceDirectory, context.sessionDirectory, {
              id: context.piSessionId ?? context.sessionId,
            });
    }
    const transcriber = this.getImageModel
      ? new ImageTranscriber({
          getSelection: this.getImageModel,
          runtime: this.modelRuntime as ModelRuntime,
          cache: new TranscriptionCache(path.join(context.configDirectory, TRANSCRIPTION_CACHE_DIRECTORY)),
          recordUsage: (entry) => sessionManager.appendCustomEntry(AUXILIARY_USAGE_ENTRY, entry),
        })
      : undefined;
    const tools = await this.builder.tools(context, plan, {
      ...(job ? { job } : {}),
      ...(transcriber ? { transcriber } : {}),
      searchHistory: (query) => continuity?.search(query),
    });
    // Read by the provider request hook, which runs only after the session exists.
    let session: AgentSession | undefined;
    ({ session } = await createAgentSession({
      cwd: context.workspaceDirectory,
      agentDir: context.configDirectory,
      model,
      modelRuntime: this.modelRuntime as ModelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: MODEL_RETRIES },
        compaction: { enabled: true, keepRecentTokens: 4000, reserveTokens: 16384 },
      }),
      // Pi treats this as a permanent registry allowlist, including after reload.
      // Current Wisp grants are applied below before the session can be used.
      tools: tools.registryNames,
      customTools: tools.definitions,
      excludeTools: ["bash", "powershell"],
      thinkingLevel: selection.thinkingLevel ?? "off",
    }));
    // Every model call of the session, compaction included, can move to the fallback; cache warming cannot.
    session.agent.streamFunction = fallback.wrap(session.agent.streamFunction);
    const fallbackLog = sessionManager;
    recordFallback = (model) => fallbackLog.appendCustomEntry(FALLBACK_ENTRY, { model });
    continuity = new ContextSession(
      session,
      path.join(context.configDirectory, "context-settings.json"),
      (kind, createdAt) => {
        if (!job) context.onContextRenewed?.(kind, createdAt);
      },
      undefined,
      () => context.userTimeZone?.() ?? systemTimeZone(),
    );
    try {
      await continuity.load();
      assertAllowedTools(session, await tools.getAllowedTools());
    } catch (error) {
      session.dispose();
      throw error;
    }
    return {
      session,
      sessionManager,
      fallback,
      fallbackListeners,
      continuity,
      refreshTools: async () => assertAllowedTools(session!, await tools.getAllowedTools()),
      snapshot: plan.snapshot,
      version: VERSION,
    };
  }
}

/**
 * Keeps OpenRouter from returning reasoning text, which Wisps never show. With
 * thinking off it also turns reasoning off; otherwise the effort Pi set stays.
 */
export function excludeOpenRouterReasoning(
  payload: unknown,
  providerId: string | undefined,
  thinkingLevel: ThinkingLevel = "off",
): unknown {
  if (providerId !== "openrouter" || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const request = payload as Record<string, unknown>;
  const reasoning =
    request.reasoning && typeof request.reasoning === "object" && !Array.isArray(request.reasoning)
      ? (request.reasoning as Record<string, unknown>)
      : {};
  if (thinkingLevel !== "off") {
    return { ...request, include_reasoning: false, reasoning: { ...reasoning, exclude: true } };
  }
  return {
    ...request,
    include_reasoning: false,
    reasoning: { ...reasoning, enabled: false, effort: "none", exclude: true },
  };
}

export function sanitizeWorkspacePath(payload: unknown, workspaceDirectory: string): unknown {
  const sensitivePaths = new Set([workspaceDirectory, workspaceDirectory.replaceAll("\\", "/")]);

  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") {
      let sanitized = value;
      for (const sensitivePath of sensitivePaths) {
        if (!sensitivePath) continue;
        sanitized = sanitized.replaceAll(
          `Current working directory: ${sensitivePath}`,
          "Use relative paths for workspace tools.",
        );
        sanitized = sanitized.replaceAll(sensitivePath, ".");
      }
      return sanitized;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
  };

  return sanitize(payload);
}

/**
 * Shapes each provider request. A request to the fallback model names its
 * provider and reasoning, which may differ from the session's model.
 */
function providerRequestExtension(
  workspaceDirectory: string,
  thinkingLevel: () => ThinkingLevel,
  fallbackProvider: () => string | undefined,
): InlineExtension {
  return {
    name: "wisp-provider-request",
    hidden: true,
    factory: (pi) => {
      pi.on("before_provider_request", (event, context) =>
        excludeOpenRouterReasoning(
          sanitizeWorkspacePath(event.payload, workspaceDirectory),
          fallbackProvider() ?? context.model?.provider,
          thinkingLevel(),
        ),
      );
    },
  };
}

function adaptSession(
  session: AgentSession,
  unsubscribeTelemetry: () => void,
  continuity: ContextSession,
  refreshTools: () => Promise<void>,
  toolRevision: string,
  fallback: ModelFallback,
  fallbackListeners: Set<(model: string) => void>,
): RuntimeSession {
  return {
    get isIdle() {
      return session.isIdle;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    get sessionId() {
      return session.sessionId;
    },
    toolRevision,
    subscribe: (listener) => {
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => listener(event as PiAgentEvent));
      const onFallback = (model: string) => listener({ type: "model_fallback", model });
      fallbackListeners.add(onFallback);
      return () => {
        fallbackListeners.delete(onFallback);
        unsubscribe();
      };
    },
    manageContext: (command) => continuity.command(command),
    prompt: async (text, { signal, ...options } = {}) => {
      // Each turn starts on the Wisp's own model.
      fallback.reset();
      await continuity.beforePrompt();
      await refreshTools();
      // A Stop during the preparation above must not start the model run.
      signal?.throwIfAborted();
      await session.prompt(text, options);
    },
    // Straight to the agent's queue, in step with clearQueue: AgentSession.steer would first run
    // input handlers and expand commands, which a prompt here never does either.
    steer: (text) => {
      session.agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
    },
    clearQueue: () => {
      session.clearQueue();
    },
    abort: () => {
      session.abortCompaction();
      return session.abort();
    },
    waitForIdle: () => session.waitForIdle(),
    reload: async () => {
      await session.reload();
      await refreshTools();
    },
    setModel: (model, options) => session.setModel(model, options),
    setThinkingLevel: (level) => session.setThinkingLevel(level),
    getActiveToolNames: () => session.getActiveToolNames(),
    appendCustomMessage: (customType, text) =>
      session.sendCustomMessage({ customType, content: text, display: false }, { triggerTurn: false }),
    dispose: () => {
      unsubscribeTelemetry();
      session.dispose();
    },
  };
}

function adaptJobSession(session: AgentSession): RuntimeJobSession {
  return {
    get sessionFile() {
      return session.sessionFile;
    },
    getActiveToolNames: () => session.getActiveToolNames(),
    prompt: async (text, signal) => {
      signal.throwIfAborted();
      const abort = () => {
        session.abortCompaction();
        void session.abort();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt(text, { expandPromptTemplates: false });
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    lastAssistantMessage: () => {
      const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
      if (!message || message.role !== "assistant") return undefined;
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim();
      return {
        text,
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      };
    },
    usage: () => {
      const { tokens } = session.getSessionStats();
      return {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        totalTokens: tokens.total,
      };
    },
    dispose: () => session.dispose(),
  };
}

type SessionIdentityLog = Pick<SessionManager, "getEntries" | "appendCustomEntry">;

/**
 * Records the Pi runtime version and safe MCP tool identities in the session
 * history, so reports can name old tool calls even after their server is
 * removed. Sessions open on every launch and tool change, so an entry is
 * appended only when it adds something: reports read the latest runtime
 * version and the union of recorded tool names.
 */
function recordSessionIdentity(
  sessionManager: SessionIdentityLog,
  version: string,
  tools: ReadonlyArray<{ name: string; label: string }>,
): void {
  let recordedVersion: unknown;
  const recordedTools = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "custom") continue;
    const data = entry.data as { version?: unknown; tools?: unknown } | undefined;
    if (entry.customType === "wisp:runtime") recordedVersion = data?.version;
    if (entry.customType === "wisp:mcp-tools" && Array.isArray(data?.tools)) {
      for (const tool of data.tools as Array<{ name?: unknown }>) {
        if (typeof tool?.name === "string") recordedTools.add(tool.name);
      }
    }
  }
  if (recordedVersion !== version) sessionManager.appendCustomEntry("wisp:runtime", { version });
  const newTools = tools.filter(({ name }) => !recordedTools.has(name));
  if (newTools.length > 0) {
    sessionManager.appendCustomEntry("wisp:mcp-tools", {
      version: 1,
      tools: newTools.map(({ name, label }) => ({ name, label })),
    });
  }
}

function assertAllowedTools(
  session: Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName">,
  allowedTools: ReadonlyArray<string>,
): void {
  const active = session.getActiveToolNames();
  const hasExactAllowedSet =
    active.length === allowedTools.length && allowedTools.every((tool) => active.includes(tool));
  if (!hasExactAllowedSet) {
    session.setActiveToolsByName([...allowedTools]);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
