import { CLAUDE_CODE_PROVIDER } from "./claude-code.js";
import { isCustomEndpointId } from "./custom-endpoints.js";

/** The runtime that runs a provider's models: Pi, or the person's Claude Code (ADR 026). */
export type ProviderRuntime = "pi" | "claude-code";

/**
 * What sets one kind of provider apart, decided here for the backend and the
 * renderer alike, so neither compares provider IDs to choose a behavior.
 */
export interface ProviderKind {
  runtime: ProviderRuntime;
  /**
   * What Wisps need before they can use the provider: a key or sign-in that
   * Wisp keeps ("required"), a key Wisp keeps when the person gives one
   * ("optional"), or the provider's own sign-in outside Wisp ("external"),
   * which Wisp never sees.
   */
  credential: "required" | "optional" | "external";
  /** Whether a selection sets the maximum output tokens ("configurable") or the runtime manages them ("runtime"). */
  outputLimit: "configurable" | "runtime";
  /** Whether token prices come from the model catalog ("catalog") or are not known ("unknown"). */
  prices: "catalog" | "unknown";
}

type ProviderKindId = "catalog" | "custom" | "claudeCode";

const PROVIDER_KINDS = {
  /** A provider in Pi's catalog, on an API key or a subscription sign-in. */
  catalog: { runtime: "pi", credential: "required", outputLimit: "configurable", prices: "catalog" },
  /** An OpenAI-compatible endpoint the person added (ADR 031): local servers need no key, and nothing says its price. */
  custom: { runtime: "pi", credential: "optional", outputLimit: "configurable", prices: "unknown" },
  /** The person's Claude Code on their Claude plan, which keeps its own sign-in and output limit. */
  claudeCode: { runtime: "claude-code", credential: "external", outputLimit: "runtime", prices: "catalog" },
} as const satisfies Record<ProviderKindId, ProviderKind>;

function providerKindId(providerId: string): ProviderKindId {
  if (providerId === CLAUDE_CODE_PROVIDER) return "claudeCode";
  return isCustomEndpointId(providerId) ? "custom" : "catalog";
}

export function providerKind(providerId: string): ProviderKind {
  return PROVIDER_KINDS[providerKindId(providerId)];
}
