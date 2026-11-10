import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { LLMProviderConfig, Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";

const position = { x: 0, y: 0 };
const secretRef = { secretId: "s" };

function workflowFor(provider: LLMProviderConfig): Workflow {
  return {
    id: "wf-stream-tools",
    name: "Stream tool calls",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position, config: { text: "Look things up" } },
      { id: "llm", type: "llm_call", name: "LLM", position, config: { provider, retry: { enabled: false, maxAttempts: 1, delayMs: 1 } } },
      { id: "output", type: "output", name: "Output", position, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "llm" },
      { id: "e2", source: "llm", target: "output" }
    ]
  };
}

type Delta = { index?: number; id?: string; name?: string; args?: string };

/** One SSE frame carrying the given tool-call deltas, the way an OpenAI-family server writes them. */
function frame(...deltas: Delta[]): string {
  return JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: deltas.map((delta) => ({
            ...(delta.index !== undefined ? { index: delta.index } : {}),
            ...(delta.id ? { id: delta.id, type: "function" } : {}),
            function: { ...(delta.name ? { name: delta.name } : {}), ...(delta.args !== undefined ? { arguments: delta.args } : {}) }
          }))
        }
      }
    ]
  });
}

function stream(frames: string[]): Response {
  const body = [...frames, JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "[DONE]"].map((entry) => `data: ${entry}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function toolCallsOf(provider: LLMProviderConfig, frames: string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => stream(frames)));
  const result = await executeWorkflow(
    { workflow: workflowFor(provider) },
    {
      providerRegistry: createDefaultProviderRegistry(),
      connectorRegistry: createDefaultConnectorRegistry(),
      mcpRegistry: createDefaultMCPRegistry(),
      agentRuntime: createDefaultAgentRuntime(),
      resolveSecret: async () => "test-key",
      onLLMDelta: () => undefined
    }
  );
  const node = result.nodeResults.find((entry) => entry.nodeId === "llm")!;
  expect(node.status, node.error).toBe("success");
  return (node.output as { toolCalls: unknown[] }).toolCalls;
}

const PROVIDERS: Array<{ label: string; provider: LLMProviderConfig }> = [
  { label: "openai", provider: { providerId: "openai", model: "gpt-4o-mini", secretRef } },
  { label: "azure_openai", provider: { providerId: "azure_openai", model: "prod-4o", baseUrl: "https://x.openai.azure.com", secretRef } },
  { label: "openai_compatible", provider: { providerId: "openai_compatible", model: "local-model", baseUrl: "http://compat.test/v1" } },
  { label: "ollama", provider: { providerId: "ollama", model: "llama3.1" } }
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(PROVIDERS)("streamed tool calls through $label", ({ provider }) => {
  it("joins argument deltas that carry only the index into one call", async () => {
    const calls = await toolCallsOf(provider, [
      frame({ index: 0, id: "call_a", name: "lookup", args: "" }),
      frame({ index: 0, args: '{"q"' }),
      frame({ index: 0, args: ':"refund' }),
      frame({ index: 0, args: 's"}' })
    ]);
    expect(calls).toEqual([{ id: "call_a", name: "lookup", arguments: { q: "refunds" } }]);
  });

  it("keeps two parallel calls apart when their argument deltas interleave", async () => {
    const calls = await toolCallsOf(provider, [
      frame({ index: 0, id: "call_a", name: "lookup", args: "" }),
      frame({ index: 1, id: "call_b", name: "weather", args: "" }),
      frame({ index: 0, args: '{"q":' }),
      frame({ index: 1, args: '{"city":' }),
      frame({ index: 0, args: '"x"}' }),
      frame({ index: 1, args: '"Oslo"}' })
    ]);
    expect(calls).toEqual([
      { id: "call_a", name: "lookup", arguments: { q: "x" } },
      { id: "call_b", name: "weather", arguments: { city: "Oslo" } }
    ]);
  });

  it("still groups a server that repeats the id on every delta", async () => {
    const calls = await toolCallsOf(provider, [
      frame({ index: 0, id: "call_a", name: "lookup", args: '{"q":' }),
      frame({ index: 1, id: "call_b", name: "weather", args: '{"city":' }),
      frame({ index: 0, id: "call_a", args: '"x"}' }),
      frame({ index: 1, id: "call_b", args: '"Oslo"}' })
    ]);
    expect(calls).toEqual([
      { id: "call_a", name: "lookup", arguments: { q: "x" } },
      { id: "call_b", name: "weather", arguments: { city: "Oslo" } }
    ]);
  });

  it("keeps calls apart when the server sends no index, only ids", async () => {
    const calls = await toolCallsOf(provider, [
      frame({ id: "call_a", name: "lookup", args: '{"q":' }),
      frame({ id: "call_b", name: "weather", args: '{"city":' }),
      frame({ id: "call_a", args: '"x"}' }),
      frame({ id: "call_b", args: '"Oslo"}' })
    ]);
    expect(calls).toEqual([
      { id: "call_a", name: "lookup", arguments: { q: "x" } },
      { id: "call_b", name: "weather", arguments: { city: "Oslo" } }
    ]);
  });

  it("keeps calls apart when the server sends no index and no ids", async () => {
    const calls = await toolCallsOf(provider, [
      frame({ name: "lookup", args: '{"q":1}' }),
      frame({ name: "weather", args: '{"c":2}' })
    ]);
    expect(calls.map((call) => (call as { name: string; arguments: unknown }).name)).toEqual(["lookup", "weather"]);
    expect(calls.map((call) => (call as { arguments: unknown }).arguments)).toEqual([{ q: 1 }, { c: 2 }]);
  });

  it("keeps calls apart when the server reuses index 0 and sends no ids", async () => {
    const calls = (await toolCallsOf(provider, [
      frame({ index: 0, name: "lookup", args: '{"q":1}' }),
      frame({ index: 0, name: "weather", args: '{"c":2}' })
    ])) as Array<{ name: string; arguments: unknown }>;
    expect(calls.map((call) => [call.name, call.arguments])).toEqual([
      ["lookup", { q: 1 }],
      ["weather", { c: 2 }]
    ]);
  });

  it("keeps calls apart when the server reuses index 0 with a different id each time", async () => {
    const calls = await toolCallsOf(provider, [
      frame({ index: 0, id: "call_a", name: "lookup", args: '{"q":1}' }),
      frame({ index: 0, id: "call_b", name: "weather", args: '{"c":2}' })
    ]);
    expect(calls).toEqual([
      { id: "call_a", name: "lookup", arguments: { q: 1 } },
      { id: "call_b", name: "weather", arguments: { c: 2 } }
    ]);
  });
});
