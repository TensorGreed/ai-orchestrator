import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GuardProtectionError } from "../types";
import type { KeyResolver, ProtectionProvider } from "./types";

export const AES_GCM_PROVIDER_ID = "aes_gcm";

export interface AesGcmOptions {
  keys: KeyResolver;
  defaultKeyId?: string;
  random?: (bytes: number) => Buffer;
}

const PREFIX = "enc";
const IV_BYTES = 12;

/**
 * Reversible: AES-256-GCM with a random nonce per value. The token names
 * the key id so rotation works: `enc:<keyId>:<base64url(iv || ciphertext || tag)>`.
 * The data class is bound as additional authenticated data, so a token for
 * one class cannot be revealed as another.
 */
export function createAesGcmProvider(options: AesGcmOptions): ProtectionProvider {
  const random = options.random ?? ((n: number) => randomBytes(n));
  const keyFor = async (keyId: string): Promise<Buffer> => {
    const key = await options.keys(keyId);
    if (!key || key.length !== 32) throw new GuardProtectionError(AES_GCM_PROVIDER_ID, `Key '${keyId}' is missing or not 32 bytes`);
    return Buffer.from(key);
  };
  return {
    id: AES_GCM_PROVIDER_ID,
    description: "AES-256-GCM encryption under an injected key; reversible, not deterministic.",
    deterministic: false,
    reversible: true,
    dataClasses: "*",
    async protect(value, context) {
      const keyId = context.keyId ?? (typeof context.options?.keyId === "string" ? context.options.keyId : undefined) ?? options.defaultKeyId;
      if (!keyId) throw new GuardProtectionError(AES_GCM_PROVIDER_ID, "No key id configured for encryption");
      const key = await keyFor(keyId);
      const iv = random(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context.dataClass, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}:${keyId}:${Buffer.concat([iv, ciphertext, tag]).toString("base64url")}`;
    },
    async reveal(token, context) {
      const parts = token.split(":");
      if (parts.length !== 3 || parts[0] !== PREFIX) throw new GuardProtectionError(AES_GCM_PROVIDER_ID, "Token is not an encrypted value");
      const keyId = parts[1]!;
      const key = await keyFor(keyId);
      const payload = Buffer.from(parts[2]!, "base64url");
      if (payload.length < IV_BYTES + 16) throw new GuardProtectionError(AES_GCM_PROVIDER_ID, "Token is truncated");
      const iv = payload.subarray(0, IV_BYTES);
      const tag = payload.subarray(payload.length - 16);
      const ciphertext = payload.subarray(IV_BYTES, payload.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(context.dataClass, "utf8"));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw new GuardProtectionError(AES_GCM_PROVIDER_ID, `Token could not be revealed with key '${keyId}' (wrong key, wrong data class or tampered token)`);
      }
    }
  };
}
