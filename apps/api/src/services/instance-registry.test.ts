/**
 * Phase 13.1 — the instance registry: the several-leaders rule, heartbeats and their warnings (logged once per
 * change), leader-only pruning and the dead-executor reconcile, and the ordered run-owner writes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { DEAD_EXECUTOR_RUN_ERROR, InstanceRegistry, RunOwnerTracker, clusterWarnings, type InstanceRegistryOptions } from "./instance-registry.js";

let tempDir: string;
let store: Store;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-registry-"));
  store = await openTestStore(path.join(tempDir, "orchestrator.db"));
});

afterEach(async () => {
  await store.close().catch(() => undefined);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function logs() {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    logger: {
      warn: (message: string) => lines.push({ level: "warn", message }),
      error: (message: string) => lines.push({ level: "error", message }),
      info: (message: string) => lines.push({ level: "info", message })
    }
  };
}

function registry(id: string, overrides: Partial<InstanceRegistryOptions> = {}): InstanceRegistry {
  return new InstanceRegistry({
    store,
    instanceId: id,
    workerMode: "all",
    haEnabled: false,
    pools: [],
    concurrency: null,
    capabilities: [],
    appVersion: null,
    schemaVersion: 44,
    runtime: () => ({ isLeader: false, running: 0, busConnected: false }),
    heartbeatMs: 60_000,
    instanceTimeoutMs: 60_000,
    logger: logs().logger,
    ...overrides
  });
}

describe("clusterWarnings", () => {
  const i = (id: string, workerMode: string, haEnabled: boolean) => ({ id, workerMode, haEnabled });
  it("warns when several schedule-running instances are live and one of them has HA off", () => {
    expect(clusterWarnings([i("a", "all", false)])).toEqual([]);
    expect(clusterWarnings([i("a", "all", true), i("b", "worker", true)])).toEqual([]);
    // Webhook and api replicas never run schedules.
    expect(clusterWarnings([i("a", "all", false), i("b", "webhook", false), i("c", "api", false)])).toEqual([]);
    const both = clusterWarnings([i("b", "all", false), i("a", "worker", false)]);
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ code: "multiple_leaders", instances: ["a", "b"] });
    expect(both[0]!.message).toContain("2 of them have HA_ENABLED=false");
    // One HA-off instance beside an elected leader also leads on its own.
    const mixed = clusterWarnings([i("a", "all", true), i("b", "all", false)]);
    expect(mixed[0]!.message).toContain("1 of them has HA_ENABLED=false");
  });
});

describe("InstanceRegistry", () => {
  it("heartbeats, reports the warning once per change, clears it, and removes its row on stop", async () => {
    const a = logs();
    const seen: Array<{ count: number; live: number }> = [];
    const first = registry("a", { logger: a.logger, onWarnings: (warnings, live) => seen.push({ count: warnings.length, live }) });
    await first.start();
    expect(first.warnings()).toEqual([]);
    const second = registry("b");
    await second.start();
    await first.beat();
    await first.beat();
    expect(first.warnings()).toHaveLength(1);
    expect(first.liveInstances()).toBe(2);
    expect(a.lines.filter((line) => line.level === "error")).toHaveLength(1);
    expect(seen.at(-1)).toEqual({ count: 1, live: 2 });
    await second.stop();
    await first.beat();
    expect(first.warnings()).toEqual([]);
    expect(a.lines.filter((line) => line.level === "info").map((line) => line.message)).toEqual(["Cluster warning cleared"]);
    expect((await first.list()).map((row) => row.id)).toEqual(["a"]);
    await first.stop();
    expect(await store.listClusterInstances({ liveWithinMs: 60_000 })).toEqual([]);
    // A stopped registry writes nothing more.
    await first.beat();
    expect(await store.listClusterInstances({ liveWithinMs: 60_000 })).toEqual([]);
  });

  it("does leader work only while leading: prunes old rows and fails a dead instance's runs when asked to", async () => {
    let leading = false;
    const failedRuns: string[] = [];
    const leader = registry("me", {
      runtime: () => ({ isLeader: leading, running: 0, busConnected: true }),
      reconcileDeadExecutors: true,
      instanceTimeoutMs: 30,
      onDeadExecutorRuns: (runs) => failedRuns.push(...runs.map((run) => run.id))
    });
    await store.saveExecutionHistory({ id: "r1", workflowId: "wf", status: "running", startedAt: new Date().toISOString() });
    await store.heartbeatClusterInstance({
      id: "dead", workerMode: "all", haEnabled: true, isLeader: false, pools: [], concurrency: null, running: 1, appVersion: null,
      schemaVersion: 44, capabilities: [], hostname: "h", busConnected: true, startedAt: new Date().toISOString()
    });
    await store.claimClusterRunOwner({ executionId: "r1", instanceId: "dead" });
    for (let i = 0; i < 100 && !(await store.listClusterInstances({ liveWithinMs: 30 })).some((row) => row.id === "dead" && !row.live); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await leader.start();
    expect((await store.getExecutionHistory("r1"))!.status).toBe("running");
    leading = true;
    await leader.beat();
    expect(failedRuns).toEqual(["r1"]);
    expect(await store.getExecutionHistory("r1")).toMatchObject({ status: "error", error: DEAD_EXECUTOR_RUN_ERROR });
    await leader.stop();
  });

  it("logs a failed heartbeat and keeps going", async () => {
    const l = logs();
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "heartbeatClusterInstance") return async () => {
          throw new Error("db down");
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      }
    });
    const r = registry("x", { store: broken, logger: l.logger });
    await r.start();
    expect(l.lines).toEqual([{ level: "warn", message: "Cluster registry heartbeat failed" }]);
    await r.stop();
  });
});

describe("RunOwnerTracker", () => {
  it("writes a run's claim before its release, whatever order the store answers in", async () => {
    const calls: string[] = [];
    let releaseFirstClaim!: () => void;
    const slowFirstClaim = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    let claims = 0;
    const fake = {
      claimClusterRunOwner: async ({ executionId }: { executionId: string }) => {
        claims += 1;
        if (claims === 1) await slowFirstClaim;
        calls.push(`claim:${executionId}`);
      },
      releaseClusterRunOwner: async ({ executionId }: { executionId: string }) => {
        calls.push(`release:${executionId}`);
      }
    } as unknown as Store;
    const warnings: string[] = [];
    const tracker = new RunOwnerTracker(fake, "me", { warn: (message) => warnings.push(message) });
    tracker.claim("r1");
    tracker.release("r1");
    tracker.claim("r2");
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstClaim();
    await tracker.settle();
    expect(calls.indexOf("claim:r1")).toBeLessThan(calls.indexOf("release:r1"));
    expect(calls).toContain("claim:r2");
    expect(warnings).toEqual([]);
  });

  it("logs a failed write without failing the run", async () => {
    const warnings: string[] = [];
    const fake = { claimClusterRunOwner: async () => Promise.reject(new Error("down")), releaseClusterRunOwner: async () => undefined } as unknown as Store;
    const tracker = new RunOwnerTracker(fake, "me", { warn: (message) => warnings.push(message) });
    tracker.claim("r1");
    tracker.release("r1");
    await tracker.settle();
    expect(warnings).toEqual(["Could not record the instance running a run"]);
  });
});
