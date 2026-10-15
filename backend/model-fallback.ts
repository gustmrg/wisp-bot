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
 * Sends a Wisp's model calls to its fallback model when its own fails for
 * good before answering. The switch lasts for the rest of the turn, so the
 * Wisp moves at most once per turn and tries its own model again on the next.
 */
export class ModelFallback {
  private readonly pi: FallbackPiFunctions;
  private readonly resolve: ModelFallbackOptions["resolve"];
  private readonly onFallback: ModelFallbackOptions["onFallback"];
  private fallback: RequestModel | null = null;
  /** The provider and reasoning of the fallback request being sent, for hooks that shape its payload. */
  fallbackRequest: { provider: string; thinkingLevel: ModelThinkingLevel } | undefined;

  constructor(options: ModelFallbackOptions) {
    this.pi = options.pi;
    this.resolve = options.resolve;
    this.onFallback = options.onFallback;
  }

  /** Starts a turn on the Wisp's own model. */
  reset(): void {
    this.fallback = null;
  }

  wrap(inner: StreamFn): StreamFn {
    return async (model, context, options) => {
      if (this.fallback) return this.sendToFallback(inner, model, this.fallback, context, options);
      this.fallbackRequest = undefined;
      const primary = await inner(model, context, options);
      const output = this.pi.createAssistantMessageEventStream();
      void this.relay(primary, output, (failed) => this.retry(inner, model, failed, context, options));
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
    if (options?.signal?.aborted || !shouldFallBack(this.pi, failed, model.contextWindow)) return null;
    const fallback = await this.resolve().catch(() => null);
    if (!fallback || options?.signal?.aborted) return null;
    try {
      const stream = await this.sendToFallback(inner, model, fallback, context, options);
      this.fallback = fallback;
      this.onFallback?.(fallback);
      return stream;
    } catch {
      // A fallback that cannot start leaves the model's own error to report.
      this.fallbackRequest = undefined;
      return null;
    }
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
