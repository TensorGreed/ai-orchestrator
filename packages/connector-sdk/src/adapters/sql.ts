import type { ConnectorAdapter } from "../types";

export class SQLConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "sql-db",
    label: "SQL Database",
    category: "sql" as const,
    description: "Connector SDK example for SQL query ingestion.",
    configSchema: {
      type: "object",
      properties: {
        connectionString: { type: "string" },
        query: { type: "string" },
        sampleRows: {
          type: "array",
          items: { type: "object", additionalProperties: true }
        }
      },
      required: ["query"]
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      }
    }
  };

  async testConnection(config: Record<string, unknown>) {
    const query = typeof config.query === "string" ? config.query : "SELECT 1";
    return {
      ok: true,
      message: `SQL connector stub validated query '${query}'`
    };
  }

  async fetchData(config: Record<string, unknown>) {
    const rows = Array.isArray(config.sampleRows)
      ? config.sampleRows
      : [
          { id: 1, title: "MCP primer", content: "MCP servers expose tools and resources." },
          { id: 2, title: "RAG primer", content: "Retriever nodes provide context documents." }
        ];

    return {
      documents: rows.map((row, index) => ({
        id: `sql-${index + 1}`,
        text: JSON.stringify(row),
        metadata: {
          source: "sql-db",
          query: typeof config.query === "string" ? config.query : "sample"
        }
      })),
      raw: rows
    };
  }
}