import crypto from "node:crypto";
import os from "node:os";
import type { SqliteStore } from "../db/database";

export interface LeaderElectionOptions {
  enabled?: boolean;
  instanceId?: string;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  /** Called exactly once when this instance newly acquires the lease. */
  onBecomeLeader?: () => void | Promise<void>;
  /** Called when this instance loses the lease (e.g. DB error, remote steal). */
  onResignLeader?: () => void | Promise<void>;
}

export interface LeaderStatus {
  enabled: boolean;
  instanceId: string;
  leaseName: string;
  isLeader: boolean;
  lastRenewAt: string | null;
  nextRenewAt: string | null;
  leaseHolder: string | null;
  leaseExpiresAt: string | null;
}

/**
 * Database-backed leader election. Uses a single row in `leader_leases`
 * keyed by lease name; the holder periodically renews the row's
 * `expires_at`. If the row is stale (past `expires_at`), any instance can
 * steal it. Works on both SQLite (single-writer, trivially) and Postgres
 * (row-level atomic updates).
 *
 * When `HA_ENABLED=false` this service always reports itself as the leader
 * — single-instance deployments get the same API without HA overhead.
 */
export class LeaderElectionService {
  private readonly enabled: boolean;
  private readonly leaseTtlMs: number;
  private readonly renewIntervalMs: number;
  private readonly instanceId: string;
  private readonly leaseName: string;
  private readonly onBecomeLeader: (() => void | Promise<void>) | undefined;
  private readonly onResignLeader: (() => void | Promise<void>) | undefined;

  private holder = false;
  private timer: NodeJS.Timeout | null = null;
  private lastRenewAt: string | null = null;
  private stopped = false;

  constructor(
    private readonly store: SqliteStore,
    options: LeaderElectionOptions = {},
    leaseName = "primary"
  ) {
    this.enabled = options.enabled === true;
    this.leaseTtlMs = options.leaseTtlMs ?? 30000;
    this.renewIntervalMs = options.renewIntervalMs ?? 10000;
    this.instanceId = options.instanceId ?? `${os.hostname()}-${crypto.randomBytes(4).toString("hex")}`;
    this.leaseName = leaseName;
    this.onBecomeLeader = options.onBecomeLeader;
    this.onResignLeader = options.onResignLeader;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  isLeader(): boolean {
    return this.enabled ? this.holder : true;
  }

  /**
   * Begin the election loop. When HA is disabled, immediately invokes
   * onBecomeLeader (sync) and returns.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      if (this.onBecomeLeader) await this.onBecomeLeader();
      this.holder = true;
      return;
    }
    // Attempt an initial acquire synchronously so callers can observe the
    // post-boot state immediately.
    await this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.renewIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled && this.holder) {
      try {
        this.store.releaseLease(this.leaseName, this.instanceId);
      } catch {
        // ignore
      }
      this.holder = false;
      if (this.onResignLeader) {
        try {
          await this.onResignLeader();
        } catch {
          // ignore
        }
      }
    }
  }

  getStatus(): LeaderStatus {
    if (!this.enabled) {
      return {
        enabled: false,
        instanceId: this.instanceId,
        leaseName: this.leaseName,
        isLeader: true,
        lastRenewAt: null,
        nextRenewAt: null,
        leaseHolder: this.instanceId,
        leaseExpiresAt: null
      };
    }
    const lease = this.store.getLease(this.leaseName);
    return {
      enabled: true,
      instanceId: this.instanceId,
      leaseName: this.leaseName,
      isLeader: this.holder,
      lastRenewAt: this.lastRenewAt,
      nextRenewAt: this.lastRenewAt
        ? new Date(Date.parse(this.lastRenewAt) + this.renewIntervalMs).toISOString()
        : null,
      leaseHolder: lease?.holderId ?? null,
      leaseExpiresAt: lease?.expiresAt ?? null
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let acquired = false;
    try {
      acquired = this.store.tryAcquireLease({
        leaseName: this.leaseName,
        holderId: this.instanceId,
        ttlMs: this.leaseTtlMs
      });
    } catch {
      acquired = false;
    }
    const wasLeader = this.holder;
    this.holder = acquired;
    this.lastRenewAt = new Date().toISOString();
    if (!wasLeader && acquired && this.onBecomeLeader) {
      try {
        await this.onBecomeLeader();
      } catch {
        // ignore — next tick will try again
      }
    }
    if (wasLeader && !acquired && this.onResignLeader) {
      try {
        await this.onResignLeader();
      } catch {
        // ignore
      }
    }
  }
}
