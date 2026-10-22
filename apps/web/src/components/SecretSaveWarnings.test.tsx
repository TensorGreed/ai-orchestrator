import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";
import { SecretSaveWarnings } from "./SecretSaveWarnings";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, createSecret: vi.fn(), fetchProviderModels: vi.fn() };
});

const WARNING = "This value is a common word used in run records, such as a status or field name. It will not be hidden there; choose a more unique value.";

describe("SecretSaveWarnings", () => {
  it("renders nothing without warnings", () => {
    const { container } = render(<SecretSaveWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<SecretSaveWarnings warnings={undefined} />);
    expect(none).toBeEmptyDOMElement();
  });

  it("shows each warning as a status notice", () => {
    render(<SecretSaveWarnings warnings={[WARNING]} className="extra" />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("warn-banner", "extra");
    expect(notice).toHaveTextContent(WARNING);
  });
});

describe("inline credential creation", () => {
  beforeEach(() => {
    vi.mocked(api.fetchProviderModels).mockResolvedValue({ models: [] } as unknown as Awaited<ReturnType<typeof api.fetchProviderModels>>);
  });

  function llmNode(): Node<EditorNodeData> {
    return {
      id: "llm-1",
      type: "workflowNode",
      position: { x: 0, y: 0 },
      data: { label: "Model", nodeType: "llm_call", config: { provider: { providerId: "openai", model: "gpt-4o-mini" } } }
    };
  }

  async function createInline(value: string, warnings: string[]) {
    vi.mocked(api.createSecret).mockResolvedValue({ id: "sec-1", name: "OpenAI Credential", provider: "openai", projectId: "default", warnings });
    const user = userEvent.setup();
    render(
      <NodeInspector
        node={llmNode()}
        inputOptions={[]}
        executionResult={null}
        workflowContext={{ id: "wf-1", name: "Workflow 1", vars: {} }}
        pinnedData={{}}
        showRuntimeInspection={false}
        secrets={[]}
        onRefreshSecrets={vi.fn()}
        mcpServerDefinitions={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onExecuteStep={vi.fn()}
        onPinNodeOutput={vi.fn()}
        onUnpinNodeOutput={vi.fn()}
      />
    );
    await user.selectOptions(screen.getByRole("combobox", { name: /API Key Secret/i }), "__add_new_credential__");
    await user.type(screen.getByRole("textbox", { name: /Credential Value/i }), value);
    await user.click(screen.getByRole("button", { name: "Create Credential" }));
    return user;
  }

  it("shows the save warning next to the credential field", async () => {
    await createInline("success", [WARNING]);
    expect(await screen.findByRole("status")).toHaveTextContent(WARNING);
    expect(screen.getByRole("status")).not.toHaveTextContent("success");
  });

  it("shows nothing when the API returns no warnings", async () => {
    await createInline("sk-unique-value-123", []);
    await screen.findByRole("option", { name: /OpenAI Credential/ });
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});
