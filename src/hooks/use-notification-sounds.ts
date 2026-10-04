import { useEffect, useRef } from "react";

import type { ChatSummaryCollection, ManagedConversationStatus } from "../../shared/conversations";
import { playNotificationSound, type NotificationSoundKind } from "@/lib/notification-sounds";

interface NotificationSoundsOptions {
  enabled: boolean;
  chats: ChatSummaryCollection;
}

/**
 * Plays a chime when a Wisp finishes its turn (working → idle) or asks for a
 * tool approval. Only reacts to live agent events, so the bootstrapped state
 * snapshot never triggers a sound; a first status event has no previous status
 * and stays silent too.
 */
export function useNotificationSounds({ enabled, chats }: NotificationSoundsOptions): void {
  const settingsRef = useRef({ enabled, chats });
  const previousStatuses = useRef<Record<string, ManagedConversationStatus>>({});

  useEffect(() => {
    settingsRef.current = { enabled, chats };
  });

  useEffect(() => {
    return window.wisp.subscribeToAgentEvents((event) => {
      const { enabled, chats } = settingsRef.current;
      if (!enabled) return;
      switch (event.type) {
        case "conversation_status": {
          const previous = previousStatuses.current[event.conversationId];
          previousStatuses.current[event.conversationId] = event.status;
          if (previous === "working" && event.status === "idle") notifyWisp(chats, event.conversationId, "finished");
          return;
        }
        case "tool_approval_requested":
          notifyWisp(chats, event.conversationId, "needs-input");
          return;
      }
    });
  }, []);
}

function notifyWisp(chats: ChatSummaryCollection, conversationId: string, kind: NotificationSoundKind): void {
  const chat = chats[conversationId];
  if (!chat || chat.kind !== "wisp" || !chat.notifyOnUpdatesEnabled) return;
  playNotificationSound(kind);
}
