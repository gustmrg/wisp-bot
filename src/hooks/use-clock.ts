import { useEffect, useState } from "react";

// Re-renders the caller on a fixed interval so relative time labels stay current.
export function useClock(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
