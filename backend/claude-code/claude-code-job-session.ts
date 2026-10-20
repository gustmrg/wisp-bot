import type { SessionReportUsage } from "../../shared/contracts.js";
import { WispBackendError } from "../backend-error.js";
import type { RuntimeJobSession } from "../runtime-session.js";
import { ClaudeCodeEventConverter, type ClaudeCodeTurnResult } from "./claude-code-events.js";
import { claudeCodeUserMessage, type ClaudeCodeQueryOptions } from "./claude-code-launch.js";
import { describeFailure, type ClaudeCodeQuery, type ClaudeCodeQueryHandle } from "./claude-code-session.js";

const NO_USAGE: SessionReportUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

export interface ClaudeCodeJobSessionOptions {
  query: ClaudeCodeQuery;
  /** The run's query options: the job's tools and skills, and no session to keep. */
  queryOptions: () => Promise<ClaudeCodeQueryOptions>;
  toolNames: ReadonlyArray<string>;
}

/**
 * One run of a Claude Code Wisp's job (ADR 019, ADR 026): a single turn in a
 * Claude Code process that keeps no session. The process starts in `prompt`,
 * so tool calls run within the authorization broker's unattended run the job
 * runner wraps it in.
 */
export class ClaudeCodeJobSession implements RuntimeJobSession {
  readonly sessionFile = undefined;
  private readonly options: ClaudeCodeJobSessionOptions;
  private handle: ClaudeCodeQueryHandle | undefined;
  private result: ClaudeCodeTurnResult | undefined;
  private aborted = false;
  private failure: string | undefined;

  constructor(options: ClaudeCodeJobSessionOptions) {
    this.options = options;
  }

  getActiveToolNames(): string[] {
    return [...this.options.toolNames];
  }

  async prompt(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const queryOptions = await this.options.queryOptions();
    signal.throwIfAborted();
    // The one message; once it is read, input ends, and Claude Code exits after the turn.
    async function* input() {
      yield claudeCodeUserMessage(text);
    }
    const handle = this.options.query({ prompt: input(), options: queryOptions });
    this.handle = handle;
    const stop = () => {
      this.aborted = true;
      handle.interrupt().catch(() => handle.close());
    };
    signal.addEventListener("abort", stop, { once: true });
    const converter = new ClaudeCodeEventConverter();
    try {
      for await (const message of handle) {
        const { result } = converter.convert(message);
        if (result) this.result = result;
      }
    } catch (error) {
      // The SDK also throws after an error result it already yielded.
      if (!this.result) this.failure = error instanceof Error ? error.message : String(error);
    } finally {
      signal.removeEventListener("abort", stop);
    }
    if (this.aborted) return;
    if (this.result && !this.result.ok) throw describeFailure(this.result);
    if (!this.result) {
      throw new WispBackendError(
        "unavailable",
        this.failure ? `Claude Code stopped unexpectedly: ${this.failure}` : "Claude Code stopped unexpectedly.",
        true,
      );
    }
  }

  lastAssistantMessage(): { text: string; stopReason?: string; errorMessage?: string } | undefined {
    if (this.aborted) return { text: "", stopReason: "aborted" };
    if (!this.result) return undefined;
    return this.result.ok
      ? { text: this.result.reply, stopReason: "stop" }
      : { text: "", stopReason: "error", errorMessage: this.result.errors.join("\n") };
  }

  usage(): SessionReportUsage {
    return this.result?.usage ?? NO_USAGE;
  }

  dispose(): void {
    try {
      this.handle?.close();
    } catch {
      // Already closed.
    }
  }
}
