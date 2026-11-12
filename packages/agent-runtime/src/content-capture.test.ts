import { describe, expect, it } from "vitest";
import { ProviderRegistry, type LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";
import {
  NOOP_RUN_INSTRUMENTATION,
  type DataLabels,
  type InstrumentationContentKind,
  type RunInstrumentation,
  type ScopedInstrumentationSpan,
  type ToolCallSpanInfo
} from "@ai-orchestrator/shared";
import { DefaultAgentRuntime } from "./default-agent-runtime";
import type { AgentToolRuntime } from "./types";

/**
 * Tool-call content and the label check of the agent loop, through the RunInstrumentation seam with a fake that
 * evaluates the active sensitivity checks when content is handed over (as packages/otel does).
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

interface Handed {
  tool: string;
  kind: InstrumentationContentKind;
  value: unknown;
  sensitive: boolean;
}

function fakeInstrumentation(captures: boolean) {
  const handed: Handed[] = [];
  const checks: Array<() => boolean> = [];
  let wrapped = 0;
  const instrument: RunInstrumentation = {
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    capturesContent: captures,
    withContentExclusion: <T>(check: () => boolean, fn: () => T): T => {
      wrapped += 1;
      checks.push(check);
      return fn();
    },
    startToolCall: (info: ToolCallSpanInfo): ScopedInstrumentationSpan => ({
      recording: true,
      traceId: "t",
      spanId: "s",
      setAttributes: () => undefined,
      recordError: () => undefined,
      keepOpen: () => undefined,
      end: () => undefined,
      enter: (fn) => fn(),
      capturesContent: captures,
      addContent: (kind, value) => {
        if (!captures) throw new Error("content handed over while capture is off");
        handed.push({ tool: info.toolCallId ?? "", kind, value, sensitive: checks.some((check) => check()) });
      }
    })
  };
  return { instrument, handed, wrapped: () => wrapped };
}

const TOOL = { name: "files__read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
const labels = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });

function run(instrument: RunInstrumentation, options: { tracked?: DataLabels; tools?: Partial<AgentToolRuntime> } = {}) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(
    new ScriptedProvider([
      { content: "", toolCalls: [{ id: "c1", name: "files__read", arguments: { path: "a.txt" } }] },
      { content: "", toolCalls: [{ id: "c2", name: "files__read", arguments: { path: "b.txt" } }] },
      { content: "done", toolCalls: [] }
    ])
  );
  return new DefaultAgentRuntime().run(
    { provider: { providerId: "scripted", model: "m" }, systemPrompt: "S", userPrompt: "U", tools: [{ serverId: "files", ...TOOL }], maxIterations: 5, toolCallingEnabled: true },
    { tools: [TOOL], invokeTool: async (_name, args) => ({ body: `contents of ${String((args as { path: string }).path)}` }), toolType: () => "extension", ...options.tools },
    { providerRegistry, resolveSecret: async () => undefined, instrument, ...(options.tracked ? { dataLabels: { input: options.tracked, persist: false } } : {}) }
  );
}

describe("agent loop content capture", () => {
  it("hands each call's arguments and result to its span", async () => {
    const fake = fakeInstrumentation(true);
    expect((await run(fake.instrument)).stopReason).toBe("final_answer");
    expect(fake.handed.map((entry) => [entry.tool, entry.kind])).toEqual([
      ["c1", "tool_call_arguments"],
      ["c1", "tool_call_result"],
      ["c2", "tool_call_arguments"],
      ["c2", "tool_call_result"]
    ]);
    expect(fake.handed[1]!.value).toEqual({ body: "contents of a.txt" });
    // Untracked runs have no labels: the loop adds no check of its own (the engine's run check still applies).
    expect(fake.wrapped()).toBe(0);
  });

  it("hands nothing over while capture is off", async () => {
    const fake = fakeInstrumentation(false);
    expect((await run(fake.instrument)).stopReason).toBe("final_answer");
    expect(fake.handed).toEqual([]);
    expect(fake.wrapped()).toBe(0);
  });

  it("marks content sensitive from the moment a tracked loop sees a sensitive result", async () => {
    const fake = fakeInstrumentation(true);
    const state = await run(fake.instrument, {
      tracked: labels(["user"]),
      tools: { resultLabels: (_name, callId) => (callId === "c1" ? labels(["untrusted_external", "sensitive"]) : labels(["untrusted_external"])) }
    });
    expect(state.stopReason).toBe("final_answer");
    expect(fake.wrapped()).toBe(1);
    expect(fake.handed.map((entry) => [entry.tool, entry.kind, entry.sensitive])).toEqual([
      ["c1", "tool_call_arguments", false],
      ["c1", "tool_call_result", true],
      ["c2", "tool_call_arguments", true],
      ["c2", "tool_call_result", true]
    ]);
  });

  it("treats a tracked loop whose input holds a detected data class as sensitive from the start", async () => {
    const fake = fakeInstrumentation(true);
    await run(fake.instrument, { tracked: labels(["user"], ["email"]) });
    expect(fake.handed.length).toBeGreaterThan(0);
    expect(fake.handed.every((entry) => entry.sensitive)).toBe(true);
  });

  it("never fails a tool call when handing over content throws", async () => {
    const fake = fakeInstrumentation(true);
    const throwing: RunInstrumentation = {
      ...fake.instrument,
      startToolCall: (info) => ({
        ...fake.instrument.startToolCall(info),
        addContent: () => {
          throw new Error("capture broke");
        }
      })
    };
    expect((await run(throwing)).stopReason).toBe("final_answer");
  });
});
