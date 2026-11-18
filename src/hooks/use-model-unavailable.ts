import { useCallback, useEffect, useRef, useState } from "react";

import type { ManagedConversationStatus } from "../../shared/conversations";

export interface ModelUnavailable {
  /** Why the Wisp cannot answer, such as an outdated Claude Code; null when unknown or none is chosen. */
  reason: string | null;
  /** The provider whose settings fix it; null with no reason. */
  providerId: string | null;
  checking: boolean;
  /** Asks again, which checks Claude Code on the server again. */
  checkAgain: () => void;
}

/**
 * Why a Wisp that needs configuration cannot answer with the model it has,
 * asked again whenever it starts needing configuration.
 */
export function useModelUnavailable(
  conversationId: string | null,
  status: ManagedConversationStatus,
): ModelUnavailable {
  const [loaded, setLoaded] = useState<{
    conversationId: string;
    reason: string | null;
    providerId: string | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  // Only the latest request's answer is kept.
  const request = useRef(0);
  const needsConfiguration = status === "configuration_required";

  const load = useCallback((id: string) => {
    const current = ++request.current;
    const settle = (reason: string | null, providerId: string | null = null) => {
      if (current !== request.current) return;
      setLoaded({ conversationId: id, reason, providerId });
      setChecking(false);
    };
    setChecking(true);
    try {
      window.wisp
        .getConversationModel({ conversationId: id })
        .then((result) =>
          result.ok
            ? settle(result.value.unavailable ?? null, result.value.unavailableProviderId ?? null)
            : settle(null),
        )
        .catch(() => settle(null));
    } catch {
      // Without the app bridge there is nothing to report.
      settle(null);
    }
  }, []);

  useEffect(() => {
    if (!conversationId || !needsConfiguration) {
      setLoaded(null);
      return;
    }
    load(conversationId);
    return () => {
      request.current += 1;
    };
  }, [conversationId, needsConfiguration, load]);

  const checkAgain = useCallback(() => {
    if (conversationId && needsConfiguration) load(conversationId);
  }, [conversationId, needsConfiguration, load]);

  const current = loaded && loaded.conversationId === conversationId ? loaded : null;
  return {
    reason: current?.reason ?? null,
    providerId: current?.reason ? current.providerId : null,
    checking: needsConfiguration && checking,
    checkAgain,
  };
}
