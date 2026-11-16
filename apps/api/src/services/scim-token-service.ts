/**
 * 13.2 — the bearer tokens a SCIM client (the identity provider's provisioning connector) authenticates with. A token
 * is `scim_<prefix>.<secret>`; only the sha256 of the secret is stored (as for API keys and gateway client tokens),
 * and the token is shown once. A token reaches only /scim/v2: it is not a user and authenticates no other route.
 * Rotation keeps the old token working for a grace window, as API key rotation does.
 */
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { Store } from "../db/store.js";
import type { ScimTokenRecord } from "../db/scim-store.js";
import { hashSecret } from "./api-key-service.js";

export const SCIM_TOKEN_HUMAN_PREFIX = "scim_";
/** `scim_` + 10 characters, a dot, then 43 base64url characters (32 random bytes). */
export const SCIM_TOKEN_FORMAT = /^(scim_[A-Za-z0-9_-]{10})\.([A-Za-z0-9_-]{43})$/;

/** How often a token's last use is written at most (each request would otherwise write a row). */
const LAST_USED_WRITE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface ScimTokenView extends ScimTokenRecord {
  /** Live: not revoked and not expired. */
  active: boolean;
}

export function scimTokenView(record: ScimTokenRecord, now: number = Date.now()): ScimTokenView {
  const expired = record.expiresAt !== null && Date.parse(record.expiresAt) <= now;
  return { ...record, active: record.revokedAt === null && !expired };
}

function newSecret(): { prefix: string; plaintext: string; tokenHash: string } {
  const prefix = `${SCIM_TOKEN_HUMAN_PREFIX}${nanoid(10)}`;
  const secret = crypto.randomBytes(32).toString("base64url");
  return { prefix, plaintext: `${prefix}.${secret}`, tokenHash: hashSecret(secret) };
}

export class ScimTokenService {
  constructor(private readonly store: Store) {}

  async list(): Promise<ScimTokenView[]> {
    const now = Date.now();
    return (await this.store.listScimTokens()).map((record) => scimTokenView(record, now));
  }

  async create(input: { name: string; createdBy: string | null; expiresInDays?: number | null }): Promise<{ plaintext: string; record: ScimTokenView }> {
    const { prefix, plaintext, tokenHash } = newSecret();
    const now = Date.now();
    const record: ScimTokenRecord = {
      id: `sct_${nanoid(16)}`,
      name: input.name,
      tokenPrefix: prefix,
      createdBy: input.createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: input.expiresInDays && input.expiresInDays > 0 ? new Date(now + input.expiresInDays * DAY_MS).toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      supersededBy: null
    };
    await this.store.createScimToken({ ...record, tokenHash });
    return { plaintext, record: scimTokenView(record, now) };
  }

  /**
   * A new token with the same name; the old one keeps working for `graceHours` (0 ends it now). The new token gets
   * the old one's lifetime again, counted from now. Null when the old token is not live or was already rotated.
   */
  async rotate(input: { id: string; graceHours: number; createdBy: string | null }): Promise<{ plaintext: string; record: ScimTokenView; previous: ScimTokenView } | null> {
    const old = (await this.store.listScimTokens()).find((record) => record.id === input.id);
    if (!old) return null;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let expiresAt: string | null = null;
    if (old.expiresAt) {
      const lifetime = Date.parse(old.expiresAt) - Date.parse(old.createdAt);
      if (Number.isFinite(lifetime) && lifetime > 0) expiresAt = new Date(nowMs + lifetime).toISOString();
    }
    const { prefix, plaintext, tokenHash } = newSecret();
    const next = {
      id: `sct_${nanoid(16)}`,
      name: old.name,
      tokenPrefix: prefix,
      tokenHash,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      supersededBy: null
    };
    const rotated = await this.store.rotateScimToken({
      id: old.id,
      next,
      graceUntil: new Date(nowMs + Math.max(0, input.graceHours) * HOUR_MS).toISOString(),
      now
    });
    if (!rotated) return null;
    const tokens = await this.store.listScimTokens();
    const record = tokens.find((entry) => entry.id === next.id);
    const previous = tokens.find((entry) => entry.id === old.id);
    if (!record || !previous) throw new Error("Rotated SCIM token could not be read back");
    return { plaintext, record: scimTokenView(record, nowMs), previous: scimTokenView(previous, nowMs) };
  }

  async revoke(id: string): Promise<boolean> {
    return await this.store.revokeScimToken(id, new Date().toISOString());
  }

  /** The live token a bearer value names, or null. Constant-time hash comparison; anything malformed costs no lookup. */
  async verify(bearer: string): Promise<ScimTokenRecord | null> {
    const match = SCIM_TOKEN_FORMAT.exec(bearer.trim());
    if (!match) return null;
    const stored = await this.store.findScimTokenByPrefix(match[1]!);
    if (!stored) return null;
    const expected = Buffer.from(stored.tokenHash, "hex");
    const actual = Buffer.from(hashSecret(match[2]!), "hex");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const now = Date.now();
    if (stored.revokedAt || (stored.expiresAt && Date.parse(stored.expiresAt) <= now)) return null;
    if (!stored.lastUsedAt || now - Date.parse(stored.lastUsedAt) >= LAST_USED_WRITE_MS) {
      await this.store.touchScimToken(stored.id, new Date(now).toISOString()).catch(() => undefined);
    }
    const { tokenHash: _hash, ...record } = stored;
    return record;
  }
}
