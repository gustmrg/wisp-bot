import type { AgentSession } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Api,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai" with { "resolution-mode": "import" };

import { isRequestTooLarge } from "./provider-error.js";

/** The session entry recording that a turn moved to the fallback model. */
export const FALLBACK_ENTRY = "wisp:fallback";

type StreamFn = AgentSession["agent"]["streamFunction"];
type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;
type RequestModel = Model<Api>;

/** What the fallback needs from Pi's model library, which the backend loads at run time. */
export interface FallbackPiFunctions {
  isRetryableAssistantError(message: AssistantMessage): boolean;
  isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean;
  clampThinkingLevel(model: RequestModel, level: ModelThinkingLevel): ModelThinkingLevel;
  createAssistantMessageEventStream(): AssistantMessageEventStream;
}

export interface ModelFallbackOptions {
  pi: FallbackPiFunctions;
  /** The Wisp's fallback model now, or null when it has none; read only when its model fails. */
  resolve: () => Promise<RequestModel | null>;
  /** Told when a turn moves to the fallback model. */
  onFallback?: (model: RequestModel) => void;
  /**
   * How many times Pi retries a failure that may pass, such as a rate limit;
   * the failure after those retries goes to the fallback. Without it, those
   * failures never move.
   */
  retries?: number;
}

/**
 * Whether a failed model call should be sent to the fallback: Pi does not
 * retry it, so it fails the same way again, as when the provider is out of
 * credits, rejects the key, or no longer serves the model. A request too
 * large for the model is left to compaction.
 */
export function shouldFallBack(pi: FallbackPiFunctions, message: AssistantMessage, contextWindow: number): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  if (pi.isRetryableAssistantError(message)) return false;
  return !pi.isContextOverflow(message, contextWindow) && !isRequestTooLarge(message.errorMessage);
}

/**
 * Whether a failed model call is one Pi retries: a rate limit, an overloaded
 * or failing server, a dropped connection. Its fallback waits for those
 * retries to run out (ADR 035).
 */
export function isRetriedFailure(pi: FallbackPiFunctions, message: AssistantMessage, contextWindow: number): boolean {
  if (message.stopReason !== "error") return false;
  return pi.isRetryableAssistantError(message) && !pi.isContextOverflow(message, contextWindow);
}

/**
 * Sends a Wisp's model calls to its fallback model when its own fails before
 * answering, for good or once Pi's retries have run out. The switch lasts for
 * the rest of the turn, so the Wisp moves at most once per turn and tries its
 * own model again on the next.
 */
export class ModelFallback {
  private readonly pi: FallbackPiFunctions;
  private readonly resolve: ModelFallbackOptions["resolve"];
  private readonly onFallback: ModelFallbackOptions["onFallback"];
  private readonly retries: number;
  private fallback: RequestModel | null = null;
  /** Calls of the Wisp's model in a row that failed in a way Pi retries, since one last answered. */
  private retriedFailures = 0;
  /** The provider and reasoning of the fallback request being sent, for hooks that shape its payload. */
  fallbackRequest: { provider: string; thinkingLevel: ModelThinkingLevel } | undefined;

  constructor(options: ModelFallbackOptions) {
    this.pi = options.pi;
    this.resolve = options.resolve;
    this.onFallback = options.onFallback;
    this.retries = options.retries ?? 0;
  }

  /** Starts a turn on the Wisp's own model. */
  reset(): void {
    this.fallback = null;
    this.retriedFailures = 0;
  }

  wrap(inner: StreamFn): StreamFn {
    return async (model, context, options) => {
      if (this.fallback) return this.sendToFallback(inner, model, this.fallback, context, options);
      this.fallbackRequest = undefined;
      const primary = await inner(model, context, options);
      const output = this.pi.createAssistantMessageEventStream();
      void this.relay(
        primary,
        output,
        (failed) => this.retry(inner, model, failed, context, options),
        () => {
          this.retriedFailures = 0;
        },
      );
      return output;
    };
  }

  /**
   * Passes the model's events on, holding back its opening event until it
   * answers: a call that fails before then can still go to the fallback.
   */
  private async relay(
    source: AssistantMessageEventStream,
    output: AssistantMessageEventStream,
    retry: (failed: AssistantMessage) => Promise<AssistantMessageEventStream | null>,
    answered: () => void,
  ): Promise<void> {
    const held: AssistantMessageEvent[] = [];
    let answering = false;
    for await (const event of source) {
      if (!answering && event.type === "start") {
        held.push(event);
        continue;
      }
      if (!answering && event.type === "error") {
        const fallback = await retry(event.error);
        if (fallback) {
          for await (const next of fallback) output.push(next);
          output.end();
          return;
        }
      }
      if (!answering) {
        answering = true;
        if (event.type !== "error") answered();
        for (const opening of held) output.push(opening);
      }
      output.push(event);
    }
    output.end();
  }

  private async retry(
    inner: StreamFn,
    model: RequestModel,
    failed: AssistantMessage,
    context: Parameters<StreamFn>[1],
    options: StreamOptions | undefined,
  ): Promise<AssistantMessageEventStream | null> {
    if (options?.signal?.aborted || !this.movesOn(failed, model.contextWindow)) return null;
    const fallback = await this.resolve().catch(() => null);
    if (!fallback || options?.signal?.aborted) return null;
    try {
      const stream = await this.sendToFallback(inner, model, fallback, context, options);
      this.fallback = fallback;
      this.retriedFailures = 0;
      this.onFallback?.(fallback);
      return stream;
    } catch {
      // A fallback that cannot start leaves the model's own error to report.
      this.fallbackRequest = undefined;
      return null;
    }
  }

  /**
   * A failure Pi does not retry moves at once. One Pi retries moves only when
   * Pi's retries have run out, on the failure that would otherwise end the turn.
   */
  private movesOn(failed: AssistantMessage, contextWindow: number): boolean {
    if (shouldFallBack(this.pi, failed, contextWindow)) return true;
    if (!isRetriedFailure(this.pi, failed, contextWindow)) return false;
    this.retriedFailures += 1;
    return this.retries > 0 && this.retriedFailures > this.retries;
  }

  private sendToFallback(
    inner: StreamFn,
    model: RequestModel,
    fallback: RequestModel,
    context: Parameters<StreamFn>[1],
    options: StreamOptions | undefined,
  ): ReturnType<StreamFn> {
    const thinkingLevel = this.pi.clampThinkingLevel(fallback, options?.reasoning ?? "off");
    this.fallbackRequest = { provider: fallback.provider, thinkingLevel };
    const { apiKey, headers, env, ...rest } = options ?? {};
    // Credentials resolved for the Wisp's provider must not reach another one; it resolves its own.
    const auth = fallback.provider === model.provider ? { apiKey, headers, env } : {};
    return inner(fallback, context, {
      ...rest,
      ...auth,
      maxTokens: rest.maxTokens === undefined ? undefined : Math.min(rest.maxTokens, fallback.maxTokens),
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
    });
  }
}
