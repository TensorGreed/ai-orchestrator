/**
 * Phase 13.1 — the cluster bus: small control messages and run events between API instances on one database.
 *
 * Two implementations behind this interface:
 *   - LocalClusterBus (cluster-bus-local.ts): in-process. The default on SQLite and on Postgres outside cluster mode
 *     (cluster mode = DB_TYPE=postgres and HA_ENABLED=true), so one instance behaves exactly as before.
 *   - PgClusterBus (cluster-bus-pg.ts): Postgres LISTEN/NOTIFY on one dedicated connection per process.
 *
 * The bus itself is best effort: a message published while an instance's listener connection is down never reaches
 * that instance. The state a message announces is always written to the database first, and every consumer has a
 * reconciliation path that reads it (a periodic check, and a re-read when the bus reports `resync` after a reconnect),
 * so each effect happens at least once; the bus only makes the common case fast. Handlers must be idempotent: a
 * message can arrive together with its reconciliation, and every instance receives its own messages.
 *
 * Messages are JSON objects `{ v, t, ... }`. A receiver ignores a message with an unknown `t` or a `v` above
 * CLUSTER_BUS_VERSION, so instances of different versions can share a bus during a rolling deploy.
 */

/** The message format version this build writes and reads. */
export const CLUSTER_BUS_VERSION = 1;

/**
 * Largest NOTIFY payload the bus sends, in bytes (Postgres refuses 8,000 and above). A control message above it is
 * refused (ClusterBusPayloadTooLargeError); a run event above it is replaced by a `ref` (see RunBusEvent).
 */
export const CLUSTER_BUS_MAX_PAYLOAD_BYTES = 7_000;

/**
 * Broadcast topics:
 *   - `ctl`: control messages (cancel, eval_cancel, workflow_changed, and later elicitation_answer, packages_changed).
 *   - `queue`: queue wake-ups (`{ t: "wake", pool }`), so consumers claim at once instead of at their next poll.
 */
export type ClusterBusTopic = "ctl" | "queue";

/** Any bus message. Known shapes are below; receivers narrow on `t`. */
export interface ClusterMessage {
  v: number;
  t: string;
  /** The publishing instance (set by the bus). */
  from?: string;
  [key: string]: unknown;
}

/** Stop a run wherever it executes. Sent after the canceled history row is written. */
export interface ClusterCancelMessage extends ClusterMessage {
  t: "cancel";
  id: string;
  reason?: string;
}

/** Stop an eval run or replay job on the instance that runs it. Sent after the run is marked canceled. */
export interface ClusterEvalCancelMessage extends ClusterMessage {
  t: "eval_cancel";
  runId: string;
}

/** A workflow was saved, published, restored or deleted: the leader reloads its schedules and triggers. */
export interface ClusterWorkflowChangedMessage extends ClusterMessage {
  t: "workflow_changed";
  id: string;
}

/** A queue item became claimable in `pool`. */
export interface ClusterQueueWakeMessage extends ClusterMessage {
  t: "wake";
  pool: string;
}

/**
 * One event of a run, for an SSE relay on another instance. An event whose JSON is larger than
 * CLUSTER_BUS_MAX_PAYLOAD_BYTES arrives as `{ v, t, ref: true, nodeId? }`: the receiver reads the full value from the
 * run's persisted progress. The local bus never shortens events.
 */
export interface RunBusEvent {
  v?: number;
  t: string;
  nodeId?: string;
  ref?: boolean;
  [key: string]: unknown;
}

/** A message as published: `v` defaults to CLUSTER_BUS_VERSION and `from` is set by the bus. */
export interface ClusterMessageInput {
  t: string;
  v?: number;
  [key: string]: unknown;
}

export type ClusterMessageHandler = (message: ClusterMessage) => void | Promise<void>;
export type RunEventHandler = (event: RunBusEvent) => void | Promise<void>;

export interface ClusterBusStatus {
  kind: "local" | "postgres";
  /** True while the listener connection is up (always true for the local bus once started). */
  connected: boolean;
  /** When the listener was last lost; null while connected. */
  disconnectedSince: string | null;
  /** Times the listener connection was re-established. */
  reconnects: number;
  /** Channels currently listened to (run channels included). */
  channels: number;
  /**
   * Whether a self-test notification, sent through the pool after the listener connected, reached the listener: false
   * points at a pooler in transaction mode or a listener on another server (messages then never arrive, and every
   * effect waits for its reconciliation). Null until tested; always true for the local bus.
   */
  verified?: boolean | null;
}

export class ClusterBusPayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Cluster bus message is ${bytes} bytes; the limit is ${CLUSTER_BUS_MAX_PAYLOAD_BYTES}.`);
    this.name = "ClusterBusPayloadTooLargeError";
  }
}

export interface ClusterBus {
  readonly kind: "local" | "postgres";
  /** This instance's id, stamped on every message as `from`. */
  readonly instanceId: string;

  /** Opens the listener (Postgres). Resolves once listening, or after the first failed attempt (it keeps retrying). */
  start(): Promise<void>;
  /** Stops listening and drops every subscription. Idempotent. */
  close(): Promise<void>;

  /**
   * Sends `message` to every instance's `topic` subscribers, this one included. `v` and `from` are filled in.
   * Postgres: one autocommit `pg_notify` on a pooled connection, never inside a transaction (a NOTIFY in a
   * transaction takes a database-wide lock at commit). Rejects when the payload is too large or the database refuses.
   */
  publish(topic: ClusterBusTopic, message: ClusterMessageInput): Promise<void>;
  /** Adds a handler for `topic`; returns the unsubscribe function. A handler that throws is logged, never retried. */
  subscribe(topic: ClusterBusTopic, handler: ClusterMessageHandler): () => void;

  /** Sends one run event to the subscribers of `executionId` on every instance (large events become a `ref`). */
  publishRunEvent(executionId: string, event: RunBusEvent): Promise<void>;
  /**
   * Subscribes to one run's events. Resolves once the subscription is active (Postgres: the LISTEN has run, or the
   * listener is down and will LISTEN when it reconnects), so a caller can subscribe before it starts the run.
   * Resolves to the unsubscribe function.
   */
  subscribeRun(executionId: string, handler: RunEventHandler): Promise<() => void>;

  /**
   * Called after the listener reconnected: messages may have been missed meanwhile, so subscribers re-read what they
   * track from the database. Returns the unsubscribe function.
   */
  onResync(handler: () => void | Promise<void>): () => void;

  status(): ClusterBusStatus;
}
