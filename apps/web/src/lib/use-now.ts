import { useEffect, useState } from "react";

/** Current time in ms, re-read every `intervalMs` while `active`. Use it only in small leaf components. */
export function useNow(active: boolean, intervalMs: number = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
