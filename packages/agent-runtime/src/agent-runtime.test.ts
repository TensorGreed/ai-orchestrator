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

class MissingArgsProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "missing-args",
    label: "Missing Args",
    supportsTools: true,
    configSchema: {}
  };

  private callCount = 0;

  async generate() {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        content: "Trying a tool call.",
        toolCalls: [
          {
            id: "tc-missing",
            name: "mock-mcp__calculator",
            arguments: {}
          }
        ]
      };
    }

    return {
      content: "Recovered after validation error.",
      toolCalls: []
    };
  }
}

class ToolCaptureProvider implements LLMProviderAdapter {
  readonly definition = {
    id: "tool-capture",
    label: "Tool Capture",
    supportsTools: true,
    configSchema: {}
  };

  readonly calls: ProviderCallRequest[] = [];

  async generate(request: ProviderCallRequest) {
    this.calls.push(request);
    return {
      content: "done",
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

  it("compacts oversized tool payloads into structured JSON for follow-up reasoning", async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new FakeToolCallingProvider());
    const runtime = new DefaultAgentRuntime();

    const hugeToolOutput = {
      skip: 0,
      limit: 50,
      total: 341920,
      resources: Array.from({ length: 24 }, (_, index) => ({
        id: `key-${index}`,
        name: `resource-${index}`,
        metadata: "x".repeat(1200)
      }))
    };

    const output = await runtime.run(
      {
        provider: { providerId: "fake", model: "fake-model" },
        systemPrompt: "You are helpful",
        userPrompt: "List keys",
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
        invokeTool: async () => hugeToolOutput
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined
      }
    );

    const toolMessage = output.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeTruthy();

    const parsed = JSON.parse(String(toolMessage?.content)) as {
      ok: boolean;
      truncated?: boolean;
      preview?: string;
      output?: { total?: number; resources?: unknown[] };
      _meta?: { truncated?: boolean };
    };
    expect(parsed.ok).toBe(true);
    if (parsed.output) {
      expect(parsed.output.total).toBe(341920);
      expect(Array.isArray(parsed.output.resources)).toBe(true);
      expect((parsed.output.resources?.length ?? 0) > 0).toBe(true);
      expect(parsed.output.resources?.length).toBeLessThanOrEqual(24);
    } else {
      expect(typeof parsed.preview).toBe("string");
      expect((parsed.preview?.length ?? 0) > 0).toBe(true);
    }
  });

  it("supports custom tool output limits for larger tool payload contexts", async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new FakeToolCallingProvider());
    const runtime = new DefaultAgentRuntime();

    const hugeToolOutput = {
      skip: 0,
      limit: 50,
      total: 341920,
      resources: Array.from({ length: 24 }, (_, index) => ({
        id: `key-${index}`,
        name: `resource-${index}`,
        metadata: "x".repeat(1200)
      }))
    };

    const output = await runtime.run(
      {
        provider: { providerId: "fake", model: "fake-model" },
        systemPrompt: "You are helpful",
        userPrompt: "List keys",
        tools: [
          {
            serverId: "mock-mcp",
            name: "mock-mcp__calculator",
            description: "calc",
            inputSchema: { type: "object" }
          }
        ],
        maxIterations: 3,
        toolCallingEnabled: true,
        toolOutputLimits: {
          messageMaxChars: 1_000_000,
          payloadMaxDepth: 8,
          payloadMaxObjectKeys: 500,
          payloadMaxArrayItems: 1000,
          payloadMaxStringChars: 5000
        }
      },
      {
        tools: [
          {
            name: "mock-mcp__calculator",
            description: "calc",
            inputSchema: { type: "object" }
          }
        ],
        invokeTool: async () => hugeToolOutput
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined
      }
    );

    const toolMessage = output.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeTruthy();

    const parsed = JSON.parse(String(toolMessage?.content)) as {
      ok: boolean;
      output?: { total?: number; resources?: unknown[] };
      _meta?: { truncated?: boolean };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.output?.total).toBe(341920);
    expect(parsed._meta?.truncated).toBeFalsy();
    expect(Array.isArray(parsed.output?.resources)).toBe(true);
    expect(parsed.output?.resources?.length).toBe(24);
  });

  it("validates required tool arguments before invocation and reports missing args", async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new MissingArgsProvider());
    const runtime = new DefaultAgentRuntime();

    let invoked = false;
    const output = await runtime.run(
      {
        provider: { providerId: "missing-args", model: "fake-model" },
        systemPrompt: "You are helpful",
        userPrompt: "Use calculator",
        tools: [
          {
            serverId: "mock-mcp",
            name: "mock-mcp__calculator",
            description: "calc",
            inputSchema: {
              type: "object",
              properties: {
                expression: { type: "string" }
              },
              required: ["expression"]
            }
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
            inputSchema: {
              type: "object",
              properties: {
                expression: { type: "string" }
              },
              required: ["expression"]
            }
          }
        ],
        invokeTool: async () => {
          invoked = true;
          return { result: 4 };
        }
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined
      }
    );

    expect(output.stopReason).toBe("final_answer");
    expect(output.finalAnswer).toContain("Recovered");
    expect(invoked).toBe(false);
    expect(output.steps[0]?.toolResults[0]?.error).toContain("missing required arguments");
    expect(output.steps[0]?.toolResults[0]?.error).toContain("expression");
  });

  it("caps tool definitions passed to providers to prevent context overflow", async () => {
    const providerRegistry = new ProviderRegistry();
    const provider = new ToolCaptureProvider();
    providerRegistry.register(provider);
    const runtime = new DefaultAgentRuntime();

    const manyTools = Array.from({ length: 120 }, (_, index) => ({
      serverId: "mock-mcp",
      name: `mock-mcp__very_large_tool_${index}`,
      description: `Large tool ${index}: ${"d".repeat(1200)}`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 40 }, (_ignored, propertyIndex) => [
            `property_${propertyIndex}`,
            {
              type: "string",
              description: `Property ${propertyIndex} description ${"x".repeat(500)}`
            }
          ])
        ),
        required: Array.from({ length: 40 }, (_ignored, propertyIndex) => `property_${propertyIndex}`)
      }
    }));

    const output = await runtime.run(
      {
        provider: { providerId: "tool-capture", model: "fake-model" },
        systemPrompt: "You are helpful",
        userPrompt: "Summarize the inventory status",
        tools: manyTools,
        maxIterations: 1,
        toolCallingEnabled: true
      },
      {
        tools: manyTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        invokeTool: async () => ({ ok: true })
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined
      }
    );

    expect(output.stopReason).toBe("final_answer");
    const requestTools = provider.calls[0]?.tools ?? [];
    expect(requestTools.length).toBeGreaterThan(0);
    expect(requestTools.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(requestTools).length).toBeLessThanOrEqual(24_000);
  });

  it("does not persist tool messages by default when memory config omits persistToolMessages", async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(new FakeToolCallingProvider());
    const runtime = new DefaultAgentRuntime();

    const memoryState = new Map<string, string>();
    const namespace = "memory-default";
    const sessionId = "session-memory-default";

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
            inputSchema: { type: "object", required: ["expression"] }
          }
        ],
        maxIterations: 3,
        toolCallingEnabled: true,
        sessionId,
        memory: {
          namespace,
          maxMessages: 20
        }
      },
      {
        tools: [
          {
            name: "mock-mcp__calculator",
            description: "calc",
            inputSchema: { type: "object", required: ["expression"] }
          }
        ],
        invokeTool: async () => ({ result: 4 })
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined,
        memoryStore: {
          loadMessages: async (bucket, key) => {
            const stored = memoryState.get(`${bucket}:${key}`);
            return stored ? JSON.parse(stored) : [];
          },
          saveMessages: async (bucket, key, messages) => {
            memoryState.set(`${bucket}:${key}`, JSON.stringify(messages));
          }
        }
      }
    );

    expect(output.stopReason).toBe("final_answer");
    const saved = JSON.parse(memoryState.get(`${namespace}:${sessionId}`) ?? "[]") as Array<{ role?: string }>;
    expect(saved.some((message) => message.role === "tool")).toBe(false);
  });
});
