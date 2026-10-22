/**
 * SSE comment frame sent while a run streams nothing else. Clients ignore
 * comment lines, but the bytes keep proxies from closing an idle connection
 * and let the browser tell a quiet run from a dead connection.
 */
export const SSE_HEARTBEAT_FRAME = ": ping\n\n";

export interface SseHeartbeatTarget {
  write(chunk: string): unknown;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
}

/**
 * Writes `: ping` to an SSE response every `intervalMs` until the returned
 * stop function is called or the response ends. `isClosed` lets the route
 * report a client disconnect it tracks itself. Call stop from `finally`.
 */
export function startSseHeartbeat(
  target: SseHeartbeatTarget,
  intervalMs: number,
  isClosed: () => boolean = () => false
): () => void {
  const handle = setInterval(() => {
    if (isClosed() || target.writableEnded || target.destroyed) {
      clearInterval(handle);
      return;
    }
    try {
      target.write(SSE_HEARTBEAT_FRAME);
    } catch {
      // A socket that failed mid-write is closed; the route's own cleanup handles it.
      clearInterval(handle);
    }
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
