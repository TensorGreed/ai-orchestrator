import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter, type ProviderCallRequest } from "@ai-orchestrator/provider-sdk";
import type { ChatMessage, DataLabels } from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import type { AgentGuardCheck, AgentGuardDecision, AgentRuntimeContext, AgentSessionMemoryStore, AgentSessionToolDataStore, AgentSessionToolRecord } from "./types";

/**
 * Phase 16 — the agent loop accumulates the labels of its model context:
 * input, memory, every tool result it saw. Guard checks get the propagated
 * labels beside the fixed ones; memory and the tool cache store labels only
 * while the run tracks them.
 */

type Response = { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  calls = 0;
  constructor(private readonly script: Response[]) {}
  async generate(_request: ProviderCallRequest) {
    this.calls += 1;
    return this.script[Math.min(this.calls - 1, this.script.length - 1)]!;
  }
}

const L = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });
const TOOL = { name: "files__read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
const toolTurn: Response = { content: "Reading.", toolCalls: [{ id: "c1", name: "files__read", arguments: { path: "a" } }] };
const finalTurn: Response = { content: "Done.", toolCalls: [] };

class Memory implements AgentSessionMemoryStore {
  stored: ChatMessage[] = [];
  labels: DataLabels | null = null;
  saveArgs: number[] = [];
  async loadMessages() {
    return this.stored;
  }
  async saveMessages(_namespace: string, _sessionId: string, messages: ChatMessage[], ...rest: Array<{ labels?: DataLabels } | undefined>) {
    this.saveArgs.push(rest.length);
    this.stored = messages;
    if (rest[0]?.labels) this.labels = rest[0].labels;
  }
  async loadLabels() {
    return this.labels;
  }
}

class ToolCache implements AgentSessionToolDataStore {
  records: AgentSessionToolRecord[] = [];
  async saveToolCall(input: Parameters<AgentSessionToolDataStore["saveToolCall"]>[0]) {
    const record = { id: `r${this.records.length + 1}`, createdAt: "now", ...input };
    this.records.push(record);
    return record;
  }
  async listToolCalls() {
    return this.records.map(({ output: _output, ...rest }) => rest);
  }
  async getToolCall(input: { id: string }) {
    return this.records.find((record) => record.id === input.id) ?? null;
  }
}

function run(options: {
  script: Response[];
  context?: Partial<AgentRuntimeContext>;
  decide?: (check: AgentGuardCheck) => AgentGuardDecision;
  resultLabels?: (name: string) => DataLabels | undefined;
  sessionId?: string;
}) {
  const provider = new ScriptedProvider(options.script);
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(provider);
  const checks: AgentGuardCheck[] = [];
  const invocations: unknown[][] = [];
  return {
    checks,
    invocations,
    state: new DefaultAgentRuntime().run(
      {
        provider: { providerId: "scripted", model: "m" },
        systemPrompt: "sys",
        userPrompt: "Go",
        tools: [{ serverId: "files", ...TOOL }],
        maxIterations: 4,
        toolCallingEnabled: true,
        ...(options.sessionId ? { sessionId: options.sessionId } : {})
      },
      {
        tools: [TOOL],
        invokeTool: async (...args: unknown[]) => {
          invocations.push(args);
          return { text: "body" };
        },
        ...(options.resultLabels ? { resultLabels: options.resultLabels } : {})
      },
      {
        providerRegistry,
        resolveSecret: async () => undefined,
        guard: {
          check: async (check) => {
            checks.push(check);
            return options.decide?.(check) ?? { outcome: "allow" };
          }
        },
        ...options.context
      }
    )
  };
}

describe("agent label accumulation", () => {
  it("without label tracking nothing changes: no labels on the state, the tool called with two arguments", async () => {
    const harness = run({ script: [toolTurn, finalTurn] });
    const state = await harness.state;
    expect(state.labels).toBeUndefined();
    expect(harness.invocations[0]).toHaveLength(2);
    expect(harness.checks.every((check) => check.dataLabels === undefined)).toBe(true);
  });

  it("accumulates the input and each tool result; checks carry the propagated labels beside the fixed ones", async () => {
    const harness = run({ script: [toolTurn, finalTurn], context: { dataLabels: { input: L(["user"], ["iban"]), persist: false } } });
    const state = await harness.state;
    expect(state.labels).toEqual(L(["user", "untrusted_external"], ["iban"]));
    expect(harness.checks.map((check) => [check.channel, check.labels, check.dataLabels])).toEqual([
      ["prompt", ["user"], L(["user"], ["iban"])],
      ["tool_arguments", [], L(["user"], ["iban"])],
      ["tool_result", ["untrusted_external"], L(["untrusted_external"])],
      ["final_output", [], L(["user", "untrusted_external"], ["iban"])]
    ]);
    // The tool (a worker) is told what the model context holds at the call.
    expect(harness.invocations[0]![2]).toEqual({ labels: L(["user"], ["iban"]) });
  });

  it("a tool's own result labels (a worker's) replace the external default", async () => {
    const harness = run({
      script: [toolTurn, finalTurn],
      context: { dataLabels: { input: L(["user"]), persist: false } },
      resultLabels: () => L(["trusted"], ["email"])
    });
    expect((await harness.state).labels).toEqual(L(["trusted", "user"], ["email"]));
  });

  it("a rewrite that declassifies removes the class from that content's labels only", async () => {
    const harness = run({
      script: [finalTurn],
      context: { dataLabels: { input: L(["user"], ["email", "iban"]), persist: false } },
      decide: (check) => (check.channel === "final_output" ? { outcome: "rewrite", content: "Done [email]", declassified: ["email"] } : { outcome: "allow" })
    });
    const state = await harness.state;
    expect(state.finalAnswer).toBe("Done [email]");
    expect(state.labels).toEqual(L(["user"], ["iban"]));
  });

  it("memory and the tool cache store labels only while persisting; reads add them", async () => {
    const memory = new Memory();
    const cache = new ToolCache();
    const first = run({ script: [toolTurn, finalTurn], sessionId: "s", context: { memoryStore: memory, toolDataStore: cache, dataLabels: { input: L(["user"]), persist: true } } });
    await first.state;
    expect(memory.labels).toEqual(L(["user", "untrusted_external"]));
    expect(cache.records[0]!.labels).toEqual(L(["untrusted_external"]));

    // A later run that reads the memory and the cached record.
    const cacheGet: Response = { content: "Looking.", toolCalls: [{ id: "c2", name: "session_cache_get", arguments: { record_id: "r1" } }] };
    cache.records[0]!.labels = L(["untrusted_external"], ["card_number"]);
    const second = run({ script: [cacheGet, finalTurn], sessionId: "s", context: { memoryStore: memory, toolDataStore: cache, dataLabels: { input: L(["trusted"]), persist: false } } });
    expect((await second.state).labels).toEqual(L(["trusted", "user", "untrusted_external"], ["card_number"]));
    // Not persisting: saved without labels (the call has no options argument).
    expect(memory.saveArgs).toEqual([1, 0]);
  });
});
