import { useEffect, useState } from "react";

/** A confirmation that clears itself, so a stale "Saved." does not linger next to later edits. */
export function useTransientMessage(durationMs = 4000): [string, (message: string) => void] {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), durationMs);
    return () => clearTimeout(timer);
  }, [message, durationMs]);
  return [message, setMessage];
}
