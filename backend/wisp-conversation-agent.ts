/** One Wisp's agent in one conversation, over a runtime session (ADR 001, ADR 026). */

import type { ContextCommand, ContextView } from "../shared/context-policy.js";
import type { BackendError, ConversationAgentEvent, ModelSelection, SendMessageRequest } from "../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import {
  isCircleContext,
  type AgentContext,
  type ConversationAgent,
  type ConversationAgentContext,
  type ConversationAgentFactory,
  type ConversationAgentListener,
} from "./conversation-agent.js";
import { currentTimeNote, scheduledMessageNote } from "./message-schedule.js";
import { PiEventTranslator, sanitizeErrorMessage } from "./pi-event-translator.js";
import { describeProviderError } from "./provider-error.js";
import {
  JOB_RESULT_MESSAGE,
  type RuntimeModel,
  type RuntimeSession,
  type RuntimeSessionFactory,
} from "./runtime-session.js";

export interface WispConversationAgentOptions {
  flushDelayMs?: number;
}

export class WispConversationAgent implements ConversationAgent {
  private readonly context: ConversationAgentContext;
  private readonly sessionFactory: RuntimeSessionFactory;
  private readonly listeners = new Set<ConversationAgentListener>();
  private readonly translator: PiEventTranslator;
  private session: RuntimeSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private pendingModel: RuntimeModel | null = null;
  private appliedSelection: ModelSelection | null = null;
  private pendingSelection: ModelSelection | null = null;
  private started = false;
  private disposed = false;
  private sending = false;
  // Aborted by a Stop that arrives while a send is still preparing.
  private sendCancellation: AbortController | null = null;
  private configured = false;
  private modelMutation: Promise<void> = Promise.resolve();
  /** Follow-ups handed to the running turn, oldest first, until it reads them. */
  private followUps: SendMessageRequest[] = [];
  /** Whether the running turn's own message has started, so later user messages are its follow-ups. */
  private promptStarted = false;

  constructor(
    context: ConversationAgentContext,
    sessionFactory: RuntimeSessionFactory,
    options: WispConversationAgentOptions = {},
  ) {
    this.context = context;
    this.sessionFactory = sessionFactory;
    this.translator = new PiEventTranslator(
      context.conversationId,
      (event) => this.emit(event),
      options.flushDelayMs,
      context.workspaceDirectory,
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
    if (!this.configured) {
      throw new WispBackendError("configuration_required", "Choose a provider and model before sending a message.");
    }
    if (this.sending)
      throw new WispBackendError("invalid_request", "The conversation is already processing a request.");
    this.sending = true;
    const cancellation = new AbortController();
    this.sendCancellation = cancellation;
    try {
      await this.ensureToolsCurrent();
      await this.enqueueModelMutation(() => this.openSession());
      if (!this.session || !this.configured) {
        throw new WispBackendError("configuration_required", "Choose a provider and model before sending a message.");
      }
      this.translator.begin(request);
      this.promptStarted = false;
      await this.promptSession(this.session, request, cancellation.signal);
    } finally {
      // Pi would add follow-ups left unread to the next prompt; they are sent as messages of their own instead.
      this.withdrawFollowUps();
      this.sending = false;
      this.sendCancellation = null;
      await this.applyPendingModel();
    }
  }

  async steer(request: SendMessageRequest): Promise<boolean> {
    const session = this.session;
    if (this.disposed || !this.sending || !session?.steer || session.isIdle) return false;
    const text = this.promptText(request);
    this.followUps.push(request);
    session.steer(text);
    return true;
  }

  withdrawFollowUps(): string[] {
    if (!this.followUps.length) return [];
    const withdrawn = this.followUps.map(({ requestId }) => requestId);
    this.followUps = [];
    this.session?.clearQueue?.();
    return withdrawn;
  }

  /** The text the model reads for a message: the person's words, after a note of when they were sent. */
  private promptText(request: SendMessageRequest): string {
    const timeZone = this.context.userTimeZone?.();
    return request.scheduled
      ? `${scheduledMessageNote(request.scheduled, new Date())}\n\n${request.text}`
      : timeZone
        ? `${currentTimeNote(new Date(), timeZone)}\n\n${request.text}`
        : request.text;
  }

  private async promptSession(
    session: RuntimeSession,
    request: SendMessageRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      await session.prompt(this.promptText(request), { expandPromptTemplates: false, signal });
      this.translator.finish();
    } catch (error) {
      if (signal.aborted) {
        // Stopped before the model ran, or while it ran: a cancellation, not a failure.
        this.translator.markCancelled();
        this.translator.finish();
        return;
      }
      const detail = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
      let backendError: BackendError;
      if (error instanceof WispBackendError) {
        backendError = { code: error.code, message: error.message, retryable: error.retryable };
      } else {
        const described = describeProviderError(detail);
        backendError = {
          code: "internal_error",
          message: described.message,
          retryable: described.retryable,
          ...(detail ? { detail } : {}),
        };
      }
      this.translator.reportError(backendError);
      this.translator.finish();
      throw new WispBackendError(backendError.code, backendError.message, backendError.retryable);
    }
  }

  async rememberJobResult(text: string): Promise<void> {
    this.assertNotDisposed();
    await this.enqueueModelMutation(async () => {
      const session = await this.openSession();
      // The registry already waits for turns it knows of; a turn started otherwise ends first.
      if (!session.isIdle) await session.waitForIdle();
      await session.appendCustomMessage?.(JOB_RESULT_MESSAGE, text);
    });
  }

  async manageContext(command: ContextCommand): Promise<ContextView> {
    this.assertNotDisposed();
    if (!this.configured)
      throw new WispBackendError("configuration_required", "Configure a model before managing context.");
    if (command.action !== "get" && (this.sending || (this.session && !this.session.isIdle)))
      throw new WispBackendError("invalid_request", "Wait for the Wisp to finish before changing its context.");
    return this.enqueueModelMutation(async () => {
      const session = await this.openSession();
      if (!session.manageContext)
        throw new WispBackendError("configuration_required", "Configure a model before managing context.");
      return session.manageContext(command);
    });
  }

  async abort(): Promise<void> {
    this.assertNotDisposed();
    const session = this.session;
    if (session && !session.isIdle) {
      this.sendCancellation?.abort();
      this.translator.markCancelled();
      await session.abort();
      this.translator.finish();
      return;
    }
    if (!this.sending) return;
    // Still preparing: opening the session, reloading tools, or renewing
    // context before the prompt. Cancel it; send() reports the cancellation.
    this.sendCancellation?.abort();
    await session?.abort();
  }

  updateContext(context: AgentContext): Promise<void> {
    return this.enqueueModelMutation(async () => {
      this.assertNotDisposed();
      if (
        isCircleContext(context) ||
        context.conversationId !== this.context.conversationId ||
        context.sessionId !== this.context.sessionId
      ) {
        throw new WispBackendError("invalid_request", "The agent context does not match this conversation.");
      }
      this.context.name = context.name;
      this.context.role = context.role;
      this.context.soul = context.soul;
      this.context.userName = context.userName;
      this.context.memory = context.memory;
      this.context.userTimeZone = context.userTimeZone;
      this.context.circle = context.circle;
      if (!this.session) return;
      if (!this.session.isIdle) await this.session.waitForIdle();
      await this.session.reload();
    });
  }

  applyModel(selection: ModelSelection): Promise<void> {
    return this.enqueueModelMutation(() => this.applyModelInternal(selection));
  }

  clearModel(): Promise<void> {
    return this.enqueueModelMutation(async () => {
      this.assertNotDisposed();
      this.configured = false;
      this.pendingModel = null;
      this.pendingSelection = null;
      this.appliedSelection = null;
      this.publishModel();
    });
  }

  private async applyModelInternal(selection: ModelSelection): Promise<void> {
    this.assertNotDisposed();
    // Resolving checks credentials and availability now, so the Wisp reports
    // ready immediately; the session itself is opened on first use.
    const model = this.sessionFactory.resolveModel(selection);
    if (this.session?.isIdle && this.switchesRuntime(selection)) this.closeSession();
    if (!this.session) {
      this.configured = true;
      this.appliedSelection = { ...selection };
      this.pendingModel = null;
      this.pendingSelection = null;
      this.publishModel();
      return;
    }
    if (!this.session.isIdle) {
      this.pendingModel = model;
      this.pendingSelection = { ...selection };
      this.publishModel();
      this.configured = true;
      return;
    }
    try {
      await this.session.setModel(model, { persist: false });
      this.session.setThinkingLevel(selection.thinkingLevel ?? "off");
      this.appliedSelection = { ...selection };
      this.pendingSelection = null;
      this.pendingModel = null;
      this.configured = true;
      this.publishModel();
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

  private applyPendingModel(): Promise<void> {
    return this.enqueueModelMutation(() => this.applyPendingModelInternal());
  }

  /**
   * Opens the session for the applied model if it is not open yet. Opening
   * loads the full session history, so it is deferred from startup to the first
   * message or context request. Must run inside the model mutation queue.
   */
  private async openSession(): Promise<RuntimeSession> {
    this.assertNotDisposed();
    if (this.session) return this.session;
    if (!this.configured || !this.appliedSelection) {
      throw new WispBackendError("configuration_required", "Choose a provider and model before sending a message.");
    }
    this.context.onContextRenewed = (kind, createdAt) =>
      this.emit({
        type: "conversation_context_renewed",
        conversationId: this.context.conversationId,
        kind,
        createdAt,
      });
    const session = await this.sessionFactory.create(this.context, this.appliedSelection);
    if (this.disposed) {
      session.dispose();
      this.assertNotDisposed();
    }
    this.attachSession(session);
    return session;
  }

  private attachSession(session: RuntimeSession): void {
    this.unsubscribeSession?.();
    this.session = session;
    this.unsubscribeSession = session.subscribe((event) => {
      if (event.type === "message_start" && event.message?.role === "user") {
        // The turn's own message comes first; each later one is the oldest follow-up, which Pi hands over in order.
        const followUp = this.promptStarted ? this.followUps.shift() : undefined;
        this.promptStarted = true;
        if (followUp) this.translator.takeFollowUp(followUp);
      }
      this.translator.handle(event);
      if (event.type === "agent_settled") void this.applyPendingModel();
    });
    // Track the live session identity so a later rebuild reopens the exact same
    // session file instead of starting a new conversation or topic.
    this.context.piSessionId = session.sessionId;
    if (session.sessionFile) this.context.piSessionFile = session.sessionFile;
  }

  /**
   * Rebuilds the session when the integration tool snapshot changed.
   * Pi's tool registry is a fixed allowlist, so new or changed definitions can
   * only appear by recreating the session, which reopens the exact current
   * session file and preserves application identity, model, context settings,
   * and event subscriptions. Runs at an idle message boundary: the next message
   * sees the new definitions, while grant reductions stay effective immediately
   * in the backend regardless.
   */
  private async ensureToolsCurrent(): Promise<void> {
    const session = this.session;
    if (!session || !this.appliedSelection) return;
    const revision = await this.sessionFactory.getToolRevision(this.context).catch(() => null);
    if (!revision || revision === session.toolRevision) return;
    if (!session.isIdle) return;
    await this.enqueueModelMutation(async () => {
      const current = this.session;
      if (this.disposed || !current || current !== session) return;
      if (current.toolRevision === revision || !this.appliedSelection) return;
      const created = await this.sessionFactory.create(this.context, this.appliedSelection);
      if (this.disposed) {
        created.dispose();
        return;
      }
      this.attachSession(created);
      session.dispose();
    });
  }

  private async applyPendingModelInternal(): Promise<void> {
    const model = this.pendingModel;
    const session = this.session;
    if (!model || !session || !session.isIdle || this.disposed) return;
    const selection = this.pendingSelection;
    this.pendingModel = null;
    this.pendingSelection = null;
    if (selection && this.switchesRuntime(selection)) {
      // The next message opens a session for the new model.
      this.closeSession();
      this.appliedSelection = selection;
      this.publishModel();
      return;
    }
    try {
      await session.setModel(model, { persist: false });
      session.setThinkingLevel(selection?.thinkingLevel ?? "off");
      this.appliedSelection = selection;
      this.publishModel();
    } catch {
      this.appliedSelection = null;
      this.publishModel();
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

  /** Whether moving to a selection needs another kind of session, such as Claude Code after Pi. */
  private switchesRuntime(selection: ModelSelection): boolean {
    const current = this.appliedSelection;
    return Boolean(current && this.sessionFactory.sameRuntime && !this.sessionFactory.sameRuntime(current, selection));
  }

  /** Closes an idle session; the next use opens one. */
  private closeSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.session?.dispose();
    this.session = null;
  }

  private publishModel(): void {
    this.emit({
      type: "conversation_model_changed",
      conversationId: this.context.conversationId,
      applied: this.appliedSelection,
      pending: this.pendingSelection,
    });
  }

  private enqueueModelMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.modelMutation.then(operation, operation);
    this.modelMutation = result.then(
      () => undefined,
      () => undefined,
    );
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

export class WispConversationAgentFactory implements ConversationAgentFactory {
  private readonly sessionFactory: RuntimeSessionFactory;
  private readonly options: WispConversationAgentOptions;

  constructor(sessionFactory: RuntimeSessionFactory, options: WispConversationAgentOptions = {}) {
    this.sessionFactory = sessionFactory;
    this.options = options;
  }

  create(context: ConversationAgentContext): ConversationAgent {
    return new WispConversationAgent(context, this.sessionFactory, this.options);
  }
}
