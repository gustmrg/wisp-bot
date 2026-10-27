import { providerFailureCause, retryAfterMs } from "./provider-error.js";

/** How long a model is held after a rate limit or an outage whose error names no time (ADR 035). */
export const MODEL_HOLD_MS = 10 * 60_000;

/** A model as a provider serves it. */
export interface HeldModel {
  provider: string;
  id: string;
}

/**
 * Models whose provider kept rate limiting or failing after the retries,
 * which Wisps with a fallback skip until a time (ADR 035). Kept in memory,
 * so restarting the backend tries every model again.
 */
export class ModelHolds {
  private readonly until = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Holds a model until a time, in milliseconds; a later hold already set stays. */
  hold(model: HeldModel, until: number): void {
    const key = keyOf(model);
    if ((this.until.get(key) ?? 0) < until) this.until.set(key, until);
  }

  /** When the hold on a model ends, or undefined when it is not held. */
  heldUntil(model: HeldModel): number | undefined {
    const key = keyOf(model);
    const until = this.until.get(key);
    if (until === undefined) return undefined;
    if (until > this.now()) return until;
    this.until.delete(key);
    return undefined;
  }
}

/**
 * When a hold should end after a failure the runtime gave up retrying: the
 * time the provider named, or `MODEL_HOLD_MS` from now. Only rate limits and
 * a failing provider hold a model; other failures do not pass with time.
 */
export function holdAfter(errorMessage: string, now: number): number | undefined {
  const cause = providerFailureCause(errorMessage);
  if (cause !== "rate_limit" && cause !== "provider_unavailable") return undefined;
  return now + (retryAfterMs(errorMessage) ?? MODEL_HOLD_MS);
}

function keyOf(model: HeldModel): string {
  return `${model.provider}\u0000${model.id}`;
}
