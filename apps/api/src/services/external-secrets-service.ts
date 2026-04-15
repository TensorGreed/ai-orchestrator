import { createRequire } from "node:module";
import { nanoid } from "nanoid";
import { SqliteStore } from "../db/database";

const require = createRequire(import.meta.url);

export type ExternalSecretProviderType = "aws-secrets-manager" | "hashicorp-vault" | "google-secret-manager" | "azure-key-vault" | "mock";

export interface ExternalSecretProviderRecord {
  id: string;
  name: string;
  type: ExternalSecretProviderType | string;
  config: Record<string, unknown>;
  credentialsSecretId: string | null;
  cacheTtlMs: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolveArgs {
  provider: ExternalSecretProviderRecord;
  credentials: string | undefined;
  key: string;
}

export interface ProviderAdapter {
  type: string;
  resolve(args: ResolveArgs): Promise<string>;
}

const CONFIGURATION_ERROR = (detail: string): Error => {
  const err = new Error(`External secret provider not configured: ${detail}`);
  (err as Error & { code?: string }).code = "CONFIGURATION_ERROR";
  return err;
};

function optionalRequire<T>(moduleName: string): T | null {
  try {
    return require(moduleName) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AWS Secrets Manager
// ---------------------------------------------------------------------------

interface AwsSecretsManagerModule {
  SecretsManagerClient: new (input: {
    region: string;
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  }) => {
    send(command: unknown): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
  };
  GetSecretValueCommand: new (input: { SecretId: string; VersionStage?: string }) => unknown;
}

const awsAdapter: ProviderAdapter = {
  type: "aws-secrets-manager",
  async resolve({ provider, credentials, key }) {
    const mod = optionalRequire<AwsSecretsManagerModule>("@aws-sdk/client-secrets-manager");
    if (!mod) {
      throw CONFIGURATION_ERROR("install @aws-sdk/client-secrets-manager to use AWS Secrets Manager");
    }
    const region = typeof provider.config.region === "string" ? provider.config.region : "us-east-1";
    let awsCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined;
    if (credentials) {
      try {
        const parsed = JSON.parse(credentials) as {
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
        };
        if (parsed.accessKeyId && parsed.secretAccessKey) {
          awsCredentials = {
            accessKeyId: parsed.accessKeyId,
            secretAccessKey: parsed.secretAccessKey,
            sessionToken: parsed.sessionToken
          };
        }
      } catch {
        // Treat as static accessKeyId:secretAccessKey pair if colon-separated.
        const parts = credentials.split(":");
        if (parts.length >= 2) {
          awsCredentials = { accessKeyId: parts[0], secretAccessKey: parts.slice(1).join(":") };
        }
      }
    }
    const client = new mod.SecretsManagerClient({ region, credentials: awsCredentials });
    const response = await client.send(new mod.GetSecretValueCommand({ SecretId: key }));
    if (typeof response.SecretString === "string") return response.SecretString;
    if (response.SecretBinary) {
      return Buffer.from(response.SecretBinary).toString("utf8");
    }
    throw new Error(`AWS Secrets Manager returned no value for '${key}'`);
  }
};

// ---------------------------------------------------------------------------
// HashiCorp Vault
// ---------------------------------------------------------------------------

const vaultAdapter: ProviderAdapter = {
  type: "hashicorp-vault",
  async resolve({ provider, credentials, key }) {
    const endpoint = typeof provider.config.endpoint === "string" ? provider.config.endpoint : "";
    if (!endpoint) {
      throw CONFIGURATION_ERROR("Vault endpoint URL is required");
    }
    const namespace = typeof provider.config.namespace === "string" ? provider.config.namespace : undefined;
    const kvField = typeof provider.config.field === "string" ? provider.config.field : undefined;
    const token = credentials;
    if (!token) {
      throw CONFIGURATION_ERROR("Vault token is required (attach a credentials secret)");
    }
    const path = key.startsWith("/") ? key : `/v1/${key}`;
    const url = `${endpoint.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = { "X-Vault-Token": token };
    if (namespace) headers["X-Vault-Namespace"] = namespace;

    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`Vault request failed (${response.status})`);
    }
    const body = (await response.json()) as { data?: Record<string, unknown> | { data?: Record<string, unknown> } };
    // KV v2 returns data.data; KV v1 returns data directly.
    const data = body.data && (body.data as { data?: Record<string, unknown> }).data
      ? ((body.data as { data?: Record<string, unknown> }).data as Record<string, unknown>)
      : (body.data as Record<string, unknown> | undefined);
    if (!data) {
      throw new Error(`Vault response did not include data for '${key}'`);
    }
    if (kvField && typeof data[kvField] === "string") {
      return data[kvField] as string;
    }
    if (typeof (data as Record<string, unknown>).value === "string") {
      return (data as Record<string, unknown>).value as string;
    }
    return JSON.stringify(data);
  }
};

// ---------------------------------------------------------------------------
// Google Secret Manager
// ---------------------------------------------------------------------------

interface GoogleSecretManagerModule {
  SecretManagerServiceClient: new (options?: { credentials?: unknown; projectId?: string }) => {
    accessSecretVersion(request: { name: string }): Promise<[{ payload?: { data?: Buffer | Uint8Array | string } }]>;
  };
}

const gcpAdapter: ProviderAdapter = {
  type: "google-secret-manager",
  async resolve({ provider, credentials, key }) {
    const mod = optionalRequire<GoogleSecretManagerModule>("@google-cloud/secret-manager");
    if (!mod) {
      throw CONFIGURATION_ERROR("install @google-cloud/secret-manager to use Google Secret Manager");
    }
    const projectId = typeof provider.config.projectId === "string" ? provider.config.projectId : undefined;
    let parsedCreds: unknown | undefined;
    if (credentials) {
      try {
        parsedCreds = JSON.parse(credentials);
      } catch {
        parsedCreds = undefined;
      }
    }
    const client = new mod.SecretManagerServiceClient({
      credentials: parsedCreds,
      projectId
    });
    const name = key.includes("/")
      ? key
      : `projects/${projectId ?? "-"}/secrets/${key}/versions/latest`;
    const [response] = await client.accessSecretVersion({ name });
    const data = response.payload?.data;
    if (!data) {
      throw new Error(`Google Secret Manager returned no value for '${key}'`);
    }
    if (typeof data === "string") return data;
    return Buffer.from(data as Uint8Array).toString("utf8");
  }
};

// ---------------------------------------------------------------------------
// Azure Key Vault
// ---------------------------------------------------------------------------

interface AzureKeyVaultModule {
  SecretClient: new (vaultUrl: string, credential: unknown) => {
    getSecret(name: string, options?: { version?: string }): Promise<{ value?: string }>;
  };
}

interface AzureIdentityModule {
  ClientSecretCredential: new (tenantId: string, clientId: string, clientSecret: string) => unknown;
  DefaultAzureCredential: new () => unknown;
}

const azureAdapter: ProviderAdapter = {
  type: "azure-key-vault",
  async resolve({ provider, credentials, key }) {
    const kv = optionalRequire<AzureKeyVaultModule>("@azure/keyvault-secrets");
    const identity = optionalRequire<AzureIdentityModule>("@azure/identity");
    if (!kv || !identity) {
      throw CONFIGURATION_ERROR(
        "install @azure/keyvault-secrets and @azure/identity to use Azure Key Vault"
      );
    }
    const vaultUrl = typeof provider.config.vaultUrl === "string" ? provider.config.vaultUrl : "";
    if (!vaultUrl) {
      throw CONFIGURATION_ERROR("vaultUrl is required");
    }
    let credential: unknown;
    if (credentials) {
      try {
        const parsed = JSON.parse(credentials) as {
          tenantId?: string;
          clientId?: string;
          clientSecret?: string;
        };
        if (parsed.tenantId && parsed.clientId && parsed.clientSecret) {
          credential = new identity.ClientSecretCredential(parsed.tenantId, parsed.clientId, parsed.clientSecret);
        }
      } catch {
        // fall through
      }
    }
    if (!credential) {
      credential = new identity.DefaultAzureCredential();
    }
    const [name, version] = key.split("@");
    const client = new kv.SecretClient(vaultUrl, credential);
    const response = await client.getSecret(name, version ? { version } : undefined);
    if (typeof response.value !== "string") {
      throw new Error(`Azure Key Vault returned no value for '${key}'`);
    }
    return response.value;
  }
};

// ---------------------------------------------------------------------------
// Mock adapter — test-only
// ---------------------------------------------------------------------------

const mockValues = new Map<string, Map<string, string>>();

export function setMockSecretValue(providerId: string, key: string, value: string): void {
  let bucket = mockValues.get(providerId);
  if (!bucket) {
    bucket = new Map();
    mockValues.set(providerId, bucket);
  }
  bucket.set(key, value);
}

export function clearMockProvider(providerId: string): void {
  mockValues.delete(providerId);
}

const mockAdapter: ProviderAdapter = {
  type: "mock",
  async resolve({ provider, key }) {
    const bucket = mockValues.get(provider.id);
    if (!bucket || !bucket.has(key)) {
      throw new Error(`mock external secret '${key}' not set for provider ${provider.id}`);
    }
    return bucket.get(key)!;
  }
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const DEFAULT_EXTERNAL_ADAPTERS: ProviderAdapter[] = [
  awsAdapter,
  vaultAdapter,
  gcpAdapter,
  azureAdapter,
  mockAdapter
];

export class ExternalSecretsService {
  private readonly adapters: Map<string, ProviderAdapter> = new Map();

  constructor(
    private readonly store: SqliteStore,
    adapters: ProviderAdapter[] = DEFAULT_EXTERNAL_ADAPTERS
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.type, adapter);
    }
  }

  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  listProviders(): ExternalSecretProviderRecord[] {
    return this.store.listExternalSecretProviders();
  }

  getProvider(id: string): ExternalSecretProviderRecord | null {
    return this.store.getExternalSecretProvider(id);
  }

  supportsType(type: string): boolean {
    return this.adapters.has(type);
  }

  createProvider(input: {
    name: string;
    type: string;
    config?: Record<string, unknown>;
    credentialsSecretId?: string | null;
    cacheTtlMs?: number;
    createdBy?: string | null;
  }): string {
    if (!this.adapters.has(input.type)) {
      throw new Error(
        `Unknown external secret provider type '${input.type}'. Supported: ${Array.from(this.adapters.keys()).join(", ")}`
      );
    }
    const id = `esp_${nanoid(12)}`;
    this.store.upsertExternalSecretProvider({
      id,
      name: input.name,
      type: input.type,
      config: input.config ?? {},
      credentialsSecretId: input.credentialsSecretId ?? null,
      cacheTtlMs: input.cacheTtlMs ?? 300000,
      createdBy: input.createdBy ?? null,
      enabled: true
    });
    return id;
  }

  updateProvider(
    id: string,
    input: {
      name?: string;
      config?: Record<string, unknown>;
      credentialsSecretId?: string | null;
      cacheTtlMs?: number;
      enabled?: boolean;
    }
  ): boolean {
    const existing = this.store.getExternalSecretProvider(id);
    if (!existing) return false;
    this.store.upsertExternalSecretProvider({
      id,
      name: input.name ?? existing.name,
      type: existing.type,
      config: input.config ?? existing.config,
      credentialsSecretId:
        input.credentialsSecretId === undefined ? existing.credentialsSecretId : input.credentialsSecretId,
      cacheTtlMs: input.cacheTtlMs ?? existing.cacheTtlMs,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled,
      createdBy: existing.createdBy
    });
    return true;
  }

  deleteProvider(id: string): { ok: boolean; reason?: string } {
    const using = this.store.countSecretsUsingExternalProvider(id);
    if (using > 0) {
      return { ok: false, reason: `${using} secret(s) still reference this provider` };
    }
    const deleted = this.store.deleteExternalSecretProvider(id);
    return { ok: deleted };
  }

  async resolveExternalSecret(input: {
    provider: ExternalSecretProviderRecord;
    credentials: string | undefined;
    key: string;
  }): Promise<string> {
    const adapter = this.adapters.get(input.provider.type);
    if (!adapter) {
      throw new Error(`No adapter registered for provider type '${input.provider.type}'`);
    }
    return await adapter.resolve({
      provider: input.provider,
      credentials: input.credentials,
      key: input.key
    });
  }
}
