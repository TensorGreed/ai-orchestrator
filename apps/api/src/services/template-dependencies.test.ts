import { describe, expect, it } from "vitest";
import { computeTemplateDependencies } from "./template-dependencies";

function wf(nodes: Array<{ type: string; config?: Record<string, unknown> }>) {
  return {
    schemaVersion: "1.0.0",
    workflow: {
      id: "wf-test",
      nodes: nodes.map((n, i) => ({
        id: `n${i}`,
        type: n.type,
        name: n.type,
        position: { x: 0, y: 0 },
        config: n.config ?? {}
      })),
      edges: []
    }
  };
}

describe("computeTemplateDependencies", () => {
  it("returns no deps for the echo provider (built-in basic-flow)", () => {
    const deps = computeTemplateDependencies(
      wf([
        { type: "text_input", config: { text: "hi" } },
        {
          type: "llm_call",
          config: { provider: { providerId: "echo", model: "demo" } }
        },
        { type: "output", config: { responseTemplate: "{{answer}}" } }
      ])
    );
    expect(deps).toEqual([]);
  });

  it("detects OpenAI provider with envVar hint", () => {
    const deps = computeTemplateDependencies(
      wf([
        {
          type: "llm_call",
          config: { provider: { providerId: "openai", model: "gpt-4" } }
        }
      ])
    );
    expect(deps).toEqual([{ kind: "provider", label: "OpenAI", envVar: "OPENAI_API_KEY" }]);
  });

  it("detects Pinecone vector store on a rag_retrieve node", () => {
    const deps = computeTemplateDependencies(
      wf([
        {
          type: "rag_retrieve",
          config: { vectorStoreId: "pinecone-vector-store" }
        }
      ])
    );
    expect(deps.find((d) => d.label === "Pinecone")).toEqual({
      kind: "vector_store",
      label: "Pinecone",
      envVar: "PINECONE_API_KEY"
    });
  });

  it("detects http_mcp on an mcp_tool node", () => {
    const deps = computeTemplateDependencies(
      wf([{ type: "mcp_tool", config: { serverId: "http_mcp" } }])
    );
    expect(deps).toEqual([
      { kind: "mcp_server", label: "Remote MCP server (HTTP)", envVar: undefined }
    ]);
  });

  it("treats mock-mcp as no dep", () => {
    const deps = computeTemplateDependencies(
      wf([{ type: "mcp_tool", config: { serverId: "mock-mcp" } }])
    );
    expect(deps).toEqual([]);
  });

  it("detects connector nodes by type", () => {
    const deps = computeTemplateDependencies(
      wf([
        { type: "postgres_query", config: {} },
        { type: "google_sheets_read", config: {} }
      ])
    );
    expect(deps.map((d) => d.label).sort()).toEqual(["Google Sheets", "PostgreSQL"]);
    for (const dep of deps) {
      expect(dep.kind).toBe("connector");
    }
  });

  it("dedupes the same dependency across multiple nodes", () => {
    const deps = computeTemplateDependencies(
      wf([
        { type: "llm_call", config: { provider: { providerId: "openai", model: "gpt-4" } } },
        { type: "llm_call", config: { provider: { providerId: "openai", model: "gpt-3.5" } } }
      ])
    );
    expect(deps).toHaveLength(1);
    expect(deps[0].label).toBe("OpenAI");
  });

  it("returns mixed deps in stable order: provider, vector_store, mcp_server, connector", () => {
    const deps = computeTemplateDependencies(
      wf([
        { type: "postgres_query", config: {} },
        { type: "mcp_tool", config: { serverId: "http_mcp" } },
        { type: "rag_retrieve", config: { vectorStoreId: "qdrant-vector-store" } },
        { type: "llm_call", config: { provider: { providerId: "anthropic", model: "claude-3" } } }
      ])
    );
    expect(deps.map((d) => d.kind)).toEqual([
      "provider",
      "vector_store",
      "mcp_server",
      "connector"
    ]);
  });

  it("handles raw workflow shape without the export wrapper", () => {
    const raw = {
      id: "wf",
      nodes: [
        { id: "a", type: "llm_call", name: "x", position: { x: 0, y: 0 },
          config: { provider: { providerId: "anthropic", model: "claude-3" } } }
      ],
      edges: []
    };
    const deps = computeTemplateDependencies(raw);
    expect(deps).toEqual([
      { kind: "provider", label: "Anthropic", envVar: "ANTHROPIC_API_KEY" }
    ]);
  });

  it("returns [] when given garbage input", () => {
    expect(computeTemplateDependencies(null)).toEqual([]);
    expect(computeTemplateDependencies(undefined)).toEqual([]);
    expect(computeTemplateDependencies("nope")).toEqual([]);
    expect(computeTemplateDependencies({})).toEqual([]);
    expect(computeTemplateDependencies({ workflow: { nodes: "not-an-array" } })).toEqual([]);
  });

  it("falls back to the raw providerId when adapter is unknown", () => {
    const deps = computeTemplateDependencies(
      wf([
        { type: "llm_call", config: { provider: { providerId: "some_future_provider", model: "x" } } }
      ])
    );
    expect(deps).toEqual([
      { kind: "provider", label: "some_future_provider", envVar: undefined }
    ]);
  });
});
