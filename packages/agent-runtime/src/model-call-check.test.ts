import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { DataLabels } from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import { isAgentGuardInterrupt, type AgentGuardDecision, type AgentGuardHooks } from "./types";

/**
 * Phase 16 — `checkModelCall`: before each model call after the first, the
 * tool results the model is about to see are judged (destination rules for
 * the provider). Absent hook: nothing changes.
 */

const TOOL = { name: "files__read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
const L = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });

class Recording implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly seen: string[][] = [];
  async generate(request: ProviderCallRequest) {
    this.seen.push(request.messages.map((message) => message.content));
    const sawTool = request.messages.some((message) => message.role === "tool");
    return sawTool ? { content: "Done.", toolCalls: [] } : { content: "Reading.", toolCalls: [{ id: "c1", name: "files__read", arguments: { path: "a" } }] };
  }
}

function run(guard: AgentGuardHooks, labels?: DataLabels) {
  const provider = new Recording();
  const registry = new ProviderRegistry();
  registry.register(provider);
  const state = new DefaultAgentRuntime().run(
    { provider: { providerId: "scripted", model: "m" }, systemPrompt: "sys", userPrompt: "Go", tools: [{ serverId: "files", ...TOOL }], maxIterations: 4, toolCallingEnabled: true },
    { tools: [TOOL], invokeTool: async () => ({ text: "IBAN DE89 3704 0044 0532 0130 00" }) },
    { providerRegistry: registry, resolveSecret: async () => undefined, guard, ...(labels ? { dataLabels: { input: labels, persist: false } } : {}) }
  );
  return { provider, state };
}

describe("model call checks", () => {
  it("are given the new tool results once, before the second call, with the accumulated labels", async () => {
    const calls: Array<{ content: string[]; dataLabels?: DataLabels; iteration: number }> = [];
    const harness = run(
      {
        check: async () => ({ outcome: "allow" }),
        checkModelCall: async (call) => {
          calls.push(call);
          return { outcome: "allow" };
        }
      },
      L(["user"])
    );
    await harness.state;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.iteration).toBe(2);
    expect(calls[0]!.content).toHaveLength(1);
    expect(calls[0]!.content[0]).toContain("DE89");
    expect(calls[0]!.dataLabels?.provenance).toEqual(["user", "untrusted_external"]);
  });

  it("a rewrite replaces what the model sees; a block stops the agent before the call", async () => {
    const rewrite = run({
      check: async () => ({ outcome: "allow" }),
      checkModelCall: async (call): Promise<AgentGuardDecision> => ({ outcome: "rewrite", content: call.content.map((text) => text.replace(/DE89[\d ]+/, "[REDACTED:iban]")) })
    });
    await rewrite.state;
    expect(rewrite.provider.seen[1]!.join("\n")).toContain("[REDACTED:iban]");
    expect(rewrite.provider.seen[1]!.join("\n")).not.toContain("DE89");

    const blocked = run({ check: async () => ({ outcome: "allow" }), checkModelCall: async () => ({ outcome: "block", message: "no" }) });
    const error = await blocked.state.catch((caught: unknown) => caught);
    expect(isAgentGuardInterrupt(error)).toBe(true);
    expect(blocked.provider.seen).toHaveLength(1);
  });

  it("without the hook the loop is unchanged", async () => {
    const harness = run({ check: async () => ({ outcome: "allow" }) });
    const state = await harness.state;
    expect(state.finalAnswer).toBe("Done.");
    expect(harness.provider.seen).toHaveLength(2);
  });
});
