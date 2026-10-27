import type { AgentSession } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Api,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai" with { "resolution-mode": "import" };

import { holdAfter, type ModelHolds } from "./model-holds.js";
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
  /**
   * The Wisp's fallback models now, in the order they are tried, or none;
   * read only when its model fails or is on hold.
   */
  resolve: () => Promise<ReadonlyArray<RequestModel>>;
  /** Told when a turn moves to a fallback model, with when the hold on the Wisp's model ends, if it is held. */
  onFallback?: (model: RequestModel, until?: number) => void;
  /**
   * How many times Pi retries a failure that may pass, such as a rate limit;
   * the failure after those retries goes to the fallback. Without it, those
   * failures never move.
   */
  retries?: number;
  /**
   * Models on hold after a rate limit or an outage (ADR 035): a turn on a
   * held model starts on a fallback, held fallbacks are skipped, and a model
   * that kept failing that way after the retries is held.
   */
  holds?: ModelHolds;
  now?: () => number;
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
 * Sends a Wisp's model calls to its fallback models when its own fails before
 * answering, for good or once Pi's retries have run out. A fallback that
 * fails the same way hands over to the next in the list. The switch lasts for
 * the rest of the turn, and each turn starts on the Wisp's own model again,
 * unless it is on hold.
 */
export class ModelFallback {
  private readonly pi: FallbackPiFunctions;
  private readonly resolve: ModelFallbackOptions["resolve"];
  private readonly onFallback: ModelFallbackOptions["onFallback"];
  private readonly retries: number;
  private readonly holds: ModelHolds | undefined;
  private readonly now: () => number;
  /** The fallback answering the rest of the turn, if the turn moved. */
  private fallback: RequestModel | null = null;
  /** The fallbacks the turn moved to, which it does not go back to. */
  private tried: RequestModel[] = [];
  /**
   * Calls in a row that failed in a way Pi retries, whichever model failed,
   * since one last answered: Pi's own count, which a switch does not reset.
   */
  private retriedFailures = 0;
  /** The provider and reasoning of the fallback request being sent, for hooks that shape its payload. */
  fallbackRequest: { provider: string; thinkingLevel: ModelThinkingLevel } | undefined;

  constructor(options: ModelFallbackOptions) {
    this.pi = options.pi;
    this.resolve = options.resolve;
    this.onFallback = options.onFallback;
    this.retries = options.retries ?? 0;
    this.holds = options.holds;
    this.now = options.now ?? Date.now;
  }

  /** Starts a turn on the Wisp's own model. */
  reset(): void {
    this.fallback = null;
    this.tried = [];
    this.retriedFailures = 0;
  }

  wrap(inner: StreamFn): StreamFn {
    return async (model, context, options) => {
      if (!this.fallback) {
        const held = await this.startOnFallback(inner, model, context, options);
        if (held) return held;
      }
      const current = this.fallback;
      if (!current) this.fallbackRequest = undefined;
      const source = current
        ? await this.sendToFallback(inner, model, current, context, options)
        : await inner(model, context, options);
      return this.relayed(source, (failed) => this.retry(inner, model, current ?? model, failed, context, options));
    };
  }

  /** A model's events, passed on by `relay` into a stream of their own. */
  private relayed(
    source: AssistantMessageEventStream,
    retry: (failed: AssistantMessage) => Promise<AssistantMessageEventStream | null>,
  ): AssistantMessageEventStream {
    const output = this.pi.createAssistantMessageEventStream();
    void this.relay(source, output, retry, () => {
      this.retriedFailures = 0;
    });
    return output;
  }

  /**
   * Passes the model's events on, holding back its opening event until it
   * answers: a call that fails before then can still go to a fallback.
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

  /** Moves a call that `current`, the Wisp's model or a fallback, failed to the next fallback, or resolves null. */
  private async retry(
    inner: StreamFn,
    model: RequestModel,
    current: RequestModel,
    failed: AssistantMessage,
    context: Parameters<StreamFn>[1],
    options: StreamOptions | undefined,
  ): Promise<AssistantMessageEventStream | null> {
    if (options?.signal?.aborted || !this.movesOn(failed, current.contextWindow)) return null;
    this.holdAfterRetries(current, failed);
    const next = await this.nextFallback(model, options);
    if (!next) return null;
    return this.switchTo(inner, model, next, context, options, this.holds?.heldUntil(model));
  }

  /**
   * Starts the call on a fallback while the Wisp's model is on hold, so the
   * turn does not wait through retries the model would most likely fail
   * again. Resolves null when the model is not held or no fallback can
   * start, and the call goes to the model as usual.
   */
  private async startOnFallback(
    inner: StreamFn,
    model: RequestModel,
    context: Parameters<StreamFn>[1],
    options: StreamOptions | undefined,
  ): Promise<AssistantMessageEventStream | null> {
    const until = this.holds?.heldUntil(model);
    if (until === undefined) return null;
    const next = await this.nextFallback(model, options);
    return next ? this.switchTo(inner, model, next, context, options, until) : null;
  }

  /** The first fallback the turn has not tried that is neither the Wisp's own model nor on hold. */
  private async nextFallback(model: RequestModel, options: StreamOptions | undefined): Promise<RequestModel | null> {
    const candidates = await this.resolve().catch(() => []);
    if (options?.signal?.aborted) return null;
    return (
      candidates.find(
        (candidate) =>
          !sameModel(candidate, model) &&
          !this.tried.some((tried) => sameModel(tried, candidate)) &&
          this.holds?.heldUntil(candidate) === undefined,
      ) ?? null
    );
  }

  /** Sends the call to `fallback`, which answers the rest of the turn, or resolves null when it cannot start. */
  private async switchTo(
    inner: StreamFn,
    model: RequestModel,
    fallback: RequestModel,
    context: Parameters<StreamFn>[1],
    options: StreamOptions | undefined,
    until: number | undefined,
  ): Promise<AssistantMessageEventStream | null> {
    this.tried.push(fallback);
    try {
      const stream = await this.sendToFallback(inner, model, fallback, context, options);
      this.fallback = fallback;
      this.onFallback?.(fallback, until);
      return this.relayed(stream, (failed) => this.retry(inner, model, fallback, failed, context, options));
    } catch {
      // A fallback that cannot start leaves the error of the model before it to report.
      this.fallbackRequest = undefined;
      return null;
    }
  }

  /** Holds a model that kept failing in a way that passes with time, once Pi's retries ran out. */
  private holdAfterRetries(model: RequestModel, failed: AssistantMessage): void {
    if (!this.holds || this.retriedFailures <= this.retries || !failed.errorMessage) return;
    const until = holdAfter(failed.errorMessage, this.now());
    if (until !== undefined) this.holds.hold(model, until);
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

function sameModel(left: RequestModel, right: RequestModel): boolean {
  return left.provider === right.provider && left.id === right.id;
}
