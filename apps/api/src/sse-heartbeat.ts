/**
 * SSE comment frame sent while a run streams nothing else. Clients ignore
 * comment lines, but the bytes keep proxies from closing an idle connection
 * and let the browser tell a quiet run from a dead connection.
 */
export const SSE_HEARTBEAT_FRAME = ": ping\n\n";

/** How many heartbeats pass between two checks of the stream's sign-in session. */
export const SSE_SESSION_CHECK_EVERY_BEATS = 2;

export interface SseHeartbeatTarget {
  write(chunk: string): unknown;
  end?(): unknown;
  readonly writableEnded?: boolean;
  readonly destroyed?: boolean;
}

/**
 * 13.2 — a stream opened with a sign-in session closes when that session ends (signed out, revoked, evicted, idle or
 * expired). `check` answers null while the session may be used, else why it ended; `onEnded` is the route's own
 * cleanup. The stream gets a final `session_ended` event before it is closed.
 */
export interface SseSessionWatch {
  check(): Promise<string | null>;
  onEnded(reason: string): void;
}

/** The frame that tells a client its stream closed because its sign-in session ended. */
export function sessionEndedFrame(reason: string): string {
  return `event: session_ended\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/**
 * Writes `: ping` to an SSE response every `intervalMs` until the returned
 * stop function is called or the response ends. `isClosed` lets the route
 * report a client disconnect it tracks itself. Call stop from `finally`.
 * With `session`, every SSE_SESSION_CHECK_EVERY_BEATS heartbeats the stream's
 * session is checked, and an ended session closes the stream.
 */
export function startSseHeartbeat(
  target: SseHeartbeatTarget,
  intervalMs: number,
  isClosed: () => boolean = () => false,
  session?: SseSessionWatch
): () => void {
  let beats = 0;
  let checking = false;
  const closeForSession = (reason: string) => {
    clearInterval(handle);
    if (isClosed() || target.writableEnded || target.destroyed) return;
    try {
      target.write(sessionEndedFrame(reason));
    } catch {
      // The socket is already gone; the route's cleanup still runs below.
    }
    try {
      session?.onEnded(reason);
    } finally {
      if (!target.writableEnded && !target.destroyed) target.end?.();
    }
  };
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
      return;
    }
    beats += 1;
    if (!session || checking || beats % SSE_SESSION_CHECK_EVERY_BEATS !== 0) return;
    checking = true;
    session
      .check()
      .then((reason) => {
        if (reason) closeForSession(reason);
      })
      // A failed lookup keeps the stream open; the next check tries again.
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
