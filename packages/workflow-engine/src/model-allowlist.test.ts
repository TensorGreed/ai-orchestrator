import { describe, expect, it } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry, createGatedProviderRegistry, ModelNotAllowedError, type GatedModelCall } from "@ai-orchestrator/provider-sdk";
import { ErrorCategory, type Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";
import { workflowModelReferences } from "./model-references";

const position = { x: 0, y: 0 };

describe("workflowModelReferences", () => {
  it("lists each node's saved model, with Azure deployments and provider configs, and skips expressions", () => {
    const references = workflowModelReferences({
      nodes: [
        { id: "llm", type: "llm_call", name: "Ask", position, config: { provider: { providerId: "openai", model: "gpt-4o" } } },
        { id: "templated", type: "llm_call", name: "Dynamic", position, config: { provider: { providerId: "openai", model: "{{vars.model}}" } } },
        { id: "azure", type: "azure_openai_chat_model", name: "", position, config: { endpoint: "https://x.openai.azure.com", deployment: "prod-4o" } },
        { id: "anthropic", type: "anthropic_chat_model", name: "Claude", position, config: { model: "claude-sonnet-5-5" } },
        { id: "parser", type: "output_parser", name: "Parser", position, config: { provider: { providerId: "ollama", model: "llama3.1" } } },
        { id: "text", type: "text_input", name: "Text", position, config: { text: "x" } }
      ]
    });
    expect(references).toEqual([
      { nodeId: "llm", nodeName: "Ask", providerId: "openai", model: "gpt-4o" },
      { nodeId: "azure", nodeName: "azure_openai_chat_model", providerId: "azure_openai", model: "prod-4o" },
      { nodeId: "anthropic", nodeName: "Claude", providerId: "anthropic", model: "claude-sonnet-5-5" },
      { nodeId: "parser", nodeName: "Parser", providerId: "ollama", model: "llama3.1" }
    ]);
  });
});

describe("a model the allowlist refuses", () => {
  it("fails the node once, with its category, even when the node retries errors", async () => {
    const calls: GatedModelCall[] = [];
    const providerRegistry = createGatedProviderRegistry(createDefaultProviderRegistry(), (call) => {
      calls.push(call);
      throw new ModelNotAllowedError(`Model "${call.model}" is not allowed.`, { providerId: call.providerId, model: call.model, refusedBy: "deployment" });
    });
    const workflow: Workflow = {
      id: "wf-refused",
      name: "Refused",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "input", type: "text_input", name: "Input", position, config: { text: "hello" } },
        { id: "llm", type: "llm_call", name: "LLM", position, config: { provider: { providerId: "echo", model: "m" }, retry: { enabled: true, maxAttempts: 3, delayMs: 1 } } },
        { id: "output", type: "output", name: "Output", position, config: { responseTemplate: "{{answer}}" } }
      ],
      edges: [
        { id: "e1", source: "input", target: "llm" },
        { id: "e2", source: "llm", target: "output" }
      ]
    };
    const result = await executeWorkflow(
      { workflow },
      { providerRegistry, connectorRegistry: createDefaultConnectorRegistry(), mcpRegistry: createDefaultMCPRegistry(), agentRuntime: createDefaultAgentRuntime(), resolveSecret: async () => undefined }
    );
    const node = result.nodeResults.find((entry) => entry.nodeId === "llm")!;
    expect(node).toMatchObject({ status: "error", errorCategory: ErrorCategory.MODEL_NOT_ALLOWED, retryable: false, error: 'Model "m" is not allowed.' });
    expect(calls).toHaveLength(1);
  });
});
