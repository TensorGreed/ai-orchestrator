import { describe, expect, it, vi } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry, createGatedProviderRegistry, ModelNotAllowedError, type GatedModelCall } from "@ai-orchestrator/provider-sdk";
import { ErrorCategory, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { workflowModelReferences } from "./model-references";

const position = { x: 0, y: 0 };

describe("workflowModelReferences", () => {
  it("lists each node's saved model, with Azure deployments and provider configs, and skips expressions", () => {
    const references = workflowModelReferences({
      nodes: [
        { id: "llm", type: "llm_call", name: "Ask", position, config: { provider: { providerId: "openai", model: "gpt-4o" } } },
        { id: "templated", type: "llm_call", name: "Dynamic", position, config: { provider: { providerId: "openai", model: "{{vars.model}}" } } },
        { id: "azure", type: "azure_openai_chat_model", name: "", position, config: { endpoint: "https://x.openai.azure.com", deployment: "prod-4o" } },
        { id: "anthropic", type: "anthropic_chat_model", name: "Claude", position, config: { model: "claude-sonnet-5-5" } },
        { id: "parser", type: "output_parser", name: "Parser", position, config: { provider: { providerId: "ollama", model: "llama3.1" } } },
        { id: "text", type: "text_input", name: "Text", position, config: { text: "x" } }
      ]
    });
    expect(references).toEqual([
      { nodeId: "llm", nodeName: "Ask", providerId: "openai", model: "gpt-4o" },
      { nodeId: "azure", nodeName: "azure_openai_chat_model", providerId: "azure_openai", model: "prod-4o" },
      { nodeId: "anthropic", nodeName: "Claude", providerId: "anthropic", model: "claude-sonnet-5-5" },
      { nodeId: "parser", nodeName: "Parser", providerId: "ollama", model: "llama3.1" }
    ]);
  });
});

describe("a model the allowlist refuses", () => {
  it("fails the node once, with its category, even when the node retries errors", async () => {
    const calls: GatedModelCall[] = [];
    const providerRegistry = createGatedProviderRegistry(createDefaultProviderRegistry(), (call) => {
      calls.push(call);
      throw new ModelNotAllowedError(`Model "${call.model}" is not allowed.`, { providerId: call.providerId, model: call.model, refusedBy: "deployment" });
    });
    const workflow: Workflow = {
      id: "wf-refused",
      name: "Refused",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "input", type: "text_input", name: "Input", position, config: { text: "hello" } },
        { id: "llm", type: "llm_call", name: "LLM", position, config: { provider: { providerId: "echo", model: "m" }, retry: { enabled: true, maxAttempts: 3, delayMs: 1 } } },
        { id: "output", type: "output", name: "Output", position, config: { responseTemplate: "{{answer}}" } }
      ],
      edges: [
        { id: "e1", source: "input", target: "llm" },
        { id: "e2", source: "llm", target: "output" }
      ]
    };
    const result = await executeWorkflow(
      { workflow },
      { providerRegistry, connectorRegistry: createDefaultConnectorRegistry(), mcpRegistry: createDefaultMCPRegistry(), agentRuntime: createDefaultAgentRuntime(), resolveSecret: async () => undefined }
    );
    const node = result.nodeResults.find((entry) => entry.nodeId === "llm")!;
    expect(node).toMatchObject({ status: "error", errorCategory: ErrorCategory.MODEL_NOT_ALLOWED, retryable: false, error: 'Model "m" is not allowed.' });
    expect(calls).toHaveLength(1);
  });
});

describe("embedding calls and the model allowlist", () => {
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type: type as Workflow["nodes"][number]["type"], name: id, position, config });
  const ragWorkflow = (embedderId: string, vectorStoreConfig: Record<string, unknown> = {}): Workflow => ({
    id: "wf-embed",
    name: "Embed",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("input", "text_input", { text: "find it" }),
      node("rag", "rag_retrieve", {
        queryTemplate: "{{user_prompt}}",
        embedderId,
        vectorStoreId: "in-memory-vector-store",
        vectorStoreConfig,
        embeddingSecretRef: { secretId: "s" },
        documents: [{ id: "d1", text: "a document" }]
      }),
      node("output", "output")
    ],
    edges: [
      { id: "e1", source: "input", target: "rag" },
      { id: "e2", source: "rag", target: "output" }
    ]
  });
  const azureNodeWorkflow: Workflow = {
    id: "wf-azure-embed",
    name: "Azure embed",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("input", "text_input", { text: "embed me" }),
      node("rag", "embeddings_azure_openai", { endpoint: "https://example.openai.azure.com", deployment: "prod-embed", secretRef: { secretId: "s" } }),
      node("output", "output")
    ],
    edges: [
      { id: "e1", source: "input", target: "rag" },
      { id: "e2", source: "rag", target: "output" }
    ]
  };
  const embeddingResponse = () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], embeddings: [[0.1, 0.2]], embedding: { values: [0.1, 0.2] } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  const cases: Array<[string, Workflow, { providerId: string; model: string }]> = [
    ["openai-embedder", ragWorkflow("openai-embedder", { model: "text-embedding-3-large" }), { providerId: "openai", model: "text-embedding-3-large" }],
    ["azure-openai-embedder", ragWorkflow("azure-openai-embedder", { endpoint: "https://example.openai.azure.com", deployment: "kb-embed" }), { providerId: "azure_openai", model: "kb-embed" }],
    ["cohere-embedder", ragWorkflow("cohere-embedder"), { providerId: "cohere", model: "embed-english-v3.0" }],
    ["mistral-embedder", ragWorkflow("mistral-embedder"), { providerId: "mistral", model: "mistral-embed" }],
    ["google-vertex-embedder", ragWorkflow("google-vertex-embedder", { model: "text-embedding-004" }), { providerId: "gemini", model: "text-embedding-004" }],
    ["huggingface-embedder", ragWorkflow("huggingface-embedder"), { providerId: "huggingface", model: "sentence-transformers/all-MiniLM-L6-v2" }],
    ["the Azure OpenAI embeddings node", azureNodeWorkflow, { providerId: "azure_openai", model: "prod-embed" }]
  ];

  const deps = (checkEmbeddingModel?: (target: { providerId: string; model: string }, context: { nodeId: string }) => Promise<void>) => ({
    providerRegistry: createDefaultProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: createDefaultAgentRuntime(),
    resolveSecret: async () => "test-key",
    outboundDnsResolver: async () => ["93.184.216.34"],
    ...(checkEmbeddingModel ? { checkEmbeddingModel } : {})
  });

  for (const [label, workflow, target] of cases) {
    it(`${label}: a refused embedding model fails the node before any text is sent; an allowed one is sent`, async () => {
      const fetchSpy = vi.fn(async () => embeddingResponse());
      vi.stubGlobal("fetch", fetchSpy);
      try {
        const seen: Array<{ providerId: string; model: string; nodeId: string }> = [];
        const refused = await executeWorkflow({ workflow }, deps(async (call, context) => {
          seen.push({ ...call, nodeId: context.nodeId });
          throw new ModelNotAllowedError(`Model "${call.model}" is not allowed.`, { providerId: call.providerId, model: call.model, refusedBy: "deployment" });
        }));
        expect(refused.nodeResults.find((entry) => entry.nodeId === "rag")).toMatchObject({ status: "error", errorCategory: ErrorCategory.MODEL_NOT_ALLOWED, retryable: false });
        expect(seen[0]).toEqual({ ...target, nodeId: "rag" });
        expect(fetchSpy).not.toHaveBeenCalled();

        const allowed = await executeWorkflow({ workflow }, deps(async () => undefined));
        expect(allowed.nodeResults.find((entry) => entry.nodeId === "rag")?.status, JSON.stringify(allowed.nodeResults)).toBe("success");
        expect(fetchSpy).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  }

  it("the token embedder is local and never checked", async () => {
    const check = vi.fn(async () => undefined);
    const result = await executeWorkflow({ workflow: ragWorkflow("token-embedder") }, deps(check));
    expect(result.nodeResults.find((entry) => entry.nodeId === "rag")?.status).toBe("success");
    expect(check).not.toHaveBeenCalled();
  });
});
