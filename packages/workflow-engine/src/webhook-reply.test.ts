import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowExecutionState } from "@ai-orchestrator/shared";
import { executeWorkflow, resumeWorkflowExecution } from "./executor";

/**
 * A run a webhook started answers its caller with the reply of the last Webhook Response node that ran, even when nodes
 * run after it (the validation's webhook starter: Reply, then a Run result Output node). Without one, the run's output
 * is chosen as before.
 */
const position = { x: 0, y: 0 };
const dependencies = () => ({
  providerRegistry: createDefaultProviderRegistry(),
  connectorRegistry: createDefaultConnectorRegistry(),
  mcpRegistry: createDefaultMCPRegistry(),
  agentRuntime: createDefaultAgentRuntime(),
  resolveSecret: async () => undefined
});

function starterLike(extraReply = false): Workflow {
  return {
    id: "wf-reply",
    name: "Reply then output",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "webhook", type: "webhook_input", name: "Incoming request", position, config: { path: "reply-test", method: "POST" } },
      {
        id: "reshape",
        type: "set_node",
        name: "Reshape",
        position,
        config: { assignments: [{ key: "fullName", valueTemplate: "{{first_name}} {{last_name}}", type: "string" }] }
      },
      {
        id: "reply",
        type: "webhook_response",
        name: "Reply",
        position,
        config: { statusCode: 201, headersTemplate: "{\"x-kind\": \"reply\"}", bodyTemplate: "{\"customer\": {{ JSON.stringify(fullName) }}}" }
      },
      ...(extraReply
        ? [{ id: "reply2", type: "webhook_response", name: "Second reply", position, config: { statusCode: 202, bodyTemplate: "{\"second\": true}" } }]
        : []),
      { id: "out", type: "output", name: "Run result", position, config: { outputKey: "result" } }
    ],
    edges: [
      { id: "e1", source: "webhook", target: "reshape" },
      { id: "e2", source: "reshape", target: "reply" },
      ...(extraReply ? [{ id: "e3", source: "reply", target: "reply2" }, { id: "e4", source: "reply2", target: "out" }] : [{ id: "e3", source: "reply", target: "out" }])
    ]
  } as Workflow;
}

const payload = { first_name: "Grace", last_name: "Hopper" };

describe("a webhook run's reply", () => {
  for (const triggerType of ["webhook", "webhook_test", "webhook_api", "webhook_api_stream"]) {
    it(`is the Webhook Response's, though an Output node runs after it (${triggerType})`, async () => {
      const result = await executeWorkflow({ workflow: starterLike(), webhookPayload: payload, triggerType }, dependencies());
      expect(result.status).toBe("success");
      expect((result.output as Record<string, unknown>).__webhookResponse).toEqual({
        statusCode: 201,
        headers: { "x-kind": "reply" },
        body: { customer: "Grace Hopper" }
      });
    });
  }

  it("is the last Webhook Response that ran when there are several", async () => {
    const result = await executeWorkflow({ workflow: starterLike(true), webhookPayload: payload, triggerType: "webhook" }, dependencies());
    expect((result.output as Record<string, any>).__webhookResponse).toMatchObject({ statusCode: 202, body: { second: true } });
  });

  it("a replay of a webhook run (its input trigger) answers the same", async () => {
    const result = await executeWorkflow(
      { workflow: starterLike(), webhookPayload: payload, triggerType: "replay", inputTriggerType: "webhook" },
      dependencies()
    );
    expect((result.output as Record<string, any>).__webhookResponse).toMatchObject({ statusCode: 201 });
  });

  it("keeps the Output node's result for runs no webhook started (editor, sub-workflow)", async () => {
    for (const triggerType of [undefined, "manual", "sub_workflow"]) {
      const result = await executeWorkflow({ workflow: starterLike(), webhookPayload: payload, ...(triggerType ? { triggerType } : {}) }, dependencies());
      expect(result.output, triggerType).not.toHaveProperty("__webhookResponse");
    }
  });

  it("is today's output when no Webhook Response ran", async () => {
    const workflow = starterLike();
    workflow.nodes = workflow.nodes.filter((node) => node.id !== "reply");
    workflow.edges = [
      { id: "e1", source: "webhook", target: "reshape" },
      { id: "e2", source: "reshape", target: "out" }
    ];
    const result = await executeWorkflow({ workflow, webhookPayload: payload, triggerType: "webhook" }, dependencies());
    expect(result.output).toEqual({ result: { fullName: "Grace Hopper" } });
  });

  it("a webhook run that paused for an approval after its reply records the reply when it resumes", async () => {
    const base = starterLike();
    const workflow = {
      ...base,
      nodes: [...base.nodes, { id: "ask", type: "human_approval", name: "Approve", position, config: { approvalMessage: "OK?", timeoutMinutes: 5 } }],
      edges: [...base.edges.filter((edge) => edge.target !== "out"), { id: "e-ask", source: "reply", target: "ask" }, { id: "e-out", source: "ask", target: "out" }]
    } as Workflow;
    const paused: WorkflowExecutionState[] = [];
    const deps = {
      ...dependencies(),
      persistPausedExecution: async (input: { state: WorkflowExecutionState }) => {
        paused.push(JSON.parse(JSON.stringify(input.state)) as WorkflowExecutionState);
      }
    };
    const first = await executeWorkflow({ workflow, executionId: "exec-resume-reply", triggerType: "webhook", webhookPayload: payload, input: payload }, deps);
    expect(first.status).toBe("waiting_approval");
    const resumed = await resumeWorkflowExecution({ executionId: "exec-resume-reply", state: paused.at(-1)!, decision: "approve", actedBy: "lead@example.com" }, deps);
    expect(resumed.status).toBe("success");
    expect(resumed.output).toMatchObject({ __webhookResponse: { statusCode: 201 } });
  });

  it("a webhook set to answer with the last node's output keeps doing so; one set to wait for the response node gets the reply", async () => {
    const withMode = (responseMode: string) => {
      const workflow = starterLike();
      return { ...workflow, nodes: workflow.nodes.map((node) => (node.id === "webhook" ? { ...node, config: { ...node.config, responseMode } } : node)) } as Workflow;
    };
    const lastNode = await executeWorkflow({ workflow: withMode("lastNode"), triggerType: "webhook", webhookPayload: payload, input: payload }, dependencies());
    expect(lastNode.output).not.toHaveProperty("__webhookResponse");
    const responseNode = await executeWorkflow({ workflow: withMode("responseNode"), triggerType: "webhook", webhookPayload: payload, input: payload }, dependencies());
    expect(responseNode.output).toMatchObject({ __webhookResponse: { statusCode: 201 } });
  });
});
