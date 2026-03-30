import type { ConnectorAdapter } from "../types";

export class NoSQLConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "nosql-db",
    label: "NoSQL Database",
    category: "nosql" as const,
    description: "Connector SDK example for document-store ingestion.",
    configSchema: {
      type: "object",
      properties: {
        uri: { type: "string" },
        database: { type: "string" },
        collection: { type: "string" },
        sampleDocs: { type: "array", items: { type: "object", additionalProperties: true } }
      },
      required: ["collection"]
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      }
    }
  };

  async testConnection(config: Record<string, unknown>) {
    const collection = typeof config.collection === "string" ? config.collection : "sample";
    return {
      ok: true,
      message: `NoSQL connector stub ready for collection '${collection}'`
    };
  }

  async fetchData(config: Record<string, unknown>) {
    const docs = Array.isArray(config.sampleDocs)
      ? config.sampleDocs
      : [
          { id: "doc-1", body: "Agent workflows can call tools dynamically." },
          { id: "doc-2", body: "Webhook payloads map to execution context." }
        ];

    return {
      documents: docs.map((doc, index) => ({
        id: `nosql-${index + 1}`,
        text: JSON.stringify(doc),
        metadata: {
          source: "nosql-db",
          collection: typeof config.collection === "string" ? config.collection : "sample"
        }
      })),
      raw: docs
    };
  }
}