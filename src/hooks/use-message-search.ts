import { useEffect, useState } from "react";

import type { MessageSearchHit } from "../../shared/conversations";
import { MAX_MESSAGE_SEARCH_LENGTH, MIN_MESSAGE_SEARCH_LENGTH } from "../../shared/message-search";

const SEARCH_DEBOUNCE_MS = 150;
const NO_HITS: ReadonlyArray<MessageSearchHit> = [];

export interface MessageSearch {
  /** Newest first. While a changed query is being searched, these are still the previous query's. */
  hits: ReadonlyArray<MessageSearchHit>;
  searching: boolean;
}

/** The search index matches three or more characters; shorter queries cannot search messages. */
export function canSearchMessages(query: string): boolean {
  return Array.from(query.trim()).length >= MIN_MESSAGE_SEARCH_LENGTH;
}

/** Searches stored messages in the backend once typing pauses. A null query searches nothing. */
export function useMessageSearch(query: string | null): MessageSearch {
  const [result, setResult] = useState<{ query: string; hits: ReadonlyArray<MessageSearchHit> } | null>(null);

  useEffect(() => {
    if (query === null) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.wisp.searchMessages({ query: query.slice(0, MAX_MESSAGE_SEARCH_LENGTH) }).then(
        (response) => {
          if (!cancelled) setResult({ query, hits: response.ok ? response.value : NO_HITS });
        },
        () => {
          if (!cancelled) setResult({ query, hits: NO_HITS });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  if (query === null) return { hits: NO_HITS, searching: false };
  return { hits: result?.hits ?? NO_HITS, searching: result?.query !== query };
}
