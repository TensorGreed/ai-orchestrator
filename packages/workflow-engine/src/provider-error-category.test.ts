import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, providerHttpError, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import { ErrorCategory, remediationForCategory, type LLMCallResponse, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";

class FailingProvider implements LLMProviderAdapter {
  readonly definition = { id: "failing", label: "Failing", supportsTools: false, configSchema: {} };
  constructor(private readonly status: number) {}

  async generate(): Promise<LLMCallResponse> {
    throw providerHttpError("failing", this.status, `Provider failing request failed (${this.status}): upstream`);
  }
}

function workflow(): Workflow {
  return {
    id: "wf-provider-error",
    name: "Provider error",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
      { id: "llm", type: "llm_call", name: "LLM", position: { x: 200, y: 0 }, config: { provider: { providerId: "failing", model: "m" } } },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "llm" },
      { id: "e2", source: "llm", target: "output" }
    ]
  };
}

async function runWith(status: number) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new FailingProvider(status));
  const result = await executeWorkflow(
    { workflow: workflow() },
    {
      providerRegistry,
      connectorRegistry: createDefaultConnectorRegistry(),
      mcpRegistry: createDefaultMCPRegistry(),
      agentRuntime: createDefaultAgentRuntime(),
      resolveSecret: async () => undefined
    }
  );
  return result.nodeResults.find((entry) => entry.nodeId === "llm")!;
}

describe("provider HTTP errors on a node", () => {
  it("shows the transient-provider fix for a 5xx instead of the generic one", async () => {
    const node = await runWith(500);
    expect(node.status).toBe("error");
    expect(node.errorCategory).toBe(ErrorCategory.PROVIDER_TRANSIENT);
    expect(node.errorRemediation).toBe(remediationForCategory(ErrorCategory.PROVIDER_TRANSIENT));
    expect(node.retryable).toBe(true);
  });

  it("points at the provider's credentials for a 401", async () => {
    const node = await runWith(401);
    expect(node.errorCategory).toBe(ErrorCategory.PROVIDER_AUTH);
    expect(node.errorRemediation).toContain("failing provider rejected the API credentials");
    expect(node.retryable).toBe(false);
  });
});
