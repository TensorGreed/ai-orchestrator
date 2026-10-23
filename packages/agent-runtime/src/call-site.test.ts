import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallSite } from "@ai-orchestrator/provider-sdk";
import { DefaultAgentRuntime } from "./default-agent-runtime";

/** Phase 15.3 — every model call of the loop names its node and iteration, so the model tape can key it. */
describe("agent runtime call sites", () => {
  it("passes the node id and the iteration of each model call", async () => {
    const sites: Array<ProviderCallSite | undefined> = [];
    let calls = 0;
    const provider: LLMProviderAdapter = {
      definition: { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} },
      async generate(_request, context) {
        sites.push(context.callSite);
        calls += 1;
        return calls === 1
          ? { content: "", toolCalls: [{ id: "c1", name: "lookup", arguments: {} }] }
          : { content: "done", toolCalls: [] };
      }
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } };
    const state = await new DefaultAgentRuntime().run(
      { provider: { providerId: "scripted", model: "m" }, systemPrompt: "s", userPrompt: "u", tools: [{ serverId: "x", ...tool }], maxIterations: 3, toolCallingEnabled: true },
      { tools: [tool], invokeTool: async () => ({ ok: true }) },
      { providerRegistry: registry, resolveSecret: async () => undefined, callSite: { nodeId: "agent_1" } }
    );
    expect(state.stopReason).toBe("final_answer");
    expect(sites).toEqual([
      { nodeId: "agent_1", iteration: 1 },
      { nodeId: "agent_1", iteration: 2 }
    ]);
  });
});
