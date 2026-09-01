import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import type {
  BackendError,
  ConversationAgentEvent,
  ModelSelection,
  SendMessageRequest,
} from "../../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type {
  ConversationAgent,
  ConversationAgentContext,
  ConversationAgentFactory,
  ConversationAgentListener,
} from "./conversation-agent.js";
import type { ModelRuntimeLike } from "./model-service.js";
import { PiEventTranslator, type PiAgentEvent } from "./pi-event-translator.js";
import type {
  ToolAuthorizationBroker,
  ToolAuthorizationRequest,
} from "./tool-authorization-broker.js";

const ACTIVE_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;
const MAX_MUTATION_INPUT_BYTES = 1_000_000;
const MAX_TOOL_OUTPUT_BYTES = 64_000;
type PiModel = NonNullable<ReturnType<ModelRuntimeLike["getModel"]>>;

export interface PiSessionLike {
  readonly isIdle: boolean;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  setModel(model: PiModel, options?: { persist?: boolean }): Promise<void>;
  getActiveToolNames(): string[];
  dispose(): void;
}

export interface PiSessionFactory {
  resolveModel(selection: ModelSelection): PiModel;
  create(context: ConversationAgentContext, selection: ModelSelection): Promise<PiSessionLike>;
}

export class SdkPiSessionFactory implements PiSessionFactory {
  private readonly modelRuntime: ModelRuntimeLike;
  private readonly authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;

  constructor(
    modelRuntime: ModelRuntimeLike,
    authorizationBroker: Pick<ToolAuthorizationBroker, "authorize"> = new BlockMutationAuthorizer(),
  ) {
    this.modelRuntime = modelRuntime;
    this.authorizationBroker = authorizationBroker;
  }

  resolveModel(selection: ModelSelection): PiModel {
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
    return model;
  }

  async create(context: ConversationAgentContext, selection: ModelSelection): Promise<PiSessionLike> {
    const model = this.resolveModel(selection);
    const {
      createAgentSession,
      createFindToolDefinition,
      createGrepToolDefinition,
      createLsToolDefinition,
      createReadToolDefinition,
      createEditToolDefinition,
      createWriteToolDefinition,
      DefaultResourceLoader,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.workspaceDirectory,
      agentDir: context.configDirectory,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => buildSystemPrompt(context),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    let sessionManager;
    if (context.piSessionFile && await fileExists(context.piSessionFile)) {
      sessionManager = SessionManager.open(
        context.piSessionFile,
        context.sessionDirectory,
        context.workspaceDirectory,
      );
    } else {
      const recent = SessionManager.continueRecent(
        context.workspaceDirectory,
        context.sessionDirectory,
      );
      sessionManager = recent.getSessionFile() && await fileExists(recent.getSessionFile()!)
        ? recent
        : SessionManager.create(
          context.workspaceDirectory,
          context.sessionDirectory,
          { id: context.piSessionId ?? context.sessionId },
        );
    }
    const confinedTools = [
      secureTool(createReadToolDefinition(context.workspaceDirectory), context, this.authorizationBroker, "read"),
      secureTool(createGrepToolDefinition(context.workspaceDirectory), context, this.authorizationBroker, "search"),
      secureTool(createFindToolDefinition(context.workspaceDirectory), context, this.authorizationBroker, "search"),
      secureTool(createLsToolDefinition(context.workspaceDirectory), context, this.authorizationBroker, "read"),
      secureTool(createEditToolDefinition(context.workspaceDirectory), context, this.authorizationBroker, "modify_file"),
      secureTool(createWriteToolDefinition(context.workspaceDirectory), context, this.authorizationBroker, "create_file"),
    ];
    const { session } = await createAgentSession({
      cwd: context.workspaceDirectory,
      agentDir: context.configDirectory,
      model,
      modelRuntime: this.modelRuntime as ModelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2 },
      }),
      tools: [...ACTIVE_TOOLS],
      customTools: confinedTools as unknown as ToolDefinition[],
      excludeTools: ["bash", "powershell"],
      thinkingLevel: "off",
    });
    assertAllowedTools(session);
    try {
      await context.savePiSessionIdentity?.({
        sessionId: session.sessionId,
        sessionFile: session.sessionFile ?? null,
      });
    } catch (error) {
      session.dispose();
      throw error;
    }
    return adaptSession(session);
  }
}

export interface PiConversationAgentOptions {
  flushDelayMs?: number;
}

export class PiConversationAgent implements ConversationAgent {
  private readonly context: ConversationAgentContext;
  private readonly sessionFactory: PiSessionFactory;
  private readonly listeners = new Set<ConversationAgentListener>();
  private readonly translator: PiEventTranslator;
  private session: PiSessionLike | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private pendingModel: PiModel | null = null;
  private started = false;
  private disposed = false;
  private sending = false;
  private configured = false;
  private modelMutation: Promise<void> = Promise.resolve();

  constructor(
    context: ConversationAgentContext,
    sessionFactory: PiSessionFactory,
    options: PiConversationAgentOptions = {},
  ) {
    this.context = context;
    this.sessionFactory = sessionFactory;
    this.translator = new PiEventTranslator(
      context.conversationId,
      (event) => this.emit(event),
      options.flushDelayMs,
    );
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.started) return;
    this.started = true;
    this.emit({ type: "conversation_status", conversationId: this.context.conversationId, status: "idle" });
  }

  async send(request: SendMessageRequest): Promise<void> {
    this.assertReady(request.conversationId);
    if (!this.session || !this.configured) {
      throw new WispBackendError("configuration_required", "Choose a provider and model before sending a message.");
    }
    if (this.sending) throw new WispBackendError("invalid_request", "The conversation is already processing a request.");
    this.sending = true;
    this.translator.begin(request);
    try {
      await this.session.prompt(request.text, { expandPromptTemplates: false });
      this.translator.finish();
    } catch (error) {
      const backendError: BackendError = error instanceof WispBackendError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: "internal_error", message: "The model request failed.", retryable: true };
      this.translator.reportError(backendError);
      this.translator.finish();
      throw new WispBackendError(backendError.code, backendError.message, backendError.retryable);
    } finally {
      this.sending = false;
      await this.applyPendingModel();
    }
  }

  async abort(): Promise<void> {
    this.assertNotDisposed();
    if (!this.session || this.session.isIdle) return;
    this.translator.markCancelled();
    await this.session.abort();
    this.translator.finish();
  }

  applyModel(selection: ModelSelection): Promise<void> {
    return this.enqueueModelMutation(() => this.applyModelInternal(selection));
  }

  clearModel(): Promise<void> {
    return this.enqueueModelMutation(async () => {
      this.assertNotDisposed();
      this.configured = false;
      this.pendingModel = null;
    });
  }

  private async applyModelInternal(selection: ModelSelection): Promise<void> {
    this.assertNotDisposed();
    const model = this.sessionFactory.resolveModel(selection);
    if (!this.session) {
      const session = await this.sessionFactory.create(this.context, selection);
      if (this.disposed) {
        session.dispose();
        return;
      }
      this.session = session;
      this.unsubscribeSession = session.subscribe((event) => {
        this.translator.handle(event);
        if (event.type === "agent_settled") void this.applyPendingModel();
      });
      this.configured = true;
      return;
    }
    if (!this.session.isIdle) {
      this.pendingModel = model;
      this.configured = true;
      return;
    }
    try {
      await this.session.setModel(model, { persist: false });
      this.configured = true;
    } catch (error) {
      this.configured = false;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.modelMutation.catch(() => undefined);
    const session = this.session;
    if (session && !session.isIdle) {
      this.translator.markCancelled();
      await session.abort().catch(() => undefined);
      await session.waitForIdle().catch(() => undefined);
    }
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.translator.dispose();
    session?.dispose();
    this.session = null;
    this.emit({ type: "conversation_status", conversationId: this.context.conversationId, status: "disposed" });
    this.listeners.clear();
  }

  subscribe(listener: ConversationAgentListener): () => void {
    this.assertNotDisposed();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async applyPendingModel(): Promise<void> {
    const model = this.pendingModel;
    const session = this.session;
    if (!model || !session || !session.isIdle || this.disposed) return;
    this.pendingModel = null;
    try {
      await session.setModel(model, { persist: false });
    } catch {
      this.configured = false;
      this.emit({
        type: "conversation_error",
        conversationId: this.context.conversationId,
        createdAt: new Date().toISOString(),
        error: { code: "internal_error", message: "The model change could not be applied.", retryable: true },
      });
      this.emit({
        type: "conversation_status",
        conversationId: this.context.conversationId,
        status: "configuration_required",
      });
    }
  }

  private enqueueModelMutation(operation: () => Promise<void>): Promise<void> {
    const result = this.modelMutation.then(operation, operation);
    this.modelMutation = result.catch(() => undefined);
    return result;
  }

  private assertReady(conversationId: string): void {
    this.assertNotDisposed();
    if (!this.started) throw new WispBackendError("invalid_request", "The conversation has not been started.");
    if (conversationId !== this.context.conversationId) {
      throw new WispBackendError("invalid_request", "The request does not match this conversation.");
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new WispBackendError("disposed", "The conversation has been disposed.");
  }

  private emit(event: ConversationAgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class PiConversationAgentFactory implements ConversationAgentFactory {
  private readonly sessionFactory: PiSessionFactory;
  private readonly options: PiConversationAgentOptions;

  constructor(sessionFactory: PiSessionFactory, options: PiConversationAgentOptions = {}) {
    this.sessionFactory = sessionFactory;
    this.options = options;
  }

  create(context: ConversationAgentContext): ConversationAgent {
    return new PiConversationAgent(context, this.sessionFactory, this.options);
  }
}

function buildSystemPrompt(context: ConversationAgentContext): string {
  return [
    `You are ${context.name}, a Wisp coding agent.`,
    `Role: ${context.label || "General assistant"}.`,
    `Description: ${context.description || "Help the user inspect and understand their workspace."}`,
    "Work only inside the assigned workspace.",
    "You may read, search, and request file changes. File changes are subject to app policy and user approval.",
    "You must not execute shell commands.",
    "Be concise, factual, and explicit when information is missing.",
  ].join("\n");
}

function adaptSession(session: AgentSession): PiSessionLike {
  return {
    get isIdle() { return session.isIdle; },
    get sessionFile() { return session.sessionFile; },
    get sessionId() { return session.sessionId; },
    subscribe: (listener) => session.subscribe((event: AgentSessionEvent) => listener(event as PiAgentEvent)),
    prompt: (text, options) => session.prompt(text, options),
    abort: () => session.abort(),
    waitForIdle: () => session.waitForIdle(),
    setModel: (model, options) => session.setModel(model, options),
    getActiveToolNames: () => session.getActiveToolNames(),
    dispose: () => session.dispose(),
  };
}

function assertAllowedTools(session: Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName">): void {
  const active = session.getActiveToolNames();
  const hasExactAllowedSet = active.length === ACTIVE_TOOLS.length
    && ACTIVE_TOOLS.every((tool) => active.includes(tool));
  if (!hasExactAllowedSet) {
    session.setActiveToolsByName([...ACTIVE_TOOLS]);
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

function secureTool<TDefinition extends ToolDefinition<any, any, any>>(
  definition: TDefinition,
  context: ConversationAgentContext,
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">,
  configuredCategory: ToolAuthorizationRequest["category"],
): TDefinition {
  return {
    ...definition,
    execute: async (...args: Parameters<TDefinition["execute"]>) => {
      const parameters = args[1];
      const input = parameters as { path?: unknown };
      if (input.path !== undefined && (typeof input.path !== "string" || !input.path)) {
        throw new WispBackendError("invalid_request", "The tool path is invalid.");
      }
      const requestedPath = typeof input.path === "string" ? input.path : ".";
      const allowMissing = configuredCategory === "create_file";
      const resolved = await resolveWorkspacePath(context.workspaceDirectory, requestedPath, allowMissing);
      const category = configuredCategory === "create_file" && resolved.exists
        ? "modify_file"
        : configuredCategory;
      let executionPath = resolved.canonicalPath;
      if (category === "create_file" || category === "modify_file") {
        assertMutationInputSize(parameters);
        await authorizationBroker.authorize({
          conversationId: context.conversationId,
          toolCallId: args[0],
          toolName: definition.name,
          category,
          summary: `${category === "create_file" ? "Create" : "Modify"} ${resolved.relativePath}`,
        }, args[2]);
        const rechecked = await resolveWorkspacePath(context.workspaceDirectory, requestedPath, allowMissing);
        if (rechecked.canonicalPath !== resolved.canonicalPath || rechecked.exists !== resolved.exists) {
          throw new WispBackendError("tool_blocked", "The target path changed before the tool could run.");
        }
        executionPath = rechecked.canonicalPath;
      }
      const securedParameters = { ...(parameters as object), path: executionPath };
      const result = await definition.execute(args[0], securedParameters as Parameters<TDefinition["execute"]>[1], args[2], args[3], args[4]);
      return limitToolResult(result) as Awaited<ReturnType<TDefinition["execute"]>>;
    },
  } as TDefinition;
}

interface ResolvedWorkspacePath {
  canonicalPath: string;
  relativePath: string;
  exists: boolean;
}

async function resolveWorkspacePath(
  workspaceDirectory: string,
  requestedPath: string,
  allowMissing: boolean,
): Promise<ResolvedWorkspacePath> {
  const workspace = await realpath(workspaceDirectory);
  const unresolved = path.resolve(workspaceDirectory, requestedPath);
  assertContainedPath(path.resolve(workspaceDirectory), unresolved);
  let canonicalPath: string;
  let exists = true;
  try {
    canonicalPath = await realpath(unresolved);
  } catch {
    if (!allowMissing) throw new WispBackendError("invalid_request", "The requested path does not exist.");
    exists = false;
    try {
      await lstat(unresolved);
      throw new WispBackendError("invalid_request", "The requested path cannot be resolved safely.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let ancestor = path.dirname(unresolved);
    while (true) {
      try {
        await lstat(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new WispBackendError("invalid_request", "The requested path cannot be resolved safely.");
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new WispBackendError("invalid_request", "The requested path is invalid.");
        ancestor = parent;
        continue;
      }
      try {
        const canonicalAncestor = await realpath(ancestor);
        canonicalPath = path.resolve(canonicalAncestor, path.relative(ancestor, unresolved));
        break;
      } catch {
        throw new WispBackendError("invalid_request", "The requested path cannot be resolved safely.");
      }
    }
  }
  assertContainedPath(workspace, canonicalPath!);
  const relative = path.relative(workspace, canonicalPath!);
  return { canonicalPath: canonicalPath!, relativePath: relative || ".", exists };
}

function assertContainedPath(workspace: string, candidate: string): void {
  const relative = path.relative(workspace, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WispBackendError("invalid_request", "The requested path is outside this Wisp's workspace.");
  }
}

function assertMutationInputSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new WispBackendError("invalid_request", "The requested file change is invalid.");
  }
  if (serialized === undefined) {
    throw new WispBackendError("invalid_request", "The requested file change is invalid.");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_MUTATION_INPUT_BYTES) {
    throw new WispBackendError("invalid_request", "The requested file change is too large.");
  }
}

function limitToolResult<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const record = result as { content?: unknown };
  if (!Array.isArray(record.content)) return result;
  let remaining = MAX_TOOL_OUTPUT_BYTES;
  const content = record.content.map((item) => {
    if (!item || typeof item !== "object") return item;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") return item;
    const text = truncateUtf8(block.text, remaining);
    remaining -= Buffer.byteLength(text, "utf8");
    return { ...block, text };
  });
  return { ...result, content };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

class BlockMutationAuthorizer implements Pick<ToolAuthorizationBroker, "authorize"> {
  authorize(action: ToolAuthorizationRequest): Promise<void> {
    if (action.category === "read" || action.category === "search") return Promise.resolve();
    return Promise.reject(new WispBackendError("tool_blocked", "File changes require the app authorization broker."));
  }
}
