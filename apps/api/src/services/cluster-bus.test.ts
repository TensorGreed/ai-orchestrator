/**
 * Phase 13.1 — the cluster bus contract, on the in-process bus (always) and on Postgres LISTEN/NOTIFY (with
 * TEST_POSTGRES_URL): delivery to every instance including the publisher, per-run channels, version gating, payload
 * limits, and (Postgres) reconnecting after the listener's session is killed, with a resync and every subscription
 * restored.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PostgresStore } from "../db/postgres-store.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";
import { CLUSTER_BUS_MAX_PAYLOAD_BYTES, ClusterBusPayloadTooLargeError, type ClusterBus, type ClusterMessage, type RunBusEvent } from "./cluster-bus.js";
import { LocalClusterBus } from "./cluster-bus-local.js";
import { decodeMessage, encodeRunEvent, runChannel, topicChannel, type PgClusterBus } from "./cluster-bus-pg.js";

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Lets pending deliveries run; used only to show that something did NOT arrive after a later message did. */
async function marker(bus: ClusterBus, seen: ClusterMessage[]): Promise<void> {
  const id = `marker-${Math.random()}`;
  await bus.publish("ctl", { t: "marker", id });
  await until(() => seen.some((message) => message.t === "marker" && message.id === id), "the marker");
}

describe("cluster bus helpers", () => {
  it("names channels per schema and hashes run ids into valid identifiers", () => {
    expect(topicChannel("ctl", "public")).toBe("l2m_ctl");
    expect(topicChannel("ctl", "t_abc")).toMatch(/^l2m_ctl_[0-9a-f]{12}$/);
    expect(topicChannel("ctl", "t_abc")).not.toBe(topicChannel("ctl", "t_abd"));
    const channel = runChannel("exec with spaces / and a very long id ".repeat(5), "public");
    expect(channel).toMatch(/^l2m_run_[0-9a-f]{32}$/);
    expect(channel.length).toBeLessThanOrEqual(63);
    expect(runChannel("a", "s1")).not.toBe(runChannel("a", "s2"));
  });

  it("sends a run event over the payload limit as a ref that keeps its type and node", () => {
    const small: RunBusEvent = { t: "node_start", nodeId: "n1", startedAt: "x" };
    expect(JSON.parse(encodeRunEvent(small))).toEqual({ ...small, v: 1 });
    const big: RunBusEvent = { t: "node_complete", nodeId: "n2", output: "x".repeat(CLUSTER_BUS_MAX_PAYLOAD_BYTES) };
    expect(JSON.parse(encodeRunEvent(big))).toEqual({ v: 1, t: "node_complete", ref: true, nodeId: "n2" });
    // Multi-byte text counts in bytes, not characters.
    const wide: RunBusEvent = { t: "llm_delta", nodeId: "n3", delta: "é".repeat(CLUSTER_BUS_MAX_PAYLOAD_BYTES / 2) };
    expect(JSON.parse(encodeRunEvent(wide)).ref).toBe(true);
  });

  it("reads only well-formed messages of a version it knows", () => {
    expect(decodeMessage(JSON.stringify({ v: 1, t: "cancel", id: "e1" }))).toEqual({ v: 1, t: "cancel", id: "e1" });
    expect(decodeMessage(JSON.stringify({ v: 2, t: "cancel", id: "e1" }))).toBeNull();
    expect(decodeMessage(JSON.stringify({ t: "cancel" }))).toBeNull();
    expect(decodeMessage("not json")).toBeNull();
    expect(decodeMessage("[1]")).toBeNull();
    expect(decodeMessage(undefined)).toBeNull();
  });
});

describe("LocalClusterBus", () => {
  it("delivers to this process's subscribers after the publisher's tick, stamped with v and from", async () => {
    const bus = new LocalClusterBus("me");
    await bus.start();
    const seen: ClusterMessage[] = [];
    const off = bus.subscribe("ctl", (message) => {
      seen.push(message);
    });
    await bus.publish("ctl", { t: "cancel", id: "e1" });
    expect(seen).toEqual([]);
    await until(() => seen.length === 1, "delivery");
    expect(seen[0]).toEqual({ v: 1, t: "cancel", id: "e1", from: "me" });
    off();
    await bus.publish("ctl", { t: "cancel", id: "e2" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    await bus.close();
  });

  it("keeps run events per run, never shortens them, and survives a throwing handler", async () => {
    const warnings: string[] = [];
    const bus = new LocalClusterBus("me", { warn: (message) => warnings.push(message) });
    const a: RunBusEvent[] = [];
    const b: RunBusEvent[] = [];
    await bus.subscribeRun("run-a", () => {
      throw new Error("boom");
    });
    const offA = await bus.subscribeRun("run-a", (event) => {
      a.push(event);
    });
    await bus.subscribeRun("run-b", (event) => {
      b.push(event);
    });
    const big = { t: "node_complete", nodeId: "n", output: "x".repeat(CLUSTER_BUS_MAX_PAYLOAD_BYTES * 2) };
    await bus.publishRunEvent("run-a", big);
    await until(() => a.length === 1, "run-a event");
    expect(a[0]).toEqual({ ...big, v: 1 });
    expect(b).toEqual([]);
    expect(warnings).toContain("Cluster bus handler failed");
    offA();
    await bus.publishRunEvent("run-a", { t: "x" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(a).toHaveLength(1);
    expect(bus.status()).toMatchObject({ kind: "local", connected: true, reconnects: 0 });
    await bus.close();
  });
});

const runPg = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("Postgres cluster bus");

runPg("PgClusterBus (two instances on one database)", () => {
  let primary: TestStore | undefined;
  let twin: PostgresStore | undefined;
  const buses: PgClusterBus[] = [];

  afterEach(async () => {
    for (const bus of buses.splice(0)) await bus.close();
    await twin?.close();
    twin = undefined;
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  async function open(options: { pingIntervalMs?: number } = {}): Promise<[PgClusterBus, PgClusterBus]> {
    primary = await createTestStore({ kind: "postgres" });
    twin = await openTestStoreTwin(primary);
    const a = (primary.store as PostgresStore).clusterBus({ instanceId: "a", reconnectMinMs: 20, reconnectMaxMs: 200, ...options });
    const b = twin.clusterBus({ instanceId: "b", reconnectMinMs: 20, reconnectMaxMs: 200, ...options });
    buses.push(a, b);
    await a.start();
    await b.start();
    return [a, b];
  }

  it("delivers a control message to both instances, the publisher included", async () => {
    const [a, b] = await open();
    const seenA: ClusterMessage[] = [];
    const seenB: ClusterMessage[] = [];
    a.subscribe("ctl", (message) => {
      seenA.push(message);
    });
    b.subscribe("ctl", (message) => {
      seenB.push(message);
    });
    // The LISTEN runs on the bus's serial chain; a run subscription waits for it, so this one flushes the topic's too.
    await (await b.subscribeRun("flush", () => undefined))();
    await (await a.subscribeRun("flush", () => undefined))();
    await a.publish("ctl", { t: "cancel", id: "e1", reason: "stop" });
    await until(() => seenA.length === 1 && seenB.length === 1, "both deliveries");
    expect(seenB[0]).toEqual({ v: 1, t: "cancel", id: "e1", reason: "stop", from: "a" });
    expect(seenA[0]).toEqual(seenB[0]);
    expect(a.status()).toMatchObject({ kind: "postgres", connected: true, disconnectedSince: null });
  }, 60_000);

  it("ignores a newer message version and refuses an oversized control message", async () => {
    const [a, b] = await open();
    const seen: ClusterMessage[] = [];
    b.subscribe("ctl", (message) => {
      seen.push(message);
    });
    await (await b.subscribeRun("flush", () => undefined))();
    const pool = testStorePool(primary!);
    try {
      await pool.query(`SELECT pg_notify($1, $2)`, [topicChannel("ctl", "public"), JSON.stringify({ v: 2, t: "cancel", id: "future" })]);
      await pool.query(`SELECT pg_notify($1, $2)`, [topicChannel("ctl", "public"), "not json"]);
    } finally {
      await pool.end();
    }
    await expect(a.publish("ctl", { t: "elicitation_answer", content: "x".repeat(CLUSTER_BUS_MAX_PAYLOAD_BYTES) })).rejects.toBeInstanceOf(
      ClusterBusPayloadTooLargeError
    );
    await marker(a, seen);
    expect(seen.map((message) => message.t)).toEqual(["marker"]);
  }, 60_000);

  it("listens to a run's channel only while it has a subscriber, and sends large events as refs", async () => {
    const [a, b] = await open();
    const events: RunBusEvent[] = [];
    const other: RunBusEvent[] = [];
    const baseline = b.status().channels;
    const off = await b.subscribeRun("exec-1", (event) => {
      events.push(event);
    });
    await b.subscribeRun("exec-2", (event) => {
      other.push(event);
    });
    expect(b.status().channels).toBe(baseline + 2);
    await a.publishRunEvent("exec-1", { t: "node_start", nodeId: "n1" });
    await a.publishRunEvent("exec-1", { t: "node_complete", nodeId: "n1", output: "y".repeat(CLUSTER_BUS_MAX_PAYLOAD_BYTES) });
    await until(() => events.length === 2, "two run events");
    expect(events).toEqual([
      { v: 1, t: "node_start", nodeId: "n1" },
      { v: 1, t: "node_complete", ref: true, nodeId: "n1" }
    ]);
    expect(other).toEqual([]);
    off();
    await until(() => b.status().channels === baseline + 1, "the UNLISTEN");
    await a.publishRunEvent("exec-1", { t: "late" });
    await a.publishRunEvent("exec-2", { t: "after" });
    await until(() => other.length === 1, "the exec-2 event");
    expect(events).toHaveLength(2);
  }, 60_000);

  it("reconnects after its listener session is killed: LISTENs again, asks for a resync, and delivers again", async () => {
    const [a, b] = await open({ pingIntervalMs: 200 });
    const seen: ClusterMessage[] = [];
    const runEvents: RunBusEvent[] = [];
    let resyncs = 0;
    b.subscribe("ctl", (message) => {
      seen.push(message);
    });
    await b.subscribeRun("exec-r", (event) => {
      runEvents.push(event);
    });
    b.onResync(() => {
      resyncs += 1;
    });
    const pid = b.listenerProcessId();
    expect(pid).not.toBeNull();
    const pool = testStorePool(primary!);
    try {
      const killed = await pool.query<{ application_name: string }>(`SELECT application_name FROM pg_stat_activity WHERE pid = $1`, [pid]);
      expect(killed.rows[0]?.application_name).toBe("l2m-bus");
      await pool.query(`SELECT pg_terminate_backend($1)`, [pid]);
    } finally {
      await pool.end();
    }
    // A message sent while the listener is down is lost: the resync is what tells subscribers to re-read.
    await until(() => resyncs === 1, "the resync after the reconnect");
    expect(b.status()).toMatchObject({ connected: true, reconnects: 1 });
    expect(b.listenerProcessId()).not.toBe(pid);
    await a.publishRunEvent("exec-r", { t: "after_reconnect" });
    await marker(a, seen);
    await until(() => runEvents.length === 1, "the run event after the reconnect");
    expect(runEvents[0]!.t).toBe("after_reconnect");
  }, 60_000);

  it("keeps deployments in different schemas apart", async () => {
    const [a] = await open();
    // The same database, another schema: a separate deployment sharing the server.
    const config = primary!.postgres!.config;
    const { PostgresStore: Store } = await import("../db/postgres-store.js");
    const other = await Store.create({ ...config, schema: `t_bus_${Math.random().toString(16).slice(2, 10)}`, maxConnections: 2 });
    try {
      const bus = other.clusterBus({ instanceId: "other" });
      await bus.start();
      const seenOther: ClusterMessage[] = [];
      const seenA: ClusterMessage[] = [];
      bus.subscribe("ctl", (message) => {
        seenOther.push(message);
      });
      a.subscribe("ctl", (message) => {
        seenA.push(message);
      });
      await (await bus.subscribeRun("flush", () => undefined))();
      await (await a.subscribeRun("flush", () => undefined))();
      await a.publish("ctl", { t: "cancel", id: "public-only" });
      await marker(bus, seenOther);
      await until(() => seenA.some((message) => message.id === "public-only"), "the public delivery");
      expect(seenOther.map((message) => message.t)).toEqual(["marker"]);
      expect(seenA.some((message) => message.t === "marker")).toBe(false);
    } finally {
      await other.close();
    }
  }, 60_000);

  it("keeps retrying while Postgres refuses the listener, then connects and asks for a resync", async () => {
    primary = await createTestStore({ kind: "postgres" });
    const { PgClusterBus } = await import("./cluster-bus-pg.js");
    const config = primary.postgres!.config;
    const pool = testStorePool(primary);
    // The listener's port is read at each connect: a closed port first, then the server's.
    let port = 1;
    const warnings: string[] = [];
    const bus = new PgClusterBus({
      instanceId: "late",
      clientConfig: {
        host: config.host,
        database: config.database,
        user: config.user,
        password: config.password,
        get port() {
          return port;
        }
      },
      query: async (sql, params) => await pool.query(sql, params),
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
      logger: { warn: (message) => warnings.push(message) }
    });
    try {
      let resyncs = 0;
      bus.onResync(() => {
        resyncs += 1;
      });
      const seen: ClusterMessage[] = [];
      bus.subscribe("ctl", (message) => {
        seen.push(message);
      });
      await bus.start();
      expect(bus.status().connected).toBe(false);
      expect(warnings).toContain("Cluster bus could not connect; retrying");
      port = config.port;
      await until(() => bus.status().connected, "the listener to connect");
      await until(() => resyncs === 1, "a resync once connected");
      await marker(bus, seen);
    } finally {
      await bus.close();
      await pool.end();
    }
  }, 60_000);
});
