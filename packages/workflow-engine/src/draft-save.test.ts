import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { nodeDefinitions, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { saveBlockingIssues, validateWorkflowGraph } from "./validation";

const position = { x: 0, y: 0 };
const dependencies = () => ({
  providerRegistry: createDefaultProviderRegistry(),
  connectorRegistry: createDefaultConnectorRegistry(),
  mcpRegistry: createDefaultMCPRegistry(),
  agentRuntime: createDefaultAgentRuntime(),
  resolveSecret: async () => undefined
});

function workflowOf(nodes: Workflow["nodes"], edges: Workflow["edges"]): Workflow {
  return { id: "wf-draft", name: "Draft", schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges };
}

describe("a workflow without an Output node", () => {
  const noOutput = workflowOf(
    [
      { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
      { id: "set", type: "set_node", name: "Set", position, config: { assignments: [{ key: "greeting", valueTemplate: "hi {{text}}" }] } }
    ],
    [{ id: "e1", source: "start", target: "set" }]
  );

  it("is valid, with a warning that names what the result will be", () => {
    const validation = validateWorkflowGraph(noOutput);
    expect(validation.valid).toBe(true);
    const issue = validation.issues.find((item) => item.code === "missing_output_node");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toMatch(/last node/i);
  });

  it("runs, and its result is the last node's output", async () => {
    const result = await executeWorkflow({ workflow: noOutput }, dependencies());
    expect(result.status).toBe("success");
    expect(result.output).toEqual(result.nodeResults.find((node) => node.nodeId === "set")?.output);
    expect(JSON.stringify(result.output)).toContain("hi hello");
  });

  it("takes the last node that ran when the last one in order was skipped", async () => {
    const branching = workflowOf(
      [
        { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
        { id: "check", type: "if_node", name: "Check", position, config: { condition: "{{ text === 'nope' }}" } },
        { id: "yes", type: "set_node", name: "Yes", position, config: { assignments: [{ key: "branch", valueTemplate: "yes" }] } }
      ],
      [
        { id: "e1", source: "start", target: "check" },
        { id: "e2", source: "check", target: "yes", sourceHandle: "true" }
      ]
    );
    const result = await executeWorkflow({ workflow: branching }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "yes")?.status).toBe("skipped");
    expect(result.output).toBeDefined();
    expect(result.output).toEqual(result.nodeResults.find((node) => node.nodeId === "check")?.output);
  });
});

describe("an Output node without a template", () => {
  it("passes on its parent's output in a flow with no prompt or answer, not an empty string", async () => {
    const workflow = workflowOf(
      [
        { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
        { id: "set", type: "set_node", name: "Set", position, config: { assignments: [{ key: "total", valueTemplate: "42" }] } },
        { id: "out", type: "output", name: "Out", position, config: { outputKey: "result" } }
      ],
      [
        { id: "e1", source: "start", target: "set" },
        { id: "e2", source: "set", target: "out" }
      ]
    );
    const result = await executeWorkflow({ workflow }, dependencies());
    expect(result.status).toBe("success");
    const out = result.nodeResults.find((node) => node.nodeId === "out")?.output as Record<string, unknown>;
    expect(out.result).not.toBe("");
    expect(out.result).toEqual(result.nodeResults.find((node) => node.nodeId === "set")?.output);
  });

  it("still returns the answer of an LLM parent", async () => {
    const workflow = workflowOf(
      [
        { id: "llm", type: "llm_call", name: "LLM", position, config: { provider: { providerId: "echo", model: "echo" } } },
        { id: "out", type: "output", name: "Out", position, config: {} }
      ],
      [{ id: "e1", source: "llm", target: "out" }]
    );
    const result = await executeWorkflow({ workflow, userPrompt: "ping" }, dependencies());
    const out = result.nodeResults.find((node) => node.nodeId === "out")?.output as Record<string, unknown>;
    expect(JSON.stringify(out.result)).toContain("ping");
  });

  it("is what a new Output node starts with", () => {
    const output = nodeDefinitions.find((definition) => definition.type === "output");
    expect(output?.sampleConfig.responseTemplate).toBeUndefined();
    expect(output?.sampleConfig.outputKey).toBe("result");
  });
});

describe("saveBlockingIssues", () => {
  const blocking = (workflow: Workflow) => saveBlockingIssues(validateWorkflowGraph(workflow)).map((issue) => issue.code);

  it("lets an unfinished draft save: unset node fields and a missing Output node do not block", () => {
    const draft = workflowOf(
      [
        { id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "orders", method: "POST" } },
        { id: "http", type: "http_request", name: "HTTP", position, config: { method: "POST" } },
        { id: "branch", type: "if_node", name: "If", position, config: {} }
      ],
      [
        { id: "e1", source: "hook", target: "http" },
        { id: "e2", source: "http", target: "branch" }
      ]
    );
    const validation = validateWorkflowGraph(draft);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing_output_node", "missing_http_request_url_template", "missing_if_condition"])
    );
    expect(blocking(draft)).toEqual([]);
  });

  it("blocks a broken graph: a cycle, a dangling edge or a duplicate node id", () => {
    const cyclic = workflowOf(
      [
        { id: "a", type: "noop_node", name: "A", position, config: {} },
        { id: "b", type: "noop_node", name: "B", position, config: {} }
      ],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "a" }
      ]
    );
    expect(blocking(cyclic)).toContain("cycle_detected");
    const dangling = workflowOf([{ id: "a", type: "noop_node", name: "A", position, config: {} }], [{ id: "e1", source: "a", target: "ghost" }]);
    expect(blocking(dangling)).toContain("missing_edge_target");
    const duplicate = workflowOf(
      [
        { id: "a", type: "noop_node", name: "A", position, config: {} },
        { id: "a", type: "noop_node", name: "A again", position, config: {} }
      ],
      []
    );
    expect(blocking(duplicate)).toContain("duplicate_node_id");
  });

  it("blocks trigger and safety settings that would be live once saved", () => {
    const unsafe = workflowOf(
      [{ id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "orders", method: "POST", authMode: "bearer_token" } }],
      []
    );
    expect(blocking(unsafe)).toContain("missing_webhook_auth_secret");
  });

  it("blocks an issue code it does not know", () => {
    expect(saveBlockingIssues({ valid: false, issues: [{ code: "some_future_check", message: "x" }] }).map((issue) => issue.code)).toEqual([
      "some_future_check"
    ]);
  });

  it("never blocks on a warning", () => {
    expect(saveBlockingIssues({ valid: true, issues: [{ code: "cycle_detected", message: "x", severity: "warning" }] })).toEqual([]);
  });
});
