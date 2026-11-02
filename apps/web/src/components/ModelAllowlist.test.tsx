import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "reactflow";
import type { ModelAllowlistEntry, Project } from "@ai-orchestrator/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import type { EditorNodeData } from "../lib/workflow";
import { GuardSecurityPage } from "./GuardSecurityPage";
import { ModelAllowlistView } from "./ModelAllowlistView";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchModelAllowlist: vi.fn(),
    addModelAllowlistEntry: vi.fn(),
    removeModelAllowlistEntry: vi.fn(),
    checkModelAllowlist: vi.fn(),
    fetchGuardProfiles: vi.fn(async () => ({ profiles: [] })),
    fetchGuardStats: vi.fn(async () => ({ stats: { verdicts: [], categories: [], channels: [], detectors: [], daily: [], shadow: [] } })),
    fetchGuardEvents: vi.fn(async () => ({ events: [], total: 0 }))
  };
});

const projects = [
  { id: "default", name: "Default" },
  { id: "p1", name: "Payments" }
] as Project[];

function entry(partial: Partial<ModelAllowlistEntry>): ModelAllowlistEntry {
  return { id: "mal_1", scope: "deployment", projectId: null, providerId: "openai", modelGlob: "gpt-4o*", note: null, createdAt: "2026-11-02T10:00:00.000Z", createdBy: "admin@example.com", ...partial };
}

const providers = [
  { id: "*", name: "Any provider" },
  { id: "echo", name: "Echo (built-in demo)" },
  { id: "openai", name: "OpenAI" }
];

beforeEach(() => {
  vi.mocked(api.fetchModelAllowlist).mockReset();
  vi.mocked(api.addModelAllowlistEntry).mockReset();
  vi.mocked(api.removeModelAllowlistEntry).mockReset();
  vi.mocked(api.checkModelAllowlist).mockReset();
});

describe("Security → Models", () => {
  it("is a tab of the Security page", async () => {
    vi.mocked(api.fetchModelAllowlist).mockResolvedValue({ entries: [], providers, canEdit: true });
    const user = userEvent.setup();
    render(<GuardSecurityPage projects={projects} workflows={[]} role="admin" />);
    await user.click(screen.getByRole("tab", { name: "Models" }));
    expect(await screen.findByText(/a project list can\s+only narrow the deployment list/)).toBeInTheDocument();
    expect(screen.getByText(/No deployment list: every provider and model is allowed/)).toBeInTheDocument();
  });

  it("lets an admin add and remove deployment entries", async () => {
    const listed = entry({});
    vi.mocked(api.fetchModelAllowlist).mockResolvedValueOnce({ entries: [], providers, canEdit: true }).mockResolvedValue({ entries: [listed], providers, canEdit: true });
    vi.mocked(api.addModelAllowlistEntry).mockResolvedValue({ entry: listed });
    vi.mocked(api.removeModelAllowlistEntry).mockResolvedValue({ ok: true, entry: listed });
    const user = userEvent.setup();
    render(<ModelAllowlistView projects={projects} activeProjectId="p1" />);
    const form = await screen.findByRole("form", { name: "Add a deployment entry" });
    await user.selectOptions(within(form).getByLabelText("Provider"), "openai");
    await user.type(within(form).getByLabelText("Model pattern"), "gpt-4o*");
    await user.type(within(form).getByLabelText("Note"), "Approved");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(api.addModelAllowlistEntry).toHaveBeenCalledWith({ scope: "deployment", providerId: "openai", modelGlob: "gpt-4o*", note: "Approved" });
    const table = await screen.findByRole("table", { name: "Deployment models" });
    expect(within(table).getByText("OpenAI")).toBeInTheDocument();
    expect(within(table).getByText("gpt-4o*")).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Remove OpenAI gpt-4o*" }));
    expect(api.removeModelAllowlistEntry).toHaveBeenCalledWith("mal_1");
  });

  it("edits the selected project's override, and shows another project's list only when selected", async () => {
    const projectEntry = entry({ id: "mal_p", scope: "project", projectId: "p1", providerId: "*", modelGlob: "small-*" });
    vi.mocked(api.fetchModelAllowlist).mockResolvedValue({ entries: [projectEntry], providers, canEdit: true });
    vi.mocked(api.addModelAllowlistEntry).mockResolvedValue({ entry: projectEntry });
    const user = userEvent.setup();
    render(<ModelAllowlistView projects={projects} activeProjectId="default" />);
    expect(await screen.findByText(/No list for Default/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Payments (has a list)" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Project"), "p1");
    const table = await screen.findByRole("table", { name: "Models for Payments" });
    expect(within(table).getByText("Any provider")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Add an entry for Payments" });
    await user.type(within(form).getByLabelText("Model pattern"), "tiny");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(api.addModelAllowlistEntry).toHaveBeenCalledWith({ scope: "project", projectId: "p1", providerId: "*", modelGlob: "tiny" });
  });

  it("is read-only for a builder", async () => {
    vi.mocked(api.fetchModelAllowlist).mockResolvedValue({ entries: [entry({})], providers, canEdit: false });
    render(<ModelAllowlistView projects={projects} />);
    expect(await screen.findByText("Read-only: only an admin changes these lists.")).toBeInTheDocument();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.getByRole("table", { name: "Deployment models" })).toBeInTheDocument();
  });

  it("shows the API's refusal of an entry", async () => {
    vi.mocked(api.fetchModelAllowlist).mockResolvedValue({ entries: [], providers, canEdit: true });
    vi.mocked(api.addModelAllowlistEntry).mockRejectedValue(new api.ApiError("This provider and model pattern is already on the list", 409));
    const user = userEvent.setup();
    render(<ModelAllowlistView projects={projects} />);
    const form = await screen.findByRole("form", { name: "Add a deployment entry" });
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter a model name or pattern");
    await user.type(within(form).getByLabelText("Model pattern"), "*");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("already on the list");
  });
});

function llmNode(model: string): Parameters<typeof NodeInspector>[0] {
  const node: Node<EditorNodeData> = {
    id: "n1",
    type: "workflowNode",
    position: { x: 0, y: 0 },
    data: { label: "Ask", nodeType: "llm_call", config: { provider: { providerId: "openai", model } } }
  };
  return {
    node,
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {}, projectId: "p1" },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: [],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave: vi.fn(),
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  } as Parameters<typeof NodeInspector>[0];
}

describe("the node's model warning", () => {
  it("warns next to the model when the project's allowlist refuses it, and not when it allows it", async () => {
    vi.mocked(api.checkModelAllowlist).mockImplementation(async ({ providerId, model, projectId }) =>
      model === "gpt-5"
        ? { allowed: false, reason: "project", message: `Model "gpt-5" on provider "openai" is not on the model allowlist of project "p1".`, deploymentEntries: 0, projectEntries: 1, providerId, model, projectId: projectId ?? null }
        : { allowed: true, reason: "allowed", deploymentEntries: 0, projectEntries: 1, providerId, model, projectId: projectId ?? null }
    );
    const { unmount } = render(<NodeInspector {...llmNode("gpt-5")} />);
    const warning = await screen.findByTestId("model-allowlist-warning");
    expect(warning).toHaveTextContent('Model "gpt-5" on provider "openai" is not on the model allowlist of project "p1".');
    expect(api.checkModelAllowlist).toHaveBeenCalledWith({ providerId: "openai", model: "gpt-5", projectId: "p1" });
    unmount();

    render(<NodeInspector {...llmNode("gpt-4o")} />);
    await waitFor(() => expect(api.checkModelAllowlist).toHaveBeenCalledWith({ providerId: "openai", model: "gpt-4o", projectId: "p1" }));
    expect(screen.queryByTestId("model-allowlist-warning")).toBeNull();
  });

  it("does not check a model chosen by an expression", async () => {
    render(<NodeInspector {...llmNode("{{vars.model}}")} />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.checkModelAllowlist).not.toHaveBeenCalled();
  });
});
