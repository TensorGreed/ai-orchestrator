import { createHmac } from "node:crypto";
import { GuardProtectionError } from "../types";
import type { KeyResolver, ProtectionProvider } from "./types";

export const KEYED_HASH_PROVIDER_ID = "keyed_hash";

export interface KeyedHashOptions {
  keys: KeyResolver;
  defaultKeyId?: string;
  /** Token prefix; the data class is appended so tokens stay readable in logs. */
  prefix?: string;
  /** Hex characters kept (default 24, which is 96 bits). */
  length?: number;
}

/** Irreversible pseudonyms: HMAC-SHA-256 of the value under a key, so equal values map to equal tokens without being recoverable. */
export function createKeyedHashProvider(options: KeyedHashOptions): ProtectionProvider {
  const length = Math.max(16, Math.min(64, options.length ?? 24));
  return {
    id: KEYED_HASH_PROVIDER_ID,
    description: "HMAC-SHA-256 pseudonym under an injected key; deterministic and irreversible.",
    deterministic: true,
    reversible: false,
    dataClasses: "*",
    async protect(value, context) {
      const keyId = context.keyId ?? (typeof context.options?.keyId === "string" ? context.options.keyId : undefined) ?? options.defaultKeyId;
      if (!keyId) throw new GuardProtectionError(KEYED_HASH_PROVIDER_ID, "No key id configured for keyed hashing");
      const key = await options.keys(keyId);
      if (!key || key.length < 16) throw new GuardProtectionError(KEYED_HASH_PROVIDER_ID, `Key '${keyId}' is missing or shorter than 16 bytes`);
      const digest = createHmac("sha256", key).update(`${context.dataClass}\u0000${value}`).digest("hex").slice(0, length);
      return `${options.prefix ?? "ph"}_${context.dataClass}_${digest}`;
    }
  };
}
