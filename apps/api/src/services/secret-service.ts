import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { SecretReference } from "@ai-orchestrator/shared";
import { SqliteStore } from "../db/database";

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

  constructor(private readonly store: SqliteStore, rawKey?: string) {
    this.key = parseMasterKey(rawKey);
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
      ...encrypted
    });

    return { secretId: id };
  }

  async resolveSecret(secretRef?: SecretReference): Promise<string | undefined> {
    if (!secretRef?.secretId) {
      return undefined;
    }

    const row = this.store.getSecret(secretRef.secretId);
    if (!row) {
      return undefined;
    }

    return this.decrypt({
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext
    });
  }

  listSecrets(options: { projectId?: string } = {}) {
    return this.store.listSecrets({ projectId: options.projectId }).map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      createdAt: row.created_at,
      projectId: row.projectId
    }));
  }

  redact(value: unknown): unknown {
    if (typeof value === "string") {
      if (/sk-[a-zA-Z0-9]/.test(value) || value.length > 20) {
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