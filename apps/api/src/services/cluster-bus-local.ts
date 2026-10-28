/**
 * Phase 13.1 — the in-process cluster bus: the default on SQLite and on Postgres outside cluster mode. Every message
 * reaches this process's subscribers only, so a single instance behaves exactly as before. Delivery is asynchronous
 * (after the publisher's current tick), the same as a NOTIFY, so a handler never runs inside the publisher's call.
 */
import {
  CLUSTER_BUS_VERSION,
  type ClusterBus,
  type ClusterBusStatus,
  type ClusterBusTopic,
  type ClusterMessage,
  type ClusterMessageInput,
  type ClusterMessageHandler,
  type RunBusEvent,
  type RunEventHandler
} from "./cluster-bus.js";

export interface ClusterBusLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Calls each handler on its own; one that throws or rejects is logged and does not stop the others. */
export function deliver<T>(handlers: Iterable<(value: T) => void | Promise<void>>, value: T, logger: ClusterBusLogger | undefined, what: string): void {
  for (const handler of [...handlers]) {
    try {
      const result = handler(value);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error: unknown) => logger?.warn("Cluster bus handler failed", { what, error: errorText(error) }));
      }
    } catch (error) {
      logger?.warn("Cluster bus handler failed", { what, error: errorText(error) });
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalClusterBus implements ClusterBus {
  readonly kind = "local" as const;
  private readonly topics = new Map<ClusterBusTopic, Set<ClusterMessageHandler>>();
  private readonly runs = new Map<string, Set<RunEventHandler>>();
  private closed = false;

  constructor(
    readonly instanceId: string,
    private readonly logger?: ClusterBusLogger
  ) {}

  async start(): Promise<void> {
    // Nothing to open.
  }

  async close(): Promise<void> {
    this.closed = true;
    this.topics.clear();
    this.runs.clear();
  }

  async publish(topic: ClusterBusTopic, message: ClusterMessageInput): Promise<void> {
    if (this.closed) return;
    const full: ClusterMessage = { ...message, v: message.v ?? CLUSTER_BUS_VERSION, from: this.instanceId };
    setImmediate(() => {
      const handlers = this.topics.get(topic);
      if (handlers) deliver(handlers, full, this.logger, `${topic}:${full.t}`);
    });
  }

  subscribe(topic: ClusterBusTopic, handler: ClusterMessageHandler): () => void {
    let handlers = this.topics.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topics.set(topic, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  async publishRunEvent(executionId: string, event: RunBusEvent): Promise<void> {
    if (this.closed) return;
    const full: RunBusEvent = { ...event, v: event.v ?? CLUSTER_BUS_VERSION };
    setImmediate(() => {
      const handlers = this.runs.get(executionId);
      if (handlers) deliver(handlers, full, this.logger, `run:${full.t}`);
    });
  }

  async subscribeRun(executionId: string, handler: RunEventHandler): Promise<() => void> {
    let handlers = this.runs.get(executionId);
    if (!handlers) {
      handlers = new Set();
      this.runs.set(executionId, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.runs.get(executionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.runs.delete(executionId);
    };
  }

  onResync(): () => void {
    // The in-process bus never loses a message, so it never asks for a resync.
    return () => undefined;
  }

  status(): ClusterBusStatus {
    return { kind: "local", connected: !this.closed, disconnectedSince: null, reconnects: 0, channels: this.topics.size + this.runs.size };
  }
}
