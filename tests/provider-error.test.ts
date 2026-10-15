import { describe, expect, it } from "vitest";

import { describeProviderError, isRequestTooLarge, isRetryableProviderError } from "../backend/provider-error.js";

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

  it("names an account out of credits whatever status the provider uses", () => {
    const outOfCredits = {
      message: "The provider account is out of credits or over its quota. Add credits or choose a different model.",
      retryable: false,
    };
    expect(
      describeProviderError(
        'OpenAI API error (429): {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}',
      ),
    ).toEqual(outOfCredits);
    expect(
      describeProviderError(
        "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.",
      ),
    ).toEqual(outOfCredits);
    expect(isRetryableProviderError("429 insufficient_quota")).toBe(false);
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

  it("names request-shape failures that share a generic 400 status", () => {
    expect(
      describeProviderError(
        'OpenRouter API error (400): {"message":"Invalid \'tools\': array too long. Expected an array with maximum length 128, but got 134 instead.","code":400}',
      ),
    ).toEqual({
      message:
        "This Wisp has more tools than the model accepts. Remove access to an MCP server in the Access tab or choose a different model.",
      retryable: false,
    });
    expect(
      describeProviderError(
        'OpenRouter API error (400): {"message":"This endpoint\'s maximum context length is 128000 tokens. However, you requested about 140000 tokens","code":400}',
      ).message,
    ).toContain("too long for the model");
    expect(describeProviderError("400 prompt is too long: 210000 tokens > 200000 maximum").message).toContain(
      "too long for the model",
    );
  });

  it("does not read a port or token count as an HTTP status", () => {
    expect(
      describeProviderError(
        "request to https://openrouter.ai/api/v1/chat/completions failed, reason: connect ETIMEDOUT 104.18.2.115:443",
      ),
    ).toEqual({ message: "Could not reach the provider. Check your connection and try again.", retryable: true });
    expect(isRetryableProviderError("socket hang up after 500 ms")).toBe(true);
    expect(isRetryableProviderError("Mistral API error (503): overloaded")).toBe(true);
    expect(isRetryableProviderError("request failed with status 503")).toBe(true);
    expect(isRetryableProviderError("404 Not Found: no such model")).toBe(false);
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

describe("isRequestTooLarge", () => {
  it("recognizes requests too large for the model, which compaction fixes", () => {
    expect(isRequestTooLarge("400 prompt is too long: 250000 tokens > 200000 maximum")).toBe(true);
    expect(isRequestTooLarge("This model's maximum context length is 128000 tokens")).toBe(true);
    expect(isRequestTooLarge("413 Request Entity Too Large")).toBe(true);
    expect(isRequestTooLarge("402 Payment Required")).toBe(false);
    expect(isRequestTooLarge("400 invalid max tokens")).toBe(false);
  });
});
