import { CLAUDE_CODE_PROVIDER } from "./claude-code.js";

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
   * Wisp keeps ("required"), or the provider's own sign-in outside Wisp
   * ("external"), which Wisp never sees.
   */
  credential: "required" | "external";
  /** Whether a selection sets the maximum output tokens ("configurable") or the runtime manages them ("runtime"). */
  outputLimit: "configurable" | "runtime";
}

type ProviderKindId = "catalog" | "claudeCode";

const PROVIDER_KINDS = {
  /** A provider in Pi's catalog, on an API key or a subscription sign-in. */
  catalog: { runtime: "pi", credential: "required", outputLimit: "configurable" },
  /** The person's Claude Code on their Claude plan, which keeps its own sign-in and output limit. */
  claudeCode: { runtime: "claude-code", credential: "external", outputLimit: "runtime" },
} as const satisfies Record<ProviderKindId, ProviderKind>;

function providerKindId(providerId: string): ProviderKindId {
  return providerId === CLAUDE_CODE_PROVIDER ? "claudeCode" : "catalog";
}

export function providerKind(providerId: string): ProviderKind {
  return PROVIDER_KINDS[providerKindId(providerId)];
}
