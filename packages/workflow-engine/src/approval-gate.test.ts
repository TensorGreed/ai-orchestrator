import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  resolvePendingApproval,
  type ChatMessage,
  type ReplayRecordedNode,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { writeToolApprovalKey } from "./approval-gate-node";
import { buildReplayPlan } from "./replay-plan";
import { validateWorkflowGraph } from "./validation";

/**
 * Phase 11.2 — approval gates in the engine: the Approval Gate node's pause,
 * its approved / rejected / timed_out routing and approve-with-edits, gates
 * inside sub-workflows, the agent-level gate before MCP write tools, the
 * legacy Human Approval timeout, and replays that answer gates from the
 * recording.
 */

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes,
    edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })),
    ...extra
  };
}

class ToolThenAnswerProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ChatMessage[][] = [];
  constructor(private readonly toolName: string, private readonly args: () => Record<string, unknown>) {}
  async generate(request: ProviderCallRequest) {
    this.calls.push(request.messages.map((message) => ({ ...message })));
    const sawTool = request.messages.some((message) => message.role === "tool");
    if (!sawTool && request.tools?.some((tool) => tool.name === this.toolName)) {
      return { content: "Calling a tool.", toolCalls: [{ id: `call-${this.calls.length}`, name: this.toolName, arguments: this.args() }] };
    }
    return { content: "All done.", toolCalls: [] };
  }
}

function crmAdapter(invoked: Array<Record<string, unknown>>): MCPServerAdapter {
  return {
    definition: { id: "crm-mcp", label: "CRM", description: "Test CRM", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [
        { serverId: "crm-mcp", serverLabel: "CRM", name: "update_contact", description: "Update a contact", inputSchema: { type: "object", properties: { email: { type: "string" } } } },
        { serverId: "crm-mcp", serverLabel: "CRM", name: "find_contact", description: "Find a contact", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }
      ];
    },
    async invokeTool(toolName: string, args: Record<string, unknown>) {
      invoked.push({ tool: toolName, ...args });
      return { ok: true, output: { updated: true } };
    }
  } as unknown as MCPServerAdapter;
}

function deps(input: { paused?: WorkflowExecutionState[]; workflows?: Workflow[]; provider?: LLMProviderAdapter; invoked?: Array<Record<string, unknown>> } = {}): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  if (input.provider) providerRegistry.register(input.provider);
  const mcpRegistry = createDefaultMCPRegistry();
  mcpRegistry.register(crmAdapter(input.invoked ?? []));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    loadWorkflow: (id) => input.workflows?.find((entry) => entry.id === id),
    persistPausedExecution: async (paused) => {
      input.paused?.push(paused.state);
    }
  };
}

const last = (result: Awaited<ReturnType<typeof executeWorkflow>>, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);

function gateWorkflow(gateConfig: Record<string, unknown>, handles: Array<"approved" | "rejected" | "timed_out"> = ["approved", "rejected", "timed_out"]) {
  return workflow(
    "wf-gate",
    [
      node("in", "webhook_input"),
      node("draft", "set_node", { assignments: [{ key: "reply", valueTemplate: "Dear {{user_prompt}}" }, { key: "priority", valueTemplate: "2" }] }),
      node("gate", "approval_gate", gateConfig, "Reply gate"),
      ...handles.map((handle) => node(`on_${handle}`, "output", { responseTemplate: handle })),
      node("after", "noop_node")
    ],
    [
      { source: "in", target: "draft" },
      { source: "draft", target: "gate" },
      ...handles.map((handle) => ({ source: "gate", sourceHandle: handle, target: `on_${handle}` })),
      ...(handles.includes("approved") ? [{ source: "on_approved", target: "after" }] : [])
    ]
  );
}

const GATE = {
  message: "Send '{{reply}}'?",
  approverRoles: ["builder"],
  approverUsers: ["lead@example.com"],
  timeoutMinutes: 30,
  timeoutOutcome: "fallback",
  editableFields: [
    { key: "reply", label: "Reply", type: "text", valueTemplate: "{{reply}}", required: true },
    { key: "priority", type: "number", valueTemplate: "{{priority}}" }
  ]
};

async function pauseGate(config: Record<string, unknown> = GATE, handles?: Array<"approved" | "rejected" | "timed_out">) {
  const paused: WorkflowExecutionState[] = [];
  const wf = gateWorkflow(config, handles);
  const first = await executeWorkflow({ workflow: wf, executionId: "exec-gate", webhookPayload: { user_prompt: "Ana" } }, deps({ paused }));
  return { first, state: paused[0]!, paused };
}

describe("approval gate node", () => {
  it("pauses with its approvers, timeout and the proposed values of its editable fields", async () => {
    const { first, state, paused } = await pauseGate();
    expect(first.status).toBe("waiting_approval");
    expect(paused).toHaveLength(1);
    expect(first.output).toMatchObject({ waitingForApproval: true, waitingNodeId: "gate", approvalMessage: "Send 'Dear Ana'?", timeoutMinutes: 30 });
    expect(state.nextNodeIndex).toBe(state.nodeOrder.indexOf("gate"));
    const info = resolvePendingApproval(state);
    expect(info.nodeType).toBe("approval_gate");
    expect(info.request).toMatchObject({
      kind: "approval_gate",
      approverRoles: ["builder"],
      approverUsers: ["lead@example.com"],
      allowSelfApproval: false,
      timeoutOutcome: "fallback",
      requireRejectReason: true,
      editableFields: [
        { key: "reply", label: "Reply", type: "text", required: true, value: "Dear Ana" },
        { key: "priority", type: "number", value: 2 }
      ]
    });
    expect(last(first, "on_approved")).toBeUndefined();
  });

  it("routes an approval with edits to approved, with the edited values on the item and the decision recorded", async () => {
    const { state } = await pauseGate();
    const approved = await resumeWorkflowExecution(
      { executionId: "exec-gate", state, decision: "approve", actedBy: "lead@example.com", reason: "Fine with a tweak", edits: { reply: "Dear Ana, thanks", priority: 2 }, editedFields: ["reply"], requestId: "req-1" },
      deps()
    );
    expect(approved.status).toBe("success");
    const output = last(approved, "gate")?.output as Record<string, any>;
    expect(output._branchHandle).toBe("approved");
    expect(output.reply).toBe("Dear Ana, thanks");
    expect(output.approved).toBe(true);
    expect(output.approval).toMatchObject({ decision: "approve", outcome: "approved", actedBy: "lead@example.com", reason: "Fine with a tweak", requestId: "req-1", editedFields: ["reply"] });
    expect(last(approved, "on_approved")?.status).toBe("success");
    expect(last(approved, "after")?.status).toBe("success");
    expect(last(approved, "on_rejected")?.status).toBe("skipped");
    expect(last(approved, "on_timed_out")?.status).toBe("skipped");
    // One result per node: the waiting entry is replaced by the decided one.
    expect(approved.nodeResults.filter((entry) => entry.nodeId === "gate")).toHaveLength(1);
  });

  it("routes a rejection to rejected, and fails the node when rejected is not connected", async () => {
    const { state } = await pauseGate();
    const rejected = await resumeWorkflowExecution({ executionId: "exec-gate", state, decision: "reject", actedBy: "lead@example.com", reason: "Wrong tone" }, deps());
    expect(rejected.status).toBe("success");
    expect((last(rejected, "gate")?.output as Record<string, any>).approval).toMatchObject({ outcome: "rejected", reason: "Wrong tone" });
    expect(last(rejected, "on_rejected")?.status).toBe("success");
    expect(last(rejected, "on_approved")?.status).toBe("skipped");

    const unconnected = await pauseGate(GATE, ["approved"]);
    const failed = await resumeWorkflowExecution({ executionId: "exec-gate", state: unconnected.state, decision: "reject", actedBy: "lead@example.com", reason: "No" }, deps());
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("Approval rejected by lead@example.com: No");
    expect(last(failed, "gate")?.status).toBe("error");
    expect(last(failed, "on_approved")?.status).toBe("skipped");
  });

  it("routes a timeout to timed_out with the fallback outcome, and handles it as a rejection otherwise", async () => {
    const fallback = await pauseGate();
    const timedOut = await resumeWorkflowExecution({ executionId: "exec-gate", state: fallback.state, decision: "timeout", actedBy: "system" }, deps());
    expect(timedOut.status).toBe("success");
    expect((last(timedOut, "gate")?.output as Record<string, any>)._branchHandle).toBe("timed_out");
    expect(last(timedOut, "on_timed_out")?.status).toBe("success");

    // The fallback with nothing connected to timed_out goes to rejected.
    const noFallbackEdge = await pauseGate(GATE, ["approved", "rejected"]);
    const routed = await resumeWorkflowExecution({ executionId: "exec-gate", state: noFallbackEdge.state, decision: "timeout" }, deps());
    expect((last(routed, "gate")?.output as Record<string, any>)._branchHandle).toBe("rejected");

    const rejectOutcome = await pauseGate({ ...GATE, timeoutOutcome: "reject" }, ["approved"]);
    const failed = await resumeWorkflowExecution({ executionId: "exec-gate", state: rejectOutcome.state, decision: "timeout" }, deps());
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("Approval timed out after 30 minutes with nobody deciding.");
  });

  it("does not take approved edits on a rejection", async () => {
    const { state } = await pauseGate();
    const rejected = await resumeWorkflowExecution({ executionId: "exec-gate", state, decision: "reject", reason: "x", edits: { reply: "sneaky" } }, deps());
    expect((last(rejected, "gate")?.output as Record<string, any>).reply).toBe("Dear Ana");
  });

  it("validates the gate config and refuses a gate as a loop body", () => {
    const bad = workflow("wf-bad", [node("in", "manual_trigger"), node("gate", "approval_gate", { timeoutMinutes: 0, approverRoles: ["owner"] })], [{ source: "in", target: "gate" }]);
    const codes = validateWorkflowGraph(bad).issues.map((issue) => issue.code);
    expect(codes.filter((code) => code === "invalid_approval_gate_config").length).toBeGreaterThanOrEqual(2);

    const looped = workflow(
      "wf-loop",
      [node("in", "manual_trigger"), node("loop", "loop_node", { inputKey: "items" }), node("gate", "approval_gate", {})],
      [{ source: "in", target: "loop" }, { source: "loop", target: "gate" }]
    );
    expect(validateWorkflowGraph(looped).issues.map((issue) => issue.code)).toContain("approval_gate_in_loop");
    expect(validateWorkflowGraph(gateWorkflow(GATE)).valid).toBe(true);
  });
});

describe("approval gates inside sub-workflows", () => {
  const child = workflow(
    "wf-child",
    [node("start", "manual_trigger"), node("gate", "approval_gate", { message: "Child asks", approverUsers: ["lead"], editableFields: [{ key: "note", valueTemplate: "draft" }] }), node("done", "set_node", { assignments: [{ key: "result", valueTemplate: "child:{{note}}" }] }), node("out", "output", { responseTemplate: "{{result}}" })],
    [{ source: "start", target: "gate" }, { source: "gate", sourceHandle: "approved", target: "done" }, { source: "done", target: "out" }]
  );
  const middle = workflow(
    "wf-middle",
    [node("start", "manual_trigger"), node("call", "execute_workflow", { workflowId: "wf-child" }), node("wrap", "set_node", { assignments: [{ key: "result", valueTemplate: "middle:{{result}}" }] }), node("out", "output", { responseTemplate: "{{result}}" })],
    [{ source: "start", target: "call" }, { source: "call", target: "wrap" }, { source: "wrap", target: "out" }]
  );
  const parent = workflow(
    "wf-parent",
    [node("start", "manual_trigger"), node("call", "execute_workflow", { workflowId: "wf-middle" }), node("after", "set_node", { assignments: [{ key: "final", valueTemplate: "parent:{{result}}" }] }), node("out", "output")],
    [{ source: "start", target: "call" }, { source: "call", target: "after" }, { source: "after", target: "out" }]
  );

  it("keeps the parent paused at the Execute Workflow node and resumes the child with the decision", async () => {
    const paused: WorkflowExecutionState[] = [];
    const first = await executeWorkflow({ workflow: parent, executionId: "exec-parent" }, deps({ paused, workflows: [child, middle] }));
    expect(first.status).toBe("waiting_approval");
    // Only the top-level run is saved; the children travel inside its hand-off.
    expect(paused).toHaveLength(1);
    expect(first.output).toMatchObject({ waitingNodeId: "call", approvalMessage: "Child asks" });
    const info = resolvePendingApproval(paused[0]!);
    expect(info).toMatchObject({ nodeId: "gate", workflowId: "wf-child", path: [{ workflowId: "wf-parent", nodeId: "call" }, { workflowId: "wf-middle", nodeId: "call" }] });
    expect(info.request.approverUsers).toEqual(["lead"]);

    const resumed = await resumeWorkflowExecution(
      { executionId: "exec-parent", state: paused[0]!, decision: "approve", actedBy: "lead", edits: { note: "final words" }, editedFields: ["note"] },
      deps({ workflows: [child, middle] })
    );
    expect(resumed.status).toBe("success");
    expect(last(resumed, "after")?.output).toEqual({ final: "parent:middle:child:final words" });
  });

  it("fails the Execute Workflow node when the child's gate is rejected with nowhere to go", async () => {
    const paused: WorkflowExecutionState[] = [];
    await executeWorkflow({ workflow: parent, executionId: "exec-parent-2" }, deps({ paused, workflows: [child, middle] }));
    const rejected = await resumeWorkflowExecution({ executionId: "exec-parent-2", state: paused[0]!, decision: "reject", actedBy: "lead", reason: "No" }, deps({ workflows: [child, middle] }));
    expect(rejected.status).toBe("error");
    expect(last(rejected, "call")?.status).toBe("error");
    expect(rejected.error).toContain("Approval rejected by lead: No");
  });

  it("pauses the parent again when the child reaches a second gate", async () => {
    const twoGates = workflow(
      "wf-child",
      [node("start", "manual_trigger"), node("g1", "approval_gate", { message: "First" }), node("g2", "approval_gate", { message: "Second" }), node("done", "output")],
      [{ source: "start", target: "g1" }, { source: "g1", sourceHandle: "approved", target: "g2" }, { source: "g2", sourceHandle: "approved", target: "done" }]
    );
    const top = workflow("wf-top", [node("start", "manual_trigger"), node("call", "execute_workflow", { workflowId: "wf-child" }), node("out", "output")], [{ source: "start", target: "call" }, { source: "call", target: "out" }]);
    const paused: WorkflowExecutionState[] = [];
    await executeWorkflow({ workflow: top, executionId: "exec-two" }, deps({ paused, workflows: [twoGates] }));
    const again: WorkflowExecutionState[] = [];
    const second = await resumeWorkflowExecution({ executionId: "exec-two", state: paused[0]!, decision: "approve" }, deps({ paused: again, workflows: [twoGates] }));
    expect(second.status).toBe("waiting_approval");
    expect(second.output).toMatchObject({ approvalMessage: "Second" });
    expect(resolvePendingApproval(again[0]!).nodeId).toBe("g2");
    const done = await resumeWorkflowExecution({ executionId: "exec-two", state: again[0]!, decision: "approve" }, deps({ workflows: [twoGates] }));
    expect(done.status).toBe("success");
  });
});

describe("agent-level gate before MCP write tools", () => {
  function agentWorkflow(toolName: string, settings: Workflow["settings"] = { writeToolApproval: { enabled: true, approverRoles: ["admin"], timeoutMinutes: 15 } }) {
    return workflow(
      "wf-agent",
      [
        node("in", "webhook_input"),
        node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, systemPromptTemplate: "You update the CRM.", userPromptTemplate: "{{user_prompt}}" }, "CRM agent"),
        node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
        node("tool", "mcp_tool", { serverId: "crm-mcp", toolName }),
        node("out", "output")
      ],
      [
        { source: "in", target: "agent" },
        { source: "agent", target: "out" },
        { source: "agent", sourceHandle: "chat_model", target: "model" },
        { source: "agent", sourceHandle: "tool", target: "tool" }
      ],
      { settings }
    );
  }

  it("pauses before an unannotated tool and calls it once approved, with the call's arguments bound to the approval", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const paused: WorkflowExecutionState[] = [];
    const args = { email: "ana@example.org" };
    const provider = () => new ToolThenAnswerProvider("crm-mcp__update_contact", () => args);
    const first = await executeWorkflow({ workflow: agentWorkflow("update_contact"), executionId: "exec-tool", webhookPayload: { user_prompt: "Update Ana" } }, deps({ paused, provider: provider(), invoked }));
    expect(first.status).toBe("waiting_approval");
    expect(invoked).toHaveLength(0);
    const handoff = paused[0]!.approvalHandoff;
    expect(handoff).toMatchObject({ kind: "rerun", source: "agent_tool_gate", request: { kind: "agent_tool", approverRoles: ["admin"], allowSelfApproval: false } });
    expect(handoff?.kind === "rerun" ? handoff.approvalKey : "").toBe(writeToolApprovalKey("agent", "crm-mcp", "update_contact", args));
    expect(first.output).toMatchObject({ timeoutMinutes: 15, approvalMessage: "Agent 'CRM agent' wants to call the write tool 'update_contact' on 'crm-mcp'." });
    const details = resolvePendingApproval(paused[0]!).details!;
    expect(details).toMatchObject({ toolName: "update_contact", classification: "unknown", arguments: "{\"email\":\"ana@example.org\"}" });

    const approved = await resumeWorkflowExecution({ executionId: "exec-tool", state: paused[0]!, decision: "approve", actedBy: "admin@example.com" }, deps({ provider: provider(), invoked }));
    expect(approved.status).toBe("success");
    expect(invoked).toEqual([{ tool: "update_contact", email: "ana@example.org" }]);

    const rejected = await resumeWorkflowExecution({ executionId: "exec-tool", state: paused[0]!, decision: "reject", reason: "Not now" }, deps({ provider: provider(), invoked }));
    expect(rejected.status).toBe("error");
    expect(rejected.error).toBe("Not now");
    expect(invoked).toHaveLength(1);
  });

  it("asks again when the re-run calls the tool with other arguments", async () => {
    const paused: WorkflowExecutionState[] = [];
    let email = "ana@example.org";
    const provider = new ToolThenAnswerProvider("crm-mcp__update_contact", () => ({ email }));
    await executeWorkflow({ workflow: agentWorkflow("update_contact"), executionId: "exec-args", webhookPayload: { user_prompt: "Update" } }, deps({ paused, provider }));
    email = "someone.else@example.org";
    const again: WorkflowExecutionState[] = [];
    const second = await resumeWorkflowExecution({ executionId: "exec-args", state: paused[0]!, decision: "approve" }, deps({ paused: again, provider }));
    expect(second.status).toBe("waiting_approval");
    expect(resolvePendingApproval(again[0]!).details).toMatchObject({ arguments: "{\"email\":\"someone.else@example.org\"}" });
  });

  it("lets read-only tools through and does nothing when the setting is off", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const readOnly = await executeWorkflow(
      { workflow: agentWorkflow("find_contact"), executionId: "exec-ro", webhookPayload: { user_prompt: "Find" } },
      deps({ provider: new ToolThenAnswerProvider("crm-mcp__find_contact", () => ({ q: "ana" })), invoked })
    );
    expect(readOnly.status).toBe("success");
    const off = await executeWorkflow(
      { workflow: agentWorkflow("update_contact", {}), executionId: "exec-off", webhookPayload: { user_prompt: "Update" } },
      deps({ provider: new ToolThenAnswerProvider("crm-mcp__update_contact", () => ({ email: "x@example.org" })), invoked })
    );
    expect(off.status).toBe("success");
    expect(invoked.map((entry) => entry.tool)).toEqual(["find_contact", "update_contact"]);
  });
});

describe("Human Approval timeouts and replays", () => {
  it("handles a timeout of a Human Approval node as a rejection", async () => {
    const paused: WorkflowExecutionState[] = [];
    const wf = workflow("wf-human", [node("in", "manual_trigger"), node("approve", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 5 }), node("after", "output")], [{ source: "in", target: "approve" }, { source: "approve", target: "after" }]);
    await executeWorkflow({ workflow: wf, executionId: "exec-human" }, deps({ paused }));
    const result = await resumeWorkflowExecution({ executionId: "exec-human", state: paused[0]!, decision: "timeout", actedBy: "system" }, deps());
    expect(result.status).toBe("error");
    expect(result.error).toBe("Human approval timed out");
    expect(last(result, "approve")?.input).toMatchObject({ decision: "reject", timedOut: true });
  });

  it("answers an approval gate from the recording in a replay, routing by the recorded branch", async () => {
    const wf = gateWorkflow(GATE);
    const recorded: Record<string, ReplayRecordedNode> = {
      gate: { nodeId: "gate", nodeType: "approval_gate", status: "success", output: { reply: "Dear Ana", approved: false, approval: { decision: "reject", outcome: "rejected" }, _branchHandle: "rejected" } } as ReplayRecordedNode
    };
    const plan = buildReplayPlan(wf, recorded);
    const persistPausedExecution = vi.fn();
    const result = await executeWorkflow({ workflow: wf, executionId: "exec-replay", webhookPayload: { user_prompt: "Ana" } }, { ...deps(), replayNodeHook: plan.hook, persistPausedExecution });
    expect(result.status).toBe("success");
    expect(persistPausedExecution).not.toHaveBeenCalled();
    expect(last(result, "on_rejected")?.status).toBe("success");
    expect(last(result, "on_approved")?.status).toBe("skipped");
  });
});
