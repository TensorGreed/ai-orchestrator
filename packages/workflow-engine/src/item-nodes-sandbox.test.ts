import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow } from "@ai-orchestrator/shared";
import type { WorkflowExecutionDependencies } from "./executor";

/**
 * A typed Set field whose expression hits a failure of the sandbox itself (a crashed instance, an open circuit
 * breaker) fails the node: it never stores `null` as if the expression had simply given nothing.
 */
vi.mock("./expression", async (importOriginal) => {
  const original = await importOriginal<typeof import("./expression")>();
  const { ExpressionSandboxError } = await import("./expression-sandbox");
  return {
    ...original,
    withExpressionEvaluator: <R>(context: Parameters<typeof original.withExpressionEvaluator>[0], body: (evaluate: (expression: string) => unknown) => R): R =>
      original.withExpressionEvaluator(context, (evaluate) =>
        body((expression) => {
          if (expression.includes("crash")) throw new ExpressionSandboxError("instance crashed", false);
          return evaluate(expression);
        })
      )
  };
});

const { executeWorkflow } = await import("./executor");
const { renderTemplateValue } = await import("./template");
const { isExpressionSandboxFailure } = await import("./expression-sandbox");
const { IN_PROCESS_CODE_SANDBOX } = await import("./code-sandbox");

function deps(): WorkflowExecutionDependencies {
  return {
    providerRegistry: new ProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX
  };
}

describe("typed Set fields and sandbox failures", () => {
  it("renderTemplateValue rethrows a sandbox failure, but an expression's own error is a missing value", () => {
    let thrown: unknown;
    try {
      renderTemplateValue("{{ crash(1) }}", {});
    } catch (error) {
      thrown = error;
    }
    expect(isExpressionSandboxFailure(thrown)).toBe(true);
    expect(renderTemplateValue("{{ (1).nope() }}", {})).toEqual({ single: true, value: undefined });
  });

  it.each(["auto", "number", "json"])("a %s field fails the node on a sandbox failure", async (type) => {
    const workflow: Workflow = {
      id: "wf-sandbox-set",
      name: "Sandbox Set",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "in", type: "text_input", name: "In", position: { x: 0, y: 0 }, config: { text: "x" } },
        { id: "set", type: "set_node", name: "Set", position: { x: 100, y: 0 }, config: { assignments: [{ key: "v", valueTemplate: "{{ crash(1) }}", type }] } }
      ],
      edges: [{ id: "e1", source: "in", target: "set" }]
    };
    const result = await executeWorkflow({ workflow }, deps());
    expect(result.status).toBe("error");
    const set = result.nodeResults.find((entry) => entry.nodeId === "set");
    expect(set?.status).toBe("error");
    expect(set?.output).toBeUndefined();
  });
});
