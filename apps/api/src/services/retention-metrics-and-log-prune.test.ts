/**
 * 13.3 — the retention counter in /metrics, and the log-stream delivery prune only on the instance that may prune.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { Store } from "../db/store.js";
import { MetricsService } from "./metrics-service.js";
import { LogStreamingService } from "./log-streaming-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("retention metrics", () => {
  it("exports rows deleted per class, only once something was deleted", () => {
    const metrics = new MetricsService({ prefix: "l2m", includeProcess: false });
    expect(metrics.formatPrometheus()).not.toContain("retention_deleted_total");
    metrics.recordRetentionDeleted("runs", 12);
    metrics.recordRetentionDeleted("runs", 3);
    metrics.recordRetentionDeleted("usage", 0);
    metrics.recordRetentionDeleted("tool_calls", 4);
    const text = metrics.formatPrometheus();
    expect(text).toContain("# TYPE l2m_retention_deleted_total counter");
    expect(text).toContain('l2m_retention_deleted_total{class="runs"} 15');
    expect(text).toContain('l2m_retention_deleted_total{class="tool_calls"} 4');
    expect(text).not.toContain('class="usage"');
  });
});

describe("log-stream delivery prune", () => {
  for (const leads of [true, false]) {
    it(`${leads ? "prunes" : "skips"} on an instance that ${leads ? "may" : "may not"} prune`, async () => {
      vi.useFakeTimers();
      const pruneLogStreamEvents = vi.fn(async () => 0);
      const store = { pruneLogStreamEvents } as unknown as Store;
      const service = new LogStreamingService(store, crypto.randomBytes(32).toString("base64"), {
        flushIntervalMs: 60_000,
        eventRetentionDays: 14,
        eventPruneIntervalMs: 1_000,
        shouldPrune: () => leads
      });
      service.start();
      await vi.advanceTimersByTimeAsync(1_100);
      await service.stop();
      expect(pruneLogStreamEvents).toHaveBeenCalledTimes(leads ? 1 : 0);
    });
  }
});
