import { useEffect } from "react";

/**
 * Keeps the screen on while `active`, since a phone that goes to sleep can end
 * what the app is doing. The system releases the lock whenever the page is
 * hidden, so it is asked for again on return. Where the lock does not exist or
 * is refused, such as in the desktop app, the screen follows its own settings.
 */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let requesting = false;
    let ended = false;
    async function acquire(): Promise<void> {
      if (requesting || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      requesting = true;
      try {
        const granted = await navigator.wakeLock.request("screen");
        if (ended) void granted.release().catch(() => undefined);
        else lock = granted;
      } catch {
        // Refused, for example on low battery; what the app is doing goes on without it.
      } finally {
        requesting = false;
      }
    }
    function handleVisibilityChange(): void {
      void acquire();
    }
    void acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      ended = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
