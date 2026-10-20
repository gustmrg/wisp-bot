import { describe, expect, it } from "vitest";

import { modelLab, modelLabLogo } from "@/lib/model-lab";

describe("modelLab", () => {
  it.each([
    ["anthropic", "claude-opus-4-5", "anthropic"],
    ["openai", "o3", "openai"],
    ["kimi-coding", "k3", "moonshot"],
    ["meta", "muse-spark-1.3", "meta"],
    ["google", "deep-research-preview-04-2026", "google"],
    ["claude-code", "opus", "anthropic"],
  ])("uses the lab running provider %s for %s", (providerId, modelId, lab) => {
    expect(modelLab({ providerId, modelId })).toBe(lab);
  });

  it.each([
    ["openrouter", "anthropic/claude-opus-4.5", "anthropic"],
    ["amazon-bedrock", "us.anthropic.claude-fable-5-1", "anthropic"],
    ["amazon-bedrock", "amazon.nova-pro-v1:0", "amazon"],
    ["github-copilot", "gpt-5.5", "openai"],
    ["groq", "openai/gpt-oss-120b", "openai"],
    ["huggingface", "deepseek-ai/DeepSeek-V3.1", "deepseek"],
    ["cloudflare-workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "meta"],
    ["vercel-ai-gateway", "alibaba/qwen-3-235b", "qwen"],
    ["openrouter", "x-ai/grok-4.7", "xai"],
    ["together", "MiniMaxAI/MiniMax-M3", "minimax"],
    ["fireworks", "accounts/fireworks/models/nemotron-3-ultra-nvfp4", "nvidia"],
    ["github-copilot", "mai-code-1.1-flash", "microsoft"],
  ])("finds the lab behind reseller %s for %s", (providerId, modelId, lab) => {
    expect(modelLab({ providerId, modelId })).toBe(lab);
  });

  it("prefers the model family over the provider that serves it", () => {
    expect(modelLab({ providerId: "mistral", modelId: "zai-glm-5-3" })).toBe("zai");
  });

  it.each([
    ["openrouter", "openrouter/auto"],
    ["radius", "balanced"],
    ["openrouter", "cohere/command-a-plus"],
  ])("has no lab for routers and unknown labs (%s %s)", (providerId, modelId) => {
    expect(modelLab({ providerId, modelId })).toBeNull();
    expect(modelLabLogo({ providerId, modelId })).toBeUndefined();
  });

  it("gives each known lab its own logo", () => {
    const anthropic = modelLabLogo({ providerId: "anthropic", modelId: "claude-opus-4-5" });
    expect(anthropic).toEqual(expect.any(String));
    expect(modelLabLogo({ providerId: "openrouter", modelId: "anthropic/claude-opus-4.5" })).toBe(anthropic);
    expect(modelLabLogo({ providerId: "openai", modelId: "gpt-5.5" })).not.toBe(anthropic);
  });
});
