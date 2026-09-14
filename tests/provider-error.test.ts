import { describe, expect, it } from "vitest";

import { describeProviderError, isRetryableProviderError } from "../electron/backend/provider-error.js";

describe("describeProviderError", () => {
  it("classifies by HTTP status with short actionable messages", () => {
    expect(describeProviderError('OpenRouter API error (404): {"code":404}')).toEqual({
      message: "This model is unavailable. Choose a different model in the model settings.",
      retryable: false,
    });
    expect(describeProviderError("Anthropic API error (401): invalid api key").message).toContain("API key");
    expect(describeProviderError("OpenAI API error (402): insufficient credits").message).toContain("credits");
    expect(describeProviderError("Gemini API error (429): resource exhausted").message).toContain("rate limiting");
  });

  it("treats server errors and network failures as retryable", () => {
    expect(describeProviderError("OpenRouter API error (502): bad gateway")).toEqual({
      message: "The provider is having temporary issues. Please try again in a moment.",
      retryable: true,
    });
    expect(describeProviderError("fetch failed").retryable).toBe(true);
    expect(describeProviderError("connection refused").retryable).toBe(true);
    expect(describeProviderError("request timed out").retryable).toBe(true);
    expect(describeProviderError("too many requests, slow down").retryable).toBe(true);
  });

  it("falls back to a generic message when the error matches nothing known", () => {
    expect(describeProviderError("The model returned malformed output")).toEqual({
      message: "The model request failed. Please try again.",
      retryable: false,
    });
    expect(describeProviderError("   ")).toEqual({
      message: "The model request failed. Please try again.",
      retryable: true,
    });
  });
});

describe("isRetryableProviderError", () => {
  it("keeps the historical status and keyword classification", () => {
    expect(isRetryableProviderError("OpenRouter API error (404): not found")).toBe(false);
    expect(isRetryableProviderError("400 invalid max tokens")).toBe(false);
    expect(isRetryableProviderError("OpenRouter API error (429): rate limited")).toBe(true);
    expect(isRetryableProviderError("OpenRouter API error (500): internal")).toBe(true);
    expect(isRetryableProviderError("service unavailable")).toBe(true);
    expect(isRetryableProviderError("stream disconnected unexpectedly")).toBe(false);
  });
});
