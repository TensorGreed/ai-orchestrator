/**
 * Phase 12.4 — argument-aware MCP tool rules in the engine: conditional deny
 * as a tool error, require_approval through the write-tool hand-off (one
 * request when the write-tool gate also asks), shadow rules that only log,
 * discovery that keeps conditional tools visible, workflow principals and
 * direct MCP Tool nodes.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry, hashMcpToolPolicyRule, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import {
  resolvePendingApproval,
  type ChatMessage,
  type McpToolPolicyRule,
  type McpToolPolicyTrace,
  type Workflow,
  type WorkflowEdge,
  type WorkflowExecutionState,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { createDefaultGuardRegistry, hashGuardProfile, InMemoryTokenVaultStorage, parseGuardProfile } from "@ai-orchestrator/guard-sdk";
import { executeWorkflow, resumeWorkflowExecution, type WorkflowExecutionDependencies } from "./executor";
import { writeToolApprovalKey, writeToolPolicyApprovalKey } from "./approval-gate-node";
import type { GuardVerdictEvent, ResolvedGuardProfile } from "./guard-runtime";

function node(id: string, type: string, config: Record<string, unknown> = {}, name = id): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[], edges: Array<Omit<WorkflowEdge, "id">>, extra: Partial<Workflow> = {}): Workflow {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes, edges: edges.map((edge, index) => ({ id: `e${index}`, ...edge })), ...extra };
}

function rule(partial: Partial<McpToolPolicyRule> & Pick<McpToolPolicyRule, "id" | "effect">): McpToolPolicyRule {
  return { name: null, description: null, projectId: null, roles: [], serverId: null, toolPattern: "*", enabled: true, ...partial };
}

/** Calls the tool once with the given arguments, then answers. */
class ToolThenAnswerProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ChatMessage[][] = [];
  readonly offered: string[][] = [];
  constructor(private readonly toolName: string, private readonly args: () => Record<string, unknown>) {}
  async generate(request: ProviderCallRequest) {
    this.calls.push(request.messages.map((message) => ({ ...message })));
    this.offered.push((request.tools ?? []).map((tool) => tool.name));
    const sawTool = request.messages.some((message) => message.role === "tool");
    if (!sawTool && request.tools?.some((tool) => tool.name === this.toolName)) {
      return { content: "Calling a tool.", toolCalls: [{ id: `call-${this.calls.length}`, name: this.toolName, arguments: this.args() }] };
    }
    return { content: "All done.", toolCalls: [] };
  }
}

function repoAdapter(invoked: Array<Record<string, unknown>>): MCPServerAdapter {
  return {
    definition: { id: "repo-mcp", label: "Repo", description: "Test repo server", configSchema: {}, authSchema: {} },
    async discoverTools() {
      return [{ serverId: "repo-mcp", serverLabel: "Repo", name: "push", description: "Push a branch", inputSchema: { type: "object", properties: { repo: { type: "string" }, branch: { type: "string" } } } }];
    },
    async invokeTool(toolName: string, args: Record<string, unknown>) {
      invoked.push({ tool: toolName, ...args });
      return { ok: true, output: { pushed: true } };
    }
  } as unknown as MCPServerAdapter;
}

function deps(input: { rules: McpToolPolicyRule[]; provider?: LLMProviderAdapter; invoked?: Array<Record<string, unknown>>; paused?: WorkflowExecutionState[] }): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  if (input.provider) providerRegistry.register(input.provider);
  const mcpRegistry = createDefaultMCPRegistry();
  mcpRegistry.register(repoAdapter(input.invoked ?? []));
  return {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry,
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    persistPausedExecution: async (paused) => {
      input.paused?.push(paused.state);
    },
    loadMcpToolPolicy: () => ({ rules: input.rules, classifications: [] })
  };
}

function agentWorkflow(settings: Workflow["settings"] = {}, id = "wf-repo-agent"): Workflow {
  return workflow(
    id,
    [
      node("in", "webhook_input"),
      node("agent", "agent_orchestrator", { maxIterations: 4, toolCallingEnabled: true, userPromptTemplate: "{{user_prompt}}" }, "Repo agent"),
      node("model", "llm_call", { provider: { providerId: "scripted", model: "m" } }),
      node("tool", "mcp_tool", { serverId: "repo-mcp", toolName: "push" }),
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

const agentOutput = (result: Awaited<ReturnType<typeof executeWorkflow>>) =>
  result.nodeResults.filter((entry) => entry.nodeId === "agent").at(-1)?.output as
    | { steps: Array<{ toolResults: Array<{ error?: string; toolCallId: string }> }>; _toolPolicy?: McpToolPolicyTrace }
    | undefined;

const prodOnly = { all: [{ path: "repo", op: "equals" as const, value: "acme/prod" }] };

describe("argument-aware rules for agent tool calls", () => {
  it("keeps a conditionally denied tool visible, refuses the matching call as a tool error and records the decision", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const deny = rule({ id: "no-prod", name: "No prod pushes", effect: "deny", conditions: prodOnly });
    const provider = new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/prod", branch: "main" }));
    const result = await executeWorkflow({ workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push" } }, deps({ rules: [deny], provider, invoked }));
    expect(result.status).toBe("success");
    expect(provider.offered[0]).toContain("repo-mcp__push");
    expect(invoked).toHaveLength(0);
    const output = agentOutput(result)!;
    expect(output.steps[0]!.toolResults[0]!.error).toContain("blocked by policy 'No prod pushes' (no-prod)");
    expect(output.steps[0]!.toolResults[0]!.error).toContain('repo equals "acme/prod"');
    expect(output._toolPolicy?.hidden).toEqual([]);
    expect(output._toolPolicy?.decisions).toEqual([
      expect.objectContaining({ tool: "push", server: "repo-mcp", effect: "deny", ruleId: "no-prod", toolCallId: "call-1", matched: [{ ruleId: "no-prod", mode: "enforce", effect: "deny" }] })
    ]);

    const other = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push" } },
      deps({ rules: [deny], provider: new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/dev" })), invoked })
    );
    expect(other.status).toBe("success");
    expect(invoked).toEqual([{ tool: "push", repo: "acme/dev" }]);
    // No rule matched that call, so nothing is recorded for it.
    expect(agentOutput(other)?._toolPolicy?.decisions).toBeUndefined();
  });

  it("pauses for a require_approval rule and runs the exact call once approved", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const paused: WorkflowExecutionState[] = [];
    const approve = rule({ id: "ask-prod", name: "Prod needs a person", effect: "require_approval", conditions: prodOnly });
    const args = { repo: "acme/prod", branch: "main" };
    const provider = () => new ToolThenAnswerProvider("repo-mcp__push", () => args);
    const first = await executeWorkflow(
      { workflow: agentWorkflow(), executionId: "exec-ask", webhookPayload: { user_prompt: "Push" } },
      deps({ rules: [approve], provider: provider(), invoked, paused })
    );
    expect(first.status).toBe("waiting_approval");
    expect(invoked).toHaveLength(0);
    expect(paused).toHaveLength(1);
    const handoff = paused[0]!.approvalHandoff;
    expect(handoff).toMatchObject({ kind: "rerun", source: "agent_tool_gate", request: { kind: "agent_tool", approverRoles: ["admin"], approverUsers: [], allowSelfApproval: false } });
    // The key binds the call to the rule that asked.
    expect(handoff?.kind === "rerun" ? handoff.approvalKey : "").toBe(
      writeToolPolicyApprovalKey(writeToolApprovalKey("agent", "repo-mcp", "push", args), { ruleId: "ask-prod", ruleHash: hashMcpToolPolicyRule(approve) })
    );
    expect(first.output).toMatchObject({ approvalMessage: "Agent 'Repo agent' wants to call 'push' on 'repo-mcp', which needs approval by tool policy 'Prod needs a person'." });
    expect(resolvePendingApproval(paused[0]!).details).toMatchObject({ policyRuleId: "ask-prod", policyRuleName: "Prod needs a person", requiredBy: ["tool_policy"] });

    const approved = await resumeWorkflowExecution({ executionId: "exec-ask", state: paused[0]!, decision: "approve" }, deps({ rules: [approve], provider: provider(), invoked }));
    expect(approved.status).toBe("success");
    expect(invoked).toEqual([{ tool: "push", ...args }]);
    expect(agentOutput(approved)?._toolPolicy?.decisions).toEqual([expect.objectContaining({ effect: "require_approval", approval: "approved", ruleId: "ask-prod" })]);
  });

  it("asks once when both the write-tool gate and a rule want approval", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const paused: WorkflowExecutionState[] = [];
    const approve = rule({ id: "ask-all", name: "Every push", effect: "require_approval", toolPattern: "push" });
    const settings: Workflow["settings"] = { writeToolApproval: { enabled: true, approverRoles: ["admin"], allowSelfApproval: true, timeoutMinutes: 15 } };
    const provider = () => new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/api" }));
    const first = await executeWorkflow(
      { workflow: agentWorkflow(settings), executionId: "exec-both", webhookPayload: { user_prompt: "Push" } },
      deps({ rules: [approve], provider: provider(), invoked, paused })
    );
    expect(first.status).toBe("waiting_approval");
    expect(paused).toHaveLength(1);
    expect(first.output).toMatchObject({
      timeoutMinutes: 15,
      approvalMessage: "Agent 'Repo agent' wants to call the write tool 'push' on 'repo-mcp'; tool policy 'Every push' also requires approval."
    });
    const handoff = paused[0]!.approvalHandoff;
    // A rule asks too, so admins decide and nobody approves their own run.
    expect(handoff).toMatchObject({ request: { approverRoles: ["admin"], approverUsers: [], allowSelfApproval: false } });
    expect(resolvePendingApproval(paused[0]!).details).toMatchObject({ classification: "not_marked_read_only", requiredBy: ["write_tool_gate", "tool_policy"] });

    const again: WorkflowExecutionState[] = [];
    const approved = await resumeWorkflowExecution({ executionId: "exec-both", state: paused[0]!, decision: "approve" }, deps({ rules: [approve], provider: provider(), invoked, paused: again }));
    expect(approved.status).toBe("success");
    expect(again).toHaveLength(0);
    expect(invoked).toEqual([{ tool: "push", repo: "acme/api" }]);
  });

  it("lets only admins decide a policy approval, whatever the workflow's approver settings say", async () => {
    const paused: WorkflowExecutionState[] = [];
    const approve = rule({ id: "ask-all", effect: "require_approval", toolPattern: "push" });
    const settings: Workflow["settings"] = { writeToolApproval: { enabled: true, approverRoles: ["builder"], approverUsers: ["bob@example.org"], allowSelfApproval: true } };
    await executeWorkflow(
      { workflow: agentWorkflow(settings), executionId: "exec-admins", webhookPayload: { user_prompt: "Push" } },
      deps({ rules: [approve], provider: new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/api" })), paused })
    );
    expect(paused[0]!.approvalHandoff).toMatchObject({ request: { approverRoles: ["admin"], approverUsers: [], allowSelfApproval: false } });

    // The write-tool gate alone keeps the workflow's own approvers.
    const gateOnly: WorkflowExecutionState[] = [];
    await executeWorkflow(
      { workflow: agentWorkflow(settings), executionId: "exec-gate", webhookPayload: { user_prompt: "Push" } },
      deps({ rules: [], provider: new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/api" })), paused: gateOnly })
    );
    expect(gateOnly[0]!.approvalHandoff).toMatchObject({ request: { approverRoles: ["builder"], approverUsers: ["bob@example.org"], allowSelfApproval: true } });
  });

  it("never lets a write-gate approval stand in for a policy approval, but a policy approval covers the gate", async () => {
    const settings: Workflow["settings"] = { writeToolApproval: { enabled: true, allowSelfApproval: true } };
    const approve = rule({ id: "ask-all", name: "Every push", effect: "require_approval", toolPattern: "push" });
    const provider = () => new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/api" }));

    // Paused for the gate alone; a rule appears before the re-run: the gate's approval does not satisfy it.
    const invoked: Array<Record<string, unknown>> = [];
    const gatePause: WorkflowExecutionState[] = [];
    await executeWorkflow({ workflow: agentWorkflow(settings), executionId: "exec-m4a", webhookPayload: { user_prompt: "Push" } }, deps({ rules: [], provider: provider(), paused: gatePause }));
    expect(gatePause).toHaveLength(1);
    const again: WorkflowExecutionState[] = [];
    const resumed = await resumeWorkflowExecution(
      { executionId: "exec-m4a", state: gatePause[0]!, decision: "approve" },
      deps({ rules: [approve], provider: provider(), invoked, paused: again })
    );
    expect(resumed.status).toBe("waiting_approval");
    expect(invoked).toHaveLength(0);
    expect(resolvePendingApproval(again[0]!).details).toMatchObject({ policyRuleId: "ask-all", requiredBy: ["write_tool_gate", "tool_policy"] });

    // Paused for the rule and the gate; the rule is gone at the re-run: the policy approval still covers the gate.
    const bothPause: WorkflowExecutionState[] = [];
    await executeWorkflow({ workflow: agentWorkflow(settings), executionId: "exec-m4b", webhookPayload: { user_prompt: "Push" } }, deps({ rules: [approve], provider: provider(), paused: bothPause }));
    const none: WorkflowExecutionState[] = [];
    const covered = await resumeWorkflowExecution(
      { executionId: "exec-m4b", state: bothPause[0]!, decision: "approve" },
      deps({ rules: [], provider: provider(), invoked, paused: none })
    );
    expect(covered.status).toBe("success");
    expect(none).toHaveLength(0);
    expect(invoked).toEqual([{ tool: "push", repo: "acme/api" }]);
  });

  it("logs shadow rules without changing the outcome", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const shadow = rule({ id: "shadow-prod", name: "Would block prod", effect: "deny", mode: "shadow", conditions: prodOnly });
    const result = await executeWorkflow(
      { workflow: agentWorkflow(), webhookPayload: { user_prompt: "Push" } },
      deps({ rules: [shadow], provider: new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/prod" })), invoked })
    );
    expect(result.status).toBe("success");
    expect(invoked).toEqual([{ tool: "push", repo: "acme/prod" }]);
    expect(agentOutput(result)?._toolPolicy?.decisions).toEqual([
      expect.objectContaining({
        effect: "allow",
        decidedBy: "default",
        matched: [{ ruleId: "shadow-prod", mode: "shadow", effect: "deny" }],
        shadow: expect.objectContaining({ effect: "deny", ruleId: "shadow-prod", changed: true })
      })
    ]);
  });

  it("applies a workflow-scoped rule only to that workflow", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const deny = rule({ id: "wf-only", effect: "deny", workflowIds: ["wf-locked"] });
    const provider = () => new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/api" }));
    const locked = await executeWorkflow({ workflow: agentWorkflow({}, "wf-locked"), webhookPayload: { user_prompt: "Push" } }, deps({ rules: [deny], provider: provider(), invoked }));
    expect(agentOutput(locked)?._toolPolicy?.hidden).toEqual([expect.objectContaining({ tool: "push", ruleId: "wf-only" })]);
    const open = await executeWorkflow({ workflow: agentWorkflow({}, "wf-open"), webhookPayload: { user_prompt: "Push" } }, deps({ rules: [deny], provider: provider(), invoked }));
    expect(open.status).toBe("success");
    expect(invoked).toEqual([{ tool: "push", repo: "acme/api" }]);
  });
});

describe("argument-aware rules for direct MCP Tool nodes", () => {
  function directWorkflow(args: Record<string, unknown>): Workflow {
    return workflow(
      "wf-direct",
      [node("start", "manual_trigger"), node("tool", "mcp_tool", { serverId: "repo-mcp", toolName: "push", argsTemplate: JSON.stringify(args) }, "Push step"), node("out", "output")],
      [
        { source: "start", target: "tool" },
        { source: "tool", target: "out" }
      ]
    );
  }

  it("fails the node on a conditional deny and runs other arguments", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const deny = rule({ id: "no-prod", effect: "deny", conditions: prodOnly });
    const denied = await executeWorkflow({ workflow: directWorkflow({ repo: "acme/prod" }) }, deps({ rules: [deny], invoked }));
    expect(denied.status).toBe("error");
    expect(denied.error).toContain("blocked by policy 'no-prod'");
    const allowed = await executeWorkflow({ workflow: directWorkflow({ repo: "acme/dev" }) }, deps({ rules: [deny], invoked }));
    expect(allowed.status).toBe("success");
    expect(invoked).toEqual([{ tool: "push", repo: "acme/dev" }]);
  });

  it("fails clearly when the arguments are not a JSON object and a rule reads arguments", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const listArgs = workflow(
      "wf-direct-list",
      [node("start", "manual_trigger"), node("tool", "mcp_tool", { serverId: "repo-mcp", toolName: "push", argsTemplate: '["acme/prod"]' }, "Push step"), node("out", "output")],
      [
        { source: "start", target: "tool" },
        { source: "tool", target: "out" }
      ]
    );
    const deny = rule({ id: "no-prod", effect: "deny", conditions: prodOnly });
    const result = await executeWorkflow({ workflow: listArgs }, deps({ rules: [deny], invoked }));
    expect(result.status).toBe("error");
    expect(result.error).toContain("must send its arguments as a JSON object (got an array)");
    expect(invoked).toHaveLength(0);
  });

  it("pauses on require_approval and calls the tool once approved", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const paused: WorkflowExecutionState[] = [];
    const approve = rule({ id: "ask", name: "Ask first", effect: "require_approval", conditions: prodOnly });
    const first = await executeWorkflow({ workflow: directWorkflow({ repo: "acme/prod" }), executionId: "exec-direct" }, deps({ rules: [approve], invoked, paused }));
    expect(first.status).toBe("waiting_approval");
    expect(first.output).toMatchObject({ approvalMessage: "MCP Tool node 'Push step' wants to call 'push' on 'repo-mcp', which needs approval by tool policy 'Ask first'." });
    expect(invoked).toHaveLength(0);
    const approved = await resumeWorkflowExecution({ executionId: "exec-direct", state: paused[0]!, decision: "approve" }, deps({ rules: [approve], invoked }));
    expect(approved.status).toBe("success");
    expect(invoked).toEqual([{ tool: "push", repo: "acme/prod" }]);
    const output = approved.nodeResults.find((entry) => entry.nodeId === "tool")?.output as { _toolPolicy?: McpToolPolicyTrace };
    expect(output._toolPolicy?.decisions).toEqual([expect.objectContaining({ effect: "require_approval", approval: "approved" })]);
    const rejected = await resumeWorkflowExecution({ executionId: "exec-direct", state: paused[0]!, decision: "reject", reason: "No" }, deps({ rules: [approve], invoked }));
    expect(rejected.status).toBe("error");
    expect(invoked).toHaveLength(1);
  });
});

describe("the tool policy decides before the guard", () => {
  // A destination rule that asks for approval when a card number goes to a public MCP server.
  const profile = parseGuardProfile({
    id: "cards",
    name: "cards",
    version: "1",
    destinations: { rules: [{ name: "Cards stay in-house", when: { dataClasses: ["card_number"] }, allow: { maxTier: "private" }, action: "require_approval" }] }
  } as never);
  const resolvedProfile: ResolvedGuardProfile = { profileId: "cards", version: 1, hash: hashGuardProfile(profile), name: "cards", profile };
  const guardFor = (events: GuardVerdictEvent[]): WorkflowExecutionDependencies["guard"] => ({
    registry: createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
    resolveRun: () => ({ source: "project", stack: [resolvedProfile], chain: [] }),
    loadProfile: () => resolvedProfile,
    vault: new InMemoryTokenVaultStorage(),
    onVerdict: (event) => {
      events.push(event);
    }
  });
  const directWorkflow = workflow(
    "wf-guarded",
    [node("in", "webhook_input"), node("tool", "mcp_tool", { serverId: "repo-mcp", toolName: "push", argsTemplate: '{"repo":"{{repo}}","note":"{{note}}"}' }), node("out", "output")],
    [
      { source: "in", target: "tool" },
      { source: "tool", target: "out" }
    ]
  );
  const payload = { repo: "acme/prod", note: "4111 1111 1111 1111" };

  it("a direct MCP Tool call the policy denies fails on the policy, and the guard never judges it", async () => {
    const events: GuardVerdictEvent[] = [];
    const deny = rule({ id: "no-prod", effect: "deny", conditions: prodOnly });
    const result = await executeWorkflow({ workflow: directWorkflow, webhookPayload: payload }, { ...deps({ rules: [deny] }), guard: guardFor(events) });
    expect(result.status).toBe("error");
    expect(result.error).toContain("blocked by policy 'no-prod'");
    expect(events).toEqual([]);
  });

  describe("when the guard rewrites an agent's tool arguments", () => {
    const EMAIL = "ana.lopez@example.org";
    const redactProfile = parseGuardProfile({
      id: "redact-email",
      name: "redact-email",
      version: "1",
      channels: {
        tool_arguments: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "redact" }, sensitive_data: { action: "allow" } }, defaultAction: { action: "allow" } }
      }
    } as never);
    const redacting: ResolvedGuardProfile = { profileId: "redact-email", version: 1, hash: hashGuardProfile(redactProfile), name: "redact-email", profile: redactProfile };
    const redactingGuard = (): WorkflowExecutionDependencies["guard"] => ({
      registry: createDefaultGuardRegistry({ resolver: async () => ["93.184.215.14"] }),
      resolveRun: () => ({ source: "project", stack: [redacting], chain: [] }),
      loadProfile: () => redacting,
      vault: new InMemoryTokenVaultStorage()
    });
    const settings: Workflow["settings"] = { writeToolApproval: { enabled: true, allowSelfApproval: true } };
    const provider = () => new ToolThenAnswerProvider("repo-mcp__push", () => ({ repo: "acme/api", note: `ping ${EMAIL}` }));

    async function approveUntilDone(rules: McpToolPolicyRule[], executionId: string) {
      const invoked: Array<Record<string, unknown>> = [];
      const pauses: WorkflowExecutionState[] = [];
      let result = await executeWorkflow(
        { workflow: agentWorkflow(settings), executionId, webhookPayload: { user_prompt: "Push" } },
        { ...deps({ rules, provider: provider(), invoked, paused: pauses }), guard: redactingGuard() }
      );
      let requests = 0;
      while (result.status === "waiting_approval" && requests < 4) {
        requests += 1;
        result = await resumeWorkflowExecution(
          { executionId, state: pauses.at(-1)!, decision: "approve" },
          { ...deps({ rules, provider: provider(), invoked, paused: pauses }), guard: redactingGuard() }
        );
      }
      return { result, requests, invoked, pauses };
    }

    it("with no rules, the write-tool gate asks once, after the guard, for the rewritten call", async () => {
      const { result, requests, invoked, pauses } = await approveUntilDone([], "exec-m7-gate");
      expect(result.status).toBe("success");
      expect(requests).toBe(1);
      expect(invoked).toHaveLength(1);
      expect(String(invoked[0]!.note)).not.toContain(EMAIL);
      // The person saw the arguments that are sent.
      expect(String(resolvePendingApproval(pauses[0]!).details?.arguments)).not.toContain(EMAIL);
    });

    it("a policy approval asked before the guard also covers the gate for the rewritten call", async () => {
      const approve = rule({ id: "ask-all", effect: "require_approval", toolPattern: "push" });
      const { result, requests, invoked } = await approveUntilDone([approve], "exec-m7-policy");
      expect(result.status).toBe("success");
      expect(requests).toBe(1);
      expect(invoked).toHaveLength(1);
    });
  });

  it("without the rule, the same call reaches the guard, which asks for approval", async () => {
    const result = await executeWorkflow({ workflow: directWorkflow, webhookPayload: payload }, { ...deps({ rules: [] }), guard: guardFor([]) });
    expect(result.status).toBe("waiting_approval");
    expect(result.output).toMatchObject({ approvalMessage: expect.stringContaining("card_number") });
  });
});
