import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNodeDefinition } from "@ai-orchestrator/shared";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";
import { ApprovalGateNodeFields } from "./ApprovalGateNodeFields";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProviderModels: vi.fn(), previewExpression: vi.fn(), fetchGuardProfiles: vi.fn(), fetchGuardWorkflowBinding: vi.fn() };
});

/**
 * Live entry points (webhook, form, chat, MCP trigger, schedule) switched off, as the starters ship them: one line says
 * so above the form, with Turn on; webhooks, forms, chats and MCP triggers keep the switch under More. An approval that
 * lets the starter approve says so plainly.
 */

function props(nodeType: string, config: Record<string, unknown>): Parameters<typeof NodeInspector>[0] {
  return {
    node: { id: "n1", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Node", nodeType, config } } as Node<EditorNodeData>,
    inputOptions: [],
    executionResult: null,
    nodeLabels: new Map([["n1", "Node"]]),
    onNavigateNode: vi.fn(),
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: true,
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

const sample = (type: string) => structuredClone(getNodeDefinition(type as never)!.sampleConfig as Record<string, unknown>);
const toggle = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
});

describe("an entry point that is off", () => {
  it("a new webhook says nothing and keeps Live calls under More", () => {
    render(<NodeInspector {...props("webhook_input", sample("webhook_input"))} />);
    expect(screen.queryByTestId("live-entry-off")).toBeNull();
    expect(screen.getByLabelText(/^Live calls/)).not.toBeVisible();
    expect(screen.getByLabelText(/^Live calls/)).toHaveValue("on");
  });

  it("an off webhook says so in one line and turns on in one click; saved, the switch is gone from the config", async () => {
    const user = userEvent.setup();
    const view = props("webhook_input", { path: "starter-reshape", method: "POST", authMode: "none", active: false });
    render(<NodeInspector {...view} />);
    const notice = screen.getByTestId("live-entry-off");
    expect(notice).toHaveTextContent("Off: calls to its URL answer \u201cnot found\u201d until you turn it on. Run in the editor works either way.");
    expect(within(screen.getByTestId("advanced-fields")).getByText("1 set")).toBeInTheDocument();
    await user.click(within(notice).getByRole("button", { name: "Turn on" }));
    expect(screen.queryByTestId("live-entry-off")).toBeNull();
    expect(screen.getByTestId("live-entry-on")).toHaveTextContent("Turned on: it takes live calls once you save.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(view.onSave).toHaveBeenCalledWith(expect.objectContaining({ config: { path: "starter-reshape", method: "POST", authMode: "none" } }));
  });

  it("names what is off for a form, a chat, an MCP trigger and a schedule", () => {
    const cases: Array<[string, RegExp]> = [
      ["form_trigger", /form's page and submissions answer/],
      ["chat_trigger", /chat messages answer/],
      ["mcp_server_trigger", /MCP calls answer .* toolsets leave the tool out/],
      ["schedule_trigger", /the schedule starts no run/]
    ];
    for (const [type, text] of cases) {
      const { unmount } = render(<NodeInspector {...props(type, { ...sample(type), active: false })} />);
      expect(screen.getByTestId("live-entry-off"), type).toHaveTextContent(text);
      unmount();
    }
  });

  it("turns a schedule on with an explicit Active", async () => {
    const user = userEvent.setup();
    const view = props("schedule_trigger", { cronExpression: "0 9 * * 1-5", timezone: "UTC", active: false });
    render(<NodeInspector {...view} />);
    await user.click(within(screen.getByTestId("live-entry-off")).getByRole("button", { name: "Turn on" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(view.onSave).toHaveBeenCalledWith(expect.objectContaining({ config: { cronExpression: "0 9 * * 1-5", timezone: "UTC", active: true } }));
  });

  it("switches a webhook off again under More", async () => {
    const user = userEvent.setup();
    const view = props("webhook_input", { path: "hook", method: "POST" });
    render(<NodeInspector {...view} />);
    await user.click(screen.getByText("More"));
    await user.selectOptions(screen.getByLabelText(/^Live calls/), "off");
    expect(screen.getByTestId("live-entry-off")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(view.onSave).toHaveBeenCalledWith(expect.objectContaining({ config: { path: "hook", method: "POST", active: false } }));
  });
});

describe("an approval the starter may approve", () => {
  it("says so plainly while self-approval is on", () => {
    const { unmount } = render(<ApprovalGateNodeFields config={{ message: "Go?", allowSelfApproval: true }} setConfig={vi.fn()} />);
    expect(screen.getByTestId("self-approval-on")).toHaveTextContent("Self-approval is on: whoever starts a run may approve it themselves.");
    unmount();
    render(<ApprovalGateNodeFields config={{ message: "Go?" }} setConfig={vi.fn()} />);
    expect(screen.queryByTestId("self-approval-on")).toBeNull();
  });
});
