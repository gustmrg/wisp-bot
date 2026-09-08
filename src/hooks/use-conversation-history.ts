import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackend } from "@/features/backend/backend-provider";
import type { Chat, Message } from "../../shared/conversations";

/** Pages are oldest-to-newest; newer snapshots replace matching messages without dropping old pages. */
export function mergeHistory(older: readonly Message[], newer: readonly Message[]): Message[] {
  const merged = [...older];
  const positions = new Map<string, number>();
  merged.forEach((message, index) => {
    if (message.id) positions.set(message.id, index);
  });
  for (const message of newer) {
    const position = message.id ? positions.get(message.id) : undefined;
    if (position !== undefined) merged[position] = message;
    else {
      if (message.id) positions.set(message.id, merged.length);
      merged.push(message);
    }
  }
  return merged;
}
interface HistoryPage {
  id: string;
  messages: Message[];
  cursor: string | null;
  loaded: boolean;
  loading: boolean;
  error?: string;
}

/** Reinsert a contiguous server window between the retained older prefix and any live tail. */
function mergeWindow(previous: readonly Message[], window: readonly Message[]): Message[] {
  const ids = new Set(window.flatMap(({ id }) => (id ? [id] : [])));
  const overlap = previous.findIndex(({ id }) => id && ids.has(id));
  if (overlap < 0) return mergeHistory(window, previous);
  return [...previous.slice(0, overlap), ...mergeHistory(window, previous.slice(overlap))];
}

export function useConversationHistory(snapshot: Chat | undefined) {
  const { api, remote, writable } = useBackend();
  const id = snapshot?.id;
  const [page, setPage] = useState<HistoryPage | undefined>();
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    if (!id || !remote || !api.getConversationMessages) {
      setPage(undefined);
      return;
    }
    if (!writable) {
      setPage((current) => (current?.id === id ? { ...current, loading: false } : undefined));
      return;
    }
    const conversationId = id;
    const getMessages = api.getConversationMessages;
    let active = true;
    // Capture the pre-reconnect history before the new bounded snapshot is accumulated.
    const previous = pageRef.current?.id === id ? pageRef.current : undefined;
    const anchor = new Set(previous?.loaded ? previous.messages.flatMap(({ id }) => (id ? [id] : [])) : []);
    setPage((current) =>
      current?.id === id
        ? { ...current, loading: true, error: undefined }
        : {
            id,
            messages: [],
            cursor: null,
            loaded: false,
            loading: true,
          },
    );
    async function refresh() {
      try {
        let result = await getMessages({ conversationId, limit: 200 });
        if (!active) return;
        if (!result.ok) throw new Error(result.error.message);
        let messages = result.value.messages;
        const latestCursor = result.value.nextCursor;
        // A long background period may exceed one page. Fill the gap back to known history.
        while (anchor.size && result.value.nextCursor && !messages.some(({ id }) => id && anchor.has(id))) {
          result = await getMessages({ conversationId, before: result.value.nextCursor, limit: 200 });
          if (!active) return;
          if (!result.ok) throw new Error(result.error.message);
          messages = mergeHistory(result.value.messages, messages);
        }
        setPage((current) =>
          !current || current.id !== conversationId
            ? current
            : {
                id: conversationId,
                messages: mergeWindow(current.messages, messages),
                cursor: previous?.loaded ? current.cursor : latestCursor,
                loaded: true,
                loading: false,
              },
        );
      } catch (cause) {
        if (active)
          setPage((current) =>
            current && current.id === conversationId
              ? {
                  ...current,
                  loading: false,
                  error: cause instanceof Error ? cause.message : "Earlier messages could not be loaded.",
                }
              : current,
          );
      }
    }
    void refresh();
    return () => {
      active = false;
    };
  }, [api, remote, id, writable]);

  useEffect(() => {
    if (!remote || !writable || !snapshot) return;
    const messages = snapshot.messages;
    // Retain every observed message, even when it leaves the server's last-20 snapshot window.
    setPage((current) =>
      current?.id === snapshot.id ? { ...current, messages: mergeHistory(current.messages, messages) } : current,
    );
  }, [remote, writable, snapshot]);

  const loadEarlier = useCallback(async () => {
    if (!writable || !id || page?.id !== id || !page.cursor || page.loading || !api.getConversationMessages) return;
    const before = page.cursor;
    setPage((current) => (current?.id === id ? { ...current, loading: true, error: undefined } : current));
    try {
      const result = await api.getConversationMessages({ conversationId: id, before, limit: 200 });
      setPage((current) =>
        current?.id !== id
          ? current
          : result.ok
            ? {
                ...current,
                messages: mergeHistory(result.value.messages, current.messages),
                cursor: result.value.nextCursor,
                loading: false,
              }
            : { ...current, loading: false, error: result.error.message },
      );
    } catch {
      setPage((current) =>
        current?.id === id ? { ...current, loading: false, error: "Earlier messages could not be loaded." } : current,
      );
    }
  }, [api, id, page, writable]);
  const chat = useMemo(
    () =>
      snapshot && page && page.id === id
        ? ({ ...snapshot, messages: mergeHistory(page.messages, snapshot.messages) } as Chat)
        : snapshot,
    [snapshot, page, id],
  );
  return {
    chat,
    loadEarlier,
    hasEarlier: page?.id === id && Boolean(page?.cursor),
    loadingHistory: page?.id === id && Boolean(page?.loading),
    historyError: page?.id === id ? page?.error : undefined,
  };
}
