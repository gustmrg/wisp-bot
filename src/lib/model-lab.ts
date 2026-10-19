import type { ModelSelection } from "../../shared/contracts";
import amazonLogo from "@/assets/model-labs/amazon.svg";
import anthropicLogo from "@/assets/model-labs/anthropic.svg";
import deepseekLogo from "@/assets/model-labs/deepseek.svg";
import googleLogo from "@/assets/model-labs/google.svg";
import metaLogo from "@/assets/model-labs/meta.svg";
import microsoftLogo from "@/assets/model-labs/microsoft.svg";
import minimaxLogo from "@/assets/model-labs/minimax.svg";
import mistralLogo from "@/assets/model-labs/mistral.svg";
import moonshotLogo from "@/assets/model-labs/moonshot.svg";
import nvidiaLogo from "@/assets/model-labs/nvidia.svg";
import openaiLogo from "@/assets/model-labs/openai.svg";
import qwenLogo from "@/assets/model-labs/qwen.svg";
import xaiLogo from "@/assets/model-labs/xai.svg";
import xiaomiLogo from "@/assets/model-labs/xiaomi.svg";
import zaiLogo from "@/assets/model-labs/zai.svg";

/** The company that made a model, which is not always the provider serving it. */
export type ModelLab =
  | "amazon"
  | "anthropic"
  | "deepseek"
  | "google"
  | "meta"
  | "microsoft"
  | "minimax"
  | "mistral"
  | "moonshot"
  | "nvidia"
  | "openai"
  | "qwen"
  | "xai"
  | "xiaomi"
  | "zai";

const logos: Record<ModelLab, string> = {
  amazon: amazonLogo,
  anthropic: anthropicLogo,
  deepseek: deepseekLogo,
  google: googleLogo,
  meta: metaLogo,
  microsoft: microsoftLogo,
  minimax: minimaxLogo,
  mistral: mistralLogo,
  moonshot: moonshotLogo,
  nvidia: nvidiaLogo,
  openai: openaiLogo,
  qwen: qwenLogo,
  xai: xaiLogo,
  xiaomi: xiaomiLogo,
  zai: zaiLogo,
};

/** Providers run by a lab, for the lab's models whose IDs name no family below. */
const labProviders: Record<string, ModelLab> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  "azure-openai-responses": "openai",
  google: "google",
  "google-vertex": "google",
  meta: "meta",
  deepseek: "deepseek",
  mistral: "mistral",
  xai: "xai",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  "kimi-coding": "moonshot",
  zai: "zai",
  "zai-coding-cn": "zai",
  minimax: "minimax",
  "minimax-cn": "minimax",
  xiaomi: "xiaomi",
};

/**
 * Model families and vendor prefixes in IDs, for providers that resell other
 * labs' models (`anthropic/claude-…`, `us.anthropic.claude-…`, `@cf/meta/llama-…`).
 */
const labPatterns: ReadonlyArray<[ModelLab, RegExp]> = [
  ["anthropic", /claude|anthropic/],
  ["openai", /gpt|openai|(^|\/)o[1-9](-|$)/],
  ["google", /gemini|gemma|(^|\/)google\//],
  ["meta", /llama|muse-spark|(^|\/)meta\//],
  ["deepseek", /deepseek/],
  ["qwen", /qwen|qwq|alibaba/],
  ["mistral", /mistral|mixtral|[cd]evstral|codestral|magistral|ministral|pixtral|voxtral/],
  ["xai", /grok|x-ai|(^|\/)xai\//],
  ["moonshot", /kimi|moonshot/],
  ["zai", /glm|z-ai|zai-org/],
  ["minimax", /minimax/],
  ["xiaomi", /mimo|xiaomi/],
  ["amazon", /(^|[./])nova-|amazon/],
  ["nvidia", /nemotron|nvidia/],
  ["microsoft", /(^|\/)phi-|(^|\/)mai-|microsoft/],
];

/** The lab that made a model, or null for unknown labs and routers that pick the model themselves. */
export function modelLab({ providerId, modelId }: ModelSelection): ModelLab | null {
  const id = modelId.toLowerCase();
  return labPatterns.find(([, pattern]) => pattern.test(id))?.[0] ?? labProviders[providerId] ?? null;
}

/** The logo of the lab that made a model, or undefined when the lab is unknown. */
export function modelLabLogo(selection: ModelSelection): string | undefined {
  const lab = modelLab(selection);
  return lab ? logos[lab] : undefined;
}
