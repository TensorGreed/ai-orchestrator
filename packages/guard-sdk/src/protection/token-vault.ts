import { createHmac, randomBytes, randomInt } from "node:crypto";
import { luhnCheckDigit } from "../detectors/dlp";
import type { GuardDataClass } from "../types";
import { GuardProtectionError } from "../types";
import type { KeyResolver, ProtectionProvider } from "./types";

export const TOKEN_VAULT_PROVIDER_ID = "token_vault";

export interface TokenVaultRecord {
  token: string;
  dataClass: GuardDataClass;
  /** The original value. The storage implementation is responsible for protecting it at rest. */
  value: string;
  /** HMAC of the value for deterministic lookups; absent for random tokens. */
  valueHash?: string;
  createdAt: string;
}

/** Storage behind the vault. The wiring layer supplies a database-backed implementation. */
export interface TokenVaultStorage {
  getByToken(token: string): Promise<TokenVaultRecord | undefined>;
  getByValueHash(valueHash: string): Promise<TokenVaultRecord | undefined>;
  put(record: TokenVaultRecord): Promise<void>;
}

export class InMemoryTokenVaultStorage implements TokenVaultStorage {
  private readonly byToken = new Map<string, TokenVaultRecord>();
  private readonly byHash = new Map<string, TokenVaultRecord>();

  async getByToken(token: string): Promise<TokenVaultRecord | undefined> {
    return this.byToken.get(token);
  }

  async getByValueHash(valueHash: string): Promise<TokenVaultRecord | undefined> {
    return this.byHash.get(valueHash);
  }

  async put(record: TokenVaultRecord): Promise<void> {
    this.byToken.set(record.token, record);
    if (record.valueHash) this.byHash.set(record.valueHash, record);
  }

  get size(): number {
    return this.byToken.size;
  }
}

export interface TokenVaultOptions {
  storage: TokenVaultStorage;
  /** Needed for deterministic tokens (the lookup hash is keyed). */
  keys?: KeyResolver;
  defaultKeyId?: string;
  /** Same value, same token. Default false (random). */
  deterministic?: boolean;
  /** Keep the shape of digit-bearing values (card numbers stay Luhn-valid, separators stay). Default false. */
  formatPreserving?: boolean;
  prefix?: string;
  random?: (bytes: number) => Buffer;
  randomDigit?: () => number;
  now?: () => Date;
}

const DIGIT_CLASSES = new Set<GuardDataClass>(["card_number", "phone", "us_ssn", "national_id", "iban"]);

/** Random digits in the same positions, keeping separators. Card numbers keep their first digit range and a valid Luhn check digit. */
export function formatPreservingToken(value: string, dataClass: GuardDataClass, randomDigit: () => number): string {
  const chars = Array.from(value);
  const digitPositions = chars.map((c, i) => (/\d/.test(c) ? i : -1)).filter((i) => i >= 0);
  if (digitPositions.length === 0) return value;
  const digits = digitPositions.map(() => String(randomDigit()));
  if (dataClass === "card_number" && digits.length >= 13) {
    // Keep the leading digit so the token still looks like the same network, then fix the checksum.
    digits[0] = chars[digitPositions[0]!]!;
    const body = digits.slice(0, -1).join("");
    digits[digits.length - 1] = luhnCheckDigit(body);
  }
  const out = [...chars];
  digitPositions.forEach((position, index) => {
    out[position] = digits[index]!;
  });
  return out.join("");
}

/**
 * Reversible tokens stored in an injected vault. Random tokens are
 * `tok_<class>_<base64url>`; deterministic tokens are looked up by a keyed
 * hash of the value so equal values share a token; format-preserving tokens
 * keep the shape of digits (and Luhn validity for cards) so downstream
 * validation keeps passing.
 */
export function createTokenVaultProvider(options: TokenVaultOptions): ProtectionProvider {
  const random = options.random ?? ((n: number) => randomBytes(n));
  const randomDigit = options.randomDigit ?? (() => randomInt(0, 10));
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? "tok";
  const hashValue = async (value: string, dataClass: GuardDataClass, keyId: string | undefined): Promise<string> => {
    if (!options.keys || !keyId) throw new GuardProtectionError(TOKEN_VAULT_PROVIDER_ID, "Deterministic tokens need a key resolver and key id");
    const key = await options.keys(keyId);
    if (!key || key.length < 16) throw new GuardProtectionError(TOKEN_VAULT_PROVIDER_ID, `Key '${keyId}' is missing or shorter than 16 bytes`);
    return createHmac("sha256", key).update(`${dataClass}\u0000${value}`).digest("hex");
  };
  return {
    id: TOKEN_VAULT_PROVIDER_ID,
    description: "Reversible tokens kept in an injected vault; random or deterministic, optionally format-preserving.",
    deterministic: options.deterministic === true,
    reversible: true,
    dataClasses: "*",
    async protect(value, context) {
      const deterministic = typeof context.options?.deterministic === "boolean" ? context.options.deterministic : options.deterministic === true;
      const formatPreserving = typeof context.options?.formatPreserving === "boolean" ? context.options.formatPreserving : options.formatPreserving === true;
      const keyId = context.keyId ?? (typeof context.options?.keyId === "string" ? context.options.keyId : undefined) ?? options.defaultKeyId;
      let valueHash: string | undefined;
      if (deterministic) {
        valueHash = await hashValue(value, context.dataClass, keyId);
        const existing = await options.storage.getByValueHash(valueHash);
        if (existing) return existing.token;
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const token =
          formatPreserving && DIGIT_CLASSES.has(context.dataClass)
            ? formatPreservingToken(value, context.dataClass, randomDigit)
            : `${prefix}_${context.dataClass}_${random(12).toString("base64url")}`;
        if (token === value) continue;
        if (await options.storage.getByToken(token)) continue;
        await options.storage.put({ token, dataClass: context.dataClass, value, valueHash, createdAt: now().toISOString() });
        return token;
      }
      throw new GuardProtectionError(TOKEN_VAULT_PROVIDER_ID, "Could not allocate a unique token");
    },
    async reveal(token, context) {
      const record = await options.storage.getByToken(token);
      if (!record) throw new GuardProtectionError(TOKEN_VAULT_PROVIDER_ID, "Token is not in the vault");
      if (record.dataClass !== context.dataClass) throw new GuardProtectionError(TOKEN_VAULT_PROVIDER_ID, "Token belongs to another data class");
      return record.value;
    }
  };
}
