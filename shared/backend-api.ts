import type { BackendResult, WispApi } from "./contracts.js";
import type { ConversationStateView, Message } from "./conversations.js";

/** Domain operations shared by local IPC and authenticated remote transports. */
export type BackendApi = Omit<
  WispApi,
  "getUpdateState" | "checkForUpdates" | "downloadUpdate" | "installUpdate" | "subscribeToUpdateState"
> & {
  subscribeToConversationState?(listener: (state: ConversationStateView) => void): () => void;
  getConversationMessages?(request: {
    conversationId: string;
    before?: string;
    limit?: number;
  }): Promise<BackendResult<{ messages: Message[]; nextCursor: string | null }>>;
  refreshConnection?(): Promise<BackendResult<ConversationStateView>>;
};
