import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { Store, StoredApiKey } from "../db/store.js";

const API_KEY_PREFIX_LENGTH = 10;
const API_KEY_SECRET_LENGTH = 32;
const API_KEY_HUMAN_PREFIX = "ao_";

export type ApiKeyRecord = StoredApiKey;

/** 13.2 — why a rotation was refused. */
export type ApiKeyRotationRefusal = "not_found" | "inactive" | "already_rotated";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface ApiKeyVerification {
  userId: string;
  keyId: string;
  scopes: string[];
}

/** sha256 hex of a token secret; shared with MCP gateway client credentials (Phase 10.4). */
export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function newKeySecret(): { prefix: string; plaintext: string; keyHash: string } {
  const prefix = `${API_KEY_HUMAN_PREFIX}${nanoid(API_KEY_PREFIX_LENGTH)}`;
  const secret = crypto.randomBytes(API_KEY_SECRET_LENGTH).toString("base64url");
  return { prefix, plaintext: `${prefix}.${secret}`, keyHash: hashSecret(secret) };
}

/** The earliest of an expiry, a hard end (`notAfter`) and a maximum age from now (0 = none); null = never. */
function capExpiry(expiresAt: string | null, notAfter: string | null, maxAgeDays: number, nowMs: number): string | null {
  let result = expiresAt ? Date.parse(expiresAt) : null;
  const caps = [notAfter ? Date.parse(notAfter) : null, maxAgeDays > 0 ? nowMs + maxAgeDays * DAY_MS : null];
  for (const cap of caps) {
    if (cap !== null && Number.isFinite(cap) && (result === null || cap < result)) result = cap;
  }
  return result === null ? null : new Date(result).toISOString();
}

export class ApiKeyService {
  constructor(
    private readonly store: Store,
    private readonly defaultExpiryDays: number = 0
  ) {}

  async create(input: {
    userId: string;
    name: string;
    scopes?: string[];
    expiresInDays?: number | null;
    /** 13.2 — the key never outlives this moment (a key made with another key ends no later than that key). */
    notAfter?: string | null;
    /** 13.2 — SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS for a service account's key: the key expires within this many days. */
    maxAgeDays?: number;
  }): Promise<{ record: ApiKeyRecord; plaintext: string }> {
    const { prefix, plaintext, keyHash } = newKeySecret();
    const id = `apk_${nanoid(16)}`;

    const expiryDays =
      input.expiresInDays !== undefined && input.expiresInDays !== null
        ? input.expiresInDays
        : this.defaultExpiryDays;
    let expiresAt: string | null = null;
    if (expiryDays && expiryDays > 0) {
      const date = new Date();
      date.setDate(date.getDate() + expiryDays);
      expiresAt = date.toISOString();
    }
    expiresAt = capExpiry(expiresAt, input.notAfter ?? null, input.maxAgeDays ?? 0, Date.now());

    await this.store.saveApiKey({
      id,
      userId: input.userId,
      name: input.name,
      keyPrefix: prefix,
      keyHash,
      scopes: input.scopes,
      expiresAt
    });

    const saved = await this.store.findApiKeyByPrefix(prefix);
    if (!saved) {
      throw new Error("API key could not be persisted");
    }
    const { keyHash: _hash, ...record } = saved;
    return { plaintext, record };
  }

  async list(userId?: string): Promise<ApiKeyRecord[]> {
    return await this.store.listApiKeys(userId);
  }

  /** One of the user's keys, or null. */
  async get(id: string, userId: string): Promise<ApiKeyRecord | null> {
    return (await this.store.listApiKeys(userId)).find((key) => key.id === id) ?? null;
  }

  /**
   * 13.2 — rotates the user's key `id`: a new key (returned once) with the same name and scopes, and the old key keeps
   * working for `graceHours` (0 ends it now; never past its own expiry). The new key gets the old key's lifetime again,
   * counted from now (an old key without an expiry gives one without, unless API_KEY_DEFAULT_EXPIRY_DAYS is set), capped
   * by `notAfter` and by `maxAgeDays`, so it never lasts longer than a key its owner could create. Refused for a revoked,
   * expired or already rotated key, and for a key of another user (not_found).
   */
  async rotate(input: {
    id: string;
    userId: string;
    graceHours: number;
    notAfter?: string | null;
    maxAgeDays?: number;
  }): Promise<{ ok: true; plaintext: string; record: ApiKeyRecord; previous: ApiKeyRecord } | { ok: false; reason: ApiKeyRotationRefusal }> {
    const old = await this.get(input.id, input.userId);
    if (!old) return { ok: false, reason: "not_found" };
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let expiresAt: string | null = null;
    if (old.expiresAt) {
      const lifetime = Date.parse(old.expiresAt) - Date.parse(old.createdAt);
      if (Number.isFinite(lifetime) && lifetime > 0) expiresAt = new Date(nowMs + lifetime).toISOString();
    } else if (this.defaultExpiryDays > 0) {
      expiresAt = new Date(nowMs + this.defaultExpiryDays * DAY_MS).toISOString();
    }
    expiresAt = capExpiry(expiresAt, input.notAfter ?? null, input.maxAgeDays ?? 0, nowMs);
    const { prefix, plaintext, keyHash } = newKeySecret();
    const outcome = await this.store.rotateApiKey({
      id: old.id,
      userId: input.userId,
      next: { id: `apk_${nanoid(16)}`, keyPrefix: prefix, keyHash, expiresAt },
      graceUntil: new Date(nowMs + Math.max(0, input.graceHours) * HOUR_MS).toISOString(),
      now
    });
    if (outcome.status !== "rotated") return { ok: false, reason: outcome.status };
    const saved = await this.store.findApiKeyByPrefix(prefix);
    const previous = await this.get(old.id, input.userId);
    if (!saved || !previous) throw new Error("Rotated API key could not be read back");
    const { keyHash: _hash, ...record } = saved;
    return { ok: true, plaintext, record, previous };
  }

  async revoke(id: string, userId?: string): Promise<boolean> {
    return await this.store.revokeApiKey(id, userId);
  }

  async verify(rawKey: string): Promise<ApiKeyVerification | null> {
    const record = await this.match(rawKey);
    if (!record) return null;
    await this.store.touchApiKey(record.id);
    return { userId: record.userId, keyId: record.id, scopes: record.scopes };
  }

  /** True when `rawKey` is a live key. A check only: unlike verify it records no use. */
  async check(rawKey: string): Promise<boolean> {
    return (await this.match(rawKey)) !== null;
  }

  private async match(rawKey: string) {
    if (!rawKey || typeof rawKey !== "string") return null;
    const trimmed = rawKey.trim();
    const separatorIndex = trimmed.indexOf(".");
    if (separatorIndex <= 0) return null;
    const prefix = trimmed.slice(0, separatorIndex);
    const secret = trimmed.slice(separatorIndex + 1);
    if (!prefix.startsWith(API_KEY_HUMAN_PREFIX) || !secret) return null;

    const record = await this.store.findApiKeyByPrefix(prefix);
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;

    const expected = Buffer.from(record.keyHash, "hex");
    const candidate = Buffer.from(hashSecret(secret), "hex");
    if (expected.length !== candidate.length) return null;
    if (!crypto.timingSafeEqual(expected, candidate)) return null;
    return record;
  }
}

/** 13.2 — the HTTP answer for a refused rotation (404 for an unknown key, 409 otherwise, with a code the studio reads). */
export function apiKeyRotationRefusal(reason: ApiKeyRotationRefusal): { status: number; body: { error: string; code?: string } } {
  if (reason === "not_found") return { status: 404, body: { error: "API key not found" } };
  if (reason === "already_rotated") {
    return { status: 409, body: { error: "This key was already rotated; rotate its replacement instead", code: "already_rotated" } };
  }
  return { status: 409, body: { error: "A revoked or expired key cannot be rotated; create a new one", code: "inactive" } };
}
