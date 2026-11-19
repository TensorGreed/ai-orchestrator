import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { AGENT_DEFAULT_MAX_ITERATIONS } from "@ai-orchestrator/shared";
import { NodeConfigModal, NodeInspector, buildNodeTrace, switchedModelProvider } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProviderModels: vi.fn()
  };
});

function makeNode(): Node<EditorNodeData> {
  return {
    id: "node-1",
    type: "workflowNode",
    position: { x: 100, y: 120 },
    data: {
      label: "User Prompt",
      nodeType: "user_prompt",
      config: {
        text: "What should I help with?"
      }
    }
  };
}

function makeAgentNode(nodeType: "agent_orchestrator" | "supervisor_node" = "agent_orchestrator"): Node<EditorNodeData> {
  return {
    id: "agent-1",
    type: "workflowNode",
    position: { x: 0, y: 0 },
    data: {
      label: "Research Agent",
      nodeType,
      config: { systemPrompt: "You are helpful.", maxIterations: 4 }
    }
  };
}

function makeProps(overrides: Partial<Parameters<typeof NodeInspector>[0]> = {}): Parameters<typeof NodeInspector>[0] {
  return {
    node: makeNode(),
    inputOptions: [],
    executionResult: null,
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: false,
    secrets: [],
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave: vi.fn(),
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn(),
    ...overrides
  };
}

describe("NodeInspector", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    try {
      window.localStorage.clear();
    } catch {
      // jsdom storage may be unavailable in some environments
    }
  });

  it("keeps the NodeConfigModal alias pointing at the inspector", () => {
    expect(NodeConfigModal).toBe(NodeInspector);
  });

  it.each(["agent_orchestrator", "supervisor_node"] as const)("shows the runtime's default Max Iterations for a %s saved without one", (nodeType) => {
    const node = makeAgentNode(nodeType);
    node.data.config = { systemPrompt: "You coordinate." };
    render(<NodeInspector {...makeProps({ node })} />);
    expect(screen.getByRole("spinbutton", { name: /Max Iterations/ })).toHaveValue(AGENT_DEFAULT_MAX_ITERATIONS);
    expect(AGENT_DEFAULT_MAX_ITERATIONS).toBe(4);
  });

  it("starts an Agent Orchestrator saved without Max Iterations from the shown default, saved only on Save", async () => {
    const onSave = vi.fn();
    const node = makeAgentNode("agent_orchestrator");
    node.data.config = { systemPrompt: "You help." };
    render(<NodeInspector {...makeProps({ node, onSave })} />);
    // Opening changes nothing stored: the node's own config is untouched and nothing was saved.
    expect(node.data.config).toEqual({ systemPrompt: "You help." });
    expect(onSave).not.toHaveBeenCalled();
    // The fill is not an edit: closing does not ask about unsaved changes.
    const save = screen.getByRole("button", { name: /Save changes/ });
    expect(save).not.toHaveAttribute("data-dirty");
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].config).toMatchObject({ maxIterations: AGENT_DEFAULT_MAX_ITERATIONS });
  });

  it("leaves a Supervisor saved without Max Iterations on its schema default", async () => {
    const onSave = vi.fn();
    const node = makeAgentNode("supervisor_node");
    node.data.config = { systemPrompt: "You coordinate." };
    render(<NodeInspector {...makeProps({ node, onSave })} />);
    expect(screen.getByRole("button", { name: /Save changes/ })).not.toHaveAttribute("data-dirty");
  });

  it("edits a GitHub issue number as a number or a template", async () => {
    const onSave = vi.fn();
    const node: Node<EditorNodeData> = {
      id: "gh-1",
      type: "workflowNode",
      position: { x: 0, y: 0 },
      data: { label: "GitHub", nodeType: "github_action", config: { owner: "o", repo: "r", operation: "commentIssue", issueNumber: 7 } }
    };
    render(<NodeInspector {...makeProps({ node, onSave })} />);
    const field = screen.getByRole("textbox", { name: /Issue Number/ });
    expect(field).toHaveValue("7");
    await userEvent.clear(field);
    await userEvent.type(field, "{{{{pull_request.number}}");
    expect(field).toHaveValue("{{pull_request.number}}");
  });

  it("renders as a docked drawer with header, tabs and footer", () => {
    render(<NodeInspector {...makeProps()} />);

    const drawer = screen.getByRole("dialog", { name: "Inspect User Prompt" });
    expect(drawer).toHaveClass("insp");
    expect(drawer.querySelector(".node-modal-backdrop")).toBeNull();
    expect(screen.getByLabelText("Node name")).toHaveValue("User Prompt");
    expect(drawer.querySelector(".insp-sub")).toHaveTextContent("user_prompt");
    expect(drawer.querySelector(".insp-node-id")).toHaveTextContent("Node id node-1");
    expect(screen.getByRole("button", { name: "Run node" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Parameters" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Input", "Parameters", "Output", "Trace"]);
    expect(screen.getByRole("separator", { name: "Resize inspector" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("offers no pin for an Approval Gate, whose output only comes from a decision", async () => {
    const user = userEvent.setup();
    const gate: Node<EditorNodeData> = { id: "gate", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Gate", nodeType: "approval_gate", config: {} } };
    render(<NodeInspector {...makeProps({ node: gate })} />);
    await user.click(screen.getByRole("tab", { name: "Output" }));
    await user.click(screen.getByRole("button", { name: "Output options" }));
    const pin = screen.getByRole("menuitem", { name: "Pin output" });
    expect(pin).toBeDisabled();
    expect(pin).toHaveAttribute("title", expect.stringMatching(/An Approval Gate cannot be pinned/));
  });

  it("offers no 'Continue Anyway' on error for an Approval Gate or Human Approval", async () => {
    const user = userEvent.setup();
    const options = (select: HTMLElement) => Array.from(select.querySelectorAll("option")).map((option) => option.getAttribute("value"));
    const onErrorOptions = async (node?: Node<EditorNodeData>) => {
      const view = render(<NodeInspector {...makeProps(node ? { node } : {})} />);
      const values = options(screen.getByLabelText("On Error Behavior"));
      view.unmount();
      return values;
    };
    const gate: Node<EditorNodeData> = { id: "gate", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Gate", nodeType: "approval_gate", config: {} } };
    expect(await onErrorOptions(gate)).toEqual(["stop", "branch"]);
    const human: Node<EditorNodeData> = { id: "ask", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Ask", nodeType: "human_approval", config: {} } };
    expect(await onErrorOptions(human)).toEqual(["stop", "branch"]);
    expect(await onErrorOptions()).toEqual(["stop", "continue", "branch"]);
  });

  it("saves updated user prompt text", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<NodeInspector {...makeProps({ onSave })} />);

    const textArea = screen.getByLabelText("Text");
    await user.clear(textArea);
    await user.type(textArea, "Updated prompt for test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "User Prompt",
        config: expect.objectContaining({
          text: "Updated prompt for test"
        })
      })
    );
  });

  it("saves the name edited in the header", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(<NodeInspector {...makeProps({ onSave })} />);

    const name = screen.getByLabelText("Node name");
    await user.clear(name);
    await user.type(name, "Renamed prompt");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ label: "Renamed prompt" }));
  });

  it("shows a dirty dot on Save only once the draft differs from the saved config", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...makeProps()} />);

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).not.toHaveAttribute("data-dirty");
    expect(save.querySelector(".insp-dirty")).toBeNull();

    await user.type(screen.getByLabelText("Text"), "!");

    expect(save).toHaveAttribute("data-dirty", "true");
    expect(save.querySelector(".insp-dirty")).not.toBeNull();
  });

  it("closes when cancel is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<NodeInspector {...makeProps({ onClose })} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with the × button", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<NodeInspector {...makeProps({ onClose })} />);

    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<NodeInspector {...makeProps({ onClose })} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs the node from the header button", async () => {
    const user = userEvent.setup();
    const onExecuteStep = vi.fn();

    render(<NodeInspector {...makeProps({ onExecuteStep })} />);

    await user.click(screen.getByRole("button", { name: "Run node" }));
    expect(onExecuteStep).toHaveBeenCalledTimes(1);
  });

  it("applies the stored inspector width and clamps to the minimum", () => {
    window.localStorage.setItem("l2m:inspector-w", "480");
    const { unmount } = render(<NodeInspector {...makeProps()} />);
    expect(screen.getByRole("dialog", { name: "Inspect User Prompt" })).toHaveStyle({ width: "480px" });
    unmount();

    window.localStorage.setItem("l2m:inspector-w", "100");
    render(<NodeInspector {...makeProps()} />);
    expect(screen.getByRole("dialog", { name: "Inspect User Prompt" }).style.width).toBe("");
  });

  it("keeps the open tab and unsaved edits while a run updates the node's live status", async () => {
    const user = userEvent.setup();
    const node = makeNode();
    const props = makeProps({ node });
    const { rerender } = render(<NodeInspector {...props} />);

    await user.type(screen.getByLabelText("Text"), "!");
    await user.click(screen.getByRole("tab", { name: "Trace" }));

    // A streamed event re-creates the node with new runtime fields but the same settings.
    const runningNode = { ...node, data: { ...node.data, executionStatus: "running" as const, liveStartedAtMs: 1000 } };
    rerender(<NodeInspector {...props} node={runningNode} inputOptions={[]} />);

    expect(screen.getByRole("tab", { name: "Trace" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Parameters" }));
    expect(screen.getByLabelText("Text")).toHaveValue("What should I help with?!");
  });

  it("renders 'No run yet' on the Trace tab without a run", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...makeProps()} />);

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
  });

  it("renders telemetry, duration and error remediation on the Trace tab", async () => {
    const user = userEvent.setup();
    render(
      <NodeInspector
        {...makeProps({
          trace: {
            status: "error",
            durationMs: 2345,
            telemetry: {
              providerId: "openai",
              model: "gpt-4o-mini",
              inputTokens: 1200,
              outputTokens: 340,
              cachedInputTokens: 800,
              totalTokens: 1540,
              latencyMs: 980,
              llmCallCount: 3
            },
            error: "Rate limit exceeded",
            errorRemediation: "Wait a moment and retry, or lower the concurrency."
          }
        })}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Trace" }));

    expect(screen.getByTestId("insp-trace-status")).toHaveTextContent("error");
    expect(screen.getByText("Duration").nextElementSibling).toHaveTextContent("2.3 s");
    expect(screen.getByText("Tokens in").nextElementSibling).toHaveTextContent("1,200");
    expect(screen.getByText("Tokens out").nextElementSibling).toHaveTextContent("340");
    expect(screen.getByText("Cached").nextElementSibling).toHaveTextContent("800");
    expect(screen.getByText("Total tokens").nextElementSibling).toHaveTextContent("1,540");
    expect(screen.getByText("LLM latency").nextElementSibling).toHaveTextContent("980 ms");
    expect(screen.getByText("LLM calls").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Model").nextElementSibling).toHaveTextContent("gpt-4o-mini");
    // Counts the provider reported are shown as they are, with no estimate note.
    expect(screen.queryByText("Token counts")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Rate limit exceeded");
    expect(screen.getByText("Wait a moment and retry, or lower the concurrency.")).toBeInTheDocument();
  });

  it("says when the token counts are an estimate", async () => {
    const user = userEvent.setup();
    render(
      <NodeInspector
        {...makeProps({
          trace: {
            status: "success",
            durationMs: 400,
            telemetry: { providerId: "openai_compatible", model: "local", inputTokens: 12, outputTokens: 4, totalTokens: 16, usageEstimated: true }
          }
        })}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByText("Tokens out").nextElementSibling).toHaveTextContent("4");
    expect(screen.getByText("Token counts").nextElementSibling).toHaveTextContent("Estimated (the provider reported no usage, or only part)");
  });

  it("falls back to the execution result for the Trace tab when no trace prop is given", async () => {
    const user = userEvent.setup();
    render(
      <NodeInspector
        {...makeProps({
          executionResult: {
            workflowId: "wf-1",
            status: "success",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            nodeResults: [
              {
                nodeId: "node-1",
                status: "success",
                startedAt: "2026-01-01T00:00:00.000Z",
                durationMs: 120,
                output: { answer: "hi" }
              }
            ]
          }
        })}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByTestId("insp-trace-status")).toHaveTextContent("success");
    expect(screen.getByText("Duration").nextElementSibling).toHaveTextContent("120 ms");
  });

  it("shows the agent's tool policy record on the Trace tab", async () => {
    const user = userEvent.setup();
    const executionResult = {
      workflowId: "wf-1",
      status: "success" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      nodeResults: [
        {
          nodeId: "node-1",
          status: "success" as const,
          startedAt: "2026-01-01T00:00:00.000Z",
          durationMs: 120,
          output: {
            answer: "hi",
            _toolPolicy: {
              subject: { role: "viewer", source: "fallback", fallbackReason: "the workflow has no recorded owner" },
              projectId: "default",
              noWriteTools: true,
              hidden: [
                { tool: "calculator", server: "mock-mcp", reason: "policy", ruleId: "r1", ruleName: "Viewers: no calculator" },
                { tool: "create_issue", server: "mcp_gh", reason: "no_write_tools" }
              ]
            }
          }
        }
      ]
    };
    const trace = buildNodeTrace("node-1", executionResult);
    expect(trace?.toolPolicy?.subject.role).toBe("viewer");
    render(<NodeInspector {...makeProps({ trace })} />);

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    const block = screen.getByTestId("insp-trace-policy");
    expect(block).toHaveTextContent("Evaluated as viewer — workflow owner unknown");
    expect(block).toHaveTextContent("calculator hidden by policy Viewers: no calculator");
    expect(block).toHaveTextContent("create_issue hidden: write tool and this workflow allows no write tools");
    expect(block).toHaveTextContent("This workflow allows no write tools.");
  });

  it("shows the Slots section for agent nodes with attached labels and attach actions", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();

    render(
      <NodeInspector
        {...makeProps({
          node: makeAgentNode("supervisor_node"),
          slots: {
            chat_model: ["OpenAI GPT-4o"],
            memory: [],
            tool: ["Search MCP", "Calendar MCP"],
            worker: ["Writer Agent"]
          },
          onAttach
        })}
      />
    );

    const slots = screen.getByRole("region", { name: "Slots" });
    expect(slots).toBeInTheDocument();
    expect(screen.getByTestId("insp-slot-chat_model")).toHaveTextContent("OpenAI GPT-4o");
    expect(screen.getByTestId("insp-slot-memory")).toHaveTextContent("none");
    expect(screen.getByTestId("insp-slot-tool")).toHaveTextContent("Search MCP");
    expect(screen.getByTestId("insp-slot-tool")).toHaveTextContent("Calendar MCP");
    expect(screen.getByTestId("insp-slot-worker")).toHaveTextContent("Writer Agent");

    await user.click(screen.getByRole("button", { name: "Attach memory" }));
    expect(onAttach).toHaveBeenCalledWith("memory");
    await user.click(screen.getByRole("button", { name: "Attach tools" }));
    expect(onAttach).toHaveBeenCalledWith("tool");
  });

  it("hides the worker slot for plain agent orchestrators and the whole section for non-agent nodes", () => {
    const { unmount } = render(
      <NodeInspector
        {...makeProps({
          node: makeAgentNode("agent_orchestrator"),
          slots: { chat_model: [], memory: [], tool: [], worker: [] },
          onAttach: vi.fn()
        })}
      />
    );
    expect(screen.getByTestId("insp-slot-chat_model")).toHaveTextContent("required");
    expect(screen.queryByTestId("insp-slot-worker")).toBeNull();
    unmount();

    render(<NodeInspector {...makeProps()} />);
    expect(screen.queryByRole("region", { name: "Slots" })).toBeNull();
  });

  it("loads model options for AI gateway chat models", async () => {
    vi.mocked(api.fetchProviderModels).mockResolvedValue({
      models: [{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }]
    });

    render(
      <NodeInspector
        {...makeProps({
          node: {
            id: "gateway-model",
            type: "workflowNode",
            position: { x: 100, y: 120 },
            data: {
              label: "AI Gateway",
              nodeType: "ai_gateway_chat_model",
              config: {
                apiProvider: "anthropic",
                baseUrl: "https://llm.company.example/v1",
                secretRef: { secretId: "secret-gateway" },
                model: ""
              }
            }
          },
          secrets: [
            {
              id: "secret-gateway",
              name: "Corporate Gateway",
              provider: "anthropic",
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        })}
      />
    );

    // Opening the node lists nothing: the list loads on the explicit action.
    expect(api.fetchProviderModels).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Load models" }));
    await waitFor(() => {
      expect(api.fetchProviderModels).toHaveBeenCalledWith({
        providerId: "anthropic",
        secretRef: { secretId: "secret-gateway" },
        baseUrl: "https://llm.company.example/v1"
      });
    });
    expect(await screen.findByRole("option", { name: "Claude Haiku 4.5" })).toBeInTheDocument();
  });

  it("never asks a model server for its models just because a model node opened", async () => {
    vi.mocked(api.fetchProviderModels).mockResolvedValue({ models: [{ id: "llama3.1", label: "llama3.1" }] });
    const nodes = [
      { nodeType: "llm_call", config: { provider: { providerId: "ollama", model: "llama3.1", baseUrl: "http://localhost:11434/v1" } } },
      { nodeType: "ollama_chat_model", config: { baseUrl: "http://localhost:11434/v1", model: "llama3.1" } },
      { nodeType: "text_classifier", config: { provider: { providerId: "ollama", model: "llama3.1" } } },
      { nodeType: "openai_chat_model", config: { model: "gpt-4o-mini" } }
    ];
    for (const entry of nodes) {
      const { unmount } = render(
        <NodeInspector
          {...makeProps({
            node: { id: `n-${entry.nodeType}`, type: "workflowNode", position: { x: 0, y: 0 }, data: { label: entry.nodeType, nodeType: entry.nodeType as EditorNodeData["nodeType"], config: entry.config } }
          })}
        />
      );
      expect(screen.getByRole("button", { name: "Load models" })).toBeInTheDocument();
      unmount();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.fetchProviderModels).not.toHaveBeenCalled();
  });

  it("offers Echo in the provider picker, and an Echo node shows no key, endpoint or model list", async () => {
    render(
      <NodeInspector
        {...makeProps({
          node: { id: "llm-echo", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "LLM Call", nodeType: "llm_call", config: { provider: { providerId: "echo", model: "echo" } } } }
        })}
      />
    );
    const picker = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    expect(picker.value).toBe("echo");
    expect([...picker.options].map((option) => option.value)).toEqual(expect.arrayContaining(["echo", "ollama", "openai", "anthropic", "gemini", "azure_openai", "openai_compatible"]));
    expect(screen.getByTestId("echo-provider-tip")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load models" })).toBeNull();
    expect(screen.queryByText("API Key Secret")).toBeNull();
    expect(screen.queryByLabelText("Base URL")).toBeNull();
  });

  it("shows a node with no provider as not set, not as Ollama", () => {
    render(
      <NodeInspector
        {...makeProps({
          node: { id: "tc", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Classify", nodeType: "text_classifier", config: { textKey: "text" } } }
        })}
      />
    );
    const picker = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    expect(picker.value).toBe("");
    expect(picker.selectedOptions[0]?.textContent).toContain("Not set");
  });

  it("lets a chain node go back to the upstream model after picking a provider", async () => {
    render(
      <NodeInspector
        {...makeProps({
          node: { id: "tc2", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Classify", nodeType: "text_classifier", config: { textKey: "text", provider: { providerId: "echo", model: "echo" } } } }
        })}
      />
    );
    const picker = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    expect(picker.value).toBe("echo");
    await userEvent.selectOptions(picker, "");
    expect(picker.value).toBe("");
  });

  it("offers no upstream model on an LLM Call that names a provider", () => {
    render(
      <NodeInspector
        {...makeProps({
          node: { id: "llm-o", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "LLM Call", nodeType: "llm_call", config: { provider: { providerId: "openai", model: "gpt-4o-mini" } } } }
        })}
      />
    );
    const picker = screen.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement;
    expect([...picker.options].some((option) => option.value === "")).toBe(false);
  });
});

describe("switchedModelProvider", () => {
  it("removes the provider for Not set", () => {
    expect(switchedModelProvider({ providerId: "echo", model: "echo" }, "")).toBeUndefined();
  });

  it("drops the endpoint and key for Echo and sets its model", () => {
    expect(
      switchedModelProvider({ providerId: "ollama", model: "llama3.1", baseUrl: "http://localhost:11434/v1", secretRef: { secretId: "s" }, temperature: 0.4 }, "echo")
    ).toEqual({ providerId: "echo", model: "echo", temperature: 0.4 });
  });

  it("clears Echo's placeholder model when leaving it, and keeps the rest for other switches", () => {
    expect(switchedModelProvider({ providerId: "echo", model: "echo" }, "openai")).toEqual({ providerId: "openai", model: "" });
    expect(switchedModelProvider({ providerId: "openai", model: "gpt-4o", baseUrl: "https://x/v1" }, "anthropic")).toEqual({
      providerId: "anthropic",
      model: "gpt-4o",
      baseUrl: "https://x/v1"
    });
  });
});

describe("NodeInspector run data", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const runResult = {
    workflowId: "wf-1",
    executionId: "exec-1",
    status: "success" as const,
    startedAt: T0,
    completedAt: T0,
    nodeResults: [
      { nodeId: "start", status: "success" as const, startedAt: T0, durationMs: 1, input: { user_prompt: "chat prompt", parent_outputs: {} }, output: { text: "hello" } },
      {
        nodeId: "node-1",
        status: "success" as const,
        startedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 7,
        input: { user_prompt: "chat prompt", start: { text: "hello" }, text: "hello", parent_outputs: { start: { text: "hello" } } },
        output: { result: "HELLO" }
      },
      { nodeId: "end", status: "success" as const, startedAt: "2026-01-01T00:00:02.000Z", durationMs: 2, output: { done: true } }
    ]
  };
  const nodeLabels = new Map([
    ["start", "Start"],
    ["node-1", "User Prompt"],
    ["end", "Finish"]
  ]);

  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // jsdom storage may be unavailable in some environments
    }
  });

  it("opens on the run's output and shows the input the node received, not the chat prompt", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...makeProps({ executionResult: runResult, showRuntimeInspection: true, nodeLabels, onNavigateNode: vi.fn() })} />);
    expect(screen.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("run-data-status")).toHaveTextContent("success · 1 item · 7 ms");
    expect(screen.getByText("HELLO")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Input" }));
    expect(screen.getByRole("region", { name: "From Start" })).toHaveTextContent("hello");
    expect(screen.getByText("chat prompt")).not.toBeVisible();
  });

  it("opens on Parameters when the node has no run data, and says so on Output", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...makeProps({ showRuntimeInspection: true })} />);
    expect(screen.getByRole("tab", { name: "Parameters" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Output" }));
    expect(screen.getByText(/No run yet for this node/)).toBeInTheDocument();
  });

  it("labels pinned data as not from a run", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...makeProps({ showRuntimeInspection: true, pinnedData: { "node-1": { pinned: "value" } } })} />);
    await user.click(screen.getByRole("tab", { name: "Output" }));
    expect(screen.getByTestId("run-data-pinned")).toHaveTextContent("Pinned data, not from a run");
    await user.click(screen.getByRole("button", { name: "Output options" }));
    expect(screen.getByRole("menuitem", { name: "Unpin output" })).toBeEnabled();
  });

  it("steps to the previous and next node of the run without closing", async () => {
    const user = userEvent.setup();
    const onNavigateNode = vi.fn();
    const onClose = vi.fn();
    render(<NodeInspector {...makeProps({ executionResult: runResult, showRuntimeInspection: true, nodeLabels, onNavigateNode, onClose })} />);
    expect(screen.getByRole("navigation", { name: "Run steps" })).toHaveTextContent("Step 2 of 3");
    await user.click(screen.getByRole("button", { name: "Next step: Finish" }));
    expect(onNavigateNode).toHaveBeenCalledWith("end");
    await user.click(screen.getByRole("button", { name: "Previous step: Start" }));
    expect(onNavigateNode).toHaveBeenCalledWith("start");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the Input tab while stepping, and leaves out steps whose node was deleted", async () => {
    const user = userEvent.setup();
    const props = makeProps({ executionResult: runResult, showRuntimeInspection: true, nodeLabels: new Map([["node-1", "User Prompt"], ["end", "Finish"]]), onNavigateNode: vi.fn() });
    const { rerender } = render(<NodeInspector {...props} />);
    // "start" is in the run but not in the workflow any more.
    expect(screen.getByRole("navigation", { name: "Run steps" })).toHaveTextContent("Step 1 of 2");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Input" }));
    const end = { ...makeNode(), id: "end", data: { ...makeNode().data, label: "Finish" } };
    rerender(<NodeInspector {...props} node={end} />);
    expect(screen.getByRole("tab", { name: "Input" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows Input, Parameters and Output side by side and remembers the choice", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<NodeInspector {...makeProps({ executionResult: runResult, showRuntimeInspection: true, nodeLabels })} />);
    const toggle = screen.getByRole("button", { name: "Show Input, Parameters and Output side by side" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog", { name: "Inspect User Prompt" })).toHaveClass("insp-split");
    expect(screen.getByRole("region", { name: "Input" })).toHaveTextContent("From Start");
    expect(screen.getByRole("region", { name: "Output" })).toHaveTextContent("HELLO");
    expect(screen.getByLabelText("Text")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Input" })).toBeNull();
    unmount();
    render(<NodeInspector {...makeProps({ executionResult: runResult, showRuntimeInspection: true, nodeLabels })} />);
    expect(screen.getByRole("dialog", { name: "Inspect User Prompt" })).toHaveClass("insp-split");
  });
});

describe("a model node's label and the other agents' models", () => {
  const modelNode = (label: string, provider: Record<string, unknown>): Node<EditorNodeData> =>
    ({ id: "sup_model", type: "workflowNode", position: { x: 0, y: 0 }, data: { label, nodeType: "llm_call", config: { provider } } }) as Node<EditorNodeData>;

  it("a label that names the provider follows a provider change; a name the person gave is kept (B14)", async () => {
    const onSave = vi.fn();
    const { unmount } = render(<NodeInspector {...makeProps({ node: modelNode("Chat Model (echo)", { providerId: "echo", model: "demo" }), onSave })} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "anthropic");
    expect(screen.getByLabelText("Node name")).toHaveValue("Chat Model (anthropic)");
    unmount();
    render(<NodeInspector {...makeProps({ node: modelNode("Classifier", { providerId: "echo", model: "demo" }), onSave })} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "anthropic");
    expect(screen.getByLabelText("Node name")).toHaveValue("Classifier");
  });

  it("offers one click to put the model on every agent's chat model, and saves with them", async () => {
    const onSave = vi.fn();
    const peers = [
      { id: "res_model", label: "Researcher Chat (echo)", provider: { providerId: "echo", model: "demo" } },
      { id: "cmp_model", label: "Computer Chat (echo)", provider: { providerId: "echo", model: "demo" } }
    ];
    render(<NodeInspector {...makeProps({ node: modelNode("Supervisor Chat Model (echo)", { providerId: "echo", model: "demo" }), onSave, agentModelPeers: peers })} />);
    // Same model everywhere: nothing to offer.
    expect(screen.queryByTestId("use-model-for-all-agents")).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "anthropic");
    const offer = await screen.findByTestId("use-model-for-all-agents");
    expect(offer).toHaveTextContent("2 other agents use another model.");
    await userEvent.click(screen.getByRole("button", { name: "Use for all agents in this workflow" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      label: "Supervisor Chat Model (anthropic)",
      config: { provider: { providerId: "anthropic" } },
      applyModelTo: ["res_model", "cmp_model"]
    });
  });

  it("makes no offer on a model node that is not an agent's, or in a read-only view", async () => {
    render(
      <NodeInspector
        {...makeProps({
          node: modelNode("Chat", { providerId: "anthropic", model: "claude-x" }),
          agentModelPeers: [{ id: "x", label: "X", provider: { providerId: "echo", model: "demo" } }],
          readOnlyReason: "You can only view this workflow."
        })}
      />
    );
    expect(screen.queryByTestId("use-model-for-all-agents")).toBeNull();
  });
});
