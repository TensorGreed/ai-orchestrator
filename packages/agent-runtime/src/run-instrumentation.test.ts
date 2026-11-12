import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import {
  NOOP_RUN_INSTRUMENTATION,
  NOOP_SCOPED_INSTRUMENTATION_SPAN,
  type InstrumentationAttributes,
  type RunInstrumentation,
  type ScopedInstrumentationSpan,
  type ToolCallSpanInfo
} from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import type { AgentGuardDecision, AgentToolRuntime } from "./types";

/**
 * The loop's tool-call and turn spans through the RunInstrumentation seam, with a recording fake (no OpenTelemetry):
 * the outcome of each call, content rules outcomes (a block is not an error) and the off path.
 */

type Response = { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

class ScriptedProvider implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  private index = 0;
  constructor(private readonly script: Response[]) {}
  async generate() {
    return this.script[Math.min(this.index++, this.script.length - 1)]!;
  }
}

interface Recorded {
  kind: "tool" | "turn";
  info: unknown;
  attributes: InstrumentationAttributes;
  errors: Array<{ error: unknown; type?: string }>;
  ended: number;
  entered: number;
}

function recordingInstrumentation(): { instrument: RunInstrumentation; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const open = (kind: Recorded["kind"], info: unknown): ScopedInstrumentationSpan => {
    const record: Recorded = { kind, info, attributes: {}, errors: [], ended: 0, entered: 0 };
    spans.push(record);
    return {
      recording: true,
      traceId: "t",
      spanId: String(spans.length),
      setAttributes: (attributes) => Object.assign(record.attributes, attributes),
      recordError: (error, options) => void record.errors.push({ error, ...(options?.type ? { type: options.type } : {}) }),
      keepOpen: () => undefined,
      end: () => void (record.ended += 1),
      enter: (fn) => {
        record.entered += 1;
        return fn();
      }
    };
  };
  const instrument: RunInstrumentation = {
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    startIteration: (info) => open("turn", info),
    startToolCall: (info) => open("tool", info)
  };
  return { instrument, spans };
}

const TOOL = { name: "files__read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

function run(script: Response[], options: { instrument?: RunInstrumentation; decide?: (channel: string) => AgentGuardDecision; tools?: Partial<AgentToolRuntime>; thinkTool?: boolean } = {}) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(new ScriptedProvider(script));
  return new DefaultAgentRuntime().run(
    {
      provider: { providerId: "scripted", model: "m" },
      systemPrompt: "S",
      userPrompt: "U",
      tools: [{ serverId: "files", ...TOOL }],
      maxIterations: 4,
      toolCallingEnabled: true,
      ...(options.thinkTool ? { thinkTool: true } : {})
    },
    { tools: [TOOL], invokeTool: async () => ({ text: "body" }), toolType: () => "extension", ...options.tools },
    {
      providerRegistry,
      resolveSecret: async () => undefined,
      ...(options.decide ? { guard: { check: async (input) => options.decide!(input.channel) } } : {}),
      ...(options.instrument ? { instrument: options.instrument } : {})
    }
  );
}

const call = (id: string, name = "files__read", args: Record<string, unknown> = { path: "a" }): Response["toolCalls"][number] => ({ id, name, arguments: args });
const final: Response = { content: "done", toolCalls: [] };

describe("agent loop spans", () => {
  it("opens one span per tool call, entered for the call, ended once, with its outcome and type", async () => {
    const { instrument, spans } = recordingInstrumentation();
    const state = await run(
      [{ content: "", toolCalls: [call("c1"), call("c2", "nope"), call("c3", "files__read", {})] }, final],
      {
        instrument,
        tools: {
          invokeTool: async () => {
            throw Object.assign(new Error("upstream said no: secret data"), { errorCategory: "mcp_transient" });
          }
        }
      }
    );
    expect(state.stopReason).toBe("final_answer");
    const tools = spans.filter((span) => span.kind === "tool");
    expect(tools.map((span) => (span.info as ToolCallSpanInfo).toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect((tools[0]!.info as ToolCallSpanInfo).toolType).toBe("extension");
    expect(tools.every((span) => span.ended === 1)).toBe(true);
    expect(tools[0]!.entered).toBeGreaterThan(0);
    expect(tools.map((span) => span.attributes["l2m.tool.outcome"])).toEqual(["error", "error", "error"]);
    expect(tools.map((span) => span.errors[0]?.type)).toEqual(["mcp_transient", "tool_not_found", "tool_arguments"]);
    // Only the type: a tool's error text never reaches the span.
    expect(tools.every((span) => span.errors.every((entry) => entry.error === ""))).toBe(true);
    // Turn spans come from startIteration: the fake records them (a real one is the no-op unless verbose).
    const turns = spans.filter((span) => span.kind === "turn");
    expect(turns.map((span) => span.info)).toEqual([{ iteration: 1 }, { iteration: 2 }]);
    expect(turns.every((span) => span.ended >= 1)).toBe(true);
    expect(turns[1]!.attributes["l2m.agent.final"]).toBe(true);
  });

  it("records a content rules block as an outcome on an unset status, and a rewrite", async () => {
    const { instrument, spans } = recordingInstrumentation();
    await run([{ content: "", toolCalls: [call("c1")] }, final], { instrument, decide: (channel) => (channel === "tool_arguments" ? { outcome: "block", message: "no" } : { outcome: "allow" }) });
    const blocked = spans.find((span) => span.kind === "tool")!;
    expect(blocked.attributes).toMatchObject({ "l2m.tool.outcome": "blocked", "l2m.content_rules.outcome": "blocked" });
    expect(blocked.errors).toEqual([]);

    const second = recordingInstrumentation();
    await run([{ content: "", toolCalls: [call("c1")] }, final], {
      instrument: second.instrument,
      decide: (channel) => (channel === "tool_result" ? { outcome: "rewrite", content: { text: "masked" } } : { outcome: "allow" })
    });
    expect(second.spans.find((span) => span.kind === "tool")!.attributes).toMatchObject({ "l2m.tool.outcome": "ok", "l2m.content_rules.outcome": "rewritten" });
  });

  it("records a tool-policy block as blocked without a content rules outcome, and a pause as paused", async () => {
    const { instrument, spans } = recordingInstrumentation();
    await run([{ content: "", toolCalls: [call("c1")] }, final], { instrument, tools: { checkToolCall: () => ({ outcome: "block", message: "policy" }) } });
    const policy = spans.find((span) => span.kind === "tool")!;
    expect(policy.attributes["l2m.tool.outcome"]).toBe("blocked");
    expect(policy.attributes["l2m.content_rules.outcome"]).toBeUndefined();

    const paused = recordingInstrumentation();
    await expect(
      run([{ content: "", toolCalls: [call("c1")] }, final], { instrument: paused.instrument, decide: (channel) => (channel === "tool_arguments" ? { outcome: "pause", message: "ask" } : { outcome: "allow" }) })
    ).rejects.toMatchObject({ name: "AgentGuardInterrupt" });
    const tool = paused.spans.find((span) => span.kind === "tool")!;
    expect(tool.attributes).toMatchObject({ "l2m.tool.outcome": "paused", "l2m.content_rules.outcome": "paused" });
    expect(tool.errors).toEqual([]);
    expect(tool.ended).toBe(1);
    expect(paused.spans.filter((span) => span.kind === "turn").every((span) => span.ended >= 1)).toBe(true);
  });

  it("marks internal tools as internal functions", async () => {
    const { instrument, spans } = recordingInstrumentation();
    await run([{ content: "", toolCalls: [call("c1", "think", { thought: "hmm" })] }, final], { instrument, thinkTool: true });
    expect(spans.find((span) => span.kind === "tool")!.info).toMatchObject({ toolName: "think", toolType: "function", internal: true });
  });

  it("calls nothing on an instrumentation that is off", async () => {
    let calls = 0;
    const off: RunInstrumentation = {
      ...NOOP_RUN_INSTRUMENTATION,
      startIteration: () => {
        calls += 1;
        return NOOP_SCOPED_INSTRUMENTATION_SPAN;
      },
      startToolCall: () => {
        calls += 1;
        return NOOP_SCOPED_INSTRUMENTATION_SPAN;
      }
    };
    const state = await run([{ content: "", toolCalls: [call("c1")] }, final], { instrument: off });
    expect(state.stopReason).toBe("final_answer");
    expect(calls).toBe(0);
  });
});
