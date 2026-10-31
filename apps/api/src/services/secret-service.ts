import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { SecretReference } from "@ai-orchestrator/shared";
import type { ExternalSecretsService } from "./external-secrets-service";
import type { Store } from "../db/store.js";

interface EncryptedSecret {
  iv: string;
  authTag: string;
  ciphertext: string;
}

/**
 * Phase 10.5 — secrets L2M manages for itself (MCP OAuth tokens and client
 * registrations; Phase 11.1 — the generated audit signing key). They are never handed to node configs: `resolveSecret`
 * refuses them, the secrets list hides them and the generic delete route
 * leaves them alone. Only `resolveInternalSecret` reads them.
 */
export const INTERNAL_SECRET_PROVIDERS: ReadonlySet<string> = new Set(["mcp_oauth", "mcp_oauth_user", "audit_signing"]);

export function isInternalSecretProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && INTERNAL_SECRET_PROVIDERS.has(provider);
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

  constructor(private readonly store: Store, rawKey?: string) {
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

  /**
   * Phase 12.1 — seals a value for storage outside the secrets table (the
   * guard token vault) with the master key. `purpose` is bound as
   * authenticated data, so a sealed value only opens for the same purpose
   * and cannot be swapped with a stored secret.
   */
  sealValue(purpose: string, plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`l2m:${purpose}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }

  openValue(purpose: string, sealed: string): string {
    const [format, iv, authTag, ciphertext] = sealed.split(".");
    if (format !== "v1" || !iv || !authTag || ciphertext === undefined) {
      throw new Error("Sealed value has an unknown format");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`l2m:${purpose}`, "utf8"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  async createSecret(input: {
    name: string;
    provider: string;
    value: string;
    projectId?: string;
  }): Promise<SecretReference> {
    const id = `sec_${nanoid(12)}`;
    const encrypted = this.encrypt(input.value);

    await this.store.saveSecret({
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
  async createExternalSecret(input: {
    name: string;
    provider: string;
    externalProviderId: string;
    externalKey: string;
    projectId?: string;
  }): Promise<SecretReference> {
    const id = `sec_${nanoid(12)}`;
    // Placeholder ciphertext — never actually returned. Real value is fetched + cached lazily.
    const encrypted = this.encrypt("__external__");
    await this.store.saveSecret({
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

  async deleteSecret(id: string): Promise<boolean> {
    return await this.store.deleteSecret(id);
  }

  async resolveSecret(secretRef?: SecretReference): Promise<string | undefined> {
    if (!secretRef?.secretId) {
      return undefined;
    }

    const row = await this.store.getSecret(secretRef.secretId);
    if (!row) {
      return undefined;
    }
    if (isInternalSecretProvider(row.provider)) {
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

    const provider = await this.externalSecrets.getProvider(row.externalProviderId);
    if (!provider) {
      throw new Error(`External provider '${row.externalProviderId}' not found`);
    }
    if (!provider.enabled) {
      throw new Error(`External provider '${provider.name}' is disabled`);
    }

    // Cache hit within TTL
    const cached = await this.store.getExternalSecretCacheEntry(row.id);
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
      const credRow = await this.store.getSecret(provider.credentialsSecretId);
      // Secrets L2M manages for itself (OAuth tokens, the audit signing key) never leave as provider credentials.
      if (credRow && credRow.source !== "external" && !isInternalSecretProvider(credRow.provider)) {
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
    await this.store.upsertExternalSecretCacheEntry({
      secretId: row.id,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      expiresAt
    });
    return value;
  }

  /** Phase 10.5 — read a secret L2M manages itself (see INTERNAL_SECRET_PROVIDERS). */
  async resolveInternalSecret(secretId: string): Promise<string | undefined> {
    const row = await this.store.getSecret(secretId);
    if (!row || !isInternalSecretProvider(row.provider) || row.source === "external") {
      return undefined;
    }
    return this.decrypt({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext });
  }

  /** Phase 10.5 — replace the value of an internal secret in place (token rotation). */
  async updateInternalSecret(secretId: string, value: string): Promise<boolean> {
    const row = await this.store.getSecret(secretId);
    if (!row || !isInternalSecretProvider(row.provider)) {
      return false;
    }
    await this.store.saveSecret({
      id: row.id,
      name: row.name,
      provider: row.provider,
      projectId: row.projectId,
      source: "local",
      ...this.encrypt(value)
    });
    return true;
  }

  /**
   * Phase 11.1 — every secret value held on this deployment, for scrubbing
   * audit bundles: local secrets of every project (a node can reference any
   * secret id), L2M's own internal secrets (MCP OAuth tokens, the signing
   * seed) and the locally cached values of external secrets. Nothing is
   * fetched from an external store. For a value that is a JSON document
   * (OAuth token sets, service-account keys, MCP secret bundles) the
   * credential-like fields are added too, with and without an auth scheme.
   * Callers hold these in memory only; never log or return them.
   */
  async valuesForScrubbing(): Promise<string[]> {
    const values = new Set<string>();
    for (const listed of await this.store.listSecrets()) {
      const row = await this.store.getSecret(listed.id);
      if (!row) continue;
      try {
        if (row.source === "external") {
          const cached = await this.store.getExternalSecretCacheEntry(row.id);
          if (cached) addScrubValue(values, this.decrypt({ iv: cached.iv, authTag: cached.authTag, ciphertext: cached.ciphertext }));
        } else {
          addScrubValue(values, this.decrypt({ iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }));
        }
      } catch {
        // A value that cannot be decrypted cannot have reached a run either.
      }
    }
    return [...values];
  }

  async invalidateExternalCache(secretId: string): Promise<void> {
    await this.store.deleteExternalSecretCacheEntry(secretId);
  }

  async listSecrets(options: { projectId?: string } = {}) {
    return (await this.store.listSecrets({ projectId: options.projectId })).filter((row) => !isInternalSecretProvider(row.provider)).map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      createdAt: row.created_at,
      projectId: row.projectId,
      source: row.source,
      externalProviderId: row.externalProviderId,
      externalKey: row.externalKey,
      sensitiveOutput: row.sensitiveOutput
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

const CREDENTIAL_FIELD = /(token|secret|password|passwd|key|credential|authorization|auth|cookie)/i;
/** Fields next to credentials that describe them rather than hold them (token_type, auth_uri, expires_at). */
const DESCRIPTIVE_FIELD = /(type|uri|url|endpoint|expires?(_at|_in)?|scope|issuer|method|name|id)$/i;

/** A secret value, plus its credential-like fields when it is a JSON document. */
function addScrubValue(into: Set<string>, value: string): void {
  if (!value || value === "__external__") return;
  into.add(value);
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  const visit = (node: unknown, key: string, depth: number): void => {
    if (depth > 8) return;
    if (typeof node === "string") {
      if (!CREDENTIAL_FIELD.test(key) || DESCRIPTIVE_FIELD.test(key) || /^(bearer|basic|token)$/i.test(node.trim())) return;
      into.add(node);
      // "Bearer <token>" / "Basic <credentials>": the credential can appear without its scheme.
      const scheme = /^(bearer|basic|token)\s+(\S.*)$/i.exec(node);
      if (scheme) into.add(scheme[2]!);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, key, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [innerKey, inner] of Object.entries(node as Record<string, unknown>)) visit(inner, innerKey, depth + 1);
    }
  };
  visit(parsed, "", 0);
}
