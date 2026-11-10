import { describe, expect, it } from "vitest";
import { ToolCallAssembler } from "./tool-call-assembly";
import { ModelTapeRecorder, recordingProviderAdapter } from "./model-tape";
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
});
