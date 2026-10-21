/**
 * Phase 10.8 — record and replay through the engine: a workflow with an
 * agent (real agent runtime, scripted model) and MCP tools runs once against
 * the mock server while recording, then replays from the cassette with the
 * same outputs and no call reaching the server. The engine is not told about
 * either; both are registries handed in as `mcpRegistry`.
 */
import { describe, expect, it } from "vitest";
import { DefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import {
  MCPRegistry,
  McpCassetteRecorder,
  MockMCPServerAdapter,
  createRecordingRegistry,
  createReplayRegistry,
  type MCPServerAdapter
} from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import type { LLMCallResponse, MCPServerConfig, Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  private index = 0;
  constructor(private readonly script: LLMCallResponse[]) {}
  async generate(): Promise<LLMCallResponse> {
    const response = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return response;
  }
}

/** The mock server, counting every call that reaches it. */
function liveRegistry(): { registry: MCPRegistry; calls: () => number } {
  const mock = new MockMCPServerAdapter();
  let calls = 0;
  const counted: MCPServerAdapter = {
    definition: mock.definition,
    discoverTools: (config, context) => {
      calls += 1;
      return mock.discoverTools(config, context);
    },
    invokeTool: (name, args, config, context) => {
      calls += 1;
      return mock.invokeTool(name, args, config, context);
    }
  };
  const registry = new MCPRegistry();
  registry.register(counted);
  return { registry, calls: () => calls };
}

const REGISTRY_ID = "mcp_mock";
const registryConfig: MCPServerConfig = { serverId: "mock-mcp", registryServerId: REGISTRY_ID, label: "Mock", connection: {} };

function script(): LLMCallResponse[] {
  return [
    {
      content: "",
      toolCalls: [
        { id: "call-1", name: "mock-mcp__get_current_time", arguments: { tz: "UTC" } },
        { id: "call-2", name: "mock-mcp__lookup_kb", arguments: { topic: "mcp" } }
      ]
    },
    { content: "It is now known and MCP is a protocol.", toolCalls: [] }
  ];
}

function deps(mcpRegistry: MCPRegistry): WorkflowExecutionDependencies {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ScriptedProvider(script()));
  return {
    providerRegistry,
    mcpRegistry,
    connectorRegistry: createDefaultConnectorRegistry(),
    agentRuntime: new DefaultAgentRuntime(),
    resolveSecret: async () => undefined,
    resolveRegisteredMcpServer: (id) => {
      if (id !== REGISTRY_ID) throw new Error(`unknown server ${id}`);
      return registryConfig;
    }
  };
}

const workflow: Workflow = {
  id: "wf-cassette",
  name: "Cassette",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes: [
    { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: {} },
    {
      id: "agent",
      type: "agent_orchestrator",
      name: "Agent",
      position: { x: 200, y: 0 },
      config: { systemPromptTemplate: "Use tools.", userPromptTemplate: "{{user_prompt}}", maxIterations: 4 }
    },
    { id: "model", type: "llm_call", name: "Model", position: { x: 200, y: 160 }, config: { provider: { providerId: "scripted", model: "m" } } },
    { id: "tools", type: "mcp_tool", name: "Tools", position: { x: 320, y: 160 }, config: { registryServerId: REGISTRY_ID, toolName: "__all__" } },
    {
      id: "clock",
      type: "mcp_tool",
      name: "Clock",
      position: { x: 400, y: 0 },
      config: { registryServerId: REGISTRY_ID, toolName: "get_current_time", argsTemplate: "{\"tz\":\"America/Toronto\"}", retry: { enabled: false } }
    },
    { id: "out", type: "output", name: "Output", position: { x: 600, y: 0 }, config: {} }
  ],
  edges: [
    { id: "e1", source: "hook", target: "agent" },
    { id: "e2", source: "agent", target: "clock" },
    { id: "e3", source: "clock", target: "out" },
    { id: "e4", source: "agent", sourceHandle: "chat_model", target: "model" },
    { id: "e5", source: "agent", sourceHandle: "tool", target: "tools" }
  ]
};

const outputOf = (result: Awaited<ReturnType<typeof executeWorkflow>>, nodeId: string) =>
  result.nodeResults.find((entry) => entry.nodeId === nodeId)?.output as Record<string, unknown>;

function toolOutputs(result: Awaited<ReturnType<typeof executeWorkflow>>) {
  const agent = outputOf(result, "agent");
  const steps = agent.steps as Array<{ toolResults: Array<{ toolName: string; output: unknown; error?: string }> }>;
  return {
    answer: agent.answer ?? agent.finalAnswer,
    agentTools: steps.flatMap((step) => step.toolResults.map((entry) => ({ tool: entry.toolName, output: entry.output, error: entry.error }))),
    clock: outputOf(result, "clock").tool_output
  };
}

describe("MCP cassettes through the engine", () => {
  it("records an agent run and replays it with identical outputs and no live calls", async () => {
    const live = liveRegistry();
    const recorder = new McpCassetteRecorder();
    const recorded = await executeWorkflow({ workflow, webhookPayload: { user_prompt: "what time is it?" } }, deps(createRecordingRegistry(live.registry, recorder)));
    expect(recorded.status).toBe("success");
    const callsWhileRecording = live.calls();
    expect(callsWhileRecording).toBeGreaterThanOrEqual(4);

    const cassette = recorder.toCassette();
    expect(cassette.entries.map((entry) => [entry.method, entry.name ?? null])).toEqual(
      expect.arrayContaining([
        ["tools/list", null],
        ["tools/call", "get_current_time"],
        ["tools/call", "lookup_kb"]
      ])
    );
    expect(cassette.servers).toEqual([expect.objectContaining({ key: `registry:${REGISTRY_ID}`, adapterId: "mock-mcp" })]);

    // Wait so a live clock call would visibly differ.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { registry, player } = createReplayRegistry(cassette, { mode: "strict", live: live.registry });
    const replayed = await executeWorkflow({ workflow, webhookPayload: { user_prompt: "what time is it?" } }, deps(registry));
    expect(replayed.status).toBe("success");
    expect(live.calls()).toBe(callsWhileRecording);
    expect(toolOutputs(replayed)).toEqual(toolOutputs(recorded));
    expect(toolOutputs(replayed).agentTools.every((entry) => !entry.error)).toBe(true);
    expect(replayed.output).toEqual(recorded.output);
    expect(player.report("cas")).toMatchObject({ matched: cassette.entries.length, live: 0, unmatched: [] });
  }, 30_000);

  it("fails a direct MCP Tool node clearly when strict replay has no answer", async () => {
    const recorder = new McpCassetteRecorder();
    const { registry } = createReplayRegistry(recorder.toCassette(), { mode: "strict", live: liveRegistry().registry });
    const result = await executeWorkflow({ workflow, webhookPayload: { user_prompt: "x" } }, deps(registry));
    expect(result.status).toBe("error");
    expect(JSON.stringify(result.nodeResults)).toContain("Cassette replay (strict)");
  }, 30_000);
});
