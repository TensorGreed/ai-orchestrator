/**
 * Phase 13.1 — the Postgres leader lock's liveness: after a network partition between the leader and the server
 * (a TCP proxy that stops forwarding but keeps both sockets open, as a lost host or a frozen VM does), the server
 * ends the old session within a few renew intervals and a standby takes the lock. Without the session settings the
 * server keeps the idle session, and its lock, for about two hours. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postgresPoolConfig } from "../postgres-store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, testStorePool, type TestStore } from "../../test-support/test-store.js";
import type { Store } from "../store.js";
import { LeaderElectionService } from "../../services/leader-election-service.js";
import { describeRefusedSettings, leaderSessionSettings, PgLeaderLock, resetLeaderSettingNotices } from "./leader-lock.js";

describe("leaderSessionSettings", () => {
  it("sizes the server-side liveness settings from the renew interval", () => {
    expect(Object.fromEntries(leaderSessionSettings(10_000))).toEqual({
      idle_session_timeout: "30000",
      tcp_keepalives_idle: "10",
      tcp_keepalives_interval: "10",
      tcp_keepalives_count: "3"
    });
    // A short interval keeps a floor, so a busy event loop does not end a live leader's session.
    expect(Object.fromEntries(leaderSessionSettings(100))).toMatchObject({ idle_session_timeout: "5000", tcp_keepalives_idle: "1" });
  });
});

describe("describeRefusedSettings", () => {
  it("says what is lost for each refused set (PostgreSQL 13 refuses only idle_session_timeout: info, keepalives still apply)", () => {
    const pg13 = describeRefusedSettings(["idle_session_timeout"], 10_000);
    expect(pg13.level).toBe("info");
    expect(pg13.message).toMatch(/keepalives still end a lost leader's session/);
    expect(pg13.message).toMatch(/about 50 s/);
    expect(pg13.message).not.toMatch(/two hours/);

    const keepalives = describeRefusedSettings(["tcp_keepalives_idle", "tcp_keepalives_count"], 10_000);
    expect(keepalives.level).toBe("warn");
    expect(keepalives.message).toMatch(/idle_session_timeout still ends a lost leader's session after 30 s/);

    const both = describeRefusedSettings(["idle_session_timeout", "tcp_keepalives_idle", "tcp_keepalives_interval", "tcp_keepalives_count"], 10_000);
    expect(both.level).toBe("warn");
    expect(both.message).toMatch(/server's own keepalive default.*about two hours/);

    // The times follow the configured renew interval, not a fixed 10 s check.
    expect(describeRefusedSettings(["idle_session_timeout"], 30_000).message).toMatch(/about 150 s/);
    expect(describeRefusedSettings(["tcp_keepalives_idle"], 30_000).message).toMatch(/after 90 s.*about 120 s/);
    expect(describeRefusedSettings(["idle_session_timeout"], 2_000).message).toMatch(/about 10 s/);

    expect(describeRefusedSettings(["no_such_leader_setting"], 10_000)).toMatchObject({ level: "warn" });
  });
});

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("the Postgres leader lock's liveness");

/** Forwards to Postgres until `partition()`; then drops every byte both ways while keeping the sockets open. */
async function startProxy(target: { host: string; port: number }) {
  let partitioned = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client).add(upstream);
    client.on("data", (data) => void (partitioned || upstream.write(data)));
    upstream.on("data", (data) => void (partitioned || client.write(data)));
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
    client.on("close", () => void (partitioned || upstream.destroy()));
    upstream.on("close", () => void (partitioned || client.destroy()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    partition: () => void (partitioned = true),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

run("Postgres leader lock liveness", () => {
  let test: TestStore | undefined;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => resetLeaderSettingNotices());

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
    await test?.cleanup();
    test = undefined;
  }, 30_000);

  async function locks(options: { sessionSettings?: Array<[string, string]>; warnings?: string[] } = {}) {
    test = await createTestStore({ kind: "postgres" });
    const config = test.postgres!.config;
    const pool = testStorePool(test, { max: 2 });
    cleanups.push(async () => await pool.end());
    const make = (holderId: string, port: number) => {
      const lock = new PgLeaderLock({
        clientConfig: postgresPoolConfig({ ...config, port }, { max: 1, application_name: `liveness-${holderId}` }),
        pool,
        leaseName: "primary",
        holderId,
        ttlMs: 30_000,
        renewIntervalMs: 1_000,
        checkTimeoutMs: 1_000,
        ...(options.sessionSettings ? { sessionSettings: options.sessionSettings } : {}),
        logger: { warn: (message) => void options.warnings?.push(message) }
      });
      cleanups.push(async () => await lock.release());
      return lock;
    };
    return { config, pool, make };
  }

  it("a partitioned leader's session is ended by the server, and a standby takes the lock within a bound", async () => {
    const { config, pool, make } = await locks();
    const proxy = await startProxy({ host: config.host, port: config.port });
    cleanups.push(async () => await proxy.close());
    const leader = make("A", proxy.port);
    const standby = make("B", config.port);
    let lost = 0;
    leader.onLost(() => void (lost += 1));
    expect(await leader.check()).toBe(true);
    expect(await standby.check()).toBe(false);

    proxy.partition();
    const partitionedAt = Date.now();
    // The leader's own check gets no answer: it steps down within one check.
    expect(await leader.check()).toBe(false);

    // idle_session_timeout is max(3 × 1 s, 5 s): the server frees the lock about 5 s after the last query.
    let takeoverMs: number | null = null;
    while (Date.now() - partitionedAt < 25_000) {
      if (await standby.check()) {
        takeoverMs = Date.now() - partitionedAt;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const zombie = await pool.query(`SELECT state FROM pg_stat_activity WHERE application_name = 'liveness-A'`);
    expect(takeoverMs, `no takeover; the server still has the old session: ${JSON.stringify(zombie.rows)}`).not.toBeNull();
    expect(takeoverMs!).toBeLessThan(15_000);
    // eslint-disable-next-line no-console
    console.info(`[leader-lock liveness] standby took the lock ${takeoverMs} ms after the partition`);
    expect(zombie.rows).toEqual([]);
    // Stepped down by its own failed check or liveness query (at most one loss reported), not by an 'end' event it
    // never got.
    expect(lost).toBeLessThanOrEqual(1);
  }, 40_000);

  it("a setting the server refuses is warned about once; the lock still works, also on a new connection", async () => {
    const warnings: string[] = [];
    const { config, pool, make } = await locks({
      sessionSettings: [
        ["no_such_leader_setting", "1"],
        ["idle_session_timeout", "60000"]
      ],
      warnings
    });
    const lock = make("A", config.port);
    expect(await lock.check()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/refused a leader-connection setting/);
    // Kill its session: the next checks reconnect, apply the settings again, and do not warn again.
    let lost = 0;
    lock.onLost(() => void (lost += 1));
    await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'liveness-A'`);
    const deadline = Date.now() + 10_000;
    while (!(lost > 0 && (await lock.check()))) {
      if (Date.now() > deadline) throw new Error("the lock never came back on a new connection");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(warnings).toHaveLength(1);
    // Another lock in the same process (a second store, a restart of the election) does not log it again.
    const again = make("B", config.port);
    expect(await again.check()).toBe(false);
    expect(warnings).toHaveLength(1);
  }, 30_000);
});


/**
 * Phase 13.1 (review round 2, M-1) — the election around the real lock when the leader's start-up (reconcile, then a
 * full schedule load) takes longer than idle_session_timeout. A model of app.ts's callbacks: onBecomeLeader waits
 * `slowMs`, then starts "the scheduler"; onResignLeader stops it. Renew 1 s, so idle_session_timeout is its 5 s floor.
 */
run("Postgres leader election with a slow start-up", () => {
  let test: TestStore | undefined;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
    await test?.cleanup();
    test = undefined;
  }, 30_000);

  async function instances() {
    test = await createTestStore({ kind: "postgres" });
    const config = test.postgres!.config;
    const pool = testStorePool(test, { max: 2 });
    cleanups.push(async () => await pool.end());
    const make = (id: string, slowMs: number, onBecome?: () => void) => {
      const lock = new PgLeaderLock({
        clientConfig: postgresPoolConfig(config, { max: 1, application_name: `slow-${id}` }),
        pool,
        leaseName: "primary",
        holderId: id,
        ttlMs: 30_000,
        renewIntervalMs: 1_000,
        checkTimeoutMs: 1_000
      });
      const state = { running: false, become: 0, resign: 0 };
      const election = new LeaderElectionService({ getLease: async () => null } as unknown as Store, {
        instanceId: id,
        lock,
        renewIntervalMs: 1_000,
        onBecomeLeader: async () => {
          state.become += 1;
          onBecome?.();
          await new Promise((resolve) => setTimeout(resolve, slowMs));
          state.running = true;
        },
        onResignLeader: () => {
          state.resign += 1;
          state.running = false;
        },
        leaderWorkRunning: () => state.running
      });
      cleanups.push(async () => await election.stop());
      return { election, state };
    };
    return { pool, make };
  }

  /** Samples every 100 ms for `ms`: how often both ran, and how often one ran while it was not the leader. */
  async function sample(ms: number, all: Array<{ election: LeaderElectionService; state: { running: boolean } }>) {
    let both = 0;
    let zombie = 0;
    let none = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const running = all.filter((one) => one.state.running);
      if (running.length > 1) both += 1;
      if (running.length === 0) none += 1;
      if (all.some((one) => one.state.running && !one.election.isLeader())) zombie += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { both, zombie, none };
  }

  it("a lone leader whose start-up outlasts idle_session_timeout keeps the lock: one become, no resign", async () => {
    const { make } = await instances();
    const a = make("A", 7_000);
    await a.election.start();
    expect(a.state).toMatchObject({ running: true, become: 1, resign: 0 });
    const seen = await sample(4_000, [a]);
    expect(seen).toEqual({ both: 0, zombie: 0, none: 0 });
    expect(a.state).toMatchObject({ running: true, become: 1, resign: 0 });
    expect(a.election.isLeader()).toBe(true);
  }, 30_000);

  it("a slow leader beside a standby: never both running, the leader keeps the lock", async () => {
    const { make } = await instances();
    const a = make("A", 7_000);
    const b = make("B", 0);
    const started = a.election.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await b.election.start();
    await started;
    const seen = await sample(4_000, [a, b]);
    expect(seen).toEqual({ both: 0, zombie: 0, none: 0 });
    expect(a.election.isLeader()).toBe(true);
    expect(b.election.isLeader()).toBe(false);
    expect(a.state).toMatchObject({ become: 1, resign: 0 });
  }, 30_000);

  it("the lock's session killed during start-up beside a standby: once settled, exactly one runs, and it holds the lock", async () => {
    const { pool, make } = await instances();
    const kill = () =>
      void setTimeout(() => {
        void pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'slow-A'`).catch(() => undefined);
      }, 1_500);
    const a = make("A", 4_000, kill);
    const b = make("B", 0);
    const started = a.election.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await b.election.start();
    await started;
    // A's start-up finished after its lock was gone and B took it: A stops at once.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const seen = await sample(4_000, [a, b]);
    expect(seen).toEqual({ both: 0, zombie: 0, none: 0 });
    expect([a, b].filter((one) => one.state.running).map((one) => one.election.isLeader())).toEqual([true]);
  }, 30_000);

  it("a lone leader whose session is killed during start-up settles as leader with the lock", async () => {
    const { pool, make } = await instances();
    let killed = false;
    const a = make("A", 4_000, () => {
      if (killed) return;
      killed = true;
      setTimeout(() => {
        void pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'slow-A'`).catch(() => undefined);
      }, 1_500);
    });
    await a.election.start();
    // The first start-up ended without the lock: it resigned and started again on a new connection.
    const deadline = Date.now() + 15_000;
    while (!(a.state.running && a.election.isLeader())) {
      if (Date.now() > deadline) throw new Error(`never settled: ${JSON.stringify(a.state)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const seen = await sample(3_000, [a]);
    expect(seen).toEqual({ both: 0, zombie: 0, none: 0 });
    const held = await pool.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid WHERE l.locktype = 'advisory' AND s.application_name = 'slow-A'`);
    expect(held.rows[0].n).toBe(1);
  }, 30_000);
});
