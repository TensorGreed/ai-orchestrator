import { describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { AgentRunRequest, AgentRunState, Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { exportWorkflowToJson, importWorkflowFromJson } from "./serialization";
import { validateWorkflowGraph } from "./validation";

class FakeProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "fake",
    label: "Fake",
    supportsTools: true,
    configSchema: {}
  };

  async generate() {
    return {
      content: "mock-response",
      toolCalls: []
    };
  }
}

class FakeAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "fake-agent";

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    return {
      finalAnswer: `agent:${request.userPrompt}`,
      stopReason: "final_answer",
      iterations: 1,
      messages: [],
      steps: []
    };
  }
}

function createProviderRegistry() {
  const registry = new ProviderRegistry();
  registry.register(new FakeProvider());
  return registry;
}

function basicWorkflow(): Workflow {
  return {
    id: "wf-basic",
    name: "Basic flow",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      {
        id: "n1",
        type: "text_input",
        name: "Text Input",
        position: { x: 0, y: 0 },
        config: { text: "hello" }
      },
      {
        id: "n2",
        type: "prompt_template",
        name: "Prompt Template",
        position: { x: 200, y: 0 },
        config: { template: "Say {{text}}" }
      },
      {
        id: "n3",
        type: "llm_call",
        name: "LLM",
        position: { x: 400, y: 0 },
        config: { provider: { providerId: "fake", model: "fake-model" } }
      },
      {
        id: "n4",
        type: "output",
        name: "Output",
        position: { x: 600, y: 0 },
        config: { responseTemplate: "{{answer}}" }
      }
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
      { id: "e3", source: "n3", target: "n4" }
    ]
  };
}

describe("workflow engine", () => {
  it("validates DAG and detects cycles", () => {
    const workflow = basicWorkflow();
    const valid = validateWorkflowGraph(workflow);
    expect(valid.valid).toBe(true);

    workflow.edges.push({ id: "e4", source: "n4", target: "n2" });
    const invalid = validateWorkflowGraph(workflow);
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "cycle_detected")).toBe(true);
  });

  it("executes basic flow", async () => {
    const workflow = basicWorkflow();
    const result = await executeWorkflow(
      { workflow },
      {
        providerRegistry: createProviderRegistry(),
        connectorRegistry: createDefaultConnectorRegistry(),
        mcpRegistry: createDefaultMCPRegistry(),
        agentRuntime: new FakeAgentRuntime(),
        resolveSecret: async () => undefined
      }
    );

    expect(result.status).toBe("success");
    expect(result.nodeResults.length).toBe(4);
  });

  it("round-trips import/export", () => {
    const workflow = basicWorkflow();
    const json = exportWorkflowToJson(workflow);
    const imported = importWorkflowFromJson(json);

    expect(imported.id).toBe(workflow.id);
    expect(imported.nodes[0]?.position.x).toBe(0);
    expect(imported.schemaVersion).toBe("1.0.0");
  });
});