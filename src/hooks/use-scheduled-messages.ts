import { useCallback, useEffect, useState } from "react";

import type { BackendResult } from "../../shared/contracts";
import type { ScheduledMessage, ScheduledMessagesView } from "../../shared/scheduled-messages";
import { localTimeZone } from "@/lib/scheduled-time";

export interface ScheduledMessagesController {
  /** False until the backend answers, and when it cannot schedule messages (an older server). */
  available: boolean;
  /** Every scheduled message, soonest first. */
  messages: ReadonlyArray<ScheduledMessage>;
  /** Each resolves with an error message, or null when it worked. */
  schedule: (conversationId: string, text: string, at: Date) => Promise<string | null>;
  update: (scheduledMessageId: string, changes: { text?: string; at?: Date }) => Promise<string | null>;
  cancel: (scheduledMessageId: string) => Promise<string | null>;
  sendNow: (scheduledMessageId: string) => Promise<string | null>;
}

/** The backend's scheduled messages, kept current by its change events. */
export function useScheduledMessages(): ScheduledMessagesController {
  const [available, setAvailable] = useState(false);
  const [messages, setMessages] = useState<ReadonlyArray<ScheduledMessage>>([]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.wisp.subscribeToScheduledMessages((view) => {
      setAvailable(true);
      setMessages(view.messages);
    });
    void window.wisp.getScheduledMessages().then(
      (result) => {
        if (cancelled) return;
        setAvailable(result.ok);
        if (result.ok) setMessages(result.value.messages);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const run = useCallback(async (call: () => Promise<BackendResult<ScheduledMessagesView>>) => {
    try {
      const result = await call();
      if (!result.ok) return result.error.message;
      setMessages(result.value.messages);
      return null;
    } catch {
      return "The scheduled message could not be saved.";
    }
  }, []);

  const schedule = useCallback(
    (conversationId: string, text: string, at: Date) =>
      run(() =>
        window.wisp.scheduleMessage({
          conversationId,
          text,
          schedule: { kind: "once", at: at.toISOString() },
          timeZone: localTimeZone(),
        }),
      ),
    [run],
  );
  const update = useCallback(
    (scheduledMessageId: string, changes: { text?: string; at?: Date }) =>
      run(() =>
        window.wisp.updateScheduledMessage({
          scheduledMessageId,
          ...(changes.text === undefined ? {} : { text: changes.text }),
          ...(changes.at
            ? { schedule: { kind: "once", at: changes.at.toISOString() }, timeZone: localTimeZone() }
            : {}),
        }),
      ),
    [run],
  );
  const cancel = useCallback(
    (scheduledMessageId: string) => run(() => window.wisp.cancelScheduledMessage({ scheduledMessageId })),
    [run],
  );
  const sendNow = useCallback(
    (scheduledMessageId: string) => run(() => window.wisp.sendScheduledMessageNow({ scheduledMessageId })),
    [run],
  );

  return { available, messages, schedule, update, cancel, sendNow };
}
