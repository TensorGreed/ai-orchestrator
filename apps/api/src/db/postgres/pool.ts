/**
 * Phase 13.1 — every pg Pool the API and its scripts open gets an 'error' listener. pg's Pool emits 'error' when the
 * server ends one of its idle connections (a Postgres restart or failover, an admin's pg_terminate_backend, a role's
 * idle_session_timeout, a pooler recycling server connections); with no listener that is an unhandled 'error' event
 * and the process exits. The pool drops the dead connection by itself and opens a new one on the next query, so the
 * listener only logs: the first error, then at most one line per interval with the count it held back.
 *
 * A client checked out of the pool has no listener of the pool's while it is out; an error between its queries (in a
 * transaction, say) would be unhandled too. Each new client gets a listener that ignores it: the client's next query
 * fails instead, and the pool discards the client when it is released.
 */
import { Pool, type PoolConfig } from "pg";

export interface PoolErrorLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface PoolErrorOptions {
  /** Which pool, in the log line (store, db:copy, ...). */
  label?: string;
  /** Defaults to the console. */
  logger?: PoolErrorLogger;
  /** At most one line per this many ms (default 60 s). */
  logIntervalMs?: number;
  /** Test seam: the clock. */
  now?: () => number;
}

export const POOL_ERROR_LOG_INTERVAL_MS = 60_000;

const consoleLogger: PoolErrorLogger = {
  // eslint-disable-next-line no-console
  warn: (message, fields) => console.warn(fields ? `${message} ${JSON.stringify(fields)}` : message)
};

/** A connection string's password, if a message ever carries one. */
function withoutPassword(message: string): string {
  return message.replace(/(\/\/[^:/@\s]+:)[^@\s]*@/g, "$1***@");
}

type ErrorEmitter = { on(event: "error", listener: (error: Error) => void): unknown };

export function attachPoolErrorHandler(pool: Pool, options: PoolErrorOptions = {}): Pool {
  const logger = options.logger ?? consoleLogger;
  const interval = options.logIntervalMs ?? POOL_ERROR_LOG_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let lastLoggedAt: number | null = null;
  let heldBack = 0;
  pool.on("error", (error: Error & { code?: string }) => {
    const at = now();
    if (lastLoggedAt !== null && at - lastLoggedAt < interval) {
      heldBack += 1;
      return;
    }
    lastLoggedAt = at;
    logger.warn("Postgres ended an idle pooled connection; the pool opens a new one on the next query", {
      pool: options.label ?? "postgres",
      ...(error.code ? { code: error.code } : {}),
      error: withoutPassword(error.message),
      heldBack
    });
    heldBack = 0;
  });
  pool.on("connect", (client) => {
    (client as unknown as ErrorEmitter).on("error", () => undefined);
  });
  return pool;
}

/** A pg Pool with the error listener above. */
export function createPostgresPool(config: PoolConfig, options: PoolErrorOptions = {}): Pool {
  return attachPoolErrorHandler(new Pool(config), options);
}
