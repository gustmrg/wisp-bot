import { useCallback, useEffect, useState } from "react";

import type { BackendResult } from "../../shared/contracts";
import type { MessageQueueView, QueuedMessage } from "../../shared/message-queue";

export interface MessageQueueController {
  /** False until the backend answers, and when it has no message queue (an older server). */
  available: boolean;
  /** Every message waiting for its Wisp, oldest first. */
  messages: ReadonlyArray<QueuedMessage>;
  /** Each resolves with an error message, or null when it worked. */
  update: (queuedMessageId: string, text: string) => Promise<string | null>;
  cancel: (queuedMessageId: string) => Promise<string | null>;
}

/** The backend's message queue, kept current by its change events. */
export function useMessageQueue(): MessageQueueController {
  const [available, setAvailable] = useState(false);
  const [messages, setMessages] = useState<ReadonlyArray<QueuedMessage>>([]);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = window.wisp.subscribeToMessageQueue((view) => {
      setAvailable(true);
      setMessages(view.messages);
    });
    void window.wisp.getMessageQueue().then(
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

  const run = useCallback(async (call: () => Promise<BackendResult<MessageQueueView>>) => {
    try {
      const result = await call();
      if (!result.ok) return result.error.message;
      setMessages(result.value.messages);
      return null;
    } catch {
      return "The queued message could not be changed.";
    }
  }, []);

  const update = useCallback(
    (queuedMessageId: string, text: string) => run(() => window.wisp.updateQueuedMessage({ queuedMessageId, text })),
    [run],
  );
  const cancel = useCallback(
    (queuedMessageId: string) => run(() => window.wisp.cancelQueuedMessage({ queuedMessageId })),
    [run],
  );

  return { available, messages, update, cancel };
}
