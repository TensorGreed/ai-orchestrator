import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import { DefaultAgentRuntime } from "./default-agent-runtime";

class FakeToolCallingProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "fake",
    label: "Fake",
    supportsTools: true,
    configSchema: {}
  };

  private callCount = 0;

  async generate() {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        content: "I should use a tool.",
        toolCalls: [
          {
            id: "tc1",
            name: "mock-mcp__calculator",
            arguments: { expression: "2+2" }
          }
        ]
      };
    }

    return {
      content: "The result is 4.",
      toolCalls: []
    };
  }
}

class MemoryAwareProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "memory-aware",
    label: "Memory Aware",
    supportsTools: false,
    configSchema: {}
  };

  readonly calls: ProviderCallRequest[] = [];

  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    return {
      content: `echo:${request.messages.at(-1)?.content ?? ""}`,
      toolCalls: []
    };
  }
}

describe("DefaultAgentRuntime", () => {
  it("loops through tool calls and returns final answer", async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new FakeToolCallingProvider());
    const runtime = new DefaultAgentRuntime();

    const output = await runtime.run(
      {
        provider: { providerId: "fake", model: "fake-model" },
        systemPrompt: "You are helpful",
        userPrompt: "What is 2+2?",
        tools: [
          {
            serverId: "mock-mcp",
            name: "mock-mcp__calculator",
            description: "calc",
            inputSchema: { type: "object" }
          }
        ],
        maxIterations: 3,
        toolCallingEnabled: true
      },
      {
        tools: [
          {
            name: "mock-mcp__calculator",
            description: "calc",
            inputSchema: { type: "object" }
          }
        ],
        invokeTool: async () => ({ result: 4 })
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined
      }
    );

    expect(output.stopReason).toBe("final_answer");
    expect(output.finalAnswer).toContain("4");
    expect(output.steps.length).toBe(2);
    expect(output.steps[0].requestedTools.length).toBe(1);
  });

  it("persists and reloads session memory when memory store is provided", async () => {
    const providerRegistry = new ProviderRegistry();
    const provider = new MemoryAwareProvider();
    providerRegistry.register(provider);
    const runtime = new DefaultAgentRuntime();

    const memoryStore = new Map<string, string>();
    const namespace = "default";
    const sessionId = "session-1";

    const runOnce = async (userPrompt: string) =>
      runtime.run(
        {
          provider: { providerId: "memory-aware", model: "fake-model" },
          systemPrompt: "You are helpful",
          userPrompt,
          tools: [],
          maxIterations: 2,
          toolCallingEnabled: false,
          sessionId,
          memory: {
            namespace,
            maxMessages: 12,
            persistToolMessages: false
          }
        },
        {
          tools: [],
          invokeTool: async () => null
        },
        {
          providerRegistry,
          resolveSecret: async () => undefined,
          memoryStore: {
            loadMessages: async (bucket, key) => {
              const stored = memoryStore.get(`${bucket}:${key}`);
              return stored ? JSON.parse(stored) : [];
            },
            saveMessages: async (bucket, key, messages) => {
              memoryStore.set(`${bucket}:${key}`, JSON.stringify(messages));
            }
          }
        }
      );

    const first = await runOnce("First question");
    expect(first.stopReason).toBe("final_answer");

    const second = await runOnce("Second question");
    expect(second.stopReason).toBe("final_answer");
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1]?.messages.some((message) => message.content.includes("First question"))).toBe(true);
  });
});
