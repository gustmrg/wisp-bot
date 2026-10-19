import { randomUUID } from "node:crypto";

import type { ThinkingLevel } from "../../shared/contracts.js";
import { WispBackendError } from "../backend-error.js";
import type { RuntimeSession } from "../runtime-session.js";
import type { PiAgentEvent } from "../pi-event-translator.js";
import { ClaudeCodeEventConverter, isMissingSession, type ClaudeCodeTurnResult } from "./claude-code-events.js";
import { claudeCodeUserMessage, type ClaudeCodeQueryOptions } from "./claude-code-launch.js";

/** A Claude Code process closes after this long without a turn; the next message resumes it. */
const DEFAULT_IDLE_MS = 30 * 60_000;

/** The part of the Agent SDK's `query` a session uses. */
export type ClaudeCodeQuery = (params: {
  prompt: AsyncIterable<ReturnType<typeof claudeCodeUserMessage>>;
  options: ClaudeCodeQueryOptions;
}) => ClaudeCodeQueryHandle;

export interface ClaudeCodeQueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
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
  /**
   * Saves the Claude Code session ID once a turn in it succeeded, so it is
   * resumed later: a new session's, or a replacement for one Claude Code no
   * longer had. A session that never answered is never resumed.
   */
  onSessionSaved?: (sessionId: string) => Promise<void>;
  /** The latest of the Wisp's own messages, to carry into a replaced session. */
  recentTranscript?: () => Promise<string>;
  /** Told the outcome of each turn: usage, plan usage, the model the alias resolved to. */
  onTurnResult?: (result: ClaudeCodeTurnResult, converter: ClaudeCodeEventConverter) => void;
  idleMs?: number;
}

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
  private disposed = false;

  constructor(options: ClaudeCodeSessionOptions) {
    this.options = options;
    this.toolRevision = options.toolRevision;
    this.toolNames = [...options.toolNames];
    this.sessionIdValue = options.sessionId;
    this.resume = options.resume;
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel;
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
    let finish!: () => void;
    const turn: Turn = {
      aborted: false,
      answered: false,
      settle: undefined,
      finished: new Promise<void>((resolve) => (finish = resolve)),
    };
    this.turn = turn;
    const message = this.notes.length ? `${this.notes.join("\n\n")}\n\n${text}` : text;
    this.notes = [];
    clearTimeout(this.idleTimer);
    this.emit({ type: "agent_start" });
    try {
      let result = await this.send(turn, message);
      if (isMissingSession(result) && !turn.answered && !turn.aborted) {
        // Claude Code deletes sessions unused for a while; start a new one that knows the latest messages.
        await this.replaceSession();
        result = await this.send(turn, message);
      }
      if (!result.ok && !turn.aborted) throw describeFailure(result);
      if (result.ok && !this.resume) {
        this.resume = true;
        await this.options.onSessionSaved?.(this.sessionIdValue);
      }
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled" });
    } finally {
      this.turn = null;
      finish();
      this.scheduleIdleClose();
    }
  }

  async abort(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.aborted = true;
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

  /** Sends the turn's message to Claude Code and waits for its result; a stopped turn sends nothing. */
  private async send(turn: Turn, text: string): Promise<ClaudeCodeTurnResult> {
    const stopped: ClaudeCodeTurnResult = {
      sessionId: this.sessionIdValue,
      ok: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
      estimatedCostUsd: null,
      errors: [],
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
    });
    turn.settle = undefined;
    if (outcome instanceof Error) throw outcome;
    return outcome!;
  }

  private async ensureProcess(): Promise<RunningProcess> {
    if (this.process) return this.process;
    const launch: ClaudeCodeLaunch = {
      sessionId: this.sessionIdValue,
      resume: this.resume,
      model: this.model,
      ...(claudeCodeEffort(this.thinkingLevel) ? { effort: claudeCodeEffort(this.thinkingLevel) } : {}),
      ...(this.recoveredContext ? { recoveredContext: this.recoveredContext } : {}),
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
      converter: new ClaudeCodeEventConverter(),
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
        const { events, result } = process.converter.convert(message);
        const turn = this.turn;
        if (turn && events.some((event) => event.type === "message_update" || event.type === "tool_execution_start")) {
          turn.answered = true;
        }
        for (const event of events) this.emit(event);
        if (result) {
          if (result.sessionId) this.sessionIdValue = result.sessionId;
          this.options.onTurnResult?.(result, process.converter);
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

  private async replaceSession(): Promise<void> {
    this.closeProcess();
    this.sessionIdValue = randomUUID();
    this.resume = false;
    this.recoveredContext = await this.options.recentTranscript?.().catch(() => undefined);
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

/** A failed turn as an error the person can act on; Claude Code's own text stays in the detail. */
function describeFailure(result: ClaudeCodeTurnResult): WispBackendError {
  const text = result.errors.join("\n");
  if (/log ?in|logged out|not authenticated|oauth|authentication/i.test(text)) {
    return new WispBackendError(
      "configuration_required",
      "Claude Code is not signed in. Run `claude auth login` on the server's computer.",
    );
  }
  if (/rate.?limit|usage limit|limit reached/i.test(text)) {
    return new WispBackendError("unavailable", "Your Claude plan's usage limit was reached. Try again later.", true);
  }
  return new WispBackendError("unavailable", "Claude Code could not finish the reply.", true);
}
