import { describe, expect, it } from "vitest";

import { holdAfter, MODEL_HOLD_MS, ModelHolds } from "../backend/model-holds.js";
import { providerFailureCause, retryAfterMs } from "../backend/provider-error.js";

const NOW = Date.parse("2026-10-26T14:00:00.000Z");
const model = { provider: "openai", id: "gpt-5" };

describe("ModelHolds", () => {
  it("holds a model until a time, keeping a later hold, and lets it go once the time passed", () => {
    let now = NOW;
    const holds = new ModelHolds(() => now);
    expect(holds.heldUntil(model)).toBeUndefined();

    holds.hold(model, NOW + 20 * 60_000);
    holds.hold(model, NOW + 5 * 60_000);
    expect(holds.heldUntil(model)).toBe(NOW + 20 * 60_000);
    expect(holds.heldUntil({ provider: "openai", id: "gpt-5-mini" })).toBeUndefined();
    expect(holds.heldUntil({ provider: "openrouter", id: "gpt-5" })).toBeUndefined();

    now = NOW + 20 * 60_000;
    expect(holds.heldUntil(model)).toBeUndefined();
  });
});

describe("holdAfter", () => {
  it.each([
    ["429 Too Many Requests: rate limit reached", NOW + MODEL_HOLD_MS],
    ["Rate limit reached for gpt-5. Please try again in 20s.", NOW + 20_000],
    ["503 Service Unavailable", NOW + MODEL_HOLD_MS],
    ['API Error: 529 {"type":"overloaded_error"}', NOW + MODEL_HOLD_MS],
  ])("holds a model limited or failing: %s", (error, until) => {
    expect(holdAfter(error, NOW)).toBe(until);
  });

  it.each([
    ["402 Payment Required"],
    ['429 {"error":{"code":"insufficient_quota"}}'],
    ["401 invalid x-api-key"],
    ["fetch failed"],
    ["400 prompt is too long"],
  ])("does not hold a model for a failure that does not pass with time: %s", (error) => {
    expect(holdAfter(error, NOW)).toBeUndefined();
  });
});

describe("provider failures", () => {
  it("tells causes apart, credits before the status", () => {
    expect(providerFailureCause('429 {"error":{"code":"insufficient_quota"}}')).toBe("billing");
    expect(providerFailureCause("429 Too Many Requests")).toBe("rate_limit");
    expect(providerFailureCause("OpenRouter API error (502): bad gateway")).toBe("provider_unavailable");
    expect(providerFailureCause("403 Forbidden")).toBe("authentication");
    expect(providerFailureCause("connect ECONNREFUSED 127.0.0.1:11434")).toBe("network");
    expect(providerFailureCause("Something odd")).toBe("other");
  });

  it("reads how long the provider asked to wait", () => {
    expect(retryAfterMs("Please try again in 1.5s")).toBe(1_500);
    expect(retryAfterMs("retry after 2 minutes")).toBe(120_000);
    expect(retryAfterMs("Try again in 250ms")).toBe(250);
    expect(retryAfterMs("429 Too Many Requests")).toBeUndefined();
  });
});
