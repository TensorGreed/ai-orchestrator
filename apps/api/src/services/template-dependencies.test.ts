import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeTemplateDependencies } from "./template-dependencies";

const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../samples/workflows");

function sampleDependencies(fileName: string) {
  return computeTemplateDependencies(JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, fileName), "utf8")));
}

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
    expect(deps).toEqual([{ kind: "provider", label: "OpenAI", envVar: "OPENAI_API_KEY", needsKey: true }]);
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
      { kind: "provider", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", needsKey: true }
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

describe("the built-in templates and their model", () => {
  it.each(["agentic-mcp-flow.json", "conditional-flow.json", "rag-flow.json", "basic-flow.json", "mcp-agent-quickstart-flow.json"])(
    "%s runs on the built-in Echo model: it needs no model",
    (fileName) => {
      expect(sampleDependencies(fileName).filter((dep) => dep.kind === "provider")).toEqual([]);
    }
  );

  it.each(["structured-output-flow.json", "two-turn-report-code-helper-flow.json", "vscode-l2m-coding-agent-flow.json"])(
    "%s says it needs a model",
    (fileName) => {
      expect(sampleDependencies(fileName).some((dep) => dep.kind === "provider")).toBe(true);
    }
  );

  it("no built-in template sends a node to a local Ollama unless it says it needs a model", () => {
    for (const fileName of fs.readdirSync(SAMPLES_DIR).filter((name) => name.endsWith(".json"))) {
      const raw = fs.readFileSync(path.join(SAMPLES_DIR, fileName), "utf8");
      if (!raw.includes("11434")) continue;
      expect(sampleDependencies(fileName), fileName).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "provider", label: "Ollama (local model server)" })]));
    }
  });

  it("counts a dedicated chat model node as a model dependency", () => {
    expect(computeTemplateDependencies(wf([{ type: "openai_chat_model", config: { model: "gpt-4o-mini" } }]))).toEqual([
      { kind: "provider", label: "OpenAI", envVar: "OPENAI_API_KEY", needsKey: true }
    ]);
    expect(computeTemplateDependencies(wf([{ type: "ollama_chat_model", config: { model: "llama3.1" } }]))).toEqual([
      { kind: "provider", label: "Ollama (local model server)", envVar: undefined }
    ]);
  });

  it("does not count the in-memory store or the token embedder, but counts a knowledge base, a remote embedder and HTML PDFs", () => {
    expect(computeTemplateDependencies(wf([{ type: "rag_retrieve", config: { vectorStoreId: "in-memory-vector-store", embedderId: "token-embedder" } }]))).toEqual([]);
    expect(computeTemplateDependencies(wf([{ type: "rag_retrieve", config: { vectorStoreId: "knowledge-base" } }]))).toEqual([
      { kind: "vector_store", label: "Knowledge base", envVar: undefined }
    ]);
    expect(computeTemplateDependencies(wf([{ type: "rag_retrieve", config: { embedderId: "cohere-embedder" } }]))).toEqual([
      { kind: "provider", label: "Cohere", envVar: "COHERE_API_KEY", needsKey: true }
    ]);
    expect(computeTemplateDependencies(wf([{ type: "pdf_output", config: { renderMode: "html" } }]))).toEqual([
      { kind: "connector", label: "Chromium for PDF rendering", envVar: "PDF_CHROMIUM_EXECUTABLE_PATH" }
    ]);
    expect(computeTemplateDependencies(wf([{ type: "pdf_output", config: { renderMode: "text" } }]))).toEqual([]);
  });

  it("marks the RAG with Citations template as needing an OpenAI key (the validation's B12)", () => {
    expect(sampleDependencies("rag-with-citations-flow.json")).toEqual(
      expect.arrayContaining([{ kind: "provider", label: "OpenAI", envVar: "OPENAI_API_KEY", needsKey: true }])
    );
  });

  it("lists the knowledge-base and HTML-PDF samples as needing setup", () => {
    expect(sampleDependencies("rag-knowledge-base-flow.json").length).toBeGreaterThan(0);
    expect(sampleDependencies("report-with-charts-flow.json").length).toBeGreaterThan(0);
  });

  it("counts the dependencies of the companion workflows a template brings", () => {
    const template = { ...wf([{ type: "execute_workflow", config: { workflowId: "child" } }]), companions: [wf([{ type: "slack_send_message" }])] };
    expect(computeTemplateDependencies(template)).toEqual([{ kind: "connector", label: "Slack", envVar: undefined }]);
  });
});
