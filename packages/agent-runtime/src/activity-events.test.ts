import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import type { AgentGuardHooks, AgentRuntimeEvent } from "./types";

type Response = { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

/** Fails the first call (transient), then answers from the script. */
class FlakyProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  private calls = 0;
  constructor(private readonly script: Response[]) {}
  async generate(_request: ProviderCallRequest) {
    this.calls += 1;
    if (this.calls === 1) throw new Error("503 Service Unavailable");
    return { ...this.script[Math.min(this.calls - 2, this.script.length - 1)]!, latencyMs: 7 };
  }
}

const TOOL = { name: "files__read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

function build(script: Response[], onEvent?: (event: AgentRuntimeEvent) => void, guard?: AgentGuardHooks) {
  const registry = new ProviderRegistry();
  registry.register(new FlakyProvider(script));
  return new DefaultAgentRuntime().run(
    {
      provider: { providerId: "scripted", model: "m" },
      systemPrompt: "s",
      userPrompt: "u",
      tools: [{ serverId: "files", ...TOOL }],
      maxIterations: 4,
      toolCallingEnabled: true
    },
    { tools: [TOOL], invokeTool: async () => ({ ok: true }) },
    { providerRegistry: registry, resolveSecret: async () => undefined, ...(onEvent ? { onEvent } : {}), ...(guard ? { guard } : {}) }
  );
}

const toolTurn: Response = { content: "Reading.", toolCalls: [{ id: "c1", name: "files__read", arguments: { path: "a.txt" } }] };
const finalTurn: Response = { content: "Done", toolCalls: [] };

describe("agent runtime activity events", () => {
  afterEach(() => vi.useRealTimers());

  it("reports steps, model calls, a retry and a tool call in order", async () => {
    vi.useFakeTimers();
    const events: AgentRuntimeEvent[] = [];
    const promise = build([toolTurn, finalTurn], (event) => events.push(event));
    await vi.advanceTimersByTimeAsync(2000);
    const state = await promise;
    expect(state.stopReason).toBe("final_answer");
    const summary = events.map((e) =>
      e.kind === "retry" ? `retry:${e.scope}:${e.attempt}/${e.maxAttempts}` : `${e.kind}:${e.phase}${"outcome" in e && e.outcome ? `:${e.outcome}` : ""}`
    );
    expect(summary).toEqual([
      "agent_step:start",
      "llm_call:start",
      "llm_call:end",
      "retry:agent_llm:1/3",
      "llm_call:start",
      "llm_call:end",
      "tool_call:start",
      "tool_call:end:ok",
      "agent_step:end",
      "agent_step:start",
      "llm_call:start",
      "llm_call:end",
      "agent_step:end"
    ]);
    expect(events[2]).toMatchObject({ kind: "llm_call", error: "503 Service Unavailable" });
    expect(events[3]).toMatchObject({ kind: "retry", delayMs: 2000, reason: "503 Service Unavailable" });
    expect(events[5]).toMatchObject({ kind: "llm_call", latencyMs: 7, iteration: 1 });
    expect(events[6]).toMatchObject({ kind: "tool_call", argsPreview: '{"path":"a.txt"}', toolCallId: "c1" });
    expect(events[8]).toMatchObject({ kind: "agent_step", toolCalls: ["files__read"] });
    expect(events[12]).toMatchObject({ kind: "agent_step", final: true, iteration: 2 });
  });

  it("reports a guard-blocked tool call as blocked", async () => {
    vi.useFakeTimers();
    const events: AgentRuntimeEvent[] = [];
    const guard: AgentGuardHooks = {
      check: async ({ channel }) => (channel === "tool_arguments" ? { outcome: "block", message: "no" } : { outcome: "allow" })
    };
    const promise = build([toolTurn, finalTurn], (event) => events.push(event), guard);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    const tool = events.filter((e) => e.kind === "tool_call");
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({ phase: "end", outcome: "blocked" });
  });

  it("is not affected by a throwing listener", async () => {
    vi.useFakeTimers();
    const promise = build([finalTurn], () => {
      throw new Error("listener broke");
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toMatchObject({ stopReason: "final_answer" });
  });
});
