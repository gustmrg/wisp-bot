import type { WispApi } from "../../shared/contracts";

const REQUIRED_WISP_METHODS = [
  "startConversation",
  "sendMessage",
  "abortConversation",
  "applyModel",
  "disposeConversation",
  "subscribeToAgentEvents",
  "getAiSettings",
  "saveAiSettings",
  "removeProviderCredential",
  "getConversationState",
  "initializeConversations",
  "createConversation",
  "updateConversation",
  "deleteConversation",
  "appendConversationMessage",
  "answerConversationPrompt",
  "markConversationRead",
  "getToolPolicy",
  "saveToolPolicy",
  "resolveToolApproval",
] as const satisfies ReadonlyArray<keyof WispApi>;

export function isWispBridgeAvailable(value: unknown): value is WispApi {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return REQUIRED_WISP_METHODS.every((method) => typeof candidate[method] === "function");
}
