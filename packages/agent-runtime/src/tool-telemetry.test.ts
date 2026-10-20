/**
 * Phase 10.1 — per-tool-call timing and per-iteration usage on AgentRunStep.
 */
import { describe, expect, it } from "vitest";
import type { LLMCallResponse, ToolCall } from "@ai-orchestrator/shared";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import { DefaultAgentRuntime } from "./default-agent-runtime";

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

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });

function call(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

async function run(script: LLMCallResponse[], invokeTool: (name: string) => Promise<unknown>) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ScriptedProvider(script));
  const names = ["mock-mcp__slow", "mock-mcp__fast", "mock-mcp__broken"];
  return new DefaultAgentRuntime().run(
    {
      provider: { providerId: "scripted", model: "scripted-1" },
      systemPrompt: "sys",
      userPrompt: "go",
      tools: names.map((name) => ({ ...tool(name), serverId: "mock-mcp" })),
      maxIterations: 4,
      toolCallingEnabled: true,
      bypassToolFiltering: true
    },
    { tools: names.map(tool), invokeTool: (name) => invokeTool(name) },
    { providerRegistry, resolveSecret: async () => undefined }
  );
}

describe("agent runtime tool telemetry", () => {
  it("records usage on a turn with zero tool calls", async () => {
    const state = await run(
      [{ content: "done", toolCalls: [], usage: { inputTokens: 12, outputTokens: 3 }, latencyMs: 7 }],
      async () => null
    );
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({ usage: { inputTokens: 12, outputTokens: 3 }, latencyMs: 7, toolResults: [] });
  });

  it("times a single tool call and keeps that turn's usage on its step", async () => {
    const state = await run(
      [
        { content: "", toolCalls: [call("a", "mock-mcp__slow")], usage: { inputTokens: 100, outputTokens: 20 } },
        { content: "answer", toolCalls: [], usage: { inputTokens: 150, outputTokens: 30 } }
      ],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true };
      }
    );
    const [first, second] = state.steps;
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(second.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
    expect(first.toolResults).toHaveLength(1);
    const result = first.toolResults[0];
    expect(result.durationMs).toBeGreaterThanOrEqual(20);
    expect(Number.isNaN(Date.parse(result.startedAt ?? ""))).toBe(false);
    expect(state.usage).toEqual({ inputTokens: 250, outputTokens: 50 });
  });

  it("times each of several tool calls in one turn, failures included", async () => {
    const state = await run(
      [
        {
          content: "",
          toolCalls: [call("a", "mock-mcp__fast"), call("b", "mock-mcp__broken"), call("c", "mock-mcp__nope")],
          usage: { inputTokens: 90, outputTokens: 9 }
        },
        { content: "answer", toolCalls: [] }
      ],
      async (name) => {
        if (name === "mock-mcp__broken") {
          await new Promise((resolve) => setTimeout(resolve, 15));
          throw new Error("server said no");
        }
        return { ok: true };
      }
    );
    const results = state.steps[0].toolResults;
    expect(results.map((entry) => entry.toolCallId)).toEqual(["a", "b", "c"]);
    for (const entry of results) {
      expect(typeof entry.durationMs).toBe("number");
      expect(typeof entry.startedAt).toBe("string");
    }
    expect(results[1].error).toContain("server said no");
    expect(results[1].durationMs).toBeGreaterThanOrEqual(10);
    expect(results[2].error).toContain("does not exist");
    expect(state.steps[0].usage).toEqual({ inputTokens: 90, outputTokens: 9 });
    expect(state.steps[1].usage).toBeUndefined();
  });
});
