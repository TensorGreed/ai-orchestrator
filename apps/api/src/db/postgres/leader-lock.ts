/**
 * Phase 13.1 — leader election on Postgres: a session advisory lock held on one dedicated connection.
 *
 * The lock (class 0x4c324e, keyed by the schema and the lease name) belongs to the connection, not to a row with an
 * expiry: one session holds it at a time, and Postgres frees it when that session ends (process exit, crash,
 * `pg_terminate_backend`). The holder steps down as soon as its connection reports an error or ends, and each check
 * runs a query on it, so a link that died silently is noticed by the holder within one check plus `checkTimeoutMs`.
 *
 * The server only frees the lock once it ends the old session, and by default it notices a lost client (a network
 * partition, a host that vanished without closing its sockets) after about two hours. So the dedicated connection
 * asks the server to end it much sooner: `idle_session_timeout` (PostgreSQL 14+) a few renew intervals long, which a
 * healthy leader never reaches because each check runs a query, and short TCP keepalives on both ends. A server or
 * pooler that refuses one of these settings is warned about once and the lock still works; it then frees a lost
 * leader's lock only when it notices the dead link itself.
 *
 * A stepping-down instance stops its leader work within one check; a standby takes the lock at its next check after
 * the server ends the old session. The connection must reach Postgres directly or through a session-mode pooler:
 * with transaction pooling (e.g. PgBouncer `pool_mode=transaction`) a session lock lands on a server connection that
 * other clients reuse.
 *
 * The connection is its own `pg.Client`, never a pooled one: a pooled connection goes back to the pool and would carry
 * the lock to whoever borrows it next.
 *
 * While it holds the lock the leader also writes the `leader_leases` row (holder and expiry), only so the health
 * output keeps showing who leads; nothing reads the row to decide leadership on Postgres.
 */
import pg, { type Pool, type PoolConfig } from "pg";

export const ADVISORY_LOCK_CLASS_LEADER = 0x4c324e;

export interface LeaderLock {
  /** Takes the lock, or checks it is still held. True while this instance leads. */
  check(): Promise<boolean>;
  /** Gives the lock up and closes the connection. Idempotent. */
  release(): Promise<void>;
  /** Called once each time a held lock is lost between checks (the connection ended or failed). */
  onLost(listener: () => void): void;
}

export interface PgLeaderLockOptions {
  /** Connection settings for the dedicated client (the store's pool settings). */
  clientConfig: PoolConfig;
  /** The store's pool, for the informational `leader_leases` row. */
  pool: Pool;
  leaseName: string;
  holderId: string;
  /** How long the informational row says the lease lasts; renewed on every check. */
  ttlMs: number;
  /** Fails a check whose query on the dedicated connection does not answer in time. */
  checkTimeoutMs?: number;
  /** How often the lock is checked (HA_RENEW_INTERVAL_MS); sizes the server-side liveness settings. Default 10 s. */
  renewIntervalMs?: number;
  /** Told once when the server refuses a liveness setting. */
  logger?: { warn: (message: string, fields?: Record<string, unknown>) => void };
  /** Test seam: the session settings applied on each new connection (default: leaderSessionSettings). */
  sessionSettings?: Array<[name: string, value: string]>;
}

/**
 * The session settings that make the server end a lost leader's session (and free its lock) within a few renew
 * intervals instead of hours: an idle session lasting three checks is not a live leader, and keepalive probes start
 * after one interval of silence and give up after three more.
 */
export function leaderSessionSettings(renewIntervalMs: number): Array<[name: string, value: string]> {
  const intervalSeconds = Math.max(1, Math.ceil(renewIntervalMs / 1000));
  return [
    ["idle_session_timeout", String(Math.max(3 * renewIntervalMs, MIN_IDLE_SESSION_TIMEOUT_MS))],
    ["tcp_keepalives_idle", String(intervalSeconds)],
    ["tcp_keepalives_interval", String(intervalSeconds)],
    ["tcp_keepalives_count", "3"]
  ];
}

/** A floor for idle_session_timeout, so a short renew interval and a busy event loop do not end a live leader's session. */
const MIN_IDLE_SESSION_TIMEOUT_MS = 5_000;

export class PgLeaderLock implements LeaderLock {
  private client: pg.Client | null = null;
  private held = false;
  private released = false;
  private readonly listeners: Array<() => void> = [];
  /** The check in flight: checks never overlap, so there is never a second connection asking for the lock. */
  private checking: Promise<boolean> | null = null;
  private warnedSettings = false;

  constructor(private readonly options: PgLeaderLockOptions) {}

  onLost(listener: () => void): void {
    this.listeners.push(listener);
  }

  async check(): Promise<boolean> {
    // promise-ok: kept so a concurrent caller waits for the same check; cleared when it settles
    this.checking ??= this.checkOnce().finally(() => {
      this.checking = null;
    });
    return await this.checking;
  }

  private async checkOnce(): Promise<boolean> {
    if (this.released) return false;
    try {
      const client = await this.connection();
      const timeout = this.options.checkTimeoutMs ?? 5_000;
      if (this.held) {
        await withTimeout(client.query(`SELECT 1`), timeout);
      } else {
        const result = await withTimeout(
          client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1, hashtext(current_schema() || ':' || $2::text)) AS locked`, [
            ADVISORY_LOCK_CLASS_LEADER,
            this.options.leaseName
          ]),
          timeout
        );
        this.held = result.rows[0]?.locked === true;
      }
    } catch {
      // The connection is unusable: whatever it held is gone (or will be once the server notices); start again next time.
      this.drop(false);
      return false;
    }
    if (this.held) await this.writeLeaseRow().catch(() => undefined);
    return this.held;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const client = this.client;
    const wasHeld = this.held;
    this.client = null;
    this.held = false;
    if (!client) return;
    if (wasHeld) {
      await this.options.pool
        .query(`DELETE FROM leader_leases WHERE lease_name = $1 AND holder_id = $2`, [this.options.leaseName, this.options.holderId])
        .catch(() => undefined);
    }
    // Ending the session releases the lock; no unlock call is needed.
    await client.end().catch(() => undefined);
  }

  private async connection(): Promise<pg.Client> {
    if (this.client) return this.client;
    const renewIntervalMs = this.options.renewIntervalMs ?? 10_000;
    // Client-side keepalive too, so this end also notices a dead link between checks.
    const client = new pg.Client({ ...this.options.clientConfig, keepAlive: true, keepAliveInitialDelayMillis: renewIntervalMs });
    client.on("error", () => this.drop(true, client));
    client.on("end", () => this.drop(true, client));
    try {
      await client.connect();
    } catch (error) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.released) {
      await client.end().catch(() => undefined);
      throw new Error("released");
    }
    try {
      await this.applySessionSettings(client, renewIntervalMs);
    } catch (error) {
      client.removeAllListeners();
      client.on("error", () => undefined);
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.released) {
      await client.end().catch(() => undefined);
      throw new Error("released");
    }
    this.client = client;
    return client;
  }

  /** Sets each liveness setting on its own, so one the server or a pooler refuses leaves the others in place. */
  private async applySessionSettings(client: pg.Client, renewIntervalMs: number): Promise<void> {
    const refused: Array<{ setting: string; error: string }> = [];
    const timeout = this.options.checkTimeoutMs ?? 5_000;
    for (const [name, value] of this.options.sessionSettings ?? leaderSessionSettings(renewIntervalMs)) {
      try {
        // set_config, not SET: the value is a bind parameter. Session level (is_local false).
        await withTimeout(client.query(`SELECT set_config($1, $2, false)`, [name, value]), timeout);
      } catch (error) {
        // No answer: the connection is unusable, not the setting refused.
        if (error instanceof NoAnswerError) throw error;
        refused.push({ setting: name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (refused.length > 0 && !this.warnedSettings) {
      this.warnedSettings = true;
      this.options.logger?.warn(
        "Postgres refused a leader-connection setting; if the leader's host or network is lost, its lock is only freed when the server notices the dead link",
        { refused }
      );
    }
  }

  /** Forgets the connection (and the lock with it); tells listeners when a held lock was lost. */
  private drop(notify: boolean, client: pg.Client | null = this.client): void {
    if (!client || client !== this.client) return;
    const wasHeld = this.held;
    this.client = null;
    this.held = false;
    client.removeAllListeners("end");
    client.removeAllListeners("error");
    // Keep a late error from becoming an unhandled 'error' event.
    client.on("error", () => undefined);
    void client.end().catch(() => undefined);
    if (notify && wasHeld && !this.released) for (const listener of this.listeners) listener();
  }

  private async writeLeaseRow(): Promise<void> {
    const now = new Date();
    await this.options.pool.query(
      `INSERT INTO leader_leases (lease_name, holder_id, expires_at, acquired_at, renewed_at)
         VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (lease_name) DO UPDATE SET
         holder_id = EXCLUDED.holder_id,
         expires_at = EXCLUDED.expires_at,
         acquired_at = CASE WHEN leader_leases.holder_id = EXCLUDED.holder_id THEN leader_leases.acquired_at ELSE EXCLUDED.acquired_at END,
         renewed_at = EXCLUDED.renewed_at`,
      [this.options.leaseName, this.options.holderId, new Date(now.getTime() + this.options.ttlMs).toISOString(), now.toISOString()]
    );
  }
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
