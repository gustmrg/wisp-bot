import { useCallback, useRef, useState } from "react";

import type { WorkspaceFileSearch } from "../../shared/workspace";

/**
 * Searches a Wisp's workspace for the files an `@` mention can name. Each
 * `search` replaces the last; null clears the result, as when no `@` is being
 * typed. The result is null until the first answer arrives, for a circle
 * (null) and when the search fails; it stays while the next one loads.
 */
export function useWorkspaceFileSearch(conversationId: string | null): {
  result: WorkspaceFileSearch | null;
  search: (query: string | null) => void;
} {
  // Kept with the conversation it answers, so another conversation's files are never offered.
  const [answer, setAnswer] = useState<{ conversationId: string; result: WorkspaceFileSearch } | null>(null);
  const revision = useRef(0);
  const search = useCallback(
    (query: string | null) => {
      const current = ++revision.current;
      if (!conversationId || query === null) {
        setAnswer(null);
        return;
      }
      // Started inside the promise, so a missing app bridge rejects like a failed search.
      Promise.resolve()
        .then(() => window.wisp.searchWorkspaceFiles({ conversationId, query }))
        .then((response) => {
          if (current === revision.current && response.ok) setAnswer({ conversationId, result: response.value });
        })
        .catch(() => {
          // Without an answer, files are simply not offered.
        });
    },
    [conversationId],
  );
  return { result: answer && answer.conversationId === conversationId ? answer.result : null, search };
}
