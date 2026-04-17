import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { SecretReference } from "@ai-orchestrator/shared";
import { SqliteStore } from "../db/database";
import type { ExternalSecretsService } from "./external-secrets-service";

interface EncryptedSecret {
  iv: string;
  authTag: string;
  ciphertext: string;
}

function parseMasterKey(rawKey?: string): Buffer {
  if (!rawKey) {
    throw new Error("SECRET_MASTER_KEY_BASE64 environment variable is required");
  }

  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error("SECRET_MASTER_KEY_BASE64 must decode to 32 bytes");
  }

  return key;
}

export class SecretService {
  private readonly key: Buffer;
  private externalSecrets: ExternalSecretsService | null = null;

  constructor(private readonly store: SqliteStore, rawKey?: string) {
    this.key = parseMasterKey(rawKey);
  }

  attachExternalSecrets(service: ExternalSecretsService): void {
    this.externalSecrets = service;
  }

  private encrypt(plaintext: string): EncryptedSecret {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: encrypted.toString("base64")
    };
  }

  private decrypt(secret: EncryptedSecret): string {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(secret.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64")),
      decipher.final()
    ]);

    return decrypted.toString("utf8");
  }

  createSecret(input: {
    name: string;
    provider: string;
    value: string;
    projectId?: string;
  }): SecretReference {
    const id = `sec_${nanoid(12)}`;
    const encrypted = this.encrypt(input.value);

    this.store.saveSecret({
      id,
      name: input.name,
      provider: input.provider,
      projectId: input.projectId,
      source: "local",
      ...encrypted
    });

    return { secretId: id };
  }

  /**
   * Create a secret that references a value stored in an external provider
   * (AWS Secrets Manager, Vault, GCP, Azure). The stored ciphertext is a
   * placeholder; the real value is resolved on demand and cached.
   */
  createExternalSecret(input: {
    name: string;
    provider: string;
    externalProviderId: string;
    externalKey: string;
    projectId?: string;
  }): SecretReference {
    const id = `sec_${nanoid(12)}`;
    // Placeholder ciphertext — never actually returned. Real value is fetched + cached lazily.
    const encrypted = this.encrypt("__external__");
    this.store.saveSecret({
      id,
      name: input.name,
      provider: input.provider,
      projectId: input.projectId,
      source: "external",
      externalProviderId: input.externalProviderId,
      externalKey: input.externalKey,
      ...encrypted
    });
    return { secretId: id };
  }

  deleteSecret(id: string): boolean {
    return this.store.deleteSecret(id);
  }

  async resolveSecret(secretRef?: SecretReference): Promise<string | undefined> {
    if (!secretRef?.secretId) {
      return undefined;
    }

    const row = this.store.getSecret(secretRef.secretId);
    if (!row) {
      return undefined;
    }

    if (row.source === "external") {
      return await this.resolveExternal(row);
    }

    return this.decrypt({
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext
    });
  }

  private async resolveExternal(row: {
    id: string;
    name: string;
    externalProviderId: string | null;
    externalKey: string | null;
  }): Promise<string | undefined> {
    if (!this.externalSecrets) {
      throw new Error("External secrets service is not initialised");
    }
    if (!row.externalProviderId || !row.externalKey) {
      throw new Error(`External secret '${row.id}' is missing provider or key`);
    }

    const provider = this.externalSecrets.getProvider(row.externalProviderId);
    if (!provider) {
      throw new Error(`External provider '${row.externalProviderId}' not found`);
    }
    if (!provider.enabled) {
      throw new Error(`External provider '${provider.name}' is disabled`);
    }

    // Cache hit within TTL
    const cached = this.store.getExternalSecretCacheEntry(row.id);
    const now = Date.now();
    if (cached && new Date(cached.expiresAt).getTime() > now) {
      return this.decrypt({
        iv: cached.iv,
        authTag: cached.authTag,
        ciphertext: cached.ciphertext
      });
    }

    // Fetch the provider's auth credentials via the local SecretService (recursive but bounded).
    let credentialValue: string | undefined;
    if (provider.credentialsSecretId) {
      const credRow = this.store.getSecret(provider.credentialsSecretId);
      if (credRow && credRow.source !== "external") {
        credentialValue = this.decrypt({
          iv: credRow.iv,
          authTag: credRow.auth_tag,
          ciphertext: credRow.ciphertext
        });
      }
    }

    const value = await this.externalSecrets.resolveExternalSecret({
      provider,
      credentials: credentialValue,
      key: row.externalKey
    });

    const encrypted = this.encrypt(value);
    const expiresAt = new Date(now + provider.cacheTtlMs).toISOString();
    this.store.upsertExternalSecretCacheEntry({
      secretId: row.id,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      expiresAt
    });
    return value;
  }

  invalidateExternalCache(secretId: string): void {
    this.store.deleteExternalSecretCacheEntry(secretId);
  }

  listSecrets(options: { projectId?: string } = {}) {
    return this.store.listSecrets({ projectId: options.projectId }).map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      createdAt: row.created_at,
      projectId: row.projectId,
      source: row.source,
      externalProviderId: row.externalProviderId,
      externalKey: row.externalKey
    }));
  }

  redact(value: unknown): unknown {
    if (typeof value === "string") {
      if (
        /sk-[a-zA-Z0-9]{20,}/.test(value) ||
        /^(AIza|ya29\.|AKIA|ghp_|gho_|github_pat_|xox[bpas]-|glpat-|sk-ant-)[a-zA-Z0-9_-]{10,}/.test(value) ||
        /^[a-zA-Z0-9+/=_-]{40,}$/.test(value)
      ) {
        return "[REDACTED]";
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.redact(entry));
    }

    if (value && typeof value === "object") {
      const copy: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        if (key.toLowerCase().includes("secret") || key.toLowerCase().includes("key") || key.toLowerCase().includes("token")) {
          copy[key] = "[REDACTED]";
        } else {
          copy[key] = this.redact(nested);
        }
      }
      return copy;
    }

    return value;
  }
}
