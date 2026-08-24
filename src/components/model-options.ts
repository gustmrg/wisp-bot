import type { ReasoningEffort } from "@/chat-data"

export const OPENAI_REASONING_EFFORTS = [
  "none", "low", "medium", "high", "xhigh", "max",
] as const satisfies ReadonlyArray<ReasoningEffort>
export const ANTHROPIC_REASONING_EFFORTS = [
  "low", "medium", "high", "xhigh", "max",
] as const satisfies ReadonlyArray<ReasoningEffort>
export const GOOGLE_REASONING_EFFORTS = [
  "minimal", "low", "medium", "high",
] as const satisfies ReadonlyArray<ReasoningEffort>

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "Extra high", max: "Maximum",
}

export const PROVIDERS = [
  { label: "OpenAI", value: "openai", models: [
    { label: "GPT-5.6 Sol", reasoningEfforts: OPENAI_REASONING_EFFORTS, value: "gpt-5.6-sol" },
    { label: "GPT-5.6 Terra", reasoningEfforts: OPENAI_REASONING_EFFORTS, value: "gpt-5.6-terra" },
    { label: "GPT-5.6 Luna", reasoningEfforts: OPENAI_REASONING_EFFORTS, value: "gpt-5.6-luna" },
  ] },
  { label: "Anthropic", value: "anthropic", models: [
    { label: "Claude Opus 5", reasoningEfforts: ANTHROPIC_REASONING_EFFORTS, value: "claude-opus-5" },
    { label: "Claude Sonnet 5", reasoningEfforts: ANTHROPIC_REASONING_EFFORTS, value: "claude-sonnet-5" },
    { label: "Claude Haiku 4.5", reasoningEfforts: [], value: "claude-haiku-4-5" },
  ] },
  { label: "Google", value: "google", models: [
    { label: "Gemini 3.7 Flash", reasoningEfforts: GOOGLE_REASONING_EFFORTS, value: "gemini-3.7-flash" },
    { label: "Gemini 3.6 Flash", reasoningEfforts: GOOGLE_REASONING_EFFORTS, value: "gemini-3.6-flash" },
    { label: "Gemini 3.5 Flash-Lite", reasoningEfforts: GOOGLE_REASONING_EFFORTS, value: "gemini-3.5-flash-lite" },
  ] },
] as const

export type ModelDefaults = { provider: string; model: string }
export const DEFAULT_MODEL_DEFAULTS: ModelDefaults = {
  provider: "openai",
  model: "gpt-5.6-terra",
}
