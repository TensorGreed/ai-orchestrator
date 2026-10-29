/**
 * Phase 13.1 — the cluster bus on Postgres LISTEN/NOTIFY, used in cluster mode (DB_TYPE=postgres and HA_ENABLED=true).
 *
 * Listening: one dedicated `pg.Client` per process (application_name `l2m-bus`), outside the store's pool, the same way
 * the leader lock has its own connection. It LISTENs to a topic's channel while the topic has a subscriber and to a
 * run's channel only while that run has a local subscriber (UNLISTEN when the last one leaves).
 *
 * Publishing: `SELECT pg_notify(channel, payload)` as one autocommit statement on a pooled connection, never inside a
 * transaction. A NOTIFY issued in a transaction takes a database-wide lock at commit and serializes every committing
 * transaction that notified; an autocommit notify holds it only for its own statement.
 *
 * Failures: the listener connection is watched three ways: its 'error' and 'end' events, client- and server-side TCP
 * keepalives, and a `SELECT 1` every `pingIntervalMs` that must answer within `queryTimeoutMs` (a half-open link sends
 * no 'end'). Any of them drops the connection; the bus reconnects with capped exponential backoff and jitter, LISTENs
 * again to everything that has subscribers, and then calls the `resync` handlers, because notifications sent while it
 * was down are lost for good. Every LISTEN/UNLISTEN, reconnect and ping runs on one serial chain, so a subscribe that
 * races a reconnect is never lost: whichever runs second sees the other's result.
 *
 * Requirements (documented in the cluster operations guide):
 *   - The connection must reach Postgres directly or through a session-mode pooler. PgBouncer in transaction mode
 *     breaks LISTEN (notifications go to whichever client holds the server connection), as it breaks the leader lock.
 *   - A payload must stay under 8,000 bytes; the bus refuses control messages over CLUSTER_BUS_MAX_PAYLOAD_BYTES and
 *     sends larger run events as a `ref`.
 *   - Channels are per database and are scoped by schema here, so deployments (and test files) that share a database
 *     but not a schema never see each other's messages.
 */
import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolConfig } from "pg";
import {
  CLUSTER_BUS_MAX_PAYLOAD_BYTES,
  CLUSTER_BUS_VERSION,
  ClusterBusPayloadTooLargeError,
  type ClusterBus,
  type ClusterBusStatus,
  type ClusterBusTopic,
  type ClusterMessage,
  type ClusterMessageInput,
  type ClusterMessageHandler,
  type RunBusEvent,
  type RunEventHandler
} from "./cluster-bus.js";
import { deliver, errorText, type ClusterBusLogger } from "./cluster-bus-local.js";

export const CLUSTER_BUS_APPLICATION_NAME = "l2m-bus";

export interface PgClusterBusOptions {
  instanceId: string;
  /** Settings for the dedicated listener connection (the store's pool settings, one connection). */
  clientConfig: PoolConfig;
  /** Runs one autocommit statement on the store's pool (publishing, and reading the schema at start). */
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  logger?: ClusterBusLogger;
  /** Liveness query on the listener every this many ms. Default 10 s. */
  pingIntervalMs?: number;
  /** A LISTEN, UNLISTEN, connect or ping that does not answer in this time drops the connection. Default 5 s. */
  queryTimeoutMs?: number;
  /** Reconnect backoff bounds. Defaults 250 ms and 10 s. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/** Channel names are identifiers: lower-case letters, digits and `_`, at most 63 bytes. */
function hashHex(text: string, length: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** The NOTIFY channel of a topic in `schema` (plain `l2m_<topic>` in `public`, so an operator can LISTEN by name). */
export function topicChannel(topic: ClusterBusTopic, schema: string): string {
  return schema === "public" ? `l2m_${topic}` : `l2m_${topic}_${hashHex(schema, 12)}`;
}

/** The NOTIFY channel of one run's events (execution ids are free text, so they are hashed). */
export function runChannel(executionId: string, schema: string): string {
  return `l2m_run_${hashHex(`${schema}\u0000${executionId}`, 32)}`;
}

/** The JSON of a run event, or its `ref` stand-in when the JSON is too large to notify. */
export function encodeRunEvent(event: RunBusEvent): string {
  const full: RunBusEvent = { ...event, v: event.v ?? CLUSTER_BUS_VERSION };
  const payload = JSON.stringify(full);
  if (Buffer.byteLength(payload, "utf8") <= CLUSTER_BUS_MAX_PAYLOAD_BYTES) return payload;
  const ref: RunBusEvent = { v: full.v, t: full.t, ref: true, ...(typeof full.nodeId === "string" ? { nodeId: full.nodeId } : {}) };
  return JSON.stringify(ref);
}

/** A received payload as a message, or null when it is not one this build reads (malformed, or a newer version). */
export function decodeMessage(payload: string | undefined): ClusterMessage | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const message = parsed as ClusterMessage;
  if (typeof message.t !== "string" || typeof message.v !== "number" || message.v > CLUSTER_BUS_VERSION) return null;
  return message;
}

class NoAnswerError extends Error {
  constructor(ms: number) {
    super(`No answer within ${ms} ms`);
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NoAnswerError(ms)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function quoteChannel(channel: string): string {
  if (!/^[a-z0-9_]{1,63}$/.test(channel)) throw new Error(`Invalid channel name '${channel}'`);
  return `"${channel}"`;
}

export class PgClusterBus implements ClusterBus {
  readonly kind = "postgres" as const;
  readonly instanceId: string;
  private schema: string | null = null;
  private readonly topicHandlers = new Map<ClusterBusTopic, Set<ClusterMessageHandler>>();
  /** Run channel → its execution id and local handlers. */
  private readonly runHandlers = new Map<string, Set<RunEventHandler>>();
  private readonly resyncHandlers = new Set<() => void | Promise<void>>();
  /** Channels LISTENed on the current connection. */
  private readonly listened = new Set<string>();
  private client: pg.Client | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  /** A connection was up before (the next successful connect is a reconnect and asks for a resync). */
  private everConnected = false;
  private disconnectedSince: Date | null = new Date();
  private reconnects = 0;
  private failedAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly pingIntervalMs: number;
  private readonly queryTimeoutMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly options: PgClusterBusOptions) {
    this.instanceId = options.instanceId;
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
    this.reconnectMinMs = options.reconnectMinMs ?? 250;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    const result = await this.options.query(`SELECT current_schema() AS schema`);
    this.schema = String(result.rows[0]?.schema ?? "public");
    await this.serial(async () => await this.connectOnce());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    this.topicHandlers.clear();
    this.runHandlers.clear();
    this.resyncHandlers.clear();
    const client = this.client;
    this.client = null;
    this.listened.clear();
    if (client) {
      client.removeAllListeners();
      client.on("error", () => undefined);
      // Ending the session drops every LISTEN; a hung connection is not waited for.
      await withTimeout(client.end(), this.queryTimeoutMs).catch(() => undefined);
    }
  }

  async publish(topic: ClusterBusTopic, message: ClusterMessageInput): Promise<void> {
    if (this.closed) return;
    const full: ClusterMessage = { ...message, v: message.v ?? CLUSTER_BUS_VERSION, from: this.instanceId };
    const payload = JSON.stringify(full);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > CLUSTER_BUS_MAX_PAYLOAD_BYTES) throw new ClusterBusPayloadTooLargeError(bytes);
    await this.notify(topicChannel(topic, this.requireSchema()), payload);
  }

  subscribe(topic: ClusterBusTopic, handler: ClusterMessageHandler): () => void {
    let handlers = this.topicHandlers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topicHandlers.set(topic, handlers);
    }
    handlers.add(handler);
    if (this.schema) void this.sync(topicChannel(topic, this.schema));
    return () => {
      const current = this.topicHandlers.get(topic);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.topicHandlers.delete(topic);
        if (this.schema) void this.sync(topicChannel(topic, this.schema));
      }
    };
  }

  async publishRunEvent(executionId: string, event: RunBusEvent): Promise<void> {
    if (this.closed) return;
    await this.notify(runChannel(executionId, this.requireSchema()), encodeRunEvent(event));
  }

  async subscribeRun(executionId: string, handler: RunEventHandler): Promise<() => void> {
    const channel = runChannel(executionId, this.requireSchema());
    let handlers = this.runHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.runHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    await this.sync(channel);
    return () => {
      const current = this.runHandlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.runHandlers.delete(channel);
        void this.sync(channel);
      }
    };
  }

  onResync(handler: () => void | Promise<void>): () => void {
    this.resyncHandlers.add(handler);
    return () => {
      this.resyncHandlers.delete(handler);
    };
  }

  status(): ClusterBusStatus {
    return {
      kind: "postgres",
      connected: this.client !== null,
      disconnectedSince: this.client ? null : (this.disconnectedSince?.toISOString() ?? null),
      reconnects: this.reconnects,
      channels: this.listened.size,
      verified: this.verified
    };
  }

  /** The listener's server process id (pg_stat_activity.pid), or null while disconnected. For operators and tests. */
  listenerProcessId(): number | null {
    const client = this.client as (pg.Client & { processID?: number }) | null;
    return client?.processID ?? null;
  }

  private requireSchema(): string {
    if (!this.schema) throw new Error("The cluster bus is not started");
    return this.schema;
  }

  private async notify(channel: string, payload: string): Promise<void> {
    // Autocommit on a pooled connection: never inside a transaction (see the header).
    await this.options.query(`SELECT pg_notify($1, $2)`, [channel, payload]);
  }

  /** Runs `work` after everything queued before it; a failure is the caller's, never the chain's. */
  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Every channel some local subscriber needs. */
  private wanted(): Set<string> {
    const channels = new Set<string>();
    if (!this.schema) return channels;
    for (const topic of this.topicHandlers.keys()) channels.add(topicChannel(topic, this.schema));
    for (const channel of this.runHandlers.keys()) channels.add(channel);
    return channels;
  }

  /** Brings one channel's LISTEN state in line with its subscribers, on the current connection (if any). */
  private sync(channel: string): Promise<void> {
    return this.serial(async () => {
      const client = this.client;
      if (!client || this.closed) return;
      const want = this.wanted().has(channel);
      const have = this.listened.has(channel);
      if (want === have) return;
      try {
        await withTimeout(client.query(`${want ? "LISTEN" : "UNLISTEN"} ${quoteChannel(channel)}`), this.queryTimeoutMs);
        if (want) this.listened.add(channel);
        else this.listened.delete(channel);
      } catch (error) {
        this.drop(client, error);
      }
    });
  }

  /** Opens the listener and LISTENs to every wanted channel; on failure schedules the next attempt. Runs on the chain. */
  private async connectOnce(): Promise<void> {
    if (this.closed || this.client) return;
    const client = new pg.Client({
      ...this.options.clientConfig,
      application_name: CLUSTER_BUS_APPLICATION_NAME,
      keepAlive: true,
      keepAliveInitialDelayMillis: this.pingIntervalMs
    });
    // Registered before connect, so an error during connect is never an unhandled 'error' event.
    client.on("error", (error) => this.drop(client, error));
    client.on("end", () => this.drop(client, new Error("connection ended")));
    client.on("notification", (notification) => this.receive(notification.channel, notification.payload));
    try {
      await withTimeout(client.connect(), this.queryTimeoutMs);
      const channels = [...this.wanted()];
      for (const channel of channels) {
        await withTimeout(client.query(`LISTEN ${quoteChannel(channel)}`), this.queryTimeoutMs);
      }
      if (this.closed) throw new Error("closed");
      this.listened.clear();
      for (const channel of channels) this.listened.add(channel);
    } catch (error) {
      client.removeAllListeners();
      client.on("error", () => undefined);
      void client.end().catch(() => undefined);
      if (this.closed) return;
      this.failedAttempts += 1;
      if (this.failedAttempts === 1 || this.failedAttempts % 20 === 0) {
        this.options.logger?.warn("Cluster bus could not connect; retrying", { error: errorText(error), attempts: this.failedAttempts });
      }
      this.scheduleReconnect();
      return;
    }
    this.client = client;
    this.disconnectedSince = null;
    this.failedAttempts = 0;
    this.startPing(client);
    void this.selfTest(client);
    const reconnected = this.everConnected;
    this.everConnected = true;
    if (reconnected) {
      this.reconnects += 1;
      this.options.logger?.info?.("Cluster bus reconnected; subscribers re-read their state", { reconnects: this.reconnects });
    }
    // A connection that came up late (or came back) may have missed messages: subscribers re-read from the database.
    if (reconnected || this.resyncPending) {
      this.resyncPending = false;
      deliver(this.resyncHandlers, undefined, this.options.logger, "resync");
    }
  }

  /** The first connect failed after subscribers registered, so they get a resync once it succeeds. */
  private resyncPending = false;
  /** The last self-test's result (see ClusterBusStatus.verified). */
  private verified: boolean | null = null;

  /**
   * Self-test after each connect: LISTEN on a one-off channel, NOTIFY it through the pool (the path every publish
   * takes), and expect the notification on the listener within `queryTimeoutMs`. Behind a pooler in transaction mode
   * the two connections can land on different server sessions and the notification never arrives; that is logged once
   * per failed test and shown as `verified: false`. Runs beside the serial chain (pg queues the listener's queries),
   * so a slow test never delays a subscription.
   */
  private async selfTest(client: pg.Client): Promise<void> {
    if (client !== this.client || this.closed || !this.schema) return;
    const channel = `l2m_probe_${hashHex(`${this.schema}\u0000${this.instanceId}\u0000${randomUUID()}`, 32)}`;
    const nonce = randomUUID();
    let heard!: () => void;
    const arrived = new Promise<void>((resolve) => {
      heard = resolve;
    });
    const onNotification = (notification: pg.Notification) => {
      if (notification.channel === channel && notification.payload === nonce) heard();
    };
    client.on("notification", onNotification);
    try {
      await withTimeout(client.query(`LISTEN ${quoteChannel(channel)}`), this.queryTimeoutMs);
      await this.options.query(`SELECT pg_notify($1, $2)`, [channel, nonce]);
      await withTimeout(arrived, this.queryTimeoutMs);
      if (client === this.client) this.verified = true;
    } catch (error) {
      if (client !== this.client || this.closed) return;
      this.verified = false;
      this.options.logger?.warn(
        "Cluster bus self-test failed: a notification sent through the pool did not reach the listener. Connect directly or through a session-mode pooler (not PgBouncer in transaction mode); until then cancels and reloads wait for their periodic checks",
        { error: errorText(error) }
      );
    } finally {
      client.off("notification", onNotification);
      if (client === this.client) await withTimeout(client.query(`UNLISTEN ${quoteChannel(channel)}`), this.queryTimeoutMs).catch(() => undefined);
    }
  }

  /** Forgets a broken connection and schedules a reconnect. Safe to call more than once per connection. */
  private drop(client: pg.Client, reason: unknown): void {
    if (client !== this.client) return;
    this.client = null;
    this.listened.clear();
    this.disconnectedSince = new Date();
    this.stopPing();
    client.removeAllListeners();
    client.on("error", () => undefined);
    void client.end().catch(() => undefined);
    if (this.closed) return;
    this.options.logger?.warn("Cluster bus listener lost; reconnecting", { error: errorText(reason) });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    if (!this.everConnected) this.resyncPending = true;
    const exp = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.failedAttempts, 16));
    const delay = Math.round(exp * (0.5 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.serial(async () => await this.connectOnce());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startPing(client: pg.Client): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      void this.serial(async () => {
        if (client !== this.client) return;
        try {
          await withTimeout(client.query(`SELECT 1`), this.queryTimeoutMs);
        } catch (error) {
          this.drop(client, error);
        }
      });
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private receive(channel: string, payload: string | undefined): void {
    if (this.closed) return;
    const message = decodeMessage(payload);
    if (!message) return;
    const runHandlers = this.runHandlers.get(channel);
    if (runHandlers) {
      deliver(runHandlers, message as RunBusEvent, this.options.logger, `run:${message.t}`);
      return;
    }
    if (!this.schema) return;
    for (const [topic, handlers] of this.topicHandlers) {
      if (topicChannel(topic, this.schema) === channel) deliver(handlers, message, this.options.logger, `${topic}:${message.t}`);
    }
  }
}
