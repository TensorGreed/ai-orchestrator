import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { LLMCallResponse } from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import { stopsAgentRun } from "./types";

/** Calls the one tool once, then answers with what the tool message said. */
class OneToolProvider implements LLMProviderAdapter {
  readonly definition = { id: "one-tool", label: "One tool", supportsTools: true, configSchema: {} };
  async generate(request: ProviderCallRequest): Promise<LLMCallResponse> {
    const toolMessage = request.messages.find((message) => message.role === "tool");
    if (!toolMessage) return { content: "", toolCalls: [{ id: "c1", name: "work", arguments: {} }] };
    return { content: `answer: ${String(toolMessage.content)}`, toolCalls: [] };
  }
}

const tool = { name: "work", description: "Does the work", inputSchema: { type: "object", properties: {} } };

function run(invokeTool: () => Promise<unknown>) {
  const registry = new ProviderRegistry();
  registry.register(new OneToolProvider());
  return new DefaultAgentRuntime().run(
    {
      provider: { providerId: "one-tool", model: "m" },
      systemPrompt: "S",
      userPrompt: "go",
      tools: [{ ...tool, serverId: "local" }],
      maxIterations: 3,
      toolCallingEnabled: true
    },
    { tools: [tool], invokeTool },
    { providerRegistry: registry, resolveSecret: async () => undefined }
  );
}

describe("a tool error marked stopsAgent", () => {
  it("fails the run instead of going back to the model", async () => {
    const error = Object.assign(new Error("Template {{nope}} has no value"), { stopsAgent: true });
    expect(stopsAgentRun(error)).toBe(true);
    await expect(run(async () => Promise.reject(error))).rejects.toBe(error);
  });

  it("leaves any other tool error to the model", async () => {
    const result = await run(async () => Promise.reject(new Error("tool broke")));
    expect(result.stopReason).toBe("final_answer");
    expect(result.finalAnswer).toContain("tool broke");
  });
});
