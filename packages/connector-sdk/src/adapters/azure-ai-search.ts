import type { ConnectorAdapter, ConnectorExecutionContext } from "../types";

type AzureSearchDocument = Record<string, unknown>;

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

function parseSearchApiKey(secretValue: string): string {
  const trimmed = secretValue.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const key = toStringValue(parsed.apiKey ?? parsed.api_key ?? parsed.key ?? parsed.adminKey ?? parsed.queryKey);
    if (key) {
      return key;
    }
  } catch {
    // ignore and treat as raw key
  }

  return trimmed;
}

function parseDocumentsJson(input: unknown): AzureSearchDocument[] {
  if (typeof input !== "string" || !input.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as AzureSearchDocument[];
    }
  } catch {
    // ignore
  }
  return [];
}

function parseVectorJson(input: unknown): number[] | undefined {
  if (typeof input !== "string" || !input.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      const vector = parsed.filter((entry) => typeof entry === "number" && Number.isFinite(entry)) as number[];
      return vector.length === parsed.length ? vector : undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function buildDemoDocuments(config: Record<string, unknown>) {
  const operation = toStringValue(config.operation) || "vector_search";
  return [
    {
      id: `azure-search-${operation}-1`,
      text: `Demo Azure AI Search response for operation '${operation}'.`,
      metadata: {
        source: "azure-ai-search",
        mode: "demo-fallback"
      }
    }
  ];
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

export class AzureAiSearchConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "azure-ai-search",
    label: "Azure AI Search Vector Store",
    category: "azure_search" as const,
    description: "Runs vector/document operations against Azure AI Search indexes.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["vector_search", "upsert_documents", "delete_documents"] },
        endpoint: { type: "string" },
        indexName: { type: "string" },
        apiVersion: { type: "string" },
        vectorField: { type: "string" },
        contentField: { type: "string" },
        idField: { type: "string" },
        metadataField: { type: "string" },
        queryText: { type: "string" },
        queryVectorJson: { type: "string" },
        topK: { type: "number" },
        documentsJson: { type: "string" },
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

  private async resolveApiKey(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<string> {
    const secretRef = toRecord(config.secretRef);
    const secretId = toStringValue(secretRef.secretId);
    const secretValue = secretId ? await context.resolveSecret({ secretId }) : undefined;
    return parseSearchApiKey(secretValue ?? "");
  }

  private async request(input: {
    method: "GET" | "POST";
    endpoint: string;
    indexName?: string;
    apiVersion: string;
    pathSuffix: string;
    apiKey: string;
    body?: unknown;
  }): Promise<Response> {
    const base = normalizeEndpoint(input.endpoint);
    const path = input.indexName
      ? `/indexes/${encodeURIComponent(input.indexName)}${input.pathSuffix}`
      : input.pathSuffix;
    const url = new URL(`${base}${path}`);
    url.searchParams.set("api-version", input.apiVersion);

    return fetch(url, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "api-key": input.apiKey
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
  }

  async testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const endpoint = toStringValue(config.endpoint);
    const indexName = toStringValue(config.indexName);
    const apiVersion = toStringValue(config.apiVersion) || "2024-07-01";
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const apiKey = await this.resolveApiKey(config, context);

    if (!endpoint || !apiKey) {
      return {
        ok: useDemoFallback,
        message: useDemoFallback
          ? "Missing endpoint or API key. Connector will run in demo fallback mode."
          : "Azure AI Search endpoint and API key are required."
      };
    }

    try {
      const response = await this.request({
        method: "GET",
        endpoint,
        indexName: indexName || undefined,
        apiVersion,
        pathSuffix: indexName ? "" : "/indexes",
        apiKey
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 320);
        return {
          ok: false,
          message: `Azure AI Search connection failed (${response.status}): ${detail || response.statusText}`
        };
      }
      return {
        ok: true,
        message: "Azure AI Search connection successful."
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Azure AI Search connection failed."
      };
    }
  }

  async fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const operation = toStringValue(config.operation) || "vector_search";
    const endpoint = toStringValue(config.endpoint);
    const indexName = toStringValue(config.indexName);
    const apiVersion = toStringValue(config.apiVersion) || "2024-07-01";
    const vectorField = toStringValue(config.vectorField) || "embedding";
    const contentField = toStringValue(config.contentField) || "content";
    const idField = toStringValue(config.idField) || "id";
    const metadataField = toStringValue(config.metadataField) || "metadata";
    const queryText = toStringValue(config.queryText) || "*";
    const queryVector = parseVectorJson(config.queryVectorJson);
    const documents = parseDocumentsJson(config.documentsJson);
    const topK = Math.max(1, Math.min(1000, toPositiveInt(config.topK, 5)));
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const apiKey = await this.resolveApiKey(config, context);

    if (!endpoint || !indexName || !apiKey) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: "missing_configuration_or_credentials"
          }
        };
      }
      throw new Error("Azure AI Search endpoint, indexName, and API key are required.");
    }

    try {
      if (operation === "vector_search") {
        const body: Record<string, unknown> = {
          search: queryText,
          top: topK
        };

        if (queryVector && queryVector.length > 0) {
          body.vectorQueries = [
            {
              kind: "vector",
              vector: queryVector,
              fields: vectorField,
              k: topK
            }
          ];
        }

        const selectedFields = [idField, contentField, metadataField].filter(Boolean).join(",");
        if (selectedFields) {
          body.select = selectedFields;
        }

        const response = await this.request({
          method: "POST",
          endpoint,
          indexName,
          apiVersion,
          pathSuffix: "/docs/search",
          apiKey,
          body
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure AI Search vector query failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = JSON.parse(payloadText) as Record<string, unknown>;
        const value = Array.isArray(payload.value) ? (payload.value as AzureSearchDocument[]) : [];

        return {
          documents: value.map((entry, index) => {
            const id = toStringValue(entry[idField]) || `search-doc-${index + 1}`;
            const text = toStringValue(entry[contentField]) || JSON.stringify(entry);
            return {
              id,
              text,
              metadata: {
                source: "azure-ai-search",
                operation,
                ...(toRecord(entry[metadataField]) || {}),
                score: entry["@search.score"],
                rerankerScore: entry["@search.rerankerScore"]
              }
            };
          }),
          raw: payload
        };
      }

      if (operation === "upsert_documents") {
        if (!documents.length) {
          throw new Error("Azure AI Search upsert_documents requires documentsJson with at least one document.");
        }
        const value = documents.map((entry) => ({
          ...entry,
          "@search.action": "mergeOrUpload"
        }));
        const response = await this.request({
          method: "POST",
          endpoint,
          indexName,
          apiVersion,
          pathSuffix: "/docs/index",
          apiKey,
          body: { value }
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure AI Search upsert failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = payloadText.trim() ? JSON.parse(payloadText) : {};
        return {
          documents: [],
          raw: payload
        };
      }

      if (operation === "delete_documents") {
        if (!documents.length) {
          throw new Error("Azure AI Search delete_documents requires documentsJson with at least one document id.");
        }
        const value = documents
          .map((entry): Record<string, unknown> | null => {
            const id = entry[idField];
            if (id === undefined || id === null) {
              return null;
            }
            return {
              "@search.action": "delete",
              [idField]: id
            };
          })
          .filter((entry): entry is Record<string, unknown> => Boolean(entry));

        if (!value.length) {
          throw new Error(`Azure AI Search delete_documents requires documentsJson entries with '${idField}'.`);
        }

        const response = await this.request({
          method: "POST",
          endpoint,
          indexName,
          apiVersion,
          pathSuffix: "/docs/index",
          apiKey,
          body: { value }
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure AI Search delete failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = payloadText.trim() ? JSON.parse(payloadText) : {};
        return {
          documents: [],
          raw: payload
        };
      }

      throw new Error(`Unsupported Azure AI Search operation '${operation}'.`);
    } catch (error) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: error instanceof Error ? error.message : "azure_search_error"
          }
        };
      }
      throw error;
    }
  }
}
