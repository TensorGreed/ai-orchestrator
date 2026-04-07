import { createHmac } from "node:crypto";
import type { ConnectorAdapter, ConnectorExecutionContext } from "../types";

type CosmosCredential =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "master_key"; keyBase64: string };

type CosmosDocument = Record<string, unknown>;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseCosmosCredential(secretValue: string): CosmosCredential {
  const trimmed = secretValue.trim();
  if (!trimmed) {
    return { mode: "none" };
  }

  if (/^bearer\s+/i.test(trimmed)) {
    return {
      mode: "bearer",
      token: trimmed.replace(/^bearer\s+/i, "").trim()
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const token = toStringValue(parsed.accessToken ?? parsed.access_token ?? parsed.token ?? parsed.bearerToken);
    if (token) {
      return { mode: "bearer", token };
    }

    const keyBase64 = toStringValue(parsed.key ?? parsed.masterKey ?? parsed.primaryKey ?? parsed.accountKey);
    if (keyBase64) {
      return { mode: "master_key", keyBase64 };
    }
  } catch {
    // continue to heuristic parsing
  }

  const likelyJwt = trimmed.split(".").length === 3;
  if (likelyJwt) {
    return { mode: "bearer", token: trimmed };
  }

  return { mode: "master_key", keyBase64: trimmed };
}

function buildCosmosMasterKeyAuthorization(input: {
  method: string;
  resourceType: string;
  resourceLink: string;
  dateUtc: string;
  keyBase64: string;
}): string {
  const payload = `${input.method.toLowerCase()}\n${input.resourceType.toLowerCase()}\n${input.resourceLink}\n${input.dateUtc.toLowerCase()}\n\n`;
  const signature = createHmac("sha256", Buffer.from(input.keyBase64, "base64")).update(payload, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${signature}`);
}

function normalizeEndpoint(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePartitionKeyValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("[")) {
    return trimmed;
  }
  return JSON.stringify([trimmed]);
}

function parseItemJson(input: unknown): CosmosDocument {
  if (typeof input !== "string" || !input.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CosmosDocument) : {};
  } catch {
    return {};
  }
}

function buildDemoDocuments(config: Record<string, unknown>) {
  const operation = toStringValue(config.operation) || "query_items";
  return [
    {
      id: `azure-cosmos-${operation}-1`,
      text: `Demo Cosmos DB response for operation '${operation}'.`,
      metadata: {
        source: "azure-cosmos-db",
        mode: "demo-fallback"
      }
    }
  ];
}

export class AzureCosmosDbConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "azure-cosmos-db",
    label: "Azure Cosmos DB",
    category: "azure_cosmos_db" as const,
    description: "Queries and mutates documents in Azure Cosmos DB SQL API containers.",
    configSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["query_items", "read_item", "create_item", "upsert_item", "delete_item"]
        },
        endpoint: { type: "string" },
        databaseId: { type: "string" },
        containerId: { type: "string" },
        queryText: { type: "string" },
        itemId: { type: "string" },
        partitionKey: { type: "string" },
        itemJson: { type: "string" },
        maxItems: { type: "number" },
        useDemoFallback: { type: "boolean" }
      }
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: {
          type: "object",
          properties: {
            secretId: { type: "string" }
          }
        }
      }
    }
  };

  private async resolveCredential(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<CosmosCredential> {
    const secretRef = toRecord(config.secretRef);
    const secretId = toStringValue(secretRef.secretId);
    const secretValue = secretId ? await context.resolveSecret({ secretId }) : undefined;
    return parseCosmosCredential(secretValue ?? "");
  }

  private async request(input: {
    endpoint: string;
    method: "GET" | "POST" | "DELETE";
    resourceType: "dbs" | "colls" | "docs";
    resourceLink: string;
    path: string;
    credential: CosmosCredential;
    body?: unknown;
    extraHeaders?: Record<string, string>;
  }): Promise<Response> {
    const endpoint = normalizeEndpoint(input.endpoint);
    if (!endpoint) {
      throw new Error("Azure Cosmos DB endpoint is required.");
    }

    const dateUtc = new Date().toUTCString();
    const headers: Record<string, string> = {
      "x-ms-version": "2018-12-31",
      "x-ms-date": dateUtc,
      "content-type": "application/json",
      ...toRecord(input.extraHeaders)
    } as Record<string, string>;

    if (input.credential.mode === "bearer") {
      headers.authorization = `Bearer ${input.credential.token}`;
    } else if (input.credential.mode === "master_key") {
      headers.authorization = buildCosmosMasterKeyAuthorization({
        method: input.method,
        resourceType: input.resourceType,
        resourceLink: input.resourceLink,
        dateUtc,
        keyBase64: input.credential.keyBase64
      });
    } else {
      throw new Error("Azure Cosmos DB credential is required.");
    }

    const body = input.body !== undefined ? JSON.stringify(input.body) : undefined;
    return fetch(`${endpoint}${input.path}`, {
      method: input.method,
      headers,
      body
    });
  }

  async testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const endpoint = toStringValue(config.endpoint);
    const credential = await this.resolveCredential(config, context);

    if (!endpoint || credential.mode === "none") {
      return {
        ok: useDemoFallback,
        message: useDemoFallback
          ? "Missing endpoint or credential. Connector will run in demo fallback mode."
          : "Cosmos endpoint and credential are required."
      };
    }

    try {
      const response = await this.request({
        endpoint,
        method: "GET",
        resourceType: "dbs",
        resourceLink: "",
        path: "/dbs",
        credential
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 320);
        return {
          ok: false,
          message: `Azure Cosmos DB connection failed (${response.status}): ${detail || response.statusText}`
        };
      }

      return {
        ok: true,
        message: "Azure Cosmos DB connection successful."
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Azure Cosmos DB connection failed."
      };
    }
  }

  async fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const operation = toStringValue(config.operation) || "query_items";
    const endpoint = toStringValue(config.endpoint);
    const databaseId = toStringValue(config.databaseId);
    const containerId = toStringValue(config.containerId);
    const itemId = toStringValue(config.itemId);
    const partitionKeyRaw = toStringValue(config.partitionKey);
    const maxItems = Math.max(1, Math.min(1000, toPositiveInt(config.maxItems, 50)));
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const credential = await this.resolveCredential(config, context);

    if (!endpoint || !databaseId || !containerId || credential.mode === "none") {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: "missing_configuration_or_credentials"
          }
        };
      }
      throw new Error("Azure Cosmos DB endpoint, databaseId, containerId, and credential are required.");
    }

    const docsBasePath = `/dbs/${encodeURIComponent(databaseId)}/colls/${encodeURIComponent(containerId)}/docs`;
    const docsResourceLink = `dbs/${databaseId}/colls/${containerId}`;

    try {
      if (operation === "query_items") {
        const queryText = toStringValue(config.queryText) || "SELECT TOP 10 * FROM c";
        const response = await this.request({
          endpoint,
          method: "POST",
          resourceType: "docs",
          resourceLink: docsResourceLink,
          path: docsBasePath,
          credential,
          body: { query: queryText },
          extraHeaders: {
            "x-ms-documentdb-isquery": "true",
            "x-ms-max-item-count": String(maxItems),
            "content-type": "application/query+json"
          }
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Cosmos DB query failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = JSON.parse(payloadText) as Record<string, unknown>;
        const resources = Array.isArray(payload.Documents) ? (payload.Documents as CosmosDocument[]) : [];
        return {
          documents: resources.map((resource, index) => ({
            id: toStringValue(resource.id) || `cosmos-doc-${index + 1}`,
            text: JSON.stringify(resource),
            metadata: {
              source: "azure-cosmos-db",
              operation,
              databaseId,
              containerId
            }
          })),
          raw: payload
        };
      }

      if (operation === "read_item") {
        if (!itemId) {
          throw new Error("Azure Cosmos DB read_item requires itemId.");
        }
        const itemPath = `${docsBasePath}/${encodeURIComponent(itemId)}`;
        const itemResourceLink = `${docsResourceLink}/docs/${itemId}`;
        const extraHeaders: Record<string, string> = {};
        if (partitionKeyRaw) {
          extraHeaders["x-ms-documentdb-partitionkey"] = normalizePartitionKeyValue(partitionKeyRaw);
        }
        const response = await this.request({
          endpoint,
          method: "GET",
          resourceType: "docs",
          resourceLink: itemResourceLink,
          path: itemPath,
          credential,
          extraHeaders
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Cosmos DB read item failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = JSON.parse(payloadText) as CosmosDocument;
        return {
          documents: [
            {
              id: toStringValue(payload.id) || itemId,
              text: JSON.stringify(payload),
              metadata: {
                source: "azure-cosmos-db",
                operation,
                databaseId,
                containerId
              }
            }
          ],
          raw: payload
        };
      }

      if (operation === "create_item" || operation === "upsert_item") {
        const item = parseItemJson(config.itemJson);
        if (!item || Object.keys(item).length === 0) {
          throw new Error("Azure Cosmos DB create_item/upsert_item requires valid itemJson.");
        }
        const extraHeaders: Record<string, string> = {};
        if (operation === "upsert_item") {
          extraHeaders["x-ms-documentdb-is-upsert"] = "true";
        }
        if (partitionKeyRaw) {
          extraHeaders["x-ms-documentdb-partitionkey"] = normalizePartitionKeyValue(partitionKeyRaw);
        }
        const response = await this.request({
          endpoint,
          method: "POST",
          resourceType: "docs",
          resourceLink: docsResourceLink,
          path: docsBasePath,
          credential,
          body: item,
          extraHeaders
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Cosmos DB write item failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = payloadText.trim() ? (JSON.parse(payloadText) as CosmosDocument) : {};
        return {
          documents: payload && Object.keys(payload).length > 0
            ? [
                {
                  id: toStringValue(payload.id) || toStringValue(item.id) || "cosmos-item",
                  text: JSON.stringify(payload),
                  metadata: {
                    source: "azure-cosmos-db",
                    operation,
                    databaseId,
                    containerId
                  }
                }
              ]
            : [],
          raw: payload
        };
      }

      if (operation === "delete_item") {
        if (!itemId) {
          throw new Error("Azure Cosmos DB delete_item requires itemId.");
        }
        const itemPath = `${docsBasePath}/${encodeURIComponent(itemId)}`;
        const itemResourceLink = `${docsResourceLink}/docs/${itemId}`;
        const extraHeaders: Record<string, string> = {};
        if (partitionKeyRaw) {
          extraHeaders["x-ms-documentdb-partitionkey"] = normalizePartitionKeyValue(partitionKeyRaw);
        }
        const response = await this.request({
          endpoint,
          method: "DELETE",
          resourceType: "docs",
          resourceLink: itemResourceLink,
          path: itemPath,
          credential,
          extraHeaders
        });
        const detail = await response.text();
        if (!response.ok && response.status !== 404) {
          throw new Error(`Azure Cosmos DB delete item failed (${response.status}): ${detail.slice(0, 320)}`);
        }
        return {
          documents: [],
          raw: {
            operation,
            databaseId,
            containerId,
            itemId,
            deleted: response.status !== 404
          }
        };
      }

      throw new Error(`Unsupported Azure Cosmos DB operation '${operation}'.`);
    } catch (error) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: error instanceof Error ? error.message : "azure_cosmos_db_error"
          }
        };
      }
      throw error;
    }
  }
}
