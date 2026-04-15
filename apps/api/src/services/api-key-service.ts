import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { SqliteStore } from "../db/database";

const API_KEY_PREFIX_LENGTH = 10;
const API_KEY_SECRET_LENGTH = 32;
const API_KEY_HUMAN_PREFIX = "ao_";

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApiKeyVerification {
  userId: string;
  keyId: string;
  scopes: string[];
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export class ApiKeyService {
  constructor(
    private readonly store: SqliteStore,
    private readonly defaultExpiryDays: number = 0
  ) {}

  create(input: {
    userId: string;
    name: string;
    scopes?: string[];
    expiresInDays?: number | null;
  }): { record: ApiKeyRecord; plaintext: string } {
    const prefix = `${API_KEY_HUMAN_PREFIX}${nanoid(API_KEY_PREFIX_LENGTH)}`;
    const secret = crypto.randomBytes(API_KEY_SECRET_LENGTH).toString("base64url");
    const plaintext = `${prefix}.${secret}`;
    const keyHash = hashSecret(secret);
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

    this.store.saveApiKey({
      id,
      userId: input.userId,
      name: input.name,
      keyPrefix: prefix,
      keyHash,
      scopes: input.scopes,
      expiresAt
    });

    const saved = this.store.findApiKeyByPrefix(prefix);
    if (!saved) {
      throw new Error("API key could not be persisted");
    }
    return {
      plaintext,
      record: {
        id: saved.id,
        userId: saved.userId,
        name: saved.name,
        keyPrefix: saved.keyPrefix,
        scopes: saved.scopes,
        lastUsedAt: saved.lastUsedAt,
        expiresAt: saved.expiresAt,
        revokedAt: saved.revokedAt,
        createdAt: saved.createdAt
      }
    };
  }

  list(userId?: string): ApiKeyRecord[] {
    return this.store.listApiKeys(userId).map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: row.scopes,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt
    }));
  }

  revoke(id: string, userId?: string): boolean {
    return this.store.revokeApiKey(id, userId);
  }

  verify(rawKey: string): ApiKeyVerification | null {
    if (!rawKey || typeof rawKey !== "string") return null;
    const trimmed = rawKey.trim();
    const separatorIndex = trimmed.indexOf(".");
    if (separatorIndex <= 0) return null;
    const prefix = trimmed.slice(0, separatorIndex);
    const secret = trimmed.slice(separatorIndex + 1);
    if (!prefix.startsWith(API_KEY_HUMAN_PREFIX) || !secret) return null;

    const record = this.store.findApiKeyByPrefix(prefix);
    if (!record) return null;
    if (record.revokedAt) return null;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;

    const expected = Buffer.from(record.keyHash, "hex");
    const candidate = Buffer.from(hashSecret(secret), "hex");
    if (expected.length !== candidate.length) return null;
    if (!crypto.timingSafeEqual(expected, candidate)) return null;

    this.store.touchApiKey(record.id);
    return {
      userId: record.userId,
      keyId: record.id,
      scopes: record.scopes
    };
  }
}
