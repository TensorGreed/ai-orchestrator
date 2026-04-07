import { createHmac } from "node:crypto";
import type { ConnectorAdapter, ConnectorExecutionContext } from "../types";

type AzureStorageCredential =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "sas"; sasToken: string }
  | { mode: "shared_key"; accountName: string; accountKeyBase64: string; endpoint?: string };

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUrlWithoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseConnectionString(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of input.split(";")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = (rawKey ?? "").trim();
    const value = rawValue.join("=").trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function toEndpointFromAccount(accountName: string): string {
  return `https://${accountName}.blob.core.windows.net`;
}

function normalizeSasToken(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
}

function parseStorageCredential(secretValue: string, config: Record<string, unknown>): AzureStorageCredential {
  const trimmedSecret = secretValue.trim();
  const configAccountName = toStringValue(config.accountName);
  const configEndpoint = toStringValue(config.endpoint);

  if (!trimmedSecret) {
    return { mode: "none" };
  }

  const lower = trimmedSecret.toLowerCase();
  if (lower.startsWith("?") || lower.includes("sig=")) {
    return { mode: "sas", sasToken: normalizeSasToken(trimmedSecret) };
  }

  if (trimmedSecret.includes("accountname=") && trimmedSecret.includes("accountkey=")) {
    const parts = parseConnectionString(trimmedSecret);
    const accountName = parts.AccountName ?? configAccountName;
    const accountKeyBase64 = parts.AccountKey ?? "";
    const blobEndpoint = parts.BlobEndpoint ?? parts.EndpointSuffix ? `https://${accountName}.blob.${parts.EndpointSuffix}` : "";
    if (accountName && accountKeyBase64) {
      return {
        mode: "shared_key",
        accountName,
        accountKeyBase64,
        endpoint: blobEndpoint || configEndpoint || toEndpointFromAccount(accountName)
      };
    }
    const sharedAccessSignature = parts.SharedAccessSignature ?? "";
    if (sharedAccessSignature) {
      return {
        mode: "sas",
        sasToken: normalizeSasToken(sharedAccessSignature)
      };
    }
  }

  try {
    const parsed = JSON.parse(trimmedSecret) as Record<string, unknown>;
    const tokenCandidate = toStringValue(parsed.accessToken ?? parsed.access_token ?? parsed.token ?? parsed.bearerToken);
    if (tokenCandidate) {
      return { mode: "bearer", token: tokenCandidate };
    }

    const sasToken = normalizeSasToken(toStringValue(parsed.sasToken ?? parsed.sas_token ?? parsed.sharedAccessSignature));
    if (sasToken) {
      return { mode: "sas", sasToken };
    }

    const accountName = toStringValue(parsed.accountName ?? parsed.account_name ?? configAccountName);
    const accountKeyBase64 = toStringValue(parsed.accountKey ?? parsed.account_key ?? parsed.primaryKey ?? parsed.key);
    const endpoint = toStringValue(parsed.endpoint ?? parsed.blobEndpoint ?? configEndpoint);
    if (accountName && accountKeyBase64) {
      return {
        mode: "shared_key",
        accountName,
        accountKeyBase64,
        endpoint: endpoint || toEndpointFromAccount(accountName)
      };
    }
  } catch {
    // keep handling below
  }

  if (/^(bearer\s+)/i.test(trimmedSecret)) {
    return { mode: "bearer", token: trimmedSecret.replace(/^bearer\s+/i, "").trim() };
  }

  return { mode: "bearer", token: trimmedSecret };
}

function buildCanonicalizedHeaders(headers: Record<string, string>): string {
  const normalized = Object.entries(headers)
    .filter(([key]) => key.toLowerCase().startsWith("x-ms-"))
    .map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  if (!normalized.length) {
    return "";
  }

  return `${normalized.map(([key, value]) => `${key}:${value}`).join("\n")}\n`;
}

function buildCanonicalizedResource(accountName: string, requestUrl: URL): string {
  const path = requestUrl.pathname || "/";
  const canonicalPath = `/${accountName}${path}`;
  const queryEntries: Array<[string, string]> = [];

  for (const [key, value] of requestUrl.searchParams.entries()) {
    queryEntries.push([key.toLowerCase(), value]);
  }

  if (!queryEntries.length) {
    return canonicalPath;
  }

  const grouped = new Map<string, string[]>();
  for (const [key, value] of queryEntries) {
    const list = grouped.get(key) ?? [];
    list.push(value);
    grouped.set(key, list);
  }

  const canonicalQuery = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => `${key}:${values.sort().join(",")}`)
    .join("\n");

  return `${canonicalPath}\n${canonicalQuery}`;
}

function buildSharedKeyAuthorization(input: {
  method: string;
  url: URL;
  accountName: string;
  accountKeyBase64: string;
  headers: Record<string, string>;
  bodyLength: number;
}): string {
  const contentLength = input.bodyLength > 0 ? String(input.bodyLength) : "";
  const canonicalizedHeaders = buildCanonicalizedHeaders(input.headers);
  const canonicalizedResource = buildCanonicalizedResource(input.accountName, input.url);

  const stringToSign = [
    input.method.toUpperCase(),
    "",
    "",
    contentLength,
    "",
    input.headers["content-type"] ?? "",
    "",
    "",
    "",
    "",
    "",
    "",
    canonicalizedHeaders + canonicalizedResource
  ].join("\n");

  const signature = createHmac("sha256", Buffer.from(input.accountKeyBase64, "base64"))
    .update(stringToSign, "utf8")
    .digest("base64");

  return `SharedKey ${input.accountName}:${signature}`;
}

function appendSasToken(url: URL, sasToken: string): void {
  const params = new URLSearchParams(sasToken);
  for (const [key, value] of params.entries()) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }
}

function parseXmlNameElements(xml: string): string[] {
  const names: string[] = [];
  const pattern = /<Name>([^<]+)<\/Name>/gi;
  let match: RegExpExecArray | null = pattern.exec(xml);
  while (match) {
    if (match[1]) {
      names.push(match[1]);
    }
    match = pattern.exec(xml);
  }
  return names;
}

function buildDemoDocuments(config: Record<string, unknown>) {
  const operation = toStringValue(config.operation) || "list_blobs";
  const containerName = toStringValue(config.containerName) || "sample-container";
  const blobName = toStringValue(config.blobName) || "sample.txt";

  return [
    {
      id: `azure-storage-${operation}-1`,
      text: `Demo Azure Storage response for operation '${operation}'.`,
      metadata: {
        source: "azure-storage",
        mode: "demo-fallback",
        containerName,
        blobName
      }
    }
  ];
}

export class AzureStorageConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "azure-storage",
    label: "Azure Storage",
    category: "azure_storage" as const,
    description: "Reads and writes Azure Blob Storage containers and blobs.",
    configSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list_containers", "list_blobs", "get_blob_text", "put_blob_text", "delete_blob"]
        },
        accountName: { type: "string" },
        endpoint: { type: "string" },
        containerName: { type: "string" },
        blobName: { type: "string" },
        blobContentTemplate: { type: "string" },
        prefix: { type: "string" },
        maxResults: { type: "number" },
        useDemoFallback: { type: "boolean" }
      }
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      }
    }
  };

  private async resolveCredential(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<AzureStorageCredential> {
    const secretRef = toRecord(config.secretRef);
    const secretId = toStringValue(secretRef.secretId);
    const secretValue = secretId ? await context.resolveSecret({ secretId }) : undefined;
    return parseStorageCredential(secretValue ?? "", config);
  }

  private buildBaseEndpoint(config: Record<string, unknown>, credential: AzureStorageCredential): string {
    const explicitEndpoint = toStringValue(config.endpoint);
    if (explicitEndpoint) {
      return normalizeUrlWithoutTrailingSlash(explicitEndpoint);
    }

    if (credential.mode === "shared_key") {
      return normalizeUrlWithoutTrailingSlash(credential.endpoint ?? toEndpointFromAccount(credential.accountName));
    }

    const accountName = toStringValue(config.accountName);
    if (accountName) {
      return toEndpointFromAccount(accountName);
    }

    return "";
  }

  private async request(input: {
    method: "GET" | "PUT" | "DELETE";
    config: Record<string, unknown>;
    credential: AzureStorageCredential;
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: string;
    extraHeaders?: Record<string, string>;
  }): Promise<Response> {
    const baseEndpoint = this.buildBaseEndpoint(input.config, input.credential);
    if (!baseEndpoint) {
      throw new Error("Azure Storage endpoint/accountName is required.");
    }

    const url = new URL(`${normalizeUrlWithoutTrailingSlash(baseEndpoint)}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      "x-ms-version": "2023-11-03",
      "x-ms-date": new Date().toUTCString(),
      ...toRecord(input.extraHeaders)
    } as Record<string, string>;

    const body = input.body ?? "";
    if (input.method === "PUT") {
      headers["content-type"] = headers["content-type"] ?? "text/plain; charset=utf-8";
      headers["x-ms-blob-type"] = headers["x-ms-blob-type"] ?? "BlockBlob";
    }

    if (input.credential.mode === "sas") {
      appendSasToken(url, input.credential.sasToken);
    } else if (input.credential.mode === "bearer") {
      headers.authorization = `Bearer ${input.credential.token}`;
    } else if (input.credential.mode === "shared_key") {
      headers.authorization = buildSharedKeyAuthorization({
        method: input.method,
        url,
        accountName: input.credential.accountName,
        accountKeyBase64: input.credential.accountKeyBase64,
        headers,
        bodyLength: Buffer.byteLength(body, "utf8")
      });
    }

    return fetch(url, {
      method: input.method,
      headers,
      body: input.method === "GET" || input.method === "DELETE" ? undefined : body
    });
  }

  async testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const credential = await this.resolveCredential(config, context);
    if (credential.mode === "none") {
      return {
        ok: useDemoFallback,
        message: useDemoFallback
          ? "No Azure Storage credential configured. Connector will run in demo fallback mode."
          : "Azure Storage credential is required."
      };
    }

    try {
      const response = await this.request({
        method: "GET",
        config,
        credential,
        path: "/",
        query: {
          comp: "list"
        }
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        return {
          ok: false,
          message: `Azure Storage connection failed (${response.status}): ${detail || response.statusText}`
        };
      }

      return {
        ok: true,
        message: "Azure Storage connection successful."
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Azure Storage connection failed."
      };
    }
  }

  async fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const operation = toStringValue(config.operation) || "list_blobs";
    const containerName = toStringValue(config.containerName);
    const blobName = toStringValue(config.blobName);
    const prefix = toStringValue(config.prefix);
    const maxResults = Math.max(1, Math.min(5000, toPositiveInt(config.maxResults, 100)));
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const credential = await this.resolveCredential(config, context);

    if (credential.mode === "none") {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: "missing_credentials"
          }
        };
      }

      throw new Error("Azure Storage credential is required.");
    }

    try {
      if (operation === "list_containers") {
        const response = await this.request({
          method: "GET",
          config,
          credential,
          path: "/",
          query: {
            comp: "list",
            maxresults: maxResults
          }
        });
        const payload = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Storage list containers failed (${response.status}): ${payload.slice(0, 320)}`);
        }
        const containerNames = parseXmlNameElements(payload);
        return {
          documents: containerNames.map((name, index) => ({
            id: `azure-storage-container-${index + 1}`,
            text: name,
            metadata: {
              source: "azure-storage",
              operation,
              containerName: name
            }
          })),
          raw: {
            operation,
            containers: containerNames
          }
        };
      }

      if (operation === "list_blobs") {
        if (!containerName) {
          throw new Error("Azure Storage list_blobs requires containerName.");
        }

        const response = await this.request({
          method: "GET",
          config,
          credential,
          path: `/${encodeURIComponent(containerName)}`,
          query: {
            restype: "container",
            comp: "list",
            prefix: prefix || undefined,
            maxresults: maxResults
          }
        });
        const payload = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Storage list blobs failed (${response.status}): ${payload.slice(0, 320)}`);
        }
        const blobNames = parseXmlNameElements(payload);
        return {
          documents: blobNames.map((name, index) => ({
            id: `azure-storage-blob-${index + 1}`,
            text: name,
            metadata: {
              source: "azure-storage",
              operation,
              containerName,
              blobName: name
            }
          })),
          raw: {
            operation,
            containerName,
            blobs: blobNames
          }
        };
      }

      if (operation === "get_blob_text") {
        if (!containerName || !blobName) {
          throw new Error("Azure Storage get_blob_text requires containerName and blobName.");
        }

        const response = await this.request({
          method: "GET",
          config,
          credential,
          path: `/${encodeURIComponent(containerName)}/${encodeURIComponent(blobName)}`
        });
        const payload = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Storage get blob failed (${response.status}): ${payload.slice(0, 320)}`);
        }

        return {
          documents: [
            {
              id: `${containerName}/${blobName}`,
              text: payload,
              metadata: {
                source: "azure-storage",
                operation,
                containerName,
                blobName
              }
            }
          ],
          raw: {
            operation,
            containerName,
            blobName,
            contentLength: payload.length
          }
        };
      }

      if (operation === "put_blob_text") {
        if (!containerName || !blobName) {
          throw new Error("Azure Storage put_blob_text requires containerName and blobName.");
        }

        const content = typeof config.blobContentTemplate === "string" ? config.blobContentTemplate : "";
        const response = await this.request({
          method: "PUT",
          config,
          credential,
          path: `/${encodeURIComponent(containerName)}/${encodeURIComponent(blobName)}`,
          body: content
        });
        const detail = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Storage put blob failed (${response.status}): ${detail.slice(0, 320)}`);
        }

        return {
          documents: [],
          raw: {
            operation,
            containerName,
            blobName,
            etag: response.headers.get("etag"),
            requestId: response.headers.get("x-ms-request-id")
          }
        };
      }

      if (operation === "delete_blob") {
        if (!containerName || !blobName) {
          throw new Error("Azure Storage delete_blob requires containerName and blobName.");
        }

        const response = await this.request({
          method: "DELETE",
          config,
          credential,
          path: `/${encodeURIComponent(containerName)}/${encodeURIComponent(blobName)}`
        });
        const detail = await response.text();
        if (!response.ok && response.status !== 404) {
          throw new Error(`Azure Storage delete blob failed (${response.status}): ${detail.slice(0, 320)}`);
        }

        return {
          documents: [],
          raw: {
            operation,
            containerName,
            blobName,
            deleted: response.status !== 404
          }
        };
      }

      throw new Error(`Unsupported Azure Storage operation '${operation}'.`);
    } catch (error) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: error instanceof Error ? error.message : "azure_storage_error"
          }
        };
      }
      throw error;
    }
  }
}
