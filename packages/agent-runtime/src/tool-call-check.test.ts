import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { ChatMessage } from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import { isAgentGuardInterrupt, type AgentGuardHooks, type AgentToolCallCheck } from "./types";

/**
 * Phase 12.4 — the caller's tool-call check (the MCP tool policy) runs before
 * the guard's tool_arguments hook: a block becomes a tool error, a pause stops
 * the agent for approval, and the guard only sees calls the check allowed.
 */

type Response = { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly calls: ChatMessage[][] = [];
  constructor(private readonly script: Response[]) {}
  async generate(request: ProviderCallRequest) {
    this.calls.push(request.messages.map((message) => ({ ...message })));
    return this.script[Math.min(this.calls.length - 1, this.script.length - 1)]!;
  }
}

const TOOL = { name: "repo__push", description: "Push", inputSchema: { type: "object", properties: { branch: { type: "string" } } } };
const toolTurn: Response = { content: "Pushing.", toolCalls: [{ id: "c1", name: "repo__push", arguments: { branch: "main" } }] };
const finalTurn: Response = { content: "Done.", toolCalls: [] };

function setup(check: (name: string, args: Record<string, unknown>) => AgentToolCallCheck) {
  const provider = new ScriptedProvider([toolTurn, finalTurn]);
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  const order: string[] = [];
  const seen: Array<{ toolCallId: string; iteration: number }> = [];
  const guard: AgentGuardHooks = {
    check: async (input) => {
      if (input.channel === "tool_arguments") order.push("guard");
      return { outcome: "allow" };
    }
  };
  const run = () =>
    new DefaultAgentRuntime().run(
      {
        provider: { providerId: "scripted", model: "m" },
        systemPrompt: "",
        userPrompt: "Push it",
        tools: [{ serverId: "repo", ...TOOL }],
        maxIterations: 3,
        toolCallingEnabled: true
      },
      {
        tools: [TOOL],
        checkToolCall: (name, args, call) => {
          order.push("check");
          seen.push(call);
          return check(name, args);
        },
        invokeTool: async () => {
          order.push("invoke");
          return { ok: true };
        }
      },
      { providerRegistry, resolveSecret: async () => undefined, guard }
    );
  return { provider, order, seen, run };
}

describe("checkToolCall", () => {
  it("runs before the guard and the call", async () => {
    const { order, seen, run } = setup(() => ({ outcome: "allow" }));
    const state = await run();
    expect(state.stopReason).toBe("final_answer");
    expect(order).toEqual(["check", "guard", "invoke"]);
    expect(seen).toEqual([{ toolCallId: "c1", iteration: 1 }]);
  });

  it("turns a block into a tool error without asking the guard or calling the tool", async () => {
    const { order, provider, run } = setup(() => ({ outcome: "block", message: "Blocked by policy 'No main'." }));
    const state = await run();
    expect(order).toEqual(["check"]);
    expect(state.steps[0]!.toolResults[0]!.error).toBe("Blocked by policy 'No main'.");
    expect(provider.calls[1]!.find((message) => message.role === "tool")?.content).toContain("Blocked by policy 'No main'.");
  });

  it("stops the agent for approval on a pause", async () => {
    const { order, run } = setup(() => ({ outcome: "pause", message: "Needs approval." }));
    const error = await run().catch((caught: unknown) => caught);
    expect(isAgentGuardInterrupt(error)).toBe(true);
    expect(error).toMatchObject({ reason: "approval_required", channel: "tool_arguments", message: "Needs approval." });
    expect(order).toEqual(["check"]);
  });
});
