import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { Workflow, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { IN_PROCESS_CODE_SANDBOX } from "./code-sandbox";

/** A model that never answers with JSON, and counts its calls. */
class NotJsonModel implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: false, configSchema: {} };
  calls = 0;
  async generate(_request: ProviderCallRequest) {
    this.calls += 1;
    return { content: "still not json", toolCalls: [] };
  }
}

function run(model: NotJsonModel, parserConfig: Record<string, unknown>): Promise<WorkflowExecutionResult> {
  const workflow: Workflow = {
    id: "wf-parser-retries",
    name: "Parser retries",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
      { id: "llm", type: "llm_call", name: "LLM", position: { x: 100, y: 0 }, config: { provider: { providerId: "scripted", model: "m" } } },
      { id: "parse", type: "output_parser", name: "Parse", position: { x: 200, y: 0 }, config: { mode: "auto_fix", inputKey: "answer", ...parserConfig } },
      { id: "out", type: "output", name: "Out", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "in", target: "llm" },
      { id: "e2", source: "llm", target: "parse" },
      { id: "e3", source: "parse", target: "out" }
    ]
  };
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(model);
  const deps: WorkflowExecutionDependencies = {
    providerRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    mcpRegistry: createDefaultMCPRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    codeSandbox: IN_PROCESS_CODE_SANDBOX
  };
  return executeWorkflow({ workflow, webhookPayload: { user_prompt: "hello" } }, deps);
}

const parserError = (result: WorkflowExecutionResult) => result.nodeResults.find((entry) => entry.nodeId === "parse")?.error ?? "";

describe("Output Parser maxRetries", () => {
  it("0 means no retry call: the parser fails at once", async () => {
    const model = new NotJsonModel();
    const result = await run(model, { maxRetries: 0 });
    // One call for the LLM node, none for the parser.
    expect(model.calls).toBe(1);
    expect(parserError(result)).toContain("after 0 retries");
  });

  it("a positive number is the number of retry calls", async () => {
    const model = new NotJsonModel();
    const result = await run(model, { maxRetries: 3 });
    expect(model.calls).toBe(4);
    expect(parserError(result)).toContain("after 3 retries");
  });

  it("missing or invalid values use the default of 2", async () => {
    for (const config of [{}, { maxRetries: -1 }, { maxRetries: "x" }, { maxRetries: Number.NaN }]) {
      const model = new NotJsonModel();
      await run(model, config);
      expect(model.calls).toBe(3);
    }
  });
});
