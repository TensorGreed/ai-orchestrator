import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowExecutionState, WorkflowNode } from "@ai-orchestrator/shared";
import type { WorkflowExecutionDependencies } from "./executor";

/**
 * Defence in depth for `approval_gate_continue_on_error`: a stored workflow
 * saved before the rule can still hold a gate set to continue on error. With
 * validation out of the way, a failed gate (a rejection with nowhere to go,
 * or an expression sandbox failure while rendering the request) must still
 * stop the run instead of running the approved branch.
 */
vi.mock("./validation", async (importOriginal) => {
  const original = await importOriginal<typeof import("./validation")>();
  return {
    ...original,
    validateWorkflowGraph: (workflow: Workflow) => ({ valid: true, issues: [], orderedNodeIds: original.sortWorkflowNodes(workflow) })
  };
});

// The sandbox failing on one template (a crashed instance, an open circuit breaker).
vi.mock("./template", async (importOriginal) => {
  const original = await importOriginal<typeof import("./template")>();
  const { ExpressionSandboxError } = await import("./expression-sandbox");
  return {
    ...original,
    renderTemplate: (template: string, data: Record<string, unknown>) => {
      if (template.includes("{{ crash }}")) throw new ExpressionSandboxError("instance crashed", false);
      return original.renderTemplate(template, data);
    }
  };
});

const { executeWorkflow, resumeWorkflowExecution } = await import("./executor");

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function continuingGate(message: string, via: "onError" | "errorConfig" = "onError"): Workflow {
  return {
    id: "wf-continue",
    name: "wf-continue",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("in", "webhook_input"),
      via === "onError"
        ? node("gate", "approval_gate", { message, approverRoles: ["builder"], onError: "continue" })
        : { ...node("gate", "approval_gate", { message, approverRoles: ["builder"] }), errorConfig: { continueOnFail: true } },
      node("on_approved", "output", { responseTemplate: "approved ran" }),
      node("after", "noop_node")
    ],
    edges: [
      { id: "e0", source: "in", target: "gate" },
      { id: "e1", source: "gate", sourceHandle: "approved", target: "on_approved" },
      { id: "e2", source: "on_approved", target: "after" }
    ]
  };
}

function deps(paused: WorkflowExecutionState[]): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    persistPausedExecution: async (input) => {
      paused.push(input.state);
    }
  };
}

const last = (result: Awaited<ReturnType<typeof executeWorkflow>>, id: string) => result.nodeResults.filter((entry) => entry.nodeId === id).at(-1);

describe("a failed Approval Gate set to continue on error", () => {
  for (const via of ["onError", "errorConfig"] as const) {
    it(`stops on a rejection with no rejected branch (${via})`, async () => {
      const paused: WorkflowExecutionState[] = [];
      const first = await executeWorkflow({ workflow: continuingGate("ok?", via), executionId: "exec-reject" }, deps(paused));
      expect(first.status).toBe("waiting_approval");
      const rejected = await resumeWorkflowExecution({ executionId: "exec-reject", state: paused[0]!, decision: "reject", actedBy: "lead@example.com", reason: "No" }, deps(paused));
      expect(rejected.status).toBe("error");
      expect(last(rejected, "gate")?.status).toBe("error");
      expect(last(rejected, "on_approved")?.status).not.toBe("success");
      expect(last(rejected, "after")?.status).not.toBe("success");
    });
  }

  it("stops when the expression sandbox cannot render the request (it throws instead of rendering an empty message)", async () => {
    const paused: WorkflowExecutionState[] = [];
    const result = await executeWorkflow({ workflow: continuingGate("Send {{ crash }}?"), executionId: "exec-crash" }, deps(paused));
    expect(paused).toEqual([]);
    expect(result.status).toBe("error");
    expect(last(result, "gate")).toMatchObject({ status: "error", error: expect.stringContaining("expression sandbox error") });
    expect(last(result, "on_approved")?.status).not.toBe("success");
  });
});
