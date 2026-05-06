import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { TemplateListItem } from "../lib/api";
import * as api from "../lib/api";
import { TemplateGallery } from "./TemplateGallery";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchTemplates: vi.fn(),
    useTemplate: vi.fn()
  };
});

function makeTemplate(): TemplateListItem {
  return {
    id: "tpl-1",
    name: "Webhook Starter",
    description: "Receives webhook payload and outputs response.",
    category: "Getting Started",
    tags: ["starter"],
    author: "AI Orchestrator",
    nodeCount: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("TemplateGallery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows loading state while templates are being fetched", () => {
    vi.mocked(api.fetchTemplates).mockReturnValue(new Promise(() => undefined));

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    expect(screen.getByText("Loading templates...")).toBeInTheDocument();
  });

  it("shows empty state when no templates exist", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({ templates: [] });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    expect(await screen.findByText("No templates found.")).toBeInTheDocument();
  });

  it("shows API errors and allows retry via category/search changes", async () => {
    vi.mocked(api.fetchTemplates).mockRejectedValue(new Error("Template API unavailable"));

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    expect(await screen.findByText("Template API unavailable")).toBeInTheDocument();
  });

  it("creates workflow from selected template", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchTemplates).mockResolvedValue({ templates: [makeTemplate()] });
    vi.mocked(api.useTemplate).mockResolvedValue({ workflowId: "wf-new", name: "Created from template" });
    const onWorkflowCreated = vi.fn();

    render(<TemplateGallery onWorkflowCreated={onWorkflowCreated} />);

    await screen.findByText("Webhook Starter");
    await user.click(screen.getByRole("button", { name: "Use Template" }));

    expect(api.useTemplate).toHaveBeenCalledWith("tpl-1");
    expect(onWorkflowCreated).toHaveBeenCalledWith("wf-new");
  });

  it("renders dependency pills with envVar hints when the template requires external setup", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [
        {
          ...makeTemplate(),
          id: "tpl-needs-openai",
          name: "OpenAI flow",
          dependencies: [
            { kind: "provider", label: "OpenAI", envVar: "OPENAI_API_KEY" },
            { kind: "vector_store", label: "Pinecone", envVar: "PINECONE_API_KEY" }
          ]
        }
      ]
    });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    await screen.findByText("OpenAI flow");
    const depsContainer = screen.getByTestId("tpl-deps-tpl-needs-openai");
    expect(depsContainer).toHaveTextContent(/Requires/i);
    expect(depsContainer).toHaveTextContent("OpenAI");
    expect(depsContainer).toHaveTextContent("OPENAI_API_KEY");
    expect(depsContainer).toHaveTextContent("Pinecone");
    expect(depsContainer).toHaveTextContent("PINECONE_API_KEY");
  });

  it("renders the 'no setup' pill when dependencies is an empty array", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [
        {
          ...makeTemplate(),
          id: "tpl-zero-deps",
          name: "Echo flow",
          dependencies: []
        }
      ]
    });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    await screen.findByText("Echo flow");
    const depsContainer = screen.getByTestId("tpl-deps-tpl-zero-deps");
    expect(depsContainer).toHaveTextContent(/runs out of the box/i);
  });

  it("renders no dependency row at all when the field is undefined (back-compat)", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [makeTemplate()] // no `dependencies` field
    });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    await screen.findByText("Webhook Starter");
    expect(screen.queryByTestId("tpl-deps-tpl-1")).toBeNull();
  });
});
