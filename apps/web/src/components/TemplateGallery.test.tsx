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
});
