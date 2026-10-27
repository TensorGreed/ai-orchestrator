/**
 * Phase 13.1 — the election loop around a leader lock (a fake lock here; the Postgres lock has its own tests in
 * db/postgres/leader-lock.test.ts and two-instance.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import type { LeaderLock } from "../db/postgres/leader-lock.js";
import { LeaderElectionService } from "./leader-election-service.js";

class FakeLock implements LeaderLock {
  granted = true;
  checks = 0;
  releases = 0;
  readonly events: string[];
  private listeners: Array<() => void> = [];
  constructor(events: string[]) {
    this.events = events;
  }
  async check(): Promise<boolean> {
    this.checks += 1;
    return this.granted;
  }
  async release(): Promise<void> {
    this.releases += 1;
    this.events.push("release");
  }
  onLost(listener: () => void): void {
    this.listeners.push(listener);
  }
  lose(): void {
    for (const listener of this.listeners) listener();
  }
}

const store = { getLease: async () => null } as unknown as Store;

async function until(read: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("leader election with a lock", () => {
  it("after the lock's connection drops it steps down, then takes the lock again at once, not at the next interval", async () => {
    const events: string[] = [];
    const lock = new FakeLock(events);
    const service = new LeaderElectionService(store, {
      lock,
      // Far longer than the test: only an immediate retry can make it lead again.
      renewIntervalMs: 60_000,
      onBecomeLeader: () => void events.push("lead"),
      onResignLeader: () => void events.push("resign")
    });
    try {
      await service.start();
      expect(service.isLeader()).toBe(true);
      const checks = lock.checks;
      lock.lose();
      await until(() => lock.checks > checks && service.isLeader(), "the immediate re-acquire");
      expect(events).toEqual(["lead", "resign", "lead"]);
    } finally {
      await service.stop();
    }
  });

  it("a check that finds the connection gone retries once at once; while the lock stays taken it waits for the interval", async () => {
    const events: string[] = [];
    const lock = new FakeLock(events);
    const service = new LeaderElectionService(store, {
      lock,
      renewIntervalMs: 60_000,
      onBecomeLeader: () => void events.push("lead"),
      onResignLeader: () => void events.push("resign")
    });
    try {
      await service.start();
      lock.granted = false;
      // The interval's tick, run by hand: the held lock's check fails.
      await (service as unknown as { tick: () => Promise<void> }).tick();
      expect(service.isLeader()).toBe(false);
      // The failed check, then exactly one immediate retry (still refused): no loop.
      expect(lock.checks).toBe(3);
      expect(events).toEqual(["lead", "resign"]);
    } finally {
      await service.stop();
    }
  });

  it("a graceful stop stops the leader's work before it frees the lock", async () => {
    const events: string[] = [];
    const lock = new FakeLock(events);
    const service = new LeaderElectionService(store, {
      lock,
      renewIntervalMs: 60_000,
      onBecomeLeader: () => void events.push("lead"),
      onResignLeader: () => void events.push("resign")
    });
    await service.start();
    await service.stop();
    // Freed first, a standby could start its schedules while this instance's are still registered.
    expect(events).toEqual(["lead", "resign", "release"]);
    expect(service.isLeader()).toBe(false);
  });
});
