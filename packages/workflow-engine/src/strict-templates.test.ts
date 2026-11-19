import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { workflowSchema, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import {
  evaluateConditionTemplate,
  isTemplateValueMissingError,
  renderTemplate,
  renderTemplateAdvanced,
  runWithStrictTemplates,
  TEMPLATE_VALUE_MISSING_CODE
} from "./template";

const position = { x: 0, y: 0 };
const dependencies = () => ({
  providerRegistry: createDefaultProviderRegistry(),
  connectorRegistry: createDefaultConnectorRegistry(),
  mcpRegistry: createDefaultMCPRegistry(),
  agentRuntime: createDefaultAgentRuntime(),
  resolveSecret: async () => undefined
});

function setWorkflow(valueTemplate: string, settings?: Workflow["settings"], setExtras: Partial<Workflow["nodes"][number]> = {}): Workflow {
  return {
    id: "wf-strict",
    name: "Strict",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    ...(settings ? { settings } : {}),
    nodes: [
      { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
      { id: "set", type: "set_node", name: "Set", position, config: { assignments: [{ key: "value", valueTemplate }] }, ...setExtras }
    ],
    edges: [{ id: "e1", source: "start", target: "set" }]
  };
}

describe("templates without strict mode (the default)", () => {
  it("render a missing path empty, as before", async () => {
    const result = await executeWorkflow({ workflow: setWorkflow("<{{customer.name}}>") }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "set")?.output).toEqual({ value: "<>" });
  });

  it("list what rendered nothing, so the editor can warn about it", () => {
    const { rendered, missing } = renderTemplateAdvanced("{{a}}-{{b.c}}-{{n}}-{{ $json.x.y }}-{{ a + 1 }}", { a: 1, b: {}, n: null });
    expect(rendered).toBe("1---" + "-2");
    expect(missing).toEqual([
      { body: "b.c", reason: "missing" },
      { body: "$json.x.y", reason: "expression_failed" }
    ]);
  });
});

describe("the strictTemplates workflow setting", () => {
  it("is part of the workflow contract", () => {
    const parsed = workflowSchema.parse(setWorkflow("x", { strictTemplates: true }));
    expect(parsed.settings?.strictTemplates).toBe(true);
    expect(workflowSchema.safeParse(setWorkflow("x", { strictTemplates: "yes" as unknown as boolean })).success).toBe(false);
  });

  it("fails the node that renders a missing path, naming the template and not retrying", async () => {
    const workflow = setWorkflow("[{{customer.name}}]", { strictTemplates: true }, { errorConfig: { retryOnFail: true, maxRetries: 3, retryIntervalMs: 1 } });
    const result = await executeWorkflow({ workflow }, dependencies());
    expect(result.status).toBe("error");
    const set = result.nodeResults.find((node) => node.nodeId === "set");
    expect(set?.status).toBe("error");
    expect(set?.error).toContain("{{customer.name}}");
    expect(set?.error).toMatch(/strict templates/i);
    expect(set?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
    expect(set?.attempts ?? 1).toBe(1);
    expect(result.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
  });

  it("renders values that are there, and a field that holds null, as before", async () => {
    const result = await executeWorkflow({ workflow: setWorkflow("<{{text}}>", { strictTemplates: true }) }, dependencies());
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((node) => node.nodeId === "set")?.output).toEqual({ value: "<hello>" });
    expect(runWithStrictTemplates(true, () => renderTemplate("<{{gone}}>", { gone: null }))).toBe("<>");
  });

  it("fails an expression that throws or returns nothing", async () => {
    for (const template of ["{{ $json.customer.name.first }}", "{{ $json.nothing }}"]) {
      const result = await executeWorkflow({ workflow: setWorkflow(template, { strictTemplates: true }) }, dependencies());
      expect(result.status, template).toBe("error");
      expect(result.nodeResults.find((node) => node.nodeId === "set")?.errorCode, template).toBe(TEMPLATE_VALUE_MISSING_CODE);
    }
  });

  it("routes the failure to the node's Error output like any other failure", async () => {
    const workflow: Workflow = {
      ...setWorkflow("{{missing}}", { strictTemplates: true }),
      nodes: [
        { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
        { id: "set", type: "set_node", name: "Set", position, config: { assignments: [{ key: "value", valueTemplate: "{{missing}}" }], onError: "branch" } },
        { id: "alert", type: "set_node", name: "Alert", position, config: { assignments: [{ key: "caught", valueTemplate: "{{errorCategory}}" }] } }
      ],
      edges: [
        { id: "e1", source: "start", target: "set" },
        { id: "e2", source: "set", target: "alert", sourceHandle: "error" }
      ]
    };
    const result = await executeWorkflow({ workflow }, dependencies());
    expect(result.nodeResults.find((node) => node.nodeId === "alert")?.status).toBe("success");
  });

  it("still renders the run's optional prompt fields empty", () => {
    const rendered = runWithStrictTemplates(true, () => renderTemplate("{{system_prompt}}{{session_id}}{{user_prompt}}", {}));
    expect(rendered).toBe("");
  });

  it("applies to IF conditions", () => {
    expect(runWithStrictTemplates(false, () => evaluateConditionTemplate("{{score}} > 5", {})).result).toBe(false);
    let thrown: unknown;
    try {
      runWithStrictTemplates(true, () => evaluateConditionTemplate("{{score}} > 5", {}));
    } catch (error) {
      thrown = error;
    }
    expect(isTemplateValueMissingError(thrown)).toBe(true);
    expect(runWithStrictTemplates(true, () => evaluateConditionTemplate("{{score}} > 5", { score: 9 })).result).toBe(true);
  });

  it("keeps its code and is not retried when a node handler passes errors on as its own (an HTML node)", async () => {
    const workflow: Workflow = {
      ...setWorkflow("x", { strictTemplates: true }),
      nodes: [
        { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
        { id: "set", type: "html_node", name: "Html", position, config: { operation: "generate", template: "<p>{{nope}}</p>" }, errorConfig: { retryOnFail: true, maxRetries: 2, retryIntervalMs: 1 } }
      ]
    };
    const result = await executeWorkflow({ workflow }, dependencies());
    const html = result.nodeResults.find((node) => node.nodeId === "set");
    expect(html?.status).toBe("error");
    expect(html?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);
    expect(html?.errorCategory).toBe("node_config");
    expect(html?.attempts ?? 1).toBe(1);
  });

  it("follows the workflow that runs: a sub-workflow uses its own setting, not its caller's", async () => {
    const child = (strict: boolean): Workflow => ({
      id: "child",
      name: "Child",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      ...(strict ? { settings: { strictTemplates: true } } : {}),
      nodes: [
        { id: "c1", type: "text_input", name: "C1", position, config: { text: "x" } },
        { id: "c2", type: "set_node", name: "C2", position, config: { assignments: [{ key: "v", valueTemplate: "<{{nope}}>" }] } }
      ],
      edges: [{ id: "ce", source: "c1", target: "c2" }]
    });
    const parent = (strict: boolean): Workflow => ({
      id: "parent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      ...(strict ? { settings: { strictTemplates: true } } : {}),
      nodes: [
        { id: "p1", type: "text_input", name: "P1", position, config: { text: "x" } },
        { id: "p2", type: "execute_workflow", name: "Call", position, config: { workflowId: "child" } }
      ],
      edges: [{ id: "pe", source: "p1", target: "p2" }]
    });
    const runWith = async (parentStrict: boolean, childStrict: boolean) =>
      (await executeWorkflow({ workflow: parent(parentStrict) }, { ...dependencies(), loadWorkflow: async () => child(childStrict) })).status;
    expect(await runWith(true, false)).toBe("success");
    expect(await runWith(false, true)).toBe("error");
  });

  it("applies to an approval message, and not to a Respond to Webhook node's default body", async () => {
    const approval: Workflow = {
      ...setWorkflow("x", { strictTemplates: true }),
      nodes: [
        { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
        { id: "set", type: "human_approval", name: "Approve", position, config: { approvalMessage: "ok {{nope}}", timeoutMinutes: 5 } }
      ]
    };
    const approvalRun = await executeWorkflow({ workflow: approval }, dependencies());
    expect(approvalRun.status).toBe("error");
    expect(approvalRun.nodeResults.find((node) => node.nodeId === "set")?.errorCode).toBe(TEMPLATE_VALUE_MISSING_CODE);

    const respond: Workflow = {
      ...setWorkflow("x", { strictTemplates: true }),
      nodes: [
        { id: "start", type: "text_input", name: "Start", position, config: { text: "hello" } },
        { id: "set", type: "webhook_response", name: "Respond", position, config: { statusCode: 200 } }
      ]
    };
    expect((await executeWorkflow({ workflow: respond }, dependencies())).status).toBe("success");
  });
});
