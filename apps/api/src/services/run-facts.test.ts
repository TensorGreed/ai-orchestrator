import { describe, expect, it } from "vitest";
import { buildRunFacts, collectRunActivity, nodeResultRecords } from "./run-facts.js";

const nodes = [
  { id: "hook", type: "webhook_input" },
  { id: "agent", type: "agent_orchestrator", config: { userPromptTemplate: "{{user_prompt}}" } },
  { id: "tool", type: "mcp_tool", config: { registryServerId: "mcp_docs", toolName: "search" } },
  { id: "out", type: "output" }
];

const nodeResults = [
  { nodeId: "hook", status: "success", durationMs: 1, output: { user_prompt: "hi" } },
  {
    nodeId: "agent",
    status: "success",
    durationMs: 900,
    output: {
      answer: "done",
      _provider: { providerId: "openai", model: "gpt-4o-mini" },
      _mcpTools: { "docs__search": { toolName: "search", registryServerId: "mcp_docs", adapterId: "http_mcp" } },
      steps: [
        {
          iteration: 1,
          usage: { inputTokens: 100, outputTokens: 10 },
          latencyMs: 400,
          requestedTools: [{ id: "c1", name: "docs__search", arguments: { q: "billing", limit: 3 } }],
          toolResults: [{ toolCallId: "c1", toolName: "docs__search", output: { hits: 2 }, durationMs: 30 }]
        },
        { iteration: 2, usage: { inputTokens: 120, outputTokens: 20 }, latencyMs: 300, requestedTools: [], toolResults: [] }
      ]
    }
  },
  { nodeId: "tool", status: "error", durationMs: 5, error: "Tool 'search' is blocked by policy", output: { invocation_request: { tool_name: "search", tool_args: { limit: 3, q: "x" }, registry_server_id: "mcp_docs" } } },
  { nodeId: "out", status: "success", durationMs: 0, output: { result: "done" } }
];

describe("run facts", () => {
  it("normalises tool calls, model calls, nodes and totals from node results", () => {
    const facts = buildRunFacts({
      status: "success",
      error: null,
      output: { result: "done" },
      durationMs: 950,
      nodeResults,
      nodes,
      guardEvents: [{ verdictId: "v1", nodeId: "agent", placement: "pre_model", channel: "prompt", detectorId: "pii", effectiveAction: "mask", shadow: false }],
      priceTurn: (_provider, _model, input, output) => (input + output) / 1_000_000
    });
    expect(facts.nodes.map((node) => [node.nodeId, node.nodeType, node.status])).toEqual([
      ["hook", "webhook_input", "success"],
      ["agent", "agent_orchestrator", "success"],
      ["tool", "mcp_tool", "error"],
      ["out", "output", "success"]
    ]);
    expect(facts.toolCalls).toEqual([
      expect.objectContaining({ nodeId: "agent", iteration: 1, server: "mcp_docs", tool: "search", args: { limit: 3, q: "billing" }, outcome: "ok", durationMs: 30 }),
      expect.objectContaining({ nodeId: "tool", iteration: null, server: "mcp_docs", tool: "search", args: { limit: 3, q: "x" }, outcome: "policy_blocked" })
    ]);
    expect(facts.toolCalls[0]!.argsHash).toMatch(/^[0-9a-f]{64}$/);
    // Key order does not change the hash.
    expect(Object.keys(facts.toolCalls[0]!.args as object)).toEqual(["limit", "q"]);
    expect(facts.modelCalls).toEqual([
      { nodeId: "agent", iteration: 1, providerId: "openai", model: "gpt-4o-mini", inputTokens: 100, outputTokens: 10, costUsd: 0.00011, latencyMs: 400 },
      { nodeId: "agent", iteration: 2, providerId: "openai", model: "gpt-4o-mini", inputTokens: 120, outputTokens: 20, costUsd: 0.00014, latencyMs: 300 }
    ]);
    expect(facts.guard).toEqual([{ nodeId: "agent", placement: "pre_model", channel: "prompt", detectorId: "pii", effectiveAction: "mask", shadow: false, dataClass: null, verdict: 0 }]);
    expect(facts.totals).toEqual({ inputTokens: 220, outputTokens: 30, totalTokens: 250, costUsd: 0.00025, durationMs: 950, modelCalls: 2, toolCalls: 2 });
  });

  it("collects the same calls the run manifest attests", () => {
    const activity = collectRunActivity(nodeResultRecords(nodeResults), new Map(nodes.map((node) => [node.id, node])));
    expect(activity.modelCalls).toHaveLength(2);
    expect(activity.toolCalls.map((call) => [call.source, call.toolName, call.outcome])).toEqual([
      ["agent", "search", "ok"],
      ["node", "search", "policy_blocked"]
    ]);
    expect(activity.prompts).toEqual([{ nodeId: "agent", role: "user", template: "{{user_prompt}}", rendered: null }]);
  });

  it("keeps a non-finite number from breaking the facts", () => {
    const facts = buildRunFacts({ status: "success", error: null, output: { ratio: Number.POSITIVE_INFINITY }, durationMs: null, nodeResults: [], nodes: [], guardEvents: [], priceTurn: () => null });
    expect(facts.output).toEqual({ ratio: null });
    expect(facts.totals.costUsd).toBeNull();
  });
});
