import type { ConnectorAdapter } from "../types";

export class GoogleDriveConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "google-drive",
    label: "Google Drive",
    category: "google_drive" as const,
    description: "Connector stub for Google Drive ingestion with demo data.",
    configSchema: {
      type: "object",
      properties: {
        folderId: { type: "string" },
        staticDocuments: { type: "array", items: { type: "string" } }
      }
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      }
    }
  };

  async testConnection(config: Record<string, unknown>) {
    const folderId = typeof config.folderId === "string" ? config.folderId : "(default)";
    return {
      ok: true,
      message: `Demo Google Drive connector ready for folder ${folderId}`
    };
  }

  async fetchData(config: Record<string, unknown>) {
    const staticDocs = Array.isArray(config.staticDocuments)
      ? config.staticDocuments.map((value) => String(value))
      : [];

    const demoDocs = [
      "Model Context Protocol (MCP) is used to connect tools and resources to agent workflows.",
      "Ollama provides local model execution and OpenAI-compatible APIs.",
      "RAG improves response quality by grounding prompts in retrieved documents."
    ];

    const documents = [...demoDocs, ...staticDocs].map((text, index) => ({
      id: `gdrive-${index + 1}`,
      text,
      metadata: {
        source: "google-drive",
        folderId: typeof config.folderId === "string" ? config.folderId : "sample"
      }
    }));

    return {
      documents
    };
  }
}