import type { ConnectorAdapter, ConnectorExecutionContext } from "../types";

type QdrantPayload = Record<string, unknown>;
type QdrantPoint = {
  id?: unknown;
  payload?: QdrantPayload;
  score?: unknown;
  vector?: unknown;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseApiKey(secretValue: string): string {
  const trimmed = secretValue.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const key = toStringValue(parsed.apiKey ?? parsed.api_key ?? parsed.key ?? parsed.token);
    if (key) {
      return key;
    }
  } catch {
    // ignore and use raw secret value
  }

  return trimmed;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function parseJsonArray(input: unknown): Array<Record<string, unknown>> {
  if (typeof input !== "string" || !input.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function parseJsonObject(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "string" || !input.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function parseVectorJson(input: unknown): number[] | undefined {
  if (typeof input !== "string" || !input.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const vector = parsed.map((entry) => toFiniteNumber(entry));
    if (vector.some((entry) => entry === undefined)) {
      return undefined;
    }
    return vector as number[];
  } catch {
    return undefined;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function lexicalScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) {
    return 0;
  }
  const textTokens = new Set(tokenize(text));
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.length;
}

function parseQdrantPoints(payload: unknown): QdrantPoint[] {
  const record = toRecord(payload);
  const result = record.result;
  if (Array.isArray(result)) {
    return result.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as QdrantPoint[];
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const nested = result as Record<string, unknown>;
    if (Array.isArray(nested.points)) {
      return nested.points.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as QdrantPoint[];
    }
  }
  return [];
}

function mapPointToDocument(
  point: QdrantPoint,
  input: { contentField: string; metadataField: string; sourceOperation: string }
): { id: string; text: string; metadata: Record<string, unknown> } {
  const payload = toRecord(point.payload);
  const id = String(point.id ?? cryptoRandomId());
  const directText = payload[input.contentField];
  const metadataValue = payload[input.metadataField];
  const metadataRecord = toRecord(metadataValue);
  const text =
    typeof directText === "string" && directText.trim()
      ? directText
      : typeof metadataRecord.content === "string"
        ? metadataRecord.content
        : JSON.stringify(payload);

  return {
    id,
    text,
    metadata: {
      ...payload,
      source: "qdrant",
      operation: input.sourceOperation,
      score: point.score
    }
  };
}

function cryptoRandomId(): string {
  return `qdrant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildDemoDocuments(operation: string) {
  return [
    {
      id: `qdrant-demo-${operation}-1`,
      text: `Demo Qdrant response for '${operation}'.`,
      metadata: {
        source: "qdrant",
        mode: "demo-fallback",
        operation
      }
    }
  ];
}

export class QdrantConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "qdrant",
    label: "Qdrant Vector Store",
    category: "qdrant" as const,
    description: "Runs retrieval and document mutation operations on Qdrant collections.",
    configSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "get_ranked_documents",
            "add_documents",
            "retrieve_for_chain_tool",
            "retrieve_for_ai_agent_tool"
          ]
        },
        endpoint: { type: "string" },
        collectionName: { type: "string" },
        apiKeyHeaderName: { type: "string" },
        queryText: { type: "string" },
        queryVectorJson: { type: "string" },
        filterJson: { type: "string" },
        documentsJson: { type: "string" },
        topK: { type: "number" },
        contentField: { type: "string" },
        metadataField: { type: "string" },
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
    if (!secretId) {
      return "";
    }
    const secret = await context.resolveSecret({ secretId });
    return parseApiKey(secret ?? "");
  }

  private buildHeaders(apiKey: string, apiKeyHeaderName: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (apiKey) {
      headers[apiKeyHeaderName || "api-key"] = apiKey;
    }
    return headers;
  }

  private async postJson<T = unknown>(input: {
    endpoint: string;
    path: string;
    apiKey: string;
    apiKeyHeaderName: string;
    body: unknown;
  }): Promise<T> {
    const response = await fetch(`${normalizeEndpoint(input.endpoint)}${input.path}`, {
      method: "POST",
      headers: this.buildHeaders(input.apiKey, input.apiKeyHeaderName),
      body: JSON.stringify(input.body)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Qdrant request failed (${response.status}): ${text.slice(0, 420)}`);
    }

    if (!text.trim()) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  async testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const endpoint = toStringValue(config.endpoint);
    const collectionName = toStringValue(config.collectionName);
    const apiKeyHeaderName = toStringValue(config.apiKeyHeaderName) || "api-key";
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const apiKey = await this.resolveApiKey(config, context);

    if (!endpoint || !collectionName) {
      return {
        ok: useDemoFallback,
        message: useDemoFallback
          ? "Missing endpoint/collection. Qdrant node will run in demo fallback mode."
          : "Qdrant endpoint and collectionName are required."
      };
    }

    try {
      const response = await fetch(
        `${normalizeEndpoint(endpoint)}/collections/${encodeURIComponent(collectionName)}`,
        {
          method: "GET",
          headers: this.buildHeaders(apiKey, apiKeyHeaderName)
        }
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 320);
        return {
          ok: false,
          message: `Qdrant connection failed (${response.status}): ${detail || response.statusText}`
        };
      }
      return {
        ok: true,
        message: "Qdrant connection successful."
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Qdrant connection failed."
      };
    }
  }

  async fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const operation = toStringValue(config.operation) || "get_ranked_documents";
    const endpoint = toStringValue(config.endpoint);
    const collectionName = toStringValue(config.collectionName);
    const apiKeyHeaderName = toStringValue(config.apiKeyHeaderName) || "api-key";
    const queryText = toStringValue(config.queryText);
    const queryVector = parseVectorJson(config.queryVectorJson);
    const filter = parseJsonObject(config.filterJson);
    const topK = Math.max(1, Math.min(5000, toPositiveInt(config.topK, 5)));
    const contentField = toStringValue(config.contentField) || "content";
    const metadataField = toStringValue(config.metadataField) || "metadata";
    const documents = parseJsonArray(config.documentsJson);
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const apiKey = await this.resolveApiKey(config, context);

    if (!endpoint || !collectionName) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(operation),
          raw: {
            mode: "demo-fallback",
            reason: "missing_configuration",
            operation
          }
        };
      }
      throw new Error("Qdrant requires endpoint and collectionName.");
    }

    try {
      if (operation === "add_documents") {
        if (!documents.length) {
          throw new Error("Qdrant add_documents requires documentsJson with at least one document object.");
        }

        const points = documents.map((document, index) => {
          const payload = toRecord(document.payload);
          const metadata = toRecord(document.metadata);
          const text = toStringValue(document.text);
          const point: Record<string, unknown> = {
            id: document.id ?? `doc-${index + 1}`,
            payload: {
              ...payload,
              ...(text ? { [contentField]: text } : {}),
              ...(Object.keys(metadata).length ? { [metadataField]: metadata } : {})
            }
          };

          const directVector = document.vector;
          if (Array.isArray(directVector)) {
            const vector = directVector.map((entry) => toFiniteNumber(entry));
            if (!vector.some((entry) => entry === undefined)) {
              point.vector = vector;
            }
          } else if (directVector && typeof directVector === "object" && !Array.isArray(directVector)) {
            point.vector = directVector;
          }

          return point;
        });

        const payload = await this.postJson<Record<string, unknown>>({
          endpoint,
          path: `/collections/${encodeURIComponent(collectionName)}/points?wait=true`,
          apiKey,
          apiKeyHeaderName,
          body: { points }
        });

        return {
          documents: [],
          raw: {
            operation,
            result: payload
          }
        };
      }

      let points: QdrantPoint[] = [];
      if (queryVector && queryVector.length > 0) {
        const payload = await this.postJson<Record<string, unknown>>({
          endpoint,
          path: `/collections/${encodeURIComponent(collectionName)}/points/search`,
          apiKey,
          apiKeyHeaderName,
          body: {
            vector: queryVector,
            limit: topK,
            with_payload: true,
            with_vector: false,
            ...(filter ? { filter } : {})
          }
        });
        points = parseQdrantPoints(payload);
      } else {
        const payload = await this.postJson<Record<string, unknown>>({
          endpoint,
          path: `/collections/${encodeURIComponent(collectionName)}/points/scroll`,
          apiKey,
          apiKeyHeaderName,
          body: {
            limit: Math.max(topK, Math.min(topK * 10, 1000)),
            with_payload: true,
            with_vector: false,
            ...(filter ? { filter } : {})
          }
        });
        points = parseQdrantPoints(payload);
      }

      let mapped = points.map((point) =>
        mapPointToDocument(point, {
          contentField,
          metadataField,
          sourceOperation: operation
        })
      );

      if (!queryVector && queryText) {
        mapped = mapped
          .map((document) => ({
            document,
            score: lexicalScore(queryText, document.text)
          }))
          .sort((a, b) => b.score - a.score)
          .map((entry) => ({
            ...entry.document,
            metadata: {
              ...toRecord(entry.document.metadata),
              lexicalScore: entry.score
            }
          }));
      }

      const documentsResult = mapped.slice(0, topK);
      const contextText = documentsResult.map((doc, index) => `[${index + 1}] ${doc.text}`).join("\n");

      return {
        documents: documentsResult,
        raw: {
          operation,
          queryText,
          topK,
          context: contextText,
          retrieved: documentsResult.length,
          mode:
            operation === "retrieve_for_chain_tool"
              ? "chain_tool"
              : operation === "retrieve_for_ai_agent_tool"
                ? "ai_agent_tool"
                : "ranked_documents"
        }
      };
    } catch (error) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(operation),
          raw: {
            mode: "demo-fallback",
            reason: error instanceof Error ? error.message : "qdrant_error",
            operation
          }
        };
      }
      throw error;
    }
  }
}
