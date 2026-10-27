/**
 * Phase 13.1 — the Postgres leader lock's liveness: after a network partition between the leader and the server
 * (a TCP proxy that stops forwarding but keeps both sockets open, as a lost host or a frozen VM does), the server
 * ends the old session within a few renew intervals and a standby takes the lock. Without the session settings the
 * server keeps the idle session, and its lock, for about two hours. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { postgresPoolConfig } from "../postgres-store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, testStorePool, type TestStore } from "../../test-support/test-store.js";
import { leaderSessionSettings, PgLeaderLock } from "./leader-lock.js";

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
    expect(lost).toBe(0); // stepped down by its own failed check, not by an 'end' event it never got
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
  }, 30_000);
});

