import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { TemplateListItem } from "../lib/api";
import * as api from "../lib/api";
import { TemplateGallery, modelPillText } from "./TemplateGallery";

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

    render(<TemplateGallery onWorkflowCreated={onWorkflowCreated} projectId="proj-team" />);

    await screen.findByText("Webhook Starter");
    await user.click(screen.getByRole("button", { name: "Use Template" }));

    // The new workflow goes into the project open in the studio.
    expect(api.useTemplate).toHaveBeenCalledWith("tpl-1", { projectId: "proj-team" });
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
            { kind: "provider", label: "OpenAI", envVar: "OPENAI_API_KEY", needsKey: true },
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
    // The validation's B12: say which key, not just "a model".
    expect(screen.getByTestId("tpl-needs-model-tpl-needs-openai")).toHaveTextContent("Needs an OpenAI key");
  });

  it("names every key a template needs, and says 'Needs a model' for a model server without a key", () => {
    expect(modelPillText([{ kind: "provider", label: "Anthropic", needsKey: true }])).toBe("Needs an Anthropic key");
    expect(modelPillText([{ kind: "provider", label: "Google Gemini", needsKey: true }])).toBe("Needs a Google Gemini key");
    expect(
      modelPillText([
        { kind: "provider", label: "OpenAI", needsKey: true },
        { kind: "provider", label: "Cohere", needsKey: true },
        { kind: "provider", label: "Ollama (local model server)" }
      ])
    ).toBe("Needs OpenAI and Cohere keys");
    expect(modelPillText([{ kind: "provider", label: "Ollama (local model server)" }])).toBe("Needs a model");
  });

  it("does not say a template needs a model when it only needs other setup", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [{ ...makeTemplate(), id: "tpl-pinecone", name: "Pinecone flow", dependencies: [{ kind: "vector_store", label: "Pinecone" }] }]
    });
    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);
    await screen.findByText("Pinecone flow");
    expect(screen.queryByTestId("tpl-needs-model-tpl-pinecone")).toBeNull();
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
    expect(depsContainer).toHaveTextContent(/runs without setup/i);
  });

  it("renders no dependency row at all when the field is undefined (back-compat)", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [makeTemplate()] // no `dependencies` field
    });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    await screen.findByText("Webhook Starter");
    expect(screen.queryByTestId("tpl-deps-tpl-1")).toBeNull();
  });

  it("renders the inline SVG thumbnail when thumbnailSvg is present", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [
        {
          ...makeTemplate(),
          id: "tpl-with-thumb",
          name: "With Thumbnail",
          thumbnailSvg: '<svg viewBox="0 0 320 96" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="96" fill="#f7fafc"/></svg>'
        }
      ]
    });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    await screen.findByText("With Thumbnail");
    const slot = screen.getByTestId("tpl-thumbnail-tpl-with-thumb");
    expect(slot.querySelector("svg")).not.toBeNull();
  });

  it("omits the thumbnail slot when thumbnailSvg is empty or missing", async () => {
    vi.mocked(api.fetchTemplates).mockResolvedValue({
      templates: [
        { ...makeTemplate(), id: "tpl-no-thumb-1", thumbnailSvg: "" },
        { ...makeTemplate(), id: "tpl-no-thumb-2" } // field absent
      ]
    });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);

    await screen.findAllByText("Webhook Starter");
    expect(screen.queryByTestId("tpl-thumbnail-tpl-no-thumb-1")).toBeNull();
    expect(screen.queryByTestId("tpl-thumbnail-tpl-no-thumb-2")).toBeNull();
  });

  it("offers a Starters category", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchTemplates).mockResolvedValue({ templates: [makeTemplate()] });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);
    await screen.findByText("Webhook Starter");
    await user.click(screen.getByRole("button", { name: "Starters" }));

    expect(api.fetchTemplates).toHaveBeenLastCalledWith({ category: "Starters" });
  });

  it("filters to templates that run without setup", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchTemplates).mockResolvedValue({ templates: [{ ...makeTemplate(), dependencies: [] }] });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);
    await screen.findByText("Webhook Starter");
    const filter = screen.getByRole("button", { name: "Runs without setup" });
    expect(filter).toHaveAttribute("aria-pressed", "false");
    await user.click(filter);

    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(api.fetchTemplates).toHaveBeenLastCalledWith({ withoutSetupOnly: true });
    expect(screen.getByTestId("tpl-deps-tpl-1")).toHaveTextContent("Runs without setup");
  });

  it("says when no template runs without setup in a category", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchTemplates).mockResolvedValueOnce({ templates: [makeTemplate()] }).mockResolvedValue({ templates: [] });

    render(<TemplateGallery onWorkflowCreated={vi.fn()} />);
    await screen.findByText("Webhook Starter");
    await user.click(screen.getByRole("button", { name: "Runs without setup" }));

    expect(await screen.findByText("No templates here run without setup.")).toBeInTheDocument();
  });
});

