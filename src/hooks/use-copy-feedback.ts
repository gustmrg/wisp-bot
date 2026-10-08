import { useCallback, useEffect, useRef, useState } from "react";

export type CopyFeedbackStatus = "idle" | "copying" | "success" | "error";

interface CopyFeedbackState {
  scopeId: string;
  status: CopyFeedbackStatus;
  message: string;
}

export interface CopyFeedback {
  status: CopyFeedbackStatus;
  message: string;
  copy: (text: string) => Promise<boolean>;
}

function idleFeedback(scopeId: string): CopyFeedbackState {
  return { scopeId, status: "idle", message: "" };
}

export function useCopyFeedback(scopeId: string, resetDelayMs = 1_400): CopyFeedback {
  const [feedback, setFeedback] = useState<CopyFeedbackState>(() => idleFeedback(scopeId));
  const requestVersion = useRef(0);
  const resetTimer = useRef<ReturnType<typeof window.setTimeout> | undefined>(undefined);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current === undefined) return;
    window.clearTimeout(resetTimer.current);
    resetTimer.current = undefined;
  }, []);

  useEffect(() => {
    requestVersion.current += 1;
    clearResetTimer();
    setFeedback(idleFeedback(scopeId));
    return () => {
      requestVersion.current += 1;
      clearResetTimer();
    };
  }, [clearResetTimer, scopeId]);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const version = ++requestVersion.current;
      clearResetTimer();

      const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
      if (!writeText) {
        setFeedback({ scopeId, status: "error", message: "Clipboard access is unavailable" });
        scheduleReset(scopeId, version);
        return false;
      }

      setFeedback({ scopeId, status: "copying", message: "Copying template" });
      try {
        await writeText(text);
        if (requestVersion.current !== version) return false;
        setFeedback({ scopeId, status: "success", message: "Template copied" });
        scheduleReset(scopeId, version);
        return true;
      } catch {
        if (requestVersion.current !== version) return false;
        setFeedback({ scopeId, status: "error", message: "Could not copy template" });
        scheduleReset(scopeId, version);
        return false;
      }

      function scheduleReset(resetScopeId: string, resetVersion: number): void {
        resetTimer.current = window.setTimeout(() => {
          if (requestVersion.current === resetVersion) setFeedback(idleFeedback(resetScopeId));
          resetTimer.current = undefined;
        }, resetDelayMs);
      }
    },
    [clearResetTimer, resetDelayMs, scopeId],
  );

  const visibleFeedback = feedback.scopeId === scopeId ? feedback : idleFeedback(scopeId);
  return { status: visibleFeedback.status, message: visibleFeedback.message, copy };
}
