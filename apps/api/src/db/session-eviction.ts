/**
 * 13.2 — of a user's live session ids (newest first), the ones to end so that `keep` remain, oldest first. The
 * protected id (the session being issued) is always kept and counts toward `keep`. Used by both stores.
 */
export function sessionsToEvict(liveNewestFirst: string[], keep: number, protectId?: string): string[] {
  const ordered = protectId && liveNewestFirst.includes(protectId)
    ? [protectId, ...liveNewestFirst.filter((id) => id !== protectId)]
    : liveNewestFirst;
  const survivors = new Set(ordered.slice(0, Math.max(0, keep)));
  if (protectId && liveNewestFirst.includes(protectId)) survivors.add(protectId);
  return liveNewestFirst.filter((id) => !survivors.has(id)).reverse();
}
