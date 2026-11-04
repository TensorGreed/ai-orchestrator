import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import { DefaultAgentRuntime, RUNTIME_INTERNAL_TOOL_NAMES, THINK_TOOL_NAME } from "./default-agent-runtime";
import type { AgentGuardCheck, AgentRuntimeEvent } from "./types";

type Turn = { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  readonly requests: ProviderCallRequest[] = [];
  constructor(private readonly script: Turn[]) {}
  async generate(request: ProviderCallRequest) {
    this.requests.push(request);
    return this.script[Math.min(this.requests.length - 1, this.script.length - 1)]!;
  }
}

const TOOL = { name: "files__read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

async function run(script: Turn[], thinkTool: boolean) {
  const provider = new ScriptedProvider(script);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const events: AgentRuntimeEvent[] = [];
  const invoked: string[] = [];
  const checked: string[] = [];
  const guarded: AgentGuardCheck[] = [];
  const state = await new DefaultAgentRuntime().run(
    {
      provider: { providerId: "scripted", model: "m" },
      systemPrompt: "s",
      userPrompt: "u",
      tools: [{ serverId: "files", ...TOOL }],
      maxIterations: 4,
      toolCallingEnabled: true,
      thinkTool
    },
    {
      tools: [TOOL],
      invokeTool: async (name) => {
        invoked.push(name);
        return { text: "file contents" };
      },
      checkToolCall: (name) => {
        checked.push(name);
        return { outcome: "allow" };
      }
    },
    {
      providerRegistry: registry,
      resolveSecret: async () => undefined,
      onEvent: (event) => events.push(event),
      guard: {
        check: async (check) => {
          guarded.push(check);
          return { outcome: "allow" };
        }
      }
    }
  );
  return { state, events, invoked, checked, guarded, provider };
}

const thinkThenRead: Turn[] = [
  { content: "Let me plan.", toolCalls: [{ id: "t1", name: "think", arguments: { thought: "I should read a.txt first, then answer." } }] },
  { content: "Reading.", toolCalls: [{ id: "c1", name: "files__read", arguments: { path: "a.txt" } }] },
  { content: "Done", toolCalls: [] }
];

describe("Think tool", () => {
  it("is offered only when the agent turns it on, and is an internal tool", async () => {
    expect(RUNTIME_INTERNAL_TOOL_NAMES).toContain(THINK_TOOL_NAME);
    const off = await run([{ content: "Done", toolCalls: [] }], false);
    expect(off.provider.requests[0]!.tools?.map((tool) => tool.name)).not.toContain("think");
    const on = await run([{ content: "Done", toolCalls: [] }], true);
    expect(on.provider.requests[0]!.tools?.map((tool) => tool.name)).toContain("think");
    expect(on.provider.requests[0]!.messages[0]!.content).toContain("`think` tool is available");
    expect(off.provider.requests[0]!.messages[0]!.content).not.toContain("`think` tool");
  });

  it("records the thought in the trace as a thought, not a tool call, and skips the policy check and the guard", async () => {
    const { state, events, invoked, checked, guarded } = await run(thinkThenRead, true);
    expect(state.stopReason).toBe("final_answer");
    expect(invoked).toEqual(["files__read"]);
    expect(checked).toEqual(["files__read"]);
    expect(guarded.filter((check) => check.channel === "tool_arguments").map((check) => check.tool?.name)).toEqual(["files__read"]);
    expect(state.steps[0]!.toolResults).toEqual([
      expect.objectContaining({ toolCallId: "t1", toolName: "think", thought: "I should read a.txt first, then answer.", output: { recorded: true } })
    ]);
    const thought = events.find((event) => event.kind === "thought");
    expect(thought).toMatchObject({ kind: "thought", iteration: 1, toolCallId: "t1", text: "I should read a.txt first, then answer." });
    expect(events.filter((event) => event.kind === "tool_call").map((event) => (event as { toolName: string }).toolName)).toEqual(["files__read", "files__read"]);
    // The model gets an acknowledgement for the call, so the conversation stays well formed.
    expect(state.messages.find((message) => message.role === "tool" && message.toolCallId === "t1")?.content).toContain("recorded");
  });

  it("is an unknown tool when the toggle is off", async () => {
    const { state, invoked } = await run(thinkThenRead, false);
    expect(state.steps[0]!.toolResults[0]).toMatchObject({ toolName: "think", error: expect.stringContaining("does not exist") });
    expect(invoked).toEqual(["files__read"]);
  });
});
