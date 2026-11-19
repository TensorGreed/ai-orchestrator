import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { KnowledgeBasePage } from "./KnowledgeBasePage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchKnowledgeBases: vi.fn(),
    createKnowledgeBase: vi.fn(),
    fetchKnowledgeBase: vi.fn(),
    fetchSecrets: vi.fn()
  };
});

const created = { id: "kb_1", name: "Docs", description: null, projectId: null, embedderId: "openai-embedder", embedderConfig: {}, chunkCount: 0, sourceCount: 0, createdAt: "", updatedAt: "" };

async function openCreateForm() {
  const user = userEvent.setup();
  render(<KnowledgeBasePage isAdmin activeProjectId={null} />);
  await user.click(await screen.findByRole("button", { name: "+ New knowledge base" }));
  await user.type(screen.getByPlaceholderText("Helpdesk corpus"), "Docs");
  return user;
}

describe("Knowledge base embedder settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchKnowledgeBases).mockResolvedValue({ knowledgeBases: [] } as never);
    vi.mocked(api.createKnowledgeBase).mockResolvedValue({ knowledgeBase: created } as never);
    vi.mocked(api.fetchKnowledgeBase).mockResolvedValue({ knowledgeBase: created, sources: [] } as never);
    vi.mocked(api.fetchSecrets).mockResolvedValue([{ id: "sec_openai", name: "OpenAI team key", provider: "openai", createdAt: "" }]);
  });

  it("asks nothing more for the built-in embedder", async () => {
    const user = await openCreateForm();
    expect(screen.queryByLabelText("Embedder key")).toBeNull();
    expect(screen.queryByText(/embedderConfig/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create knowledge base" }));
    expect(api.createKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({ embedderId: "token-embedder", embedderConfig: {} }));
    expect(api.fetchSecrets).not.toHaveBeenCalled();
  });

  it("sets a model and a key from Secrets with fields, not JSON", async () => {
    const user = await openCreateForm();
    await user.selectOptions(screen.getByLabelText("Embedder"), "openai-embedder");
    await waitFor(() => expect(screen.getByRole("option", { name: "OpenAI team key" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Embedder key"), "sec_openai");
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "text-embedding-3-large" } });
    await user.click(screen.getByRole("button", { name: "Create knowledge base" }));
    expect(api.createKnowledgeBase).toHaveBeenCalledWith(
      expect.objectContaining({ embedderId: "openai-embedder", embedderConfig: { secretRef: { secretId: "sec_openai" }, model: "text-embedding-3-large" } })
    );
  });

  it("drops settings the next embedder does not read, and keeps the key", async () => {
    const user = await openCreateForm();
    await user.selectOptions(screen.getByLabelText("Embedder"), "openai-embedder");
    await waitFor(() => expect(screen.getByRole("option", { name: "OpenAI team key" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Embedder key"), "sec_openai");
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://proxy.example.com/v1" } });
    await user.selectOptions(screen.getByLabelText("Embedder"), "cohere-embedder");
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create knowledge base" }));
    expect(api.createKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({ embedderId: "cohere-embedder", embedderConfig: { secretRef: { secretId: "sec_openai" } } }));
  });
});
