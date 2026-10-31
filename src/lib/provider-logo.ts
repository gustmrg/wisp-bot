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
import basetenLogo from "@/assets/providers/baseten.svg";
import cerebrasLogo from "@/assets/providers/cerebras.svg";
import cloudflareLogo from "@/assets/providers/cloudflare.svg";
import copilotLogo from "@/assets/providers/copilot.svg";
import fireworksLogo from "@/assets/providers/fireworks.svg";
import groqLogo from "@/assets/providers/groq.svg";
import huggingfaceLogo from "@/assets/providers/huggingface.svg";
import opencodeLogo from "@/assets/providers/opencode.svg";
import openrouterLogo from "@/assets/providers/openrouter.svg";
import togetherLogo from "@/assets/providers/together.svg";
import vercelLogo from "@/assets/providers/vercel.svg";

const logos: Record<string, string> = {
  "amazon-bedrock": amazonLogo,
  anthropic: anthropicLogo,
  azure: microsoftLogo,
  baseten: basetenLogo,
  cerebras: cerebrasLogo,
  "claude-code": anthropicLogo,
  "cloudflare-ai-gateway": cloudflareLogo,
  "cloudflare-workers-ai": cloudflareLogo,
  deepseek: deepseekLogo,
  fireworks: fireworksLogo,
  "github-copilot": copilotLogo,
  google: googleLogo,
  "google-vertex": googleLogo,
  groq: groqLogo,
  huggingface: huggingfaceLogo,
  "kimi-coding": moonshotLogo,
  meta: metaLogo,
  minimax: minimaxLogo,
  "minimax-cn": minimaxLogo,
  mistral: mistralLogo,
  moonshotai: moonshotLogo,
  "moonshotai-cn": moonshotLogo,
  nvidia: nvidiaLogo,
  openai: openaiLogo,
  "openai-codex": openaiLogo,
  opencode: opencodeLogo,
  "opencode-go": opencodeLogo,
  openrouter: openrouterLogo,
  "qwen-token-plan": qwenLogo,
  "qwen-token-plan-cn": qwenLogo,
  "qwen-token-plan-individual": qwenLogo,
  together: togetherLogo,
  "vercel-ai-gateway": vercelLogo,
  xai: xaiLogo,
  xiaomi: xiaomiLogo,
  "xiaomi-token-plan-ams": xiaomiLogo,
  "xiaomi-token-plan-cn": xiaomiLogo,
  "xiaomi-token-plan-sgp": xiaomiLogo,
  zai: zaiLogo,
  "zai-coding-cn": zaiLogo,
};

/**
 * The logo of the service a provider ID names, which is not always who made
 * its models (see `modelLabLogo`). The catalog comes from the server, which may
 * be newer than this app, so an unknown ID has no logo.
 */
export function providerLogo(providerId: string): string | undefined {
  return Object.hasOwn(logos, providerId) ? logos[providerId] : undefined;
}
