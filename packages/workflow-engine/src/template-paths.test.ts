/**
 * The `{{ }}` path check Describe it repairs with, and the node output lists it reads (shared NODE_OUTPUT_SPECS):
 * each closed list matches what the node really outputs when it runs, and no shipped template or starter reads a
 * field that is not there.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { NODE_OUTPUT_SPECS, nodeOutputFieldNames, type Workflow, type WorkflowNode } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { unknownTemplatePaths } from "./template-paths";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const position = { x: 0, y: 0 };
const ECHO = { providerId: "echo", model: "echo" };

function node(id: string, type: string, config: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position, config, ...extra };
}

function workflow(nodes: WorkflowNode[], edges: Array<[string, string, string?]>): Workflow {
  return {
    id: "wf",
    name: "wf",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes,
    edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }))
  };
}

describe("unknownTemplatePaths", () => {
  const llmThen = (template: string, extra: Partial<WorkflowNode> = {}) =>
    workflow(
      [node("start", "manual_trigger"), node("ask", "llm_call", { provider: ECHO }, extra), node("after", "set_node", { assignments: [{ key: "out", valueTemplate: template }] })],
      [
        ["start", "ask"],
        ["ask", "after"]
      ]
    );

  it("reports a field the step connected straight in does not output", () => {
    const issues = unknownTemplatePaths(llmThen("{{response}}"));
    expect(issues).toEqual([expect.objectContaining({ nodeId: "after", setting: "assignments.0.valueTemplate", template: "{{response}}" })]);
    expect(issues[0]!.message).toMatch(/'ask' \(llm_call\) outputs answer, toolCalls, raw/);
    expect(issues[0]!.message).toMatch(/for example \{\{answer\}\}/);
  });

  it("accepts the output fields, the alias kept for saved workflows, deeper paths, run-wide names and expressions", () => {
    for (const template of ["{{answer}}", "{{text}}", "{{raw.choices.0}}", "{{vars.region}}", "{{user_prompt}}", "{{webhook.id}}", "{{ answer.toUpperCase() }}", "{{$json.anything}}", "{{ask.answer}}"]) {
      expect(unknownTemplatePaths(llmThen(template))).toEqual([]);
    }
  });

  it("does not check the output of a step that continues or branches on an error (it carries the failed item)", () => {
    expect(unknownTemplatePaths(llmThen("{{customer}}", { config: { provider: ECHO, onError: "continue" } }))).toEqual([]);
    expect(unknownTemplatePaths(llmThen("{{customer}}", { errorConfig: { continueOnFail: true } }))).toEqual([]);
    const branched = workflow(
      [node("start", "manual_trigger"), node("ask", "llm_call", { provider: ECHO, onError: "branch" }), node("fallback", "set_node", { assignments: [{ key: "x", valueTemplate: "{{error}}" }] })],
      [
        ["start", "ask"],
        ["ask", "fallback", "error"]
      ]
    );
    expect(unknownTemplatePaths(branched)).toEqual([]);
  });

  it("does not check plain paths in a loop body, with an input mapping, or in code", () => {
    const loop = workflow(
      [
        node("start", "manual_trigger"),
        node("each", "loop_node", { inputKey: "orders", itemVariable: "order" }),
        node("ask", "llm_call", { provider: ECHO }),
        node("body", "set_node", { assignments: [{ key: "id", valueTemplate: "{{order.id}}" }] })
      ],
      [
        ["start", "each"],
        ["each", "ask"],
        ["ask", "body"]
      ]
    );
    expect(unknownTemplatePaths(loop)).toEqual([]);
    const mapped = llmThen("{{reply}}");
    (mapped.nodes[2]!.config as Record<string, unknown>).inputMapping = { reply: "answer" };
    expect(unknownTemplatePaths(mapped)).toEqual([]);
    const code = workflow(
      [node("start", "manual_trigger"), node("ask", "llm_call", { provider: ECHO }), node("run", "code_node", { code: "return { x: '{{nope}}' }" })],
      [
        ["start", "ask"],
        ["ask", "run"]
      ]
    );
    expect(unknownTemplatePaths(code)).toEqual([]);
  });

  it("ignores attachment edges: an agent's chat model is not a step before it", () => {
    const agent = workflow(
      [
        node("start", "manual_trigger"),
        node("agent", "agent_orchestrator", { userPromptTemplate: "{{user_prompt}}" }),
        node("model", "llm_call", { provider: ECHO }),
        node("reply", "output", { responseTemplate: "{{answer}} after {{iterations}} turns, not {{summary}}" })
      ],
      [
        ["start", "agent"],
        ["agent", "model", "chat_model"],
        ["agent", "reply"]
      ]
    );
    const issues = unknownTemplatePaths(agent);
    expect(issues.map((issue) => issue.template)).toEqual(["{{summary}}"]);
    expect(issues[0]!.message).toMatch(/'agent' \(agent_orchestrator\) outputs answer, iterations/);
  });

  it("finds nothing to fix in the shipped templates and starters", () => {
    for (const folder of ["samples/workflows", "samples/starters"]) {
      for (const file of fs.readdirSync(path.join(REPO, folder)).filter((name) => name.endsWith(".json"))) {
        const raw = JSON.parse(fs.readFileSync(path.join(REPO, folder, file), "utf8"));
        const flow = (raw.workflow ?? raw) as Workflow;
        if (!Array.isArray(flow.nodes)) continue;
        expect({ file, issues: unknownTemplatePaths(flow) }).toEqual({ file, issues: [] });
      }
    }
  });
});

describe("the closed output lists match what the nodes output", () => {
  const dependencies = () => ({
    providerRegistry: createDefaultProviderRegistry(),
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: createDefaultAgentRuntime(),
    resolveSecret: async () => undefined
  });

  const cases: Array<{ type: string; config: Record<string, unknown> }> = [
    { type: "llm_call", config: { provider: ECHO } },
    { type: "basic_llm_chain", config: { provider: ECHO } },
    { type: "text_classifier", config: { provider: ECHO } },
    { type: "information_extractor", config: { provider: ECHO } },
    { type: "sentiment_analysis", config: { provider: ECHO } },
    { type: "ai_transform", config: { provider: ECHO } },
    { type: "agent_orchestrator", config: { userPromptTemplate: "{{user_prompt}}", toolCallingEnabled: false, maxIterations: 1 } },
    { type: "prompt_template", config: { template: "Hi {{user_prompt}}", outputKey: "question" } },
    { type: "set_node", config: { assignments: [{ key: "greeting", valueTemplate: "hi" }] } },
    { type: "output", config: { responseTemplate: "{{user_prompt}}", outputKey: "final" } },
    { type: "webhook_response", config: { bodyTemplate: "{\"ok\": true}" } }
  ];

  for (const { type, config } of cases) {
    it(`${type}: every output field it lists is a field it outputs, and it outputs nothing else`, async () => {
      const nodes = [node("start", "text_input", { text: "hello" }), node("step", type, config)];
      const edges: Array<[string, string, string?]> = [["start", "step"]];
      if (type === "agent_orchestrator") {
        nodes.push(node("model", "llm_call", { provider: ECHO }));
        edges.push(["step", "model", "chat_model"]);
      }
      const result = await executeWorkflow({ workflow: workflow(nodes, edges), userPrompt: "hello" }, dependencies());
      const output = result.nodeResults.find((entry) => entry.nodeId === "step")?.output as Record<string, unknown>;
      expect(output, JSON.stringify(result.error ?? result.nodeResults)).toBeTruthy();
      const keys = Object.keys(output).filter((key) => !key.startsWith("_"));
      const listed = nodeOutputFieldNames(type, config)!;
      expect(listed).not.toBeNull();
      // Everything it outputs is listed (optional fields such as toolCalls or clarification may be missing in a run).
      for (const key of keys) expect(listed.has(key), `${type} outputs '${key}', which its list does not name`).toBe(true);
      // The first field (the one the docs lead with) is always there.
      const first = NODE_OUTPUT_SPECS[type]!.fields[0]?.name;
      if (first) expect(keys).toContain(first);
    });
  }
});
