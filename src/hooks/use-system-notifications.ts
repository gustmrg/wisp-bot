import { useEffect, useRef } from "react";

import type { SystemNotificationTarget } from "../../shared/contracts";
import type { AppPreferences } from "@/lib/app-preferences";

interface SystemNotificationsOptions {
  preferences: AppPreferences;
  /** The conversation on screen, if any: while the window has focus, its updates need no notification. */
  shownChatId: string | null;
  onOpen: (target: SystemNotificationTarget) => void;
}

/**
 * Tells the desktop app which Wisp updates show a native notification and
 * which conversation is on screen, and opens the conversation a clicked
 * notification is about. The notifications come from the main process, so
 * they keep coming with every window closed. Does nothing in the browser app.
 */
export function useSystemNotifications({ preferences, shownChatId, onOpen }: SystemNotificationsOptions): void {
  const api = window.wisp.systemNotifications;
  const { systemNotifications, systemNotifyOnCompletion, systemNotifyOnApproval, systemNotifyOnError } = preferences;
  const open = useRef(onOpen);

  useEffect(() => {
    open.current = onOpen;
  });

  useEffect(() => {
    void api
      ?.configure({
        enabled: systemNotifications,
        onCompletion: systemNotifyOnCompletion,
        onApproval: systemNotifyOnApproval,
        onError: systemNotifyOnError,
      })
      .catch(() => undefined);
  }, [api, systemNotifications, systemNotifyOnCompletion, systemNotifyOnApproval, systemNotifyOnError]);

  useEffect(() => {
    void api?.setFocus({ conversationId: shownChatId }).catch(() => undefined);
  }, [api, shownChatId]);

  useEffect(() => api?.subscribeToOpen((target) => open.current(target)), [api]);
}
