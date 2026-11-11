import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SSE_HEARTBEAT_FRAME, SSE_SESSION_CHECK_EVERY_BEATS, sessionEndedFrame, startSseHeartbeat } from "./sse-heartbeat.js";

function target() {
  const writes: string[] = [];
  const raw = {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {
      raw.writableEnded = true;
    }
  };
  return { raw, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startSseHeartbeat", () => {
  it("pings until stopped", async () => {
    const { raw, writes } = target();
    const stop = startSseHeartbeat(raw, 100);
    await vi.advanceTimersByTimeAsync(350);
    expect(writes).toEqual([SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME]);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toHaveLength(3);
  });

  it("checks the session every few beats and closes the stream with session_ended when it has ended", async () => {
    const { raw, writes } = target();
    let reason: string | null = null;
    const check = vi.fn(async () => reason);
    const onEnded = vi.fn();
    startSseHeartbeat(raw, 100, () => false, { check, onEnded });
    await vi.advanceTimersByTimeAsync(100 * SSE_SESSION_CHECK_EVERY_BEATS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(raw.writableEnded).toBe(false);
    reason = "admin";
    await vi.advanceTimersByTimeAsync(100 * SSE_SESSION_CHECK_EVERY_BEATS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onEnded).toHaveBeenCalledWith("admin");
    expect(writes.at(-1)).toBe(sessionEndedFrame("admin"));
    expect(raw.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps the stream open when a check fails", async () => {
    const { raw } = target();
    const check = vi.fn(async (): Promise<string | null> => {
      throw new Error("db down");
    });
    const onEnded = vi.fn();
    startSseHeartbeat(raw, 100, () => false, { check, onEnded });
    await vi.advanceTimersByTimeAsync(100 * SSE_SESSION_CHECK_EVERY_BEATS * 2);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onEnded).not.toHaveBeenCalled();
    expect(raw.writableEnded).toBe(false);
  });

  it("does not write to a stream the route already closed", async () => {
    const { raw, writes } = target();
    let closed = false;
    const check = vi.fn(async () => {
      closed = true;
      return "logout";
    });
    const onEnded = vi.fn();
    startSseHeartbeat(raw, 100, () => closed, { check, onEnded });
    await vi.advanceTimersByTimeAsync(100 * SSE_SESSION_CHECK_EVERY_BEATS);
    expect(onEnded).not.toHaveBeenCalled();
    expect(writes.every((chunk) => chunk === SSE_HEARTBEAT_FRAME)).toBe(true);
  });
});
