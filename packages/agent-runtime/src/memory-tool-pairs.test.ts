import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { ChatMessage } from "@ai-orchestrator/shared";
import { DefaultAgentRuntime, repairToolCallPairs } from "./default-agent-runtime";

const call = (id: string, name = "mock-mcp__lookup") => ({ id, name, arguments: {} });

describe("repairToolCallPairs", () => {
  it("drops tool calls whose results were not kept, and empty assistant turns", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "find our refund policy" },
      { role: "assistant", content: "", toolCalls: [call("call_1")] },
      { role: "assistant", content: "Done: found it." },
      { role: "user", content: "and shipping?" },
      { role: "assistant", content: "Let me check.", toolCalls: [call("call_2")] }
    ];
    expect(repairToolCallPairs(history)).toEqual([
      { role: "user", content: "find our refund policy" },
      { role: "assistant", content: "Done: found it." },
      { role: "user", content: "and shipping?" },
      { role: "assistant", content: "Let me check." }
    ]);
  });

  it("keeps answered calls with their results and drops orphan results", () => {
    const history: ChatMessage[] = [
      { role: "tool", content: "{}", toolCallId: "cut_off" },
      { role: "user", content: "time?" },
      { role: "assistant", content: "", toolCalls: [call("a"), call("b")] },
      { role: "tool", content: '{"ok":true}', toolCallId: "a" },
      { role: "tool", content: '{"ok":true}', toolCallId: "a" },
      { role: "user", content: "thanks" },
      { role: "tool", content: "{}", toolCallId: "stray" }
    ];
    expect(repairToolCallPairs(history)).toEqual([
      { role: "user", content: "time?" },
      { role: "assistant", content: "", toolCalls: [call("a")] },
      { role: "tool", content: '{"ok":true}', toolCallId: "a" },
      { role: "user", content: "thanks" }
    ]);
  });

  it("keeps a trailing unanswered clarify call, but not one followed by later turns", () => {
    const clarify = { role: "assistant" as const, content: "", toolCalls: [call("q1", "agent_clarify")] };
    expect(repairToolCallPairs([{ role: "user", content: "book it" }, clarify])).toEqual([{ role: "user", content: "book it" }, clarify]);
    expect(repairToolCallPairs([clarify, { role: "user", content: "never mind" }])).toEqual([{ role: "user", content: "never mind" }]);
  });
});

class RecordingToolProvider implements LLMProviderAdapter {
  readonly definition = { id: "rec", label: "Recording", supportsTools: true, configSchema: {} };
  readonly requests: ChatMessage[][] = [];
  async generate(request: ProviderCallRequest) {
    this.requests.push(request.messages);
    const hasToolResult = request.messages.some((message, index) => index > 0 && message.role === "tool" && request.messages[index - 1]?.role === "assistant");
    if (this.requests.length % 2 === 1 && !hasToolResult) {
      return { content: "", toolCalls: [{ id: "call_1", name: "mock-mcp__lookup", arguments: {} }] };
    }
    return { content: "Done: found it.", toolCalls: [] };
  }
}

/** Every tool call must be answered by the tool messages right after it, and every tool message must answer one. */
function expectWellFormed(messages: ChatMessage[]) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      const answered = new Set<string>();
      for (let next = index + 1; next < messages.length && messages[next]!.role === "tool"; next += 1) {
        answered.add(messages[next]!.toolCallId ?? "");
      }
      for (const toolCall of message.toolCalls) expect(answered.has(toolCall.id)).toBe(true);
    }
    if (message.role === "tool") {
      let previous = index - 1;
      while (previous >= 0 && messages[previous]!.role === "tool") previous -= 1;
      const owner = messages[previous];
      expect(owner?.role).toBe("assistant");
      expect(owner?.toolCalls?.some((toolCall) => toolCall.id === message.toolCallId)).toBe(true);
    }
  }
}

describe("agent memory without tool messages", () => {
  it("sends a well-formed history on the next turn and saves none of the unanswered calls", async () => {
    const provider = new RecordingToolProvider();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);
    const store = new Map<string, ChatMessage[]>();
    // A history saved before this fix: an assistant tool call whose result was not persisted.
    store.set("default:s1", [
      { role: "user", content: "find our refund policy" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "mock-mcp__lookup", arguments: {} }] },
      { role: "assistant", content: "Done: found it." }
    ]);
    const memoryStore = {
      loadMessages: async (namespace: string, sessionId: string) => store.get(`${namespace}:${sessionId}`) ?? [],
      saveMessages: async (namespace: string, sessionId: string, messages: ChatMessage[]) => {
        store.set(`${namespace}:${sessionId}`, messages);
      }
    };
    const runtime = new DefaultAgentRuntime();
    const tool = { name: "mock-mcp__lookup", description: "lookup", inputSchema: { type: "object" } };
    const runTurn = (userPrompt: string) =>
      runtime.run(
        {
          provider: { providerId: "rec", model: "m" },
          systemPrompt: "You are helpful",
          userPrompt,
          tools: [{ serverId: "mock-mcp", ...tool }],
          maxIterations: 4,
          toolCallingEnabled: true,
          sessionId: "s1",
          memory: { namespace: "default", maxMessages: 20, persistToolMessages: false }
        },
        { tools: [tool], invokeTool: async () => ({ found: true }) },
        { providerRegistry, resolveSecret: async () => undefined, memoryStore }
      );

    expect((await runTurn("find it again")).stopReason).toBe("final_answer");
    expect((await runTurn("one more time")).stopReason).toBe("final_answer");

    for (const messages of provider.requests) expectWellFormed(messages);
    const saved = store.get("default:s1")!;
    expect(saved.some((message) => message.role === "tool")).toBe(false);
    expect(saved.some((message) => message.toolCalls && message.toolCalls.length > 0)).toBe(false);
  });
});
