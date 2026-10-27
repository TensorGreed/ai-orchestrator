import crypto from "node:crypto";
import os from "node:os";
import type { Store } from "../db/store.js";
import type { LeaderLock } from "../db/postgres/leader-lock.js";

export interface LeaderElectionOptions {
  enabled?: boolean;
  instanceId?: string;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  /** Called exactly once when this instance newly acquires the lease. */
  onBecomeLeader?: () => void | Promise<void>;
  /** Called when this instance loses the lease (e.g. DB error, remote steal). */
  onResignLeader?: () => void | Promise<void>;
  /**
   * Phase 13.1 — decide leadership with this lock instead of the `leader_leases` row (Postgres: an advisory lock on
   * a dedicated connection). Election is then on whatever `enabled` says, and losing the lock's connection steps
   * this instance down at once, not at the next renewal.
   */
  lock?: LeaderLock;
}

/** A lock that is never granted: the instance follows (Postgres instances without background workers, with HA on). */
export const NEVER_LEAD: LeaderLock = {
  check: async () => false,
  release: async () => undefined,
  onLost: () => undefined
};

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
 *
 * With a `lock` (Postgres) the lock decides instead of the row: one holder at a time, freed when its session ends.
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
  private readonly lock: LeaderLock | undefined;
  /** Leading since acquireEarly(), with onBecomeLeader not yet run (start() runs it). */
  private unannounced = false;
  /** A tick in flight: a slow check or leader callback never overlaps the next interval's tick. */
  private ticking = false;
  /** Run one more tick as soon as the current one ends (the lock was just lost). */
  private retryRequested = false;

  constructor(
    private readonly store: Store,
    options: LeaderElectionOptions = {},
    leaseName = "primary"
  ) {
    this.lock = options.lock;
    this.enabled = options.enabled === true || this.lock !== undefined;
    // A dropped lock connection: step down now, then try to take the lock again at once (a lone instance whose
    // connection blipped leads again within moments instead of a renew interval later).
    this.lock?.onLost(() => void this.stepDown().then(() => this.retryNow()));
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
   * Phase 13.1 — with a lock: takes it now, if it is free, so isLeader() answers for this instance while the rest of
   * startup runs (an approval sweep at boot asks before the election loop starts). onBecomeLeader still runs from
   * start(). Without a lock this does nothing.
   */
  async acquireEarly(): Promise<void> {
    if (!this.lock || this.stopped || this.timer || this.holder) return;
    try {
      this.holder = await this.lock.check();
    } catch {
      this.holder = false;
    }
    this.unannounced = this.holder;
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
    if (this.lock) await this.lock.release();
    if (this.enabled && this.holder) {
      try {
        if (!this.lock) await this.store.releaseLease(this.leaseName, this.instanceId);
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

  async getStatus(): Promise<LeaderStatus> {
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
    const lease = await this.store.getLease(this.leaseName);
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
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      do {
        this.retryRequested = false;
        await this.tickOnce();
      } while (this.retryRequested && !this.stopped);
    } finally {
      this.ticking = false;
    }
  }

  /** Re-tries the lock at once instead of at the next interval; only once the election loop runs. */
  private retryNow(): void {
    if (this.stopped || !this.timer || !this.lock) return;
    this.retryRequested = true;
    void this.tick();
  }

  private async tickOnce(): Promise<void> {
    let acquired = false;
    try {
      acquired = this.lock
        ? await this.lock.check()
        : await this.store.tryAcquireLease({
            leaseName: this.leaseName,
            holderId: this.instanceId,
            ttlMs: this.leaseTtlMs
          });
    } catch {
      acquired = false;
    }
    if (this.stopped) return;
    const wasLeader = this.holder && !this.unannounced;
    this.unannounced = false;
    this.holder = acquired;
    this.lastRenewAt = new Date().toISOString();
    if (!wasLeader && acquired && this.onBecomeLeader) {
      try {
        await this.onBecomeLeader();
      } catch {
        // ignore — next tick will try again
      }
    }
    if (wasLeader && !acquired) {
      if (this.onResignLeader) {
        try {
          await this.onResignLeader();
        } catch {
          // ignore
        }
      }
      // The check found the lock's connection gone: try for the lock again at once on a new one.
      if (this.lock) this.retryRequested = true;
    }
  }

  /** The lock's connection ended or failed while this instance led: stop leading now. */
  private async stepDown(): Promise<void> {
    if (!this.holder || this.stopped) return;
    this.holder = false;
    const announced = !this.unannounced;
    this.unannounced = false;
    if (announced && this.onResignLeader) {
      try {
        await this.onResignLeader();
      } catch {
        // ignore
      }
    }
  }
}
