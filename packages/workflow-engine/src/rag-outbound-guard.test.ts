/**
 * RAG endpoints set on a node (vector store `endpoint`, embedder `baseUrl`,
 * the Azure embeddings node's `endpoint`) go through the outbound URL guard:
 * metadata and link-local are always refused, and the connection is pinned.
 * Endpoints that come from deployment settings (env fallbacks) are not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowEdge, WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

const node = (id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config });
const edge = (source: string, target: string): WorkflowEdge => ({ id: `${source}-${target}`, source, target });
const workflow = (nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({ id: "wf-rag-guard", name: "RAG guard", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges });

function deps(resolved: string[]): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: { id: "none", run: async () => ({ finalAnswer: "", stopReason: "final_answer", iterations: 0, messages: [], steps: [] }) },
    resolveSecret: async () => "test-key",
    outboundDnsResolver: async () => resolved
  };
}

const ragWorkflow = (vectorStoreId: string, vectorStoreConfig: Record<string, unknown>, embedderId = "token-embedder") =>
  workflow(
    [
      node("input", "text_input", { text: "find it" }),
      node("rag", "rag_retrieve", { queryTemplate: "{{user_prompt}}", embedderId, vectorStoreId, vectorStoreConfig, embeddingSecretRef: { secretId: "s" } }),
      node("output", "output")
    ],
    [edge("input", "rag"), edge("rag", "output")]
  );

afterEach(() => vi.unstubAllGlobals());

describe("RAG endpoints from node config go through the outbound guard", () => {
  const cases: Array<[string, Record<string, unknown>, string?]> = [
    ["qdrant-vector-store", { endpoint: "http://169.254.169.254/latest", collectionName: "c" }],
    ["chroma-vector-store", { endpoint: "http://metadata.google.internal", collectionName: "c" }],
    ["weaviate-vector-store", { endpoint: "http://[fd00:ec2::254]", className: "C" }],
    ["redis-vector-store", { endpoint: "http://169.254.169.254", indexName: "i" }],
    ["azure-ai-search-vector-store", { endpoint: "http://169.254.169.254", indexName: "i" }],
    ["in-memory-vector-store", { baseUrl: "http://169.254.169.254/v1" }, "openai-embedder"]
  ];

  for (const [storeId, storeConfig, embedderId] of cases) {
    it(`${embedderId ?? storeId} refuses a metadata endpoint without sending a request`, async () => {
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      const started = Date.now();
      const result = await executeWorkflow({ workflow: ragWorkflow(storeId, storeConfig, embedderId) }, deps(["93.184.216.34"]));
      const rag = result.nodeResults.find((entry) => entry.nodeId === "rag")!;
      expect(rag.status, JSON.stringify(rag.error)).toBe("error");
      expect(String(rag.error)).toMatch(/metadata|link local/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      // A policy refusal is not retried (the default retry waits 2 s first).
      expect(Date.now() - started).toBeLessThan(1500);
    });
  }

  it("refuses a node endpoint whose name resolves to the metadata address", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await executeWorkflow({ workflow: ragWorkflow("qdrant-vector-store", { endpoint: "http://vectors.evil.test", collectionName: "c" }) }, deps(["169.254.169.254"]));
    expect(result.nodeResults.find((entry) => entry.nodeId === "rag")!.status).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets an allowed node endpoint through", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await executeWorkflow({ workflow: ragWorkflow("qdrant-vector-store", { endpoint: "https://vectors.example.com", collectionName: "c" }) }, deps(["93.184.216.34"]));
    expect(result.nodeResults.find((entry) => entry.nodeId === "rag")!.status).toBe("success");
    expect(String((fetchSpy.mock.calls[0] as unknown[] | undefined)?.[0])).toMatch(/^https:\/\/vectors\.example\.com\/collections\/c\//);
  });

  it("the Azure embeddings node's endpoint is checked too", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await executeWorkflow(
      {
        workflow: workflow(
          [node("input", "text_input", { text: "embed me" }), node("emb", "embeddings_azure_openai", { endpoint: "http://169.254.169.254", deployment: "d", secretRef: { secretId: "s" } }), node("output", "output")],
          [edge("input", "emb"), edge("emb", "output")]
        )
      },
      deps(["93.184.216.34"])
    );
    expect(result.nodeResults.find((entry) => entry.nodeId === "emb")!.status).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a node-supplied RAG endpoint never receives the deployment's env API key (REREVIEW-A12 L-b)", () => {
  const withoutSecret = (vectorStoreId: string, vectorStoreConfig: Record<string, unknown>, embedderId = "token-embedder") =>
    workflow(
      [
        node("input", "text_input", { text: "find it" }),
        node("rag", "rag_retrieve", { queryTemplate: "{{user_prompt}}", embedderId, vectorStoreId, vectorStoreConfig }),
        node("output", "output")
      ],
      [edge("input", "rag"), edge("rag", "output")]
    );
  const ENV = { QDRANT_API_KEY: "ENV-QDRANT-KEY", OPENAI_API_KEY: "ENV-OPENAI-KEY", QDRANT_ENDPOINT: "https://env-qdrant.example.com" };
  const saved: Record<string, string | undefined> = {};
  const sentHeaders = (fetchSpy: ReturnType<typeof vi.fn>) =>
    fetchSpy.mock.calls
      .map((call) => {
        const values: string[] = [];
        new Headers(((call as unknown[])[1] as RequestInit | undefined)?.headers).forEach((value, name) => values.push(`${name}=${value}`));
        return values.join(";");
      })
      .join(" ");

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const setEnv = () => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  };

  it("qdrant at a node endpoint is called without QDRANT_API_KEY", async () => {
    setEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    await executeWorkflow({ workflow: withoutSecret("qdrant-vector-store", { endpoint: "https://collector.example.net", collectionName: "c" }) }, deps(["93.184.216.34"]));
    expect(fetchSpy).toHaveBeenCalled();
    expect(sentHeaders(fetchSpy)).not.toContain("ENV-QDRANT-KEY");
  });

  it("the OpenAI embedder at a node baseUrl is called without OPENAI_API_KEY", async () => {
    setEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    await executeWorkflow({ workflow: withoutSecret("in-memory-vector-store", { baseUrl: "https://collector.example.net/v1" }, "openai-embedder") }, deps(["93.184.216.34"]));
    expect(fetchSpy).toHaveBeenCalled();
    expect(sentHeaders(fetchSpy)).not.toContain("ENV-OPENAI-KEY");
  });

  it("the deployment's own endpoint (env) still gets the env key", async () => {
    setEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    await executeWorkflow({ workflow: withoutSecret("qdrant-vector-store", { collectionName: "c" }) }, deps(["93.184.216.34"]));
    expect(String((fetchSpy.mock.calls[0] as unknown[] | undefined)?.[0])).toMatch(/^https:\/\/env-qdrant\.example\.com\//);
    expect(sentHeaders(fetchSpy)).toContain("ENV-QDRANT-KEY");
  });
});
