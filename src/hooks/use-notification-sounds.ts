import { useEffect, useRef } from "react";

import type { ChatSummaryCollection, ManagedConversationStatus } from "../../shared/conversations";
import type { AppPreferences } from "@/lib/app-preferences";
import { playNotificationSound, type NotificationSoundKind } from "@/lib/notification-sounds";

interface NotificationSoundsOptions {
  preferences: AppPreferences;
  chats: ChatSummaryCollection;
  activeChatId?: string;
}

/** Only live transitions notify; snapshots and initial idle statuses stay silent. */
export function useNotificationSounds(options: NotificationSoundsOptions): void {
  const settingsRef = useRef(options);
  const previousStatuses = useRef<Record<string, ManagedConversationStatus>>({});
  const unsuccessful = useRef(new Set<string>());

  useEffect(() => {
    settingsRef.current = options;
  });

  useEffect(() => {
    function notify(conversationId: string, kind: NotificationSoundKind) {
      const { preferences, chats, activeChatId } = settingsRef.current;
      const chat = chats[conversationId];
      if (!preferences.notificationSounds || !chat || chat.kind !== "wisp" || !chat.notifyOnUpdatesEnabled) return;
      const enabled =
        kind === "finished"
          ? preferences.notifyOnCompletion
          : kind === "needs-input"
            ? preferences.notifyOnApproval
            : preferences.notifyOnError;
      if (!enabled) return;
      if (
        preferences.muteActiveConversation &&
        activeChatId === conversationId &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      )
        return;
      playNotificationSound(kind, preferences.notificationVolume);
    }

    return window.wisp.subscribeToAgentEvents((event) => {
      const id = event.conversationId;
      switch (event.type) {
        case "conversation_status": {
          const previous = previousStatuses.current[id];
          previousStatuses.current[id] = event.status;
          if (event.status === "working" && previous !== "working") unsuccessful.current.delete(id);
          if (previous === "working" && event.status === "idle" && !unsuccessful.current.has(id))
            notify(id, "finished");
          if (event.status === "disposed") {
            delete previousStatuses.current[id];
            unsuccessful.current.delete(id);
          }
          return;
        }
        case "conversation_error":
          // Errors without a request (e.g. a rejected model change) are not turn failures.
          if (!event.requestId) return;
          unsuccessful.current.add(id);
          notify(id, "error");
          return;
        case "assistant_message_cancelled":
          unsuccessful.current.add(id);
          return;
        case "tool_approval_requested":
          notify(id, "needs-input");
          return;
      }
    });
  }, []);
}
