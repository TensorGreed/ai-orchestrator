import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { AgentRunRequest, AgentRunState, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { assertChatModelCredentials, executeWorkflow } from "./executor";

class CapturingAgentRuntime implements AgentRuntimeAdapter {
  readonly id = "capturing-agent";
  lastRequest: AgentRunRequest | null = null;

  async run(request: AgentRunRequest): Promise<AgentRunState> {
    this.lastRequest = request;
    return { finalAnswer: "ok", stopReason: "final_answer", iterations: 1, messages: [], steps: [] };
  }
}

function agentWorkflow(modelConfig: Record<string, unknown>): Workflow {
  return {
    id: "wf-agent-anthropic",
    name: "Agent with Anthropic model",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "webhook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
      {
        id: "agent",
        type: "agent_orchestrator",
        name: "Agent",
        position: { x: 220, y: 0 },
        config: { systemPromptTemplate: "{{system_prompt}}", userPromptTemplate: "{{user_prompt}}", maxIterations: 1 }
      },
      {
        id: "claude",
        type: "anthropic_chat_model",
        name: "Claude Model",
        position: { x: 220, y: 180 },
        config: { model: "claude-sonnet-5-5", ...modelConfig }
      },
      { id: "output", type: "output", name: "Output", position: { x: 430, y: 0 }, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "webhook", target: "agent" },
      { id: "e2", source: "agent", target: "output" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "claude" }
    ]
  };
}

function run(workflow: Workflow, runtime: CapturingAgentRuntime) {
  return executeWorkflow(
    { workflow, webhookPayload: { user_prompt: "hi", system_prompt: "be brief" } },
    {
      providerRegistry: new ProviderRegistry(),
      connectorRegistry: createDefaultConnectorRegistry(),
      mcpRegistry: createDefaultMCPRegistry(),
      agentRuntime: runtime,
      resolveSecret: async () => "resolved-key"
    }
  );
}

describe("chat model credentials", () => {
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  it("names the attached chat model node when it has no API key secret", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await run(agentWorkflow({}), runtime);

    expect(result.status).toBe("error");
    const agentError = result.nodeResults.find((entry) => entry.nodeId === "agent")?.error ?? result.error ?? "";
    expect(agentError).toContain('Chat model node "Claude Model" (claude)');
    expect(agentError).toContain("select an API key secret");
    expect(agentError).toContain("ANTHROPIC_API_KEY");
    expect(runtime.lastRequest).toBeNull();
  });

  it("runs when the chat model node has a secret selected", async () => {
    const runtime = new CapturingAgentRuntime();
    const result = await run(agentWorkflow({ secretRef: { secretId: "anthropic-secret" } }), runtime);

    expect(result.status).toBe("success");
    expect(runtime.lastRequest?.provider.secretRef).toEqual({ secretId: "anthropic-secret" });
    expect(runtime.lastRequest?.provider.model).toBe("claude-sonnet-5-5");
  });

  it("accepts the server env var instead of a secret", () => {
    const node: WorkflowNode = {
      id: "openai",
      type: "openai_chat_model",
      name: "GPT",
      position: { x: 0, y: 0 },
      config: {}
    };
    const provider = { providerId: "openai", model: "gpt-4o-mini" };
    expect(() => assertChatModelCredentials(node, provider, { OPENAI_API_KEY: "sk-test" })).not.toThrow();
    expect(() => assertChatModelCredentials(node, provider, {})).toThrow(/Chat model node "GPT" \(openai\) has no OpenAI API key/);
    expect(() =>
      assertChatModelCredentials({ ...node, type: "ollama_chat_model" }, { providerId: "ollama", model: "llama3.1" }, {})
    ).not.toThrow();
  });
});
