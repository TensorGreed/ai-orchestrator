import { describe, expect, it } from "vitest";
import { MAX_TOOL_CALL_INDEX, ToolCallAssembler } from "./tool-call-assembly";
import { ModelTapeRecorder, createModelTapeReplayRegistry, recordingProviderAdapter } from "./model-tape";
import type { LLMStreamChunk } from "./types";

type Delta = Extract<LLMStreamChunk, { type: "tool_call_delta" }>;
const delta = (fields: Omit<Delta, "type">): Delta => ({ type: "tool_call_delta", ...fields });

function assemble(deltas: Delta[]) {
  const assembler = new ToolCallAssembler();
  for (const entry of deltas) assembler.add(entry);
  return assembler.calls();
}

describe("ToolCallAssembler", () => {
  it("keys later deltas that carry only an index to the call that began at that index", () => {
    expect(
      assemble([
        delta({ index: 0, toolCallId: "a", name: "lookup", argumentsDelta: "" }),
        delta({ index: 0, argumentsDelta: '{"q"' }),
        delta({ index: 0, argumentsDelta: ":1}" })
      ])
    ).toEqual([{ id: "a", name: "lookup", argumentsText: '{"q":1}' }]);
  });

  it("keeps parallel calls apart", () => {
    expect(
      assemble([
        delta({ index: 0, toolCallId: "a", name: "one" }),
        delta({ index: 1, toolCallId: "b", name: "two" }),
        delta({ index: 1, argumentsDelta: "{}" }),
        delta({ index: 0, argumentsDelta: '{"x":1}' })
      ])
    ).toEqual([
      { id: "a", name: "one", argumentsText: '{"x":1}' },
      { id: "b", name: "two", argumentsText: "{}" }
    ]);
  });

  it("groups by id when the provider sends no index (and when it sends the id every time)", () => {
    expect(
      assemble([
        delta({ toolCallId: "a", name: "one", argumentsDelta: "{" }),
        delta({ toolCallId: "b", name: "two", argumentsDelta: "{" }),
        delta({ toolCallId: "a", argumentsDelta: "}" }),
        delta({ toolCallId: "b", argumentsDelta: "}" })
      ])
    ).toEqual([
      { id: "a", name: "one", argumentsText: "{}" },
      { id: "b", name: "two", argumentsText: "{}" }
    ]);
  });

  it("starts a new call when a different id arrives at an index already in use", () => {
    expect(
      assemble([
        delta({ index: 0, toolCallId: "a", name: "one", argumentsDelta: "{}" }),
        delta({ index: 0, toolCallId: "b", name: "two", argumentsDelta: "{}" }),
        delta({ index: 0, toolCallId: "b", argumentsDelta: "" })
      ])
    ).toEqual([
      { id: "a", name: "one", argumentsText: "{}" },
      { id: "b", name: "two", argumentsText: "{}" }
    ]);
  });

  it("gives a call that never sent an id a stable placeholder, and sends a bare continuation to the last call", () => {
    expect(assemble([delta({ name: "one", argumentsDelta: "{" }), delta({ argumentsDelta: "}" })])).toEqual([
      { id: "toolcall_0", name: "one", argumentsText: "{}" }
    ]);
  });
});

describe("ToolCallAssembler, servers that reuse indexes", () => {
  it("starts a new call for a name with no id once the call at that index has complete arguments", () => {
    expect(
      assemble([
        delta({ index: 0, name: "lookup", argumentsDelta: '{"q":1}' }),
        delta({ index: 0, name: "weather", argumentsDelta: '{"c":2}' })
      ])
    ).toEqual([
      { id: "toolcall_0", name: "lookup", argumentsText: '{"q":1}' },
      { id: "toolcall_1", name: "weather", argumentsText: '{"c":2}' }
    ]);
  });

  it("still groups a server that repeats the name on every delta while the arguments are partial", () => {
    expect(assemble([delta({ index: 0, name: "lookup", argumentsDelta: '{"q"' }), delta({ index: 0, name: "lookup", argumentsDelta: ":1}" })])).toEqual([
      { id: "toolcall_0", name: "lookup", argumentsText: '{"q":1}' }
    ]);
  });

  it("gives a fresh index its own call even when the id repeats", () => {
    expect(
      assemble([
        delta({ index: 0, toolCallId: "call_0", name: "a", argumentsDelta: '{"x":1}' }),
        delta({ index: 1, toolCallId: "call_0", name: "b", argumentsDelta: '{"y":2}' })
      ])
    ).toEqual([
      { id: "call_0", name: "a", argumentsText: '{"x":1}' },
      { id: "call_0", name: "b", argumentsText: '{"y":2}' }
    ]);
  });

  it("keeps a call whose name came before its id, and takes the id when it arrives", () => {
    expect(assemble([delta({ index: 0, name: "one", argumentsDelta: "{" }), delta({ index: 0, toolCallId: "call_x", argumentsDelta: "}" })])).toEqual([
      { id: "call_x", name: "one", argumentsText: "{}" }
    ]);
  });

  it("does not trust an index that is huge or not a whole number, and says which call each delta joined", () => {
    const assembler = new ToolCallAssembler();
    expect(assembler.add(delta({ index: 1_000_000_000, toolCallId: "a", name: "one", argumentsDelta: "{" }))).toBe(0);
    expect(assembler.add(delta({ index: 1_000_000_000, argumentsDelta: "}" }))).toBe(0);
    expect(assembler.add(delta({ index: MAX_TOOL_CALL_INDEX + 1, toolCallId: "b", name: "two" }))).toBe(1);
    expect(assembler.add(delta({ index: 1.5, toolCallId: "b", argumentsDelta: "{}" }))).toBe(1);
    expect(assembler.calls()).toEqual([
      { id: "a", name: "one", argumentsText: "{}" },
      { id: "b", name: "two", argumentsText: "{}" }
    ]);
  });

  it("names placeholders by the options", () => {
    const assembler = new ToolCallAssembler({ idPrefix: "call_", blankName: true });
    assembler.add(delta({ argumentsDelta: "{}" }));
    expect(assembler.calls()).toEqual([{ id: "call_0", name: "", argumentsText: "{}" }]);
  });
});

describe("model tape and streamed tool calls", () => {
  it("records an index-only argument stream as one call", async () => {
    const recorder = new ModelTapeRecorder();
    const base = {
      definition: { id: "fake", label: "Fake", supportsTools: true, configSchema: {} },
      generate: async () => ({ content: "", toolCalls: [] }),
      async *generateStream(): AsyncGenerator<LLMStreamChunk> {
        yield delta({ index: 0, toolCallId: "a", name: "lookup", argumentsDelta: '{"q":' });
        yield delta({ index: 0, argumentsDelta: '"x"}' });
      }
    };
    const wrapped = recordingProviderAdapter(base, recorder);
    for await (const _chunk of wrapped.generateStream!({ provider: { providerId: "fake", model: "m" }, messages: [{ role: "user", content: "x" }] }, { resolveSecret: async () => "k" })) void _chunk;
    expect(recorder.toTape().entries[0]!.response).toMatchObject({ toolCalls: [{ id: "a", name: "lookup", arguments: { q: "x" } }] });
  });

  it("replays two calls that share an id as two calls", async () => {
    const recorder = new ModelTapeRecorder();
    const base = {
      definition: { id: "fake", label: "Fake", supportsTools: true, configSchema: {} },
      generate: async () => ({ content: "", toolCalls: [] }),
      async *generateStream(): AsyncGenerator<LLMStreamChunk> {
        yield delta({ index: 0, toolCallId: "same", name: "a", argumentsDelta: '{"x":1}' });
        yield delta({ index: 1, toolCallId: "same", name: "b", argumentsDelta: '{"y":2}' });
      }
    };
    const request = { provider: { providerId: "fake", model: "m" }, messages: [{ role: "user" as const, content: "x" }] };
    const context = { resolveSecret: async () => "k" };
    for await (const _chunk of recordingProviderAdapter(base, recorder).generateStream!(request, context)) void _chunk;
    const tape = recorder.toTape();
    expect((tape.entries[0]!.response as { toolCalls: unknown[] }).toolCalls).toHaveLength(2);
    const replay = createModelTapeReplayRegistry(tape).registry.get("fake");
    const assembler = new ToolCallAssembler();
    for await (const chunk of replay.generateStream!(request, context)) if (chunk.type === "tool_call_delta") assembler.add(chunk);
    expect(assembler.calls().map((call) => call.name)).toEqual(["a", "b"]);
  });
});
