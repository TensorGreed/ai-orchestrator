import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { AGENT_DEFAULT_MAX_ITERATIONS } from "@ai-orchestrator/shared";
import { NodeConfigModal, NodeInspector, buildNodeTrace } from "./NodeConfigModal";

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
    expect(drawer.querySelector(".insp-sub")).toHaveTextContent("user_prompt·node-1");
    expect(screen.getByRole("button", { name: "Run this node" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Parameters" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Input" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Output" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Trace" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize inspector" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("offers no pin for an Approval Gate, whose output only comes from a decision", async () => {
    const user = userEvent.setup();
    const gate: Node<EditorNodeData> = { id: "gate", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Gate", nodeType: "approval_gate", config: {} } };
    render(<NodeInspector {...makeProps({ node: gate })} />);
    await user.click(screen.getByRole("tab", { name: "Output" }));
    expect(screen.queryByRole("button", { name: "Pin output" })).toBeNull();
    expect(screen.getByText(/An Approval Gate cannot be pinned/)).toBeInTheDocument();
  });

  it("offers no 'Continue Anyway' on error for an Approval Gate or Human Approval", () => {
    const gate: Node<EditorNodeData> = { id: "gate", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Gate", nodeType: "approval_gate", config: {} } };
    const { unmount } = render(<NodeInspector {...makeProps({ node: gate })} />);
    const options = (select: HTMLElement) => Array.from(select.querySelectorAll("option")).map((option) => option.getAttribute("value"));
    expect(options(screen.getByLabelText("On Error Behavior"))).toEqual(["stop", "branch"]);
    unmount();
    const human: Node<EditorNodeData> = { id: "ask", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Ask", nodeType: "human_approval", config: {} } };
    const humanView = render(<NodeInspector {...makeProps({ node: human })} />);
    expect(options(screen.getByLabelText("On Error Behavior"))).toEqual(["stop", "branch"]);
    humanView.unmount();
    render(<NodeInspector {...makeProps()} />);
    expect(options(screen.getByLabelText("On Error Behavior"))).toEqual(["stop", "continue", "branch"]);
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

    await user.click(screen.getByRole("button", { name: "Run this node" }));
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

    await waitFor(() => {
      expect(api.fetchProviderModels).toHaveBeenCalledWith({
        providerId: "anthropic",
        secretRef: { secretId: "secret-gateway" },
        baseUrl: "https://llm.company.example/v1"
      });
    });
    expect(await screen.findByRole("option", { name: "Claude Haiku 4.5" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Unpin output" })).toBeInTheDocument();
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
