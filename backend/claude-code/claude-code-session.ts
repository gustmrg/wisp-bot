import { randomUUID } from "node:crypto";

import { shouldRenewContext, type ContextCommand, type ContextView } from "../../shared/context-policy.js";
import type { ThinkingLevel } from "../../shared/contracts.js";
import { WispBackendError } from "../backend-error.js";
import type { ContextSettings } from "../context-session.js";
import type { RuntimeSession } from "../runtime-session.js";
import type { PiAgentEvent } from "../pi-event-translator.js";
import { ClaudeCodeEventConverter, isMissingSession, type ClaudeCodeTurnResult } from "./claude-code-events.js";
import { claudeCodeUserMessage, type ClaudeCodeQueryOptions } from "./claude-code-launch.js";
import type { WispToolObserver } from "./wisp-mcp-server.js";

/** A Claude Code process closes after this long without a turn; the next message resumes it. */
const DEFAULT_IDLE_MS = 30 * 60_000;

/** The part of the Agent SDK's `query` a session uses. */
export type ClaudeCodeQuery = (params: {
  prompt: AsyncIterable<ReturnType<typeof claudeCodeUserMessage>>;
  options: ClaudeCodeQueryOptions;
}) => ClaudeCodeQueryHandle;

export interface ClaudeCodeQueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  /** Drops a queued message by its uuid; true when it had not been read yet. Not in the SDK's types. */
  cancelAsyncMessage?(uuid: string): Promise<unknown>;
  close(): void;
}

/** What one process of a session starts with. */
export interface ClaudeCodeLaunch {
  sessionId: string;
  resume: boolean;
  model: string;
  effort?: ClaudeCodeQueryOptions["effort"];
  /** Set when a session that no longer existed was replaced: what the new one should know. */
  recoveredContext?: string;
  /** Told what the process's Wisp tools report as they run and end. */
  observer: WispToolObserver;
}

export interface ClaudeCodeSessionOptions {
  query: ClaudeCodeQuery;
  /** Builds the query options for a process; read anew at each start, so a changed soul applies. */
  queryOptions: (launch: ClaudeCodeLaunch) => Promise<ClaudeCodeQueryOptions>;
  /** Claude Code's session to resume, or a new one's ID. */
  sessionId: string;
  resume: boolean;
  model: string;
  thinkingLevel: ThinkingLevel;
  toolNames: ReadonlyArray<string>;
  toolRevision: string;
  /** What an earlier process of this session reported, for automatic context renewal. */
  state?: ClaudeCodeContextState;
  /**
   * Saves the session after each successful turn and context renewal. The ID
   * is null until a turn in the current session succeeded, so a session that
   * never answered is never resumed.
   */
  onSessionSaved?: (saved: ClaudeCodeSavedSession) => Promise<void>;
  /** The Wisp's context policy and memory, shared with Pi; without it, context cannot be managed. */
  context?: ClaudeCodeContextHooks;
  /**
   * A session on the Wisp's fallback model, with its name, for a turn Claude
   * Code failed for good before answering (ADR 021); null when it has none.
   */
  fallback?: () => Promise<{ name: string; session: RuntimeSession } | null>;
  /** Told when the fallback model answers a turn, for the session report. */
  onFallback?: (model: string) => void;
  now?: () => Date;
  /** The latest of the Wisp's own messages, to carry into a replaced session. */
  recentTranscript?: () => Promise<string>;
  /** Told the outcome of each turn: usage, plan usage, the model the alias resolved to. */
  onTurnResult?: (result: ClaudeCodeTurnResult, converter: ClaudeCodeEventConverter) => void;
  idleMs?: number;
}

/** When the conversation was last active and renewed, and how large its context is. */
export interface ClaudeCodeContextState {
  lastActivityAt: string | null;
  lastRenewedAt: string | null;
  tokens: number;
}

export interface ClaudeCodeSavedSession extends ClaudeCodeContextState {
  sessionId: string | null;
}

export interface ClaudeCodeContextHooks {
  load(): Promise<ContextSettings>;
  save(settings: ContextSettings): Promise<void>;
  /** The person's time zone, where the daily renewal hour is read. */
  timeZone(): string;
  /** Tells the conversation its context was renewed, as Pi's sessions do. */
  onRenewed(kind: "compacted" | "new_topic", at: string): void;
}

const EMPTY_STATE: ClaudeCodeContextState = { lastActivityAt: null, lastRenewedAt: null, tokens: 0 };

/** Claude Code's effort for a Wisp's reasoning level; "off" leaves the model's default. */
export function claudeCodeEffort(level: ThinkingLevel): ClaudeCodeQueryOptions["effort"] {
  switch (level) {
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "low";
    default:
      return level;
  }
}

interface RunningProcess {
  handle: ClaudeCodeQueryHandle;
  send: (message: ReturnType<typeof claudeCodeUserMessage>) => void;
  end: () => void;
  converter: ClaudeCodeEventConverter;
  /** The uuids of follow-ups sent to steer the running turn that Claude Code has not read yet, oldest first. */
  steers: string[];
}

/** A turn from the moment a message is accepted, so a second one or a Stop is handled even before Claude Code starts. */
interface Turn {
  aborted: boolean;
  /** Whether anything of the reply arrived, so a missing session is retried only before it did. */
  answered: boolean;
  /** Ends the message sent to Claude Code; set while Claude Code works on it. */
  settle: ((result: ClaudeCodeTurnResult | Error) => void) | undefined;
  /** Resolves when the turn ended, however it ended. */
  finished: Promise<void>;
  /** Whether Claude Code has the turn's message, so a follow-up can steer it. */
  steerable: boolean;
  /** Follow-ups that arrived before Claude Code had the message, sent right after it. */
  pendingSteers: string[];
}

/**
 * A Wisp's conversation on Claude Code, shaped as a Pi session so the
 * conversation agent, its follow-ups, cancellation, and translator stay the
 * same (ADR 026). One long-lived Claude Code process takes the person's
 * messages from a queue. Changing the model, reasoning level, or the Wisp's
 * identity closes the idle process; the next message resumes the session
 * with the new options.
 */
export class ClaudeCodeSession implements RuntimeSession {
  readonly sessionFile = undefined;
  readonly toolRevision: string;
  private readonly options: ClaudeCodeSessionOptions;
  private readonly listeners = new Set<(event: PiAgentEvent) => void>();
  private readonly toolNames: ReadonlyArray<string>;
  private sessionIdValue: string;
  private resume: boolean;
  private model: string;
  private thinkingLevel: ThinkingLevel;
  private process: RunningProcess | null = null;
  private turn: Turn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Context added since the last turn, such as a job's result; read with the next message. */
  private notes: string[] = [];
  /** What a replacement for a session that no longer existed should know, until a process starts with it. */
  private recoveredContext: string | undefined;
  private state: ClaudeCodeContextState;
  private readonly now: () => Date;
  /** The fallback model's session while it answers a turn. */
  private fallbackSession: RuntimeSession | null = null;
  private disposed = false;

  constructor(options: ClaudeCodeSessionOptions) {
    this.options = options;
    this.toolRevision = options.toolRevision;
    this.toolNames = [...options.toolNames];
    this.sessionIdValue = options.sessionId;
    this.resume = options.resume;
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel;
    this.state = { ...(options.state ?? EMPTY_STATE) };
    this.now = options.now ?? (() => new Date());
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get isIdle(): boolean {
    return this.turn === null;
  }

  subscribe(listener: (event: PiAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.assertOpen();
    if (this.turn) throw new WispBackendError("invalid_request", "The conversation is already processing a request.");
    options.signal?.throwIfAborted();
    const { turn, end } = this.beginTurn();
    const message = this.notes.length ? `${this.notes.join("\n\n")}\n\n${text}` : text;
    this.notes = [];
    this.emit({ type: "agent_start" });
    // The turn's own message; each later one is a follow-up the turn read.
    this.emit({ type: "message_start", message: { role: "user" } });
    try {
      await this.renewIfDue(turn);
      let result = await this.send(turn, message, { steerable: true });
      if (isMissingSession(result) && !turn.answered && !turn.aborted) {
        // Claude Code deletes sessions unused for a while; start a new one that knows the latest messages.
        await this.replaceSession();
        result = await this.send(turn, message, { steerable: true });
      }
      if (!result.ok && !turn.aborted) {
        const answered =
          failedForGood(result) && !turn.answered && (await this.answerWithFallback(turn, message, options.signal));
        if (!answered) throw describeFailure(result);
      }
      if (result.ok) {
        this.resume = true;
        this.state.lastActivityAt = this.now().toISOString();
        this.state.tokens = this.process?.converter.contextTokens ?? this.state.tokens;
        await this.saveSession();
      }
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled" });
    } finally {
      end();
    }
  }

  /**
   * The context view and commands Pi sessions offer (ADR 026). Claude Code
   * keeps its own summary, so none is shown; compacting asks Claude Code to
   * `/compact`, and a new topic starts a new Claude Code session.
   */
  async manageContext(command: ContextCommand): Promise<ContextView> {
    this.assertOpen();
    const context = this.options.context;
    if (!context) throw new WispBackendError("configuration_required", "Configure a model before managing context.");
    if (command.action !== "get") {
      if (this.turn) {
        throw new WispBackendError("invalid_request", "Wait for the Wisp to finish before changing its context.");
      }
      if (command.action === "save") {
        await context.save({ policy: command.policy, memory: command.memory });
        // The memory is part of the system prompt, which the next process reads.
        this.closeIdleProcess();
      } else {
        const { turn, end } = this.beginTurn();
        try {
          if (command.action === "compact") await this.compact(turn);
          else await this.startNewTopic();
        } finally {
          end();
        }
      }
    }
    const settings = await context.load();
    return {
      policy: settings.policy,
      memory: settings.memory,
      summary: null,
      lastRenewedAt: this.state.lastRenewedAt,
      lastActivityAt: this.state.lastActivityAt,
      tokens: this.state.tokens,
    };
  }

  /**
   * Hands a follow-up to the running turn, which reads it before its next
   * model call (Pi's steering). Claude Code reports when it reads it, and
   * the session then emits a user `message_start`, as Pi's sessions do.
   */
  steer(text: string): void {
    const turn = this.turn;
    if (!turn || this.disposed) return;
    if (this.fallbackSession) {
      this.fallbackSession.steer?.(text);
      return;
    }
    if (turn.steerable && this.process) this.sendSteer(this.process, text);
    else turn.pendingSteers.push(text);
  }

  /** Drops the follow-ups the turn has not read, so they can be sent as messages of their own. */
  clearQueue(): void {
    this.fallbackSession?.clearQueue?.();
    if (this.turn) this.turn.pendingSteers = [];
    const process = this.process;
    if (process?.steers.length) void this.withdrawSteers(process);
  }

  async abort(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.aborted = true;
    if (this.fallbackSession) {
      await this.fallbackSession.abort();
      await turn.finished;
      return;
    }
    // Before Claude Code has the message, marking the turn is enough: it is never sent.
    if (turn.settle && this.process) {
      try {
        await this.process.handle.interrupt();
      } catch {
        // Without a working control channel, ending the process ends the turn.
        this.closeProcess(new WispBackendError("aborted", "The reply was stopped."));
      }
    }
    await turn.finished;
  }

  async waitForIdle(): Promise<void> {
    await this.turn?.finished;
  }

  async reload(): Promise<void> {
    // The Wisp's identity changed; the next process reads it.
    this.closeIdleProcess();
  }

  async setModel(model: { id: string }): Promise<void> {
    if (model.id === this.model) return;
    this.model = model.id;
    this.closeIdleProcess();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    if (level === this.thinkingLevel) return;
    this.thinkingLevel = level;
    this.closeIdleProcess();
  }

  getActiveToolNames(): string[] {
    return [...this.toolNames];
  }

  async appendCustomMessage(_customType: string, text: string): Promise<void> {
    this.notes.push(text);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.closeProcess(new WispBackendError("disposed", "The conversation has been disposed."));
    this.listeners.clear();
  }

  /**
   * Sends the turn's message to Claude Code and waits for its result; a
   * stopped turn sends nothing. A steerable message takes follow-ups.
   */
  private async send(turn: Turn, text: string, options: { steerable?: boolean } = {}): Promise<ClaudeCodeTurnResult> {
    const stopped: ClaudeCodeTurnResult = {
      sessionId: this.sessionIdValue,
      ok: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
      estimatedCostUsd: null,
      errors: [],
      reply: "",
    };
    if (turn.aborted) return stopped;
    const process = await this.ensureProcess();
    if (turn.aborted) return stopped;
    let outcome: ClaudeCodeTurnResult | Error | undefined;
    await new Promise<void>((resolve) => {
      turn.settle = (value) => {
        outcome ??= value;
        resolve();
      };
      process.send(claudeCodeUserMessage(text));
      if (options.steerable) {
        turn.steerable = true;
        for (const followUp of turn.pendingSteers.splice(0)) this.sendSteer(process, followUp);
      }
    });
    turn.settle = undefined;
    turn.steerable = false;
    if (outcome instanceof Error) throw outcome;
    return outcome!;
  }

  private async ensureProcess(): Promise<RunningProcess> {
    if (this.process) return this.process;
    const converter = new ClaudeCodeEventConverter();
    const launch: ClaudeCodeLaunch = {
      sessionId: this.sessionIdValue,
      resume: this.resume,
      model: this.model,
      ...(claudeCodeEffort(this.thinkingLevel) ? { effort: claudeCodeEffort(this.thinkingLevel) } : {}),
      ...(this.recoveredContext ? { recoveredContext: this.recoveredContext } : {}),
      observer: {
        progress: (toolCallId, partialResult) => {
          if (this.process?.converter !== converter) return;
          for (const event of converter.toolProgress(toolCallId, partialResult)) this.emit(event);
        },
        result: (toolCallId, result) => converter.recordToolResult(toolCallId, result),
      },
    };
    const queryOptions = await this.options.queryOptions(launch);
    this.assertOpen();
    const queue: Array<ReturnType<typeof claudeCodeUserMessage>> = [];
    let wake: (() => void) | undefined;
    let ended = false;
    async function* input() {
      while (!ended) {
        const next = queue.shift();
        if (next) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    }
    const handle = this.options.query({ prompt: input(), options: queryOptions });
    const process: RunningProcess = {
      handle,
      converter,
      steers: [],
      send: (message) => {
        queue.push(message);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    this.process = process;
    void this.read(process);
    return process;
  }

  private async read(process: RunningProcess): Promise<void> {
    let failure: Error | undefined;
    try {
      for await (const message of process.handle) {
        if (this.process !== process) return;
        this.takeSteers(process, message);
        const { events, result } = process.converter.convert(message);
        const turn = this.turn;
        if (turn && events.some((event) => event.type === "message_update" || event.type === "tool_execution_start")) {
          turn.answered = true;
        }
        for (const event of events) this.emit(event);
        if (result) {
          if (result.sessionId) this.sessionIdValue = result.sessionId;
          this.options.onTurnResult?.(result, process.converter);
          // Claude Code would answer a follow-up the turn did not read with a turn of its own.
          if (process.steers.length && !(await this.withdrawSteers(process))) continue;
          turn?.settle?.(result);
        }
      }
    } catch (error) {
      // The SDK also throws after an error result it already yielded; the turn has settled then.
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (this.process !== process) return;
    this.process = null;
    process.end();
    this.turn?.settle?.(
      new WispBackendError(
        "unavailable",
        failure ? `Claude Code stopped unexpectedly: ${failure.message}` : "Claude Code stopped unexpectedly.",
        true,
      ),
    );
  }

  private sendSteer(process: RunningProcess, text: string): void {
    const uuid = randomUUID();
    process.steers.push(uuid);
    process.send(claudeCodeUserMessage(text, { steer: true, uuid }));
  }

  /**
   * Emits a user `message_start` for each follow-up Claude Code started
   * reading: it reports a queued message's `command_lifecycle` and stamps
   * the reply to it with its uuid. Follow-ups are read in order.
   */
  private takeSteers(process: RunningProcess, message: unknown): void {
    if (!process.steers.length || !message || typeof message !== "object") return;
    const event = message as Record<string, unknown>;
    const uuid =
      event.type === "command_lifecycle" && event.state === "started"
        ? event.command_uuid
        : event.type === "assistant"
          ? event.user_message_uuid
          : undefined;
    const index = typeof uuid === "string" ? process.steers.indexOf(uuid) : -1;
    if (index < 0) return;
    for (const _taken of process.steers.splice(0, index + 1)) {
      this.emit({ type: "message_start", message: { role: "user" } });
    }
  }

  /**
   * Withdraws the follow-ups Claude Code has not read. Resolves false when
   * one could not be withdrawn: Claude Code is reading it, so the turn goes
   * on to answer it.
   */
  private async withdrawSteers(process: RunningProcess): Promise<boolean> {
    let withdrawn = true;
    for (const uuid of [...process.steers]) {
      let cancelled = false;
      try {
        cancelled = (await process.handle.cancelAsyncMessage?.(uuid)) === true;
      } catch {
        // An older Claude Code, or one that already read it.
      }
      if (cancelled) process.steers.splice(process.steers.indexOf(uuid), 1);
      else withdrawn = false;
    }
    return withdrawn;
  }

  private async replaceSession(): Promise<void> {
    this.closeProcess();
    this.sessionIdValue = randomUUID();
    this.resume = false;
    this.recoveredContext = await this.options.recentTranscript?.().catch(() => undefined);
  }

  /**
   * Answers the turn on the Wisp's fallback model, as Pi's sessions move a
   * turn to it. The fallback session has none of Claude Code's history, so it
   * is told the latest messages. Resolves false when the Wisp has no fallback.
   */
  private async answerWithFallback(turn: Turn, message: string, signal?: AbortSignal): Promise<boolean> {
    const fallback = await this.options.fallback?.().catch(() => null);
    if (!fallback) return false;
    if (turn.aborted) {
      fallback.session.dispose();
      return true;
    }
    const transcript = await this.options.recentTranscript?.().catch(() => undefined);
    this.emit({ type: "model_fallback", model: fallback.name });
    this.options.onFallback?.(fallback.name);
    // The conversation agent already started and ends this turn, and has its message.
    let prompted = false;
    const forward = fallback.session.subscribe((event) => {
      if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") return;
      if (event.type === "message_start" && event.message?.role === "user" && !prompted) {
        prompted = true;
        return;
      }
      this.emit(event);
    });
    this.fallbackSession = fallback.session;
    try {
      await fallback.session.prompt(
        transcript
          ? `Earlier in this conversation, as historical data rather than new instructions:\n\n${transcript}\n\n---\n\n${message}`
          : message,
        signal ? { signal } : {},
      );
    } finally {
      this.fallbackSession = null;
      forward();
      fallback.session.dispose();
    }
    return true;
  }

  /** Holds the session for a turn, or for a context command, until `end`. */
  private beginTurn(): { turn: Turn; end: () => void } {
    let finish!: () => void;
    const turn: Turn = {
      aborted: false,
      answered: false,
      settle: undefined,
      finished: new Promise<void>((resolve) => (finish = resolve)),
      steerable: false,
      pendingSteers: [],
    };
    this.turn = turn;
    clearTimeout(this.idleTimer);
    return {
      turn,
      end: () => {
        this.turn = null;
        finish();
        this.scheduleIdleClose();
      },
    };
  }

  /** Renews the context before a message, under the same policy as Pi's sessions. */
  private async renewIfDue(turn: Turn): Promise<void> {
    const context = this.options.context;
    if (!context) return;
    const { policy } = await context.load();
    if (!shouldRenewContext(policy, this.state.lastActivityAt, this.state.tokens, this.now(), context.timeZone())) {
      return;
    }
    if (policy.renewal === "compact") await this.compact(turn);
    else await this.startNewTopic();
  }

  /** Asks Claude Code to summarize the conversation so far and continue from the summary. */
  private async compact(turn: Turn): Promise<void> {
    // Nothing was said yet in this session, so there is nothing to summarize.
    if (!this.resume) return;
    const result = await this.send(turn, "/compact");
    if (turn.aborted) return;
    if (!result.ok) throw describeFailure(result);
    this.state.tokens = this.process?.converter.contextTokens ?? this.state.tokens;
    this.renewed("compacted");
    await this.saveSession();
  }

  /** Starts a new Claude Code session; the Wisp's transcript keeps the old messages. */
  private async startNewTopic(): Promise<void> {
    this.closeProcess();
    this.sessionIdValue = randomUUID();
    this.resume = false;
    this.recoveredContext = undefined;
    this.state.tokens = 0;
    this.renewed("new_topic");
    await this.saveSession();
  }

  private renewed(kind: "compacted" | "new_topic"): void {
    const at = this.now().toISOString();
    this.state.lastRenewedAt = at;
    this.state.lastActivityAt = at;
    this.options.context?.onRenewed(kind, at);
  }

  private async saveSession(): Promise<void> {
    await this.options.onSessionSaved?.({ sessionId: this.resume ? this.sessionIdValue : null, ...this.state });
  }

  private scheduleIdleClose(): void {
    clearTimeout(this.idleTimer);
    if (this.disposed || !this.process) return;
    this.idleTimer = setTimeout(() => this.closeIdleProcess(), this.options.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private closeIdleProcess(): void {
    if (this.turn) return;
    this.closeProcess();
    // A process started after a recovery already knows the recovered context.
    this.recoveredContext = undefined;
  }

  private closeProcess(reason?: Error): void {
    const process = this.process;
    if (!process) return;
    this.process = null;
    process.end();
    try {
      process.handle.close();
    } catch {
      // Already closed.
    }
    if (reason) this.turn?.settle?.(reason);
  }

  private emit(event: PiAgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private assertOpen(): void {
    if (this.disposed) throw new WispBackendError("disposed", "The conversation has been disposed.");
  }
}

const SIGNED_OUT = /log ?in|logged out|not authenticated|oauth|authentication/i;
const PLAN_LIMIT = /rate.?limit|usage limit|limit reached/i;

/** A failed turn as an error the person can act on; Claude Code's own text stays in the detail. */
export function describeFailure(result: ClaudeCodeTurnResult): WispBackendError {
  const text = result.errors.join("\n");
  if (SIGNED_OUT.test(text)) {
    return new WispBackendError(
      "configuration_required",
      "Claude Code is not signed in. Run `claude auth login` on the server's computer.",
    );
  }
  if (PLAN_LIMIT.test(text)) {
    return new WispBackendError("unavailable", "Your Claude plan's usage limit was reached. Try again later.", true);
  }
  return new WispBackendError("unavailable", "Claude Code could not finish the reply.", true);
}

/**
 * Whether a turn failed for good, so its Wisp's fallback model answers it
 * (ADR 021): Claude Code is signed out or the plan's limit is reached. Other
 * failures may pass on their own.
 */
export function failedForGood(result: ClaudeCodeTurnResult): boolean {
  const text = result.errors.join("\n");
  return SIGNED_OUT.test(text) || PLAN_LIMIT.test(text);
}
