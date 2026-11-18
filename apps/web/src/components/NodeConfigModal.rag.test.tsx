/**
 * The editor fields for RAG Retrieve (knowledge base, search mode, hybrid weights), Rerank (its secret), the IF
 * condition preview and the Output Parser's retries: what the node schema has, the form has.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchKnowledgeBases: vi.fn(), previewExpression: vi.fn(), fetchProviderModels: vi.fn() };
});

function node(nodeType: string, config: Record<string, unknown>): Node<EditorNodeData> {
  return { id: "n1", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Node", nodeType, config } } as Node<EditorNodeData>;
}

function props(target: Node<EditorNodeData>, overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: target,
    inputOptions: [],
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {}, projectId: "proj-a" },
    pinnedData: {},
    secrets: [{ id: "sec-cohere", name: "Cohere key", provider: "custom" } as never],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave: vi.fn(),
    ...overrides
  };
}

const KBS = [
  { id: "kb-docs", name: "Product docs", embedderId: "openai-embedder", chunkCount: 120 },
  { id: "kb-faq", name: "FAQ", embedderId: "token-embedder", chunkCount: 8 }
] as Awaited<ReturnType<typeof api.fetchKnowledgeBases>>["knowledgeBases"];

async function save(onSave: ReturnType<typeof vi.fn>) {
  await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  return onSave.mock.calls.at(-1)![0].config as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchKnowledgeBases).mockResolvedValue({ knowledgeBases: KBS });
  vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
});

describe("RAG Retrieve fields", () => {
  it("shows the engine's defaults and offers every store and embedder the node runs", () => {
    render(<NodeInspector {...props(node("rag_retrieve", { queryTemplate: "{{user_prompt}}" }))} />);
    const store = screen.getByRole("combobox", { name: "Vector Store" }) as HTMLSelectElement;
    expect(store).toHaveValue("in-memory-vector-store");
    expect(Array.from(store.options).map((option) => option.value)).toEqual([
      "in-memory-vector-store",
      "knowledge-base",
      "pinecone-vector-store",
      "azure-ai-search-vector-store",
      "qdrant-vector-store",
      "pgvector-store",
      "chroma-vector-store",
      "weaviate-vector-store",
      "redis-vector-store"
    ]);
    const embedder = screen.getByRole("combobox", { name: "Embedder" }) as HTMLSelectElement;
    expect(embedder).toHaveValue("token-embedder");
    expect(Array.from(embedder.options).map((option) => option.value)).toContain("cohere-embedder");
    // Knowledge-base fields show only for the knowledge-base store.
    expect(screen.queryByRole("combobox", { name: "Knowledge Base" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Search Mode/ })).toBeNull();
  });

  it("picks a knowledge base of the workflow's project, follows its embedder and sets a hybrid search", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props(node("rag_retrieve", { vectorStoreId: "knowledge-base", embedderId: "token-embedder" }), { onSave })} />);
    await waitFor(() => expect(api.fetchKnowledgeBases).toHaveBeenCalledWith("proj-a"));
    const kb = await screen.findByRole("combobox", { name: /Knowledge Base/ });
    await screen.findByRole("option", { name: "Product docs (120 chunks)" });
    await user.selectOptions(kb, "kb-docs");
    expect(screen.getByRole("combobox", { name: "Embedder" })).toHaveValue("openai-embedder");

    const mode = screen.getByRole("combobox", { name: /Search Mode/ });
    expect(mode).toHaveValue("vector");
    // Hybrid tuning shows only for hybrid search.
    expect(screen.queryByLabelText(/RRF k/)).toBeNull();
    await user.selectOptions(mode, "hybrid");
    const advanced = screen.getByTestId("advanced-fields");
    await user.click(within(advanced).getByText("Advanced"));
    await user.type(screen.getByLabelText(/Keyword Weight/), "2");
    await user.type(screen.getByLabelText(/RRF k/), "30");
    expect(within(advanced).getByText("2 set")).toBeInTheDocument();

    const config = await save(onSave);
    expect(config).toMatchObject({ vectorStoreId: "knowledge-base", knowledgeBaseId: "kb-docs", embedderId: "openai-embedder", searchMode: "hybrid", bm25Weight: 2, rrfK: 30 });
    expect(config).not.toHaveProperty("candidatesPerRanker");
  });

  it("reads a knowledge base id kept in the store config, warns on an embedder mismatch, and moves the id when changed", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NodeInspector
        {...props(node("rag_retrieve", { vectorStoreId: "knowledge-base", embedderId: "token-embedder", vectorStoreConfig: { knowledgeBaseId: "kb-docs" } }), { onSave })}
      />
    );
    const kb = await screen.findByRole("combobox", { name: /Knowledge Base/ });
    await screen.findByRole("option", { name: "Product docs (120 chunks)" });
    expect(kb).toHaveValue("kb-docs");
    expect(screen.getByRole("note")).toHaveTextContent(/built with openai-embedder/);
    await user.selectOptions(kb, "kb-faq");
    expect(screen.queryByRole("note")).toBeNull();
    const config = await save(onSave);
    expect(config.knowledgeBaseId).toBe("kb-faq");
    expect(config.vectorStoreConfig).toBeUndefined();
  });

  it("keeps typed JSON until it parses: inline documents can be typed key by key", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props(node("rag_retrieve", {}), { onSave })} />);
    await user.click(within(screen.getByTestId("advanced-fields")).getByText("Advanced"));
    const field = screen.getByLabelText(/Inline Documents/);
    await user.clear(field);
    await user.type(field, '[["Refunds take 5 days."]');
    expect(field).toHaveValue('["Refunds take 5 days."]');
    const config = await save(onSave);
    expect(config.documents).toEqual(["Refunds take 5 days."]);
  });

  it("says why a JSON field has not changed the node", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props(node("rag_retrieve", {}))} />);
    await user.click(within(screen.getByTestId("advanced-fields")).getByText("Advanced"));
    const field = screen.getByLabelText(/Inline Documents/);
    await user.clear(field);
    await user.type(field, "{{");
    expect(field).toHaveValue("{");
    expect(screen.getByText(/Not valid JSON yet/)).toBeInTheDocument();
    await user.type(field, "}");
    expect(screen.getByText(/Use a JSON array/)).toBeInTheDocument();
  });

  it("drops the knowledge-base settings when the store changes", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NodeInspector
        {...props(
          node("rag_retrieve", {
            vectorStoreId: "knowledge-base",
            knowledgeBaseId: "kb-docs",
            searchMode: "hybrid",
            rrfK: 30,
            vectorStoreConfig: { knowledgeBaseId: "kb-docs", indexName: "x" }
          }),
          { onSave }
        )}
      />
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Vector Store" }), "qdrant-vector-store");
    const config = await save(onSave);
    expect(config).toMatchObject({ vectorStoreId: "qdrant-vector-store", vectorStoreConfig: { indexName: "x" } });
    for (const key of ["knowledgeBaseId", "searchMode", "rrfK"]) expect(config).not.toHaveProperty(key);
  });

  it("says when the knowledge bases cannot be loaded", async () => {
    vi.mocked(api.fetchKnowledgeBases).mockRejectedValue(new Error("forbidden"));
    render(<NodeInspector {...props(node("rag_retrieve", { vectorStoreId: "knowledge-base" }))} />);
    expect(await screen.findByText(/Failed to load knowledge bases: forbidden/)).toBeInTheDocument();
  });
});

describe("Rerank fields", () => {
  it("has every schema field, the secret picker included", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props(node("rerank", { queryTemplate: "{{user_prompt}}", topN: 3, providerId: "cohere", model: "rerank-english-v3.0" }), { onSave })} />);
    expect(screen.getByRole("combobox", { name: /Provider Id/i })).toHaveValue("cohere");
    expect(screen.getByLabelText(/^Model/)).toHaveValue("rerank-english-v3.0");
    expect(screen.getByLabelText(/Top N/i)).toHaveValue(3);
    const secret = screen.getByRole("combobox", { name: /Reranker API Key Secret/ });
    await user.selectOptions(secret, "sec-cohere");
    const config = await save(onSave);
    expect(config.secretRef).toEqual({ secretId: "sec-cohere" });
  });
});

describe("IF condition", () => {
  it("previews the condition as true or false", async () => {
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: false });
    render(<NodeInspector {...props(node("if_node", { condition: "{{userScore}} > 90" }))} />);
    await waitFor(() => expect(api.previewExpression).toHaveBeenCalled());
    expect(vi.mocked(api.previewExpression).mock.calls[0]![0]).toMatchObject({ expression: "{{userScore}} > 90", mode: "condition" });
  });
});

describe("Output Parser retries", () => {
  it("keeps 0 retries", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<NodeInspector {...props(node("output_parser", { mode: "json_schema", maxRetries: 2 }), { onSave })} />);
    const field = screen.getByLabelText(/LLM Max Auto-Retries/);
    await user.clear(field);
    await user.type(field, "0");
    const config = await save(onSave);
    expect(config.maxRetries).toBe(0);
  });
});
