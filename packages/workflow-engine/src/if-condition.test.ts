import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";
import { evaluateConditionTemplate } from "./template";

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

/** Set node "values" → IF → true / false outputs. */
function ifWorkflow(values: Record<string, unknown>, condition: string): Workflow {
  return {
    id: "wf-if-cond",
    name: "IF condition",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "in", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "start" } },
      {
        id: "vals",
        type: "set_node",
        name: "Values",
        position: { x: 100, y: 0 },
        config: { assignments: Object.entries(values).map(([field, value]) => ({ key: field, valueTemplate: JSON.stringify(value) })) }
      },
      { id: "if", type: "if_node", name: "IF", position: { x: 200, y: 0 }, config: { condition } },
      { id: "yes", type: "output", name: "Yes", position: { x: 400, y: -50 }, config: { responseTemplate: "yes" } },
      { id: "no", type: "output", name: "No", position: { x: 400, y: 50 }, config: { responseTemplate: "no" } }
    ],
    edges: [
      { id: "e0", source: "in", target: "vals" },
      { id: "e1", source: "vals", target: "if" },
      { id: "e2", source: "if", sourceHandle: "true", target: "yes" },
      { id: "e3", source: "if", sourceHandle: "false", target: "no" }
    ]
  };
}

describe("evaluateConditionTemplate", () => {
  it("keeps the old truthiness when the condition is one {{ }} or plain text", () => {
    expect(evaluateConditionTemplate("{{answer}}", { answer: "yes" })).toEqual({ result: true, evaluatedValue: "yes" });
    expect(evaluateConditionTemplate("{{answer}}", { answer: "false" }).result).toBe(false);
    expect(evaluateConditionTemplate("  {{ answer }}  ", { answer: "" }).result).toBe(false);
    expect(evaluateConditionTemplate("true", {}).result).toBe(true);
    expect(evaluateConditionTemplate("false", {}).result).toBe(false);
    expect(evaluateConditionTemplate("{{ score > 90 }}", { score: 95 }).result).toBe(true);
    expect(evaluateConditionTemplate("{{ score > 90 }}", { score: 10 }).result).toBe(false);
  });

  it("evaluates text outside {{ }} as an expression over the filled-in values", () => {
    expect(evaluateConditionTemplate("{{userScore}} > 90", { userScore: 95 })).toEqual({ result: true, evaluatedValue: "true" });
    expect(evaluateConditionTemplate("{{userScore}} > 90", { userScore: 40 })).toEqual({ result: false, evaluatedValue: "false" });
    expect(evaluateConditionTemplate("{{answer}} === 'true'", { answer: "true" }).result).toBe(true);
    expect(evaluateConditionTemplate("{{answer}} === 'true'", { answer: "no" }).result).toBe(false);
    // Values keep their type: a number stays a number, a string stays a string.
    expect(evaluateConditionTemplate("{{count}} === 3", { count: 3 }).result).toBe(true);
    expect(evaluateConditionTemplate("{{count}} === 3", { count: "3" }).result).toBe(false);
    // Nested paths, and expressions inside the braces.
    expect(evaluateConditionTemplate("{{results.n1.status}} == 'done' && {{ items.length }} > 1", { results: { n1: { status: "done" } }, items: [1, 2] }).result).toBe(true);
    // A missing value is undefined, not the text "undefined".
    expect(evaluateConditionTemplate("{{missing}} === undefined", {}).result).toBe(true);
  });

  it("a string value that looks like code stays data", () => {
    expect(evaluateConditionTemplate("{{name}} === 'x'", { name: "x' || true || '" }).result).toBe(false);
  });

  it("fails clearly when the filled-in condition is not an expression, without echoing values", () => {
    expect(() => evaluateConditionTemplate("{{status}} == done", { status: "secret-value" })).toThrow(/IF condition/);
    try {
      evaluateConditionTemplate("{{status}} == done", { status: "secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});

describe("if_node conditions with text outside {{ }}", () => {
  it("routes by the comparison, not by the rendered text being non-empty", async () => {
    const low = await executeWorkflow({ workflow: ifWorkflow({ userScore: 40 }, "{{userScore}} > 90") }, deps());
    expect(low.status).toBe("success");
    expect(low.nodeResults.find((entry) => entry.nodeId === "yes")?.status).toBe("skipped");
    expect(low.nodeResults.find((entry) => entry.nodeId === "no")?.status).toBe("success");

    const high = await executeWorkflow({ workflow: ifWorkflow({ userScore: 95 }, "{{userScore}} > 90") }, deps());
    expect(high.nodeResults.find((entry) => entry.nodeId === "yes")?.status).toBe("success");
    expect(high.nodeResults.find((entry) => entry.nodeId === "no")?.status).toBe("skipped");
  });

  it("the editor's default condition {{answer}} === 'true' compares", async () => {
    const result = await executeWorkflow({ workflow: ifWorkflow({ answer: "nope" }, "{{answer}} === 'true'") }, deps());
    expect(result.nodeResults.find((entry) => entry.nodeId === "no")?.status).toBe("success");
    expect(result.nodeResults.find((entry) => entry.nodeId === "yes")?.status).toBe("skipped");
  });

  it("a condition that is not an expression fails the node instead of taking the true branch", async () => {
    const result = await executeWorkflow({ workflow: ifWorkflow({ status: "open" }, "{{status}} == done") }, deps());
    expect(result.status).toBe("error");
    expect(result.nodeResults.find((entry) => entry.nodeId === "if")?.error).toMatch(/IF condition/);
    expect(result.nodeResults.find((entry) => entry.nodeId === "yes")?.status).not.toBe("success");
  });
});
