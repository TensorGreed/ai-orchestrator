/**
 * Phase 13.1 — where a flow that waits on a person keeps its state between two requests: a sign-in's TOTP step
 * (password login `mfa_login`, SSO login `sso_mfa`) and an MCP OAuth authorization waiting for its callback
 * (`mcp_oauth`: state, PKCE verifier, client registration).
 *
 *   - MemoryChallengeStore: a map in this process, exactly today's behaviour (lost on restart). Used on SQLite and on
 *     Postgres outside cluster mode.
 *   - DbChallengeStore: the `pending_challenges` table, so the second request may land on any instance (cluster mode:
 *     Postgres with HA_ENABLED=true). Only the sha256 of the opaque id is stored, and the payload is sealed with the
 *     master key, bound to the kind and the id hash. A consume is one atomic delete: across every instance a challenge
 *     is handed out once. Expired rows are pruned by the session cleanup tick.
 *
 * Both hand back an expired challenge as `expired` (and drop it), so callers keep their distinct "expired" messages.
 */
import { createHash } from "node:crypto";
import type { Store } from "../db/store.js";

export type ChallengeKind = "mfa_login" | "sso_mfa" | "mcp_oauth";

export interface IssueChallengeInput<T> {
  kind: ChallengeKind;
  /** The opaque id the client holds (never stored by the database store; only its hash). */
  id: string;
  /** The user the challenge belongs to, if any. */
  userId: string | null;
  /** What it belongs to, for bulk removal (an MCP OAuth authorization: the registry server id). */
  scope?: string | null;
  payload: T;
  ttlMs: number;
}

export interface ConsumedChallenge<T> {
  payload: T;
  userId: string | null;
  /** The lifetime had passed: the caller refuses it. It is gone either way. */
  expired: boolean;
}

export interface ChallengeStore {
  readonly backend: "memory" | "database";
  issue<T>(input: IssueChallengeInput<T>): Promise<void>;
  /** Takes the challenge out (single use). Null when unknown, already used, or of another kind. */
  consume<T>(kind: ChallengeKind, id: string): Promise<ConsumedChallenge<T> | null>;
  /** Drops the challenges of `kind` under `scope` held for `userId` (null: held for no user). */
  discard(kind: ChallengeKind, filter: { scope: string; userId: string | null }): Promise<void>;
  /** Drops expired challenges. Returns how many (the memory store prunes as it goes and returns 0). */
  prune(): Promise<number>;
}

interface MemoryEntry {
  kind: ChallengeKind;
  userId: string | null;
  scope: string | null;
  payload: unknown;
  expiresAtMs: number;
}

export interface MemoryChallengeStoreOptions {
  /** Most entries kept per kind; issuing one more drops the oldest. Unset: no cap (expired entries still go). */
  maxPerKind?: Partial<Record<ChallengeKind, number>>;
  now?: () => number;
}

/** In this process only: today's maps, one store for every kind. */
export class MemoryChallengeStore implements ChallengeStore {
  readonly backend = "memory" as const;
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly options: MemoryChallengeStoreOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private static key(kind: ChallengeKind, id: string): string {
    return `${kind}\u0000${id}`;
  }

  async issue<T>(input: IssueChallengeInput<T>): Promise<void> {
    const now = this.now();
    // Expired entries of this kind go first, then the oldest while the kind is at its cap.
    for (const [key, entry] of this.entries) {
      if (entry.kind === input.kind && entry.expiresAtMs <= now) this.entries.delete(key);
    }
    const cap = this.options.maxPerKind?.[input.kind];
    if (cap !== undefined) {
      let count = 0;
      for (const entry of this.entries.values()) if (entry.kind === input.kind) count += 1;
      for (const [key, entry] of this.entries) {
        if (count < cap) break;
        if (entry.kind !== input.kind) continue;
        this.entries.delete(key);
        count -= 1;
      }
    }
    this.entries.set(MemoryChallengeStore.key(input.kind, input.id), {
      kind: input.kind,
      userId: input.userId,
      scope: input.scope ?? null,
      payload: input.payload,
      expiresAtMs: now + input.ttlMs
    });
  }

  async consume<T>(kind: ChallengeKind, id: string): Promise<ConsumedChallenge<T> | null> {
    const key = MemoryChallengeStore.key(kind, id);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return { payload: entry.payload as T, userId: entry.userId, expired: entry.expiresAtMs <= this.now() };
  }

  async discard(kind: ChallengeKind, filter: { scope: string; userId: string | null }): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.kind === kind && entry.scope === filter.scope && entry.userId === filter.userId) this.entries.delete(key);
    }
  }

  async prune(): Promise<number> {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test seam: live entries of a kind. */
  size(kind: ChallengeKind): number {
    const now = this.now();
    let count = 0;
    for (const entry of this.entries.values()) if (entry.kind === kind && entry.expiresAtMs > now) count += 1;
    return count;
  }
}

/** Seals and opens a value with the master key, `purpose` bound as authenticated data (SecretService). */
export interface ChallengeSealer {
  sealValue(purpose: string, plaintext: string): string;
  openValue(purpose: string, sealed: string): string;
}

export function challengeIdHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function sealPurpose(kind: ChallengeKind, idHash: string): string {
  return `pending_challenge:${kind}:${idHash}`;
}

/** In the database, for cluster mode: any instance can finish a flow another one started. */
export class DbChallengeStore implements ChallengeStore {
  readonly backend = "database" as const;

  constructor(
    private readonly store: Pick<Store, "createPendingChallenge" | "consumePendingChallenge" | "deletePendingChallenges" | "prunePendingChallenges">,
    private readonly sealer: ChallengeSealer,
    private readonly logger?: { warn: (message: string, fields?: Record<string, unknown>) => void }
  ) {}

  async issue<T>(input: IssueChallengeInput<T>): Promise<void> {
    const idHash = challengeIdHash(input.id);
    await this.store.createPendingChallenge({
      idHash,
      kind: input.kind,
      userId: input.userId,
      scope: input.scope ?? null,
      payloadSealed: this.sealer.sealValue(sealPurpose(input.kind, idHash), JSON.stringify(input.payload)),
      ttlMs: input.ttlMs
    });
  }

  async consume<T>(kind: ChallengeKind, id: string): Promise<ConsumedChallenge<T> | null> {
    if (!id) return null;
    const idHash = challengeIdHash(id);
    const row = await this.store.consumePendingChallenge({ idHash, kind });
    if (!row) return null;
    let payload: T;
    try {
      // The seal binds the kind and the id hash: a row moved under another hash or kind does not open.
      payload = JSON.parse(this.sealer.openValue(sealPurpose(kind, idHash), row.payloadSealed)) as T;
    } catch (error) {
      this.logger?.warn("A pending challenge could not be opened; it is refused", { kind, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    return { payload, userId: row.userId, expired: row.expired };
  }

  async discard(kind: ChallengeKind, filter: { scope: string; userId: string | null }): Promise<void> {
    await this.store.deletePendingChallenges({ kind, scope: filter.scope, userId: filter.userId });
  }

  async prune(): Promise<number> {
    return await this.store.prunePendingChallenges();
  }
}
