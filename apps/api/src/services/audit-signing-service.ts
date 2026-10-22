/**
 * Phase 11.1 — the deployment's Ed25519 signing key for run manifests and
 * audit bundles.
 *
 *   - `AUDIT_SIGNING_KEY_BASE64` (base64 of a 32-byte seed) is used when set.
 *     Changing it rotates the key: the previous key is retired, its public
 *     key stays listed.
 *   - Otherwise a key is generated on first use, its seed stored encrypted
 *     through SecretService as an internal secret (hidden from the secrets
 *     API and refused to node configs), and only its key id is logged.
 *     Admins rotate it from the API; the retired key's private half is
 *     deleted, its public key kept so bundles it signed still verify.
 *
 * Key id = the first 16 hex characters of SHA-256(raw 32-byte public key).
 * Private key material never leaves this module: callers get signatures,
 * key ids and public keys.
 */

import crypto, { type KeyObject } from "node:crypto";
import {
  AUDIT_KEY_ID_HEX_CHARS,
  AUDIT_SIGNING_ALGORITHM,
  type AuditSigningKeysResponse,
  type AuditSigningKeyView
} from "@ai-orchestrator/shared";
import type { AuditSigningKeyRecord, SqliteStore } from "../db/database.js";
import type { SecretService } from "./secret-service.js";

/** SecretService provider of the generated signing key (an internal secret). */
export const AUDIT_SIGNING_SECRET_PROVIDER = "audit_signing";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class AuditSigningKeyError extends Error {
  constructor(
    message: string,
    readonly code: "env_managed" | "unreadable"
  ) {
    super(message);
    this.name = "AuditSigningKeyError";
  }
}

interface LoadedKey {
  keyId: string;
  privateKey: KeyObject;
  publicKeyRaw: Buffer;
}

export interface AuditSignature {
  keyId: string;
  /** Base64 of the raw 32-byte public key. */
  publicKey: string;
  /** Base64 Ed25519 signature. */
  signature: string;
}

export function auditKeyIdFor(publicKeyRaw: Uint8Array): string {
  return crypto.createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, AUDIT_KEY_ID_HEX_CHARS);
}

export function ed25519PublicKeyFromRaw(publicKeyRaw: Uint8Array): KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyRaw)]), format: "der", type: "spki" });
}

export function ed25519PublicKeyPem(publicKeyRaw: Uint8Array): string {
  return ed25519PublicKeyFromRaw(publicKeyRaw).export({ format: "pem", type: "spki" }).toString();
}

function keyFromSeed(seed: Buffer): LoadedKey {
  if (seed.length !== 32) throw new Error("An Ed25519 seed is 32 bytes");
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKeyRaw = Buffer.from(spki.subarray(spki.length - 32));
  return { keyId: auditKeyIdFor(publicKeyRaw), privateKey, publicKeyRaw };
}

export interface AuditSigningServiceOptions {
  /** AUDIT_SIGNING_KEY_BASE64, already validated as base64 of 32 bytes. */
  envKeyBase64?: string;
  logger?: { info: (message: string, fields?: Record<string, unknown>) => void; warn: (message: string, fields?: Record<string, unknown>) => void };
}

export class AuditSigningService {
  private loaded: LoadedKey | null = null;
  private readonly envKey: LoadedKey | null;

  constructor(
    private readonly store: SqliteStore,
    private readonly secrets: SecretService,
    private readonly options: AuditSigningServiceOptions = {}
  ) {
    this.envKey = options.envKeyBase64 ? keyFromSeed(Buffer.from(options.envKeyBase64, "base64")) : null;
  }

  /** True when the key comes from AUDIT_SIGNING_KEY_BASE64 and cannot be rotated from the API. */
  get envManaged(): boolean {
    return this.envKey !== null;
  }

  /** The key that signs now, created or switched to on first use. */
  activeKeyId(): string {
    return this.ensureActive().keyId;
  }

  /** Key id and base64 raw public key of the key that signs now. */
  activePublicKey(): { keyId: string; publicKey: string } {
    const key = this.ensureActive();
    return { keyId: key.keyId, publicKey: key.publicKeyRaw.toString("base64") };
  }

  sign(bytes: Uint8Array): AuditSignature {
    const key = this.ensureActive();
    return {
      keyId: key.keyId,
      publicKey: key.publicKeyRaw.toString("base64"),
      signature: crypto.sign(null, Buffer.from(bytes), key.privateKey).toString("base64")
    };
  }

  /** Verifies against any key this deployment has used (active or retired). */
  verify(keyId: string, bytes: Uint8Array, signatureBase64: string): boolean {
    const record = this.store.getAuditSigningKey(keyId);
    if (!record) return false;
    try {
      return crypto.verify(null, Buffer.from(bytes), ed25519PublicKeyFromRaw(Buffer.from(record.publicKey, "base64")), Buffer.from(signatureBase64, "base64"));
    } catch {
      return false;
    }
  }

  list(): AuditSigningKeysResponse {
    const activeKeyId = this.activeKeyId();
    return {
      activeKeyId,
      canRotate: !this.envManaged,
      keys: this.store.listAuditSigningKeys().map((record) => this.view(record))
    };
  }

  /** Generates a new key and retires the current one. Refused when the key comes from the environment. */
  rotate(): AuditSigningKeyView {
    if (this.envManaged) {
      throw new AuditSigningKeyError("The signing key comes from AUDIT_SIGNING_KEY_BASE64; rotate it by setting a new value and restarting", "env_managed");
    }
    // No ensureActive(): a key that can no longer be decrypted must still be replaceable.
    const key = this.generate();
    const record = this.store.getAuditSigningKey(key.keyId);
    return this.view(record!);
  }

  private view(record: AuditSigningKeyRecord): AuditSigningKeyView {
    const raw = Buffer.from(record.publicKey, "base64");
    return {
      keyId: record.keyId,
      algorithm: AUDIT_SIGNING_ALGORITHM,
      publicKey: record.publicKey,
      publicKeyPem: ed25519PublicKeyPem(raw),
      source: record.source,
      status: record.status,
      createdAt: record.createdAt,
      retiredAt: record.retiredAt
    };
  }

  private ensureActive(): LoadedKey {
    const active = this.store.getActiveAuditSigningKey();
    if (this.loaded && active?.keyId === this.loaded.keyId) return this.loaded;

    if (this.envKey) {
      if (active?.keyId !== this.envKey.keyId) this.activate(this.envKey, "env", null, active);
      this.loaded = this.envKey;
      return this.envKey;
    }

    if (active && active.source === "generated" && active.secretId) {
      let seed: string | undefined;
      try {
        seed = this.secrets.resolveInternalSecret(active.secretId);
      } catch {
        seed = undefined;
      }
      if (!seed) {
        throw new AuditSigningKeyError(
          `The audit signing key ${active.keyId} cannot be read (was SECRET_MASTER_KEY_BASE64 changed?). An admin can rotate to a new key.`,
          "unreadable"
        );
      }
      const key = keyFromSeed(Buffer.from(seed, "base64"));
      if (key.keyId !== active.keyId) {
        throw new AuditSigningKeyError(`The stored audit signing key does not match key id ${active.keyId}`, "unreadable");
      }
      this.loaded = key;
      return key;
    }

    // No key yet, or the active key came from an environment variable that is no longer set.
    return this.generate();
  }

  private generate(): LoadedKey {
    const current = this.store.getActiveAuditSigningKey();
    const key = keyFromSeed(crypto.randomBytes(32));
    const secretRef = this.secrets.createSecret({
      name: `Audit signing key ${key.keyId}`,
      provider: AUDIT_SIGNING_SECRET_PROVIDER,
      value: key.privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_ED25519_PREFIX.length).toString("base64")
    });
    if (!this.activate(key, "generated", secretRef.secretId, current)) {
      // Another instance activated a key first; use that one.
      this.secrets.deleteSecret(secretRef.secretId);
      this.loaded = null;
      return this.ensureActive();
    }
    this.options.logger?.info("Generated a new audit signing key", { keyId: key.keyId });
    this.loaded = key;
    return key;
  }

  /** Activates `key`, retiring `current`; deletes the retired key's private half. */
  private activate(key: LoadedKey, source: "env" | "generated", secretId: string | null, current: AuditSigningKeyRecord | null): boolean {
    const ok = this.store.activateAuditSigningKey(
      {
        keyId: key.keyId,
        algorithm: AUDIT_SIGNING_ALGORITHM,
        publicKey: key.publicKeyRaw.toString("base64"),
        source,
        secretId,
        createdAt: new Date().toISOString()
      },
      current?.keyId ?? null
    );
    if (!ok) return false;
    if (current && current.keyId !== key.keyId) {
      if (current.secretId) this.secrets.deleteSecret(current.secretId);
      this.options.logger?.info("Retired audit signing key", { keyId: current.keyId, activeKeyId: key.keyId });
    }
    if (source === "env") this.options.logger?.info("Using the audit signing key from AUDIT_SIGNING_KEY_BASE64", { keyId: key.keyId });
    return true;
  }
}
