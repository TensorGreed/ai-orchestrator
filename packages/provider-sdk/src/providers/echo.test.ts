import { describe, expect, it } from "vitest";
import { EchoProviderAdapter } from "./echo";

const ctx = { resolveSecret: async () => undefined };

function makeRequest(messages: Array<{ role: string; content: string }>, prefix?: string) {
  return {
    provider: { providerId: "echo", model: "demo", ...(prefix === undefined ? {} : { prefix }) },
    messages: messages as never
  };
}

describe("EchoProviderAdapter", () => {
  it("echoes the last user message with the default 'Echo: ' prefix", async () => {
    const adapter = new EchoProviderAdapter();
    const result = await adapter.generate(
      makeRequest([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello world" }
      ]),
      ctx
    );
    expect(result.content).toBe("Echo: Hello world");
    expect(result.toolCalls).toEqual([]);
  });

  it("uses a custom prefix when provided in provider config", async () => {
    const adapter = new EchoProviderAdapter();
    const result = await adapter.generate(
      makeRequest([{ role: "user", content: "ping" }], ">> "),
      ctx
    );
    expect(result.content).toBe(">> ping");
  });

  it("picks the most recent user message when there are multiple", async () => {
    const adapter = new EchoProviderAdapter();
    const result = await adapter.generate(
      makeRequest([
        { role: "user", content: "first" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "second" }
      ]),
      ctx
    );
    expect(result.content).toBe("Echo: second");
  });

  it("returns a friendly hint when no user message is present", async () => {
    const adapter = new EchoProviderAdapter();
    const result = await adapter.generate(
      makeRequest([{ role: "system", content: "system only" }]),
      ctx
    );
    expect(result.content).toMatch(/no user message/i);
    expect(result.toolCalls).toEqual([]);
  });

  it("never emits tool calls (so agents using echo terminate on first turn)", async () => {
    const adapter = new EchoProviderAdapter();
    const result = await adapter.generate(
      makeRequest([{ role: "user", content: "use a tool" }]),
      ctx
    );
    expect(result.toolCalls).toEqual([]);
  });

  it("testConnection always succeeds (it's in-process)", async () => {
    const adapter = new EchoProviderAdapter();
    const result = await adapter.testConnection!();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/built in/i);
  });

  it("registry definition has supportsTools and the right id/label", () => {
    const adapter = new EchoProviderAdapter();
    expect(adapter.definition.id).toBe("echo");
    expect(adapter.definition.label).toMatch(/echo/i);
    expect(adapter.definition.supportsTools).toBe(true);
  });
});
