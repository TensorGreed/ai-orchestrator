import { describe, expect, it } from "vitest";
import type { MCPServerConfig, MCPToolResult, McpCassette } from "@ai-orchestrator/shared";
import {
  CASSETTE_REDACTED,
  McpCassetteMissError,
  McpCassetteRecorder,
  canonicalJson,
  cassetteServerKey,
  createRecordingRegistry,
  createReplayRegistry,
  hashCassetteArgs,
  scrubElicitationResult,
  scrubForCassette
} from "./cassette";
import { createDefaultMCPRegistry } from "./index";
import { MCPRegistry } from "./registry";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

const SECRET = "s3cr3t-value-123456";
const HEADER_TOKEN = "hdr-token-abcdef-987";

/** Echoes its arguments and counts calls, so order and live traffic are visible. */
class CountingAdapter implements MCPServerAdapter {
  calls = 0;
  readonly definition = {
    id: "counting",
    label: "Counting",
    description: "test adapter",
    configSchema: {},
    authSchema: {}
  };

  async discoverTools() {
    this.calls += 1;
    return [{ serverId: "counting", name: "echo", description: "echo", inputSchema: { type: "object" } }];
  }

  async invokeTool(toolName: string, args: Record<string, unknown>, _config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolResult> {
    this.calls += 1;
    if (toolName === "boom") throw new Error(`exploded with ${SECRET}`);
    if (toolName === "leaky") {
      const secret = await context.resolveSecret({ secretId: "sec_1" });
      return {
        ok: true,
        output: {
          echoed: args,
          note: `the key is ${secret} and the header is ${HEADER_TOKEN}`,
          authorization: "Basic dXNlcjpwYXNz",
          bearer: "Bearer abcdefghijklmnopqrstuvwxyz",
          github: "ghp_abcdefghijklmnopqrstuvwxyz0123",
          blob: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
        }
      };
    }
    return { ok: true, output: { call: this.calls, args } };
  }
}

function contextOf(extra: Partial<MCPExecutionContext> = {}): MCPExecutionContext {
  return { resolveSecret: async (ref) => (ref?.secretId === "sec_1" ? SECRET : undefined), runtimeState: new Map(), ...extra };
}

const countingConfig: MCPServerConfig = {
  serverId: "counting",
  registryServerId: "srv_counting",
  label: "Counting",
  connection: { headers: { "X-Api-Key": HEADER_TOKEN, Accept: "application/json" }, env: { API_TOKEN: "env-token-55555" } },
  secretRef: { secretId: "sec_1" }
};

function countingRegistry(adapter = new CountingAdapter()) {
  const registry = new MCPRegistry();
  registry.register(adapter);
  return { registry, adapter };
}

async function recordCounting(run: (registry: MCPRegistry, context: MCPExecutionContext) => Promise<void>): Promise<McpCassette> {
  const { registry } = countingRegistry();
  const recorder = new McpCassetteRecorder({ snapshotHashFor: (id) => (id === "srv_counting" ? "hash-abc" : null) });
  await run(createRecordingRegistry(registry, recorder), contextOf());
  return recorder.toCassette();
}

describe("cassette scrubbing", () => {
  it("removes secret values, credential keys and token shapes but keeps binary payloads", () => {
    const scrubbed = scrubForCassette(
      {
        text: `use ${SECRET} please`,
        nested: { Authorization: "anything", apiKey: "k", accessToken: "t", maxTokens: 200, topic: "mcp" },
        list: ["Bearer abcdefgh12345678", "sk-ant-abcdefghijklmnopqrstu", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
        blob: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg=="
      },
      { secrets: [SECRET], redact: (value) => (/^[A-Za-z0-9+/=]{60,}$/.test(value) ? CASSETTE_REDACTED : value) }
    ) as Record<string, unknown>;
    expect(scrubbed.text).toBe(`use ${CASSETTE_REDACTED} please`);
    expect(scrubbed.nested).toEqual({
      Authorization: CASSETTE_REDACTED,
      apiKey: CASSETTE_REDACTED,
      accessToken: CASSETTE_REDACTED,
      maxTokens: 200,
      topic: "mcp"
    });
    expect(scrubbed.list).toEqual([`Bearer ${CASSETTE_REDACTED}`, CASSETTE_REDACTED, CASSETTE_REDACTED]);
    // The redact hook would match this blob, but base64 payload fields are exempt from shape redaction.
    expect(scrubbed.blob).toMatch(/^QUJD/);
  });

  it("redacts sensitive elicitation answers and keeps the rest", () => {
    const result = scrubElicitationResult(
      {
        message: "Details?",
        requestedSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            pin: { type: "string", format: "password" } as never,
            apiToken: { type: "string" }
          }
        }
      },
      { action: "accept", content: { city: "Toronto", pin: "1234", apiToken: "x" } }
    );
    expect(result).toEqual({ action: "accept", content: { city: "Toronto", pin: CASSETTE_REDACTED, apiToken: CASSETTE_REDACTED } });
    expect(scrubElicitationResult({ message: "m", requestedSchema: { type: "object", properties: {} } }, { action: "decline" })).toEqual({ action: "decline" });
  });

  it("files servers by registry id, or by a hash of the endpoint for inline configs", () => {
    expect(cassetteServerKey(countingConfig)).toBe("registry:srv_counting");
    const inline = cassetteServerKey({ serverId: "http_mcp", connection: { endpoint: "https://tools.example.com/mcp?key=abc" } });
    expect(inline).toMatch(/^inline:http_mcp:[0-9a-f]{12}$/);
    expect(inline).not.toContain("example.com");
    expect(hashCassetteArgs({ b: 1, a: 2 })).toBe(hashCassetteArgs({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: { d: 1, c: undefined } })).toEqual({ a: { d: 1 }, b: 1 });
  });
});

describe("cassette recording", () => {
  it("records tools, resources, prompts, sampling and elicitation in order with server identity", async () => {
    const recorder = new McpCassetteRecorder({ snapshotHashFor: () => "snap-hash" });
    const registry = createRecordingRegistry(createDefaultMCPRegistry(), recorder);
    const config: MCPServerConfig = { serverId: "mock-mcp", registryServerId: "srv_mock", label: "Mock", connection: {} };
    const context = contextOf({
      onElicitation: async () => ({ action: "accept", content: { answer: "blue" } }),
      onSampling: async () => ({ role: "assistant", content: { type: "text", text: "short summary" }, model: "fake-model" })
    });
    const adapter = registry.get("mock-mcp");
    await adapter.discoverTools(config, context);
    await adapter.invokeTool("lookup_kb", { topic: "mcp" }, config, context);
    await adapter.readResource!("mock://docs/readme", config, context);
    await adapter.getPrompt!("explain_topic", { topic: "rag" }, config, context);
    await adapter.invokeTool("ask_user", { question: "Favourite colour?" }, config, context);
    await adapter.invokeTool("summarize_with_model", { text: "long text" }, config, context);

    const cassette = recorder.toCassette();
    expect(cassette.format).toBe("l2m.mcp-cassette");
    expect(cassette.llm).toBe("not_recorded");
    expect(cassette.servers).toEqual([{ key: "registry:srv_mock", adapterId: "mock-mcp", registryServerId: "srv_mock", label: "Mock", snapshotHash: "snap-hash" }]);
    expect(cassette.entries.map((entry) => [entry.seq, entry.method, entry.name])).toEqual([
      [1, "tools/list", undefined],
      [2, "tools/call", "lookup_kb"],
      [3, "resources/read", "mock://docs/readme"],
      [4, "prompts/get", "explain_topic"],
      [5, "tools/call", "ask_user"],
      [6, "tools/call", "summarize_with_model"]
    ]);
    expect(cassette.entries[1]).toMatchObject({ args: { topic: "mcp" }, result: { ok: true, output: { found: true, topic: "mcp" } } });
    expect(cassette.entries[4].exchanges).toEqual([
      expect.objectContaining({ kind: "elicitation", request: expect.objectContaining({ message: "Favourite colour?" }), response: { action: "accept", content: { answer: "blue" } } })
    ]);
    expect(cassette.entries[5].exchanges?.[0]).toMatchObject({ kind: "sampling", response: { model: "fake-model", content: { text: "short summary" } } });
    expect(cassette.entries.every((entry) => entry.durationMs >= 0 && entry.at >= 0)).toBe(true);
    expect(cassette.bytes).toBeGreaterThan(0);
  });

  it("never writes the server's secret, credential headers or env, or token-shaped strings", async () => {
    const cassette = await recordCounting(async (registry, context) => {
      await registry.get("counting").invokeTool("leaky", { query: `find ${SECRET}` }, countingConfig, context);
      await expect(registry.get("counting").invokeTool("boom", {}, countingConfig, context)).rejects.toThrow(SECRET);
    });
    const json = JSON.stringify(cassette);
    for (const value of [SECRET, HEADER_TOKEN, "env-token-55555", "dXNlcjpwYXNz", "abcdefghijklmnopqrstuvwxyz", "ghp_"]) {
      expect(json).not.toContain(value);
    }
    expect(json).toContain("iVBORw0KGgo");
    expect(cassette.entries[0].args).toEqual({ query: `find ${CASSETTE_REDACTED}` });
    expect(cassette.entries[1].error).toBe(`exploded with ${CASSETTE_REDACTED}`);
    expect(cassette.servers[0].snapshotHash).toBe("hash-abc");
  });

  it("stops at the size budget and marks the cassette truncated", async () => {
    const { registry } = countingRegistry();
    const recorder = new McpCassetteRecorder({ maxBytes: 700 });
    const recording = createRecordingRegistry(registry, recorder);
    for (let index = 0; index < 10; index += 1) {
      await recording.get("counting").invokeTool("echo", { index, padding: "x".repeat(50) }, countingConfig, contextOf());
    }
    const cassette = recorder.toCassette();
    expect(cassette.truncated).toBe(true);
    expect(cassette.entries.length).toBeGreaterThan(0);
    expect(cassette.entries.length).toBeLessThan(10);
    expect(cassette.bytes).toBeLessThanOrEqual(700);
  });
});

describe("cassette replay", () => {
  it("answers in recorded order and never touches the live adapter in strict mode", async () => {
    const cassette = await recordCounting(async (registry, context) => {
      await registry.get("counting").discoverTools(countingConfig, context);
      await registry.get("counting").invokeTool("echo", { q: "same" }, countingConfig, context);
      await registry.get("counting").invokeTool("echo", { q: "other" }, countingConfig, context);
      await registry.get("counting").invokeTool("echo", { q: "same" }, countingConfig, context);
    });
    const live = countingRegistry();
    const { registry, player } = createReplayRegistry(cassette, { mode: "strict", live: live.registry });
    const adapter = registry.get("counting");
    const context = contextOf();
    expect(await adapter.discoverTools(countingConfig, context)).toHaveLength(1);
    // Repeated identical calls get their answers in recorded order; different keys interleave freely.
    expect((await adapter.invokeTool("echo", { q: "same" }, countingConfig, context)).output).toEqual({ call: 2, args: { q: "same" } });
    expect((await adapter.invokeTool("echo", { q: "same" }, countingConfig, context)).output).toEqual({ call: 4, args: { q: "same" } });
    expect((await adapter.invokeTool("echo", { q: "other" }, countingConfig, context)).output).toEqual({ call: 3, args: { q: "other" } });
    // List reads can repeat.
    await adapter.discoverTools(countingConfig, context);

    await expect(adapter.invokeTool("echo", { q: "same" }, countingConfig, context)).rejects.toThrow(/called more often than recorded \(2 recorded\)/);
    await expect(adapter.invokeTool("echo", { q: "new" }, countingConfig, context)).rejects.toThrow(McpCassetteMissError);
    await expect(adapter.invokeTool("echo", { q: "new" }, countingConfig, context)).rejects.toThrow(/with these arguments \(3 recorded with different arguments\)/);
    await expect(adapter.invokeTool("echo", {}, { ...countingConfig, registryServerId: "elsewhere" }, context)).rejects.toThrow(/no calls to server registry:elsewhere/);
    expect(live.adapter.calls).toBe(0);

    const report = player.report("cas_1");
    expect(report).toMatchObject({ cassetteId: "cas_1", mode: "strict", matched: 5, reused: 0, live: 0 });
    expect(report.unmatched).toHaveLength(4);
    expect(report.unmatched[0]).toMatchObject({ server: "registry:srv_counting", method: "tools/call", name: "echo" });
  });

  it("matches arguments after scrubbing, so recorded secrets still line up", async () => {
    const cassette = await recordCounting(async (registry, context) => {
      await registry.get("counting").invokeTool("echo", { token_hint: `uses ${SECRET}` }, countingConfig, context);
    });
    const { registry } = createReplayRegistry(cassette);
    const result = await registry.get("counting").invokeTool("echo", { token_hint: `uses ${SECRET}` }, countingConfig, contextOf());
    expect(result.ok).toBe(true);
  });

  it("replays recorded failures as failures", async () => {
    const cassette = await recordCounting(async (registry, context) => {
      await registry.get("counting").invokeTool("boom", {}, countingConfig, context).catch(() => undefined);
    });
    const { registry } = createReplayRegistry(cassette);
    await expect(registry.get("counting").invokeTool("boom", {}, countingConfig, contextOf())).rejects.toThrow(`exploded with ${CASSETTE_REDACTED}`);
  });

  it("lenient mode reuses exhausted answers and falls through to live for unknown calls", async () => {
    const cassette = await recordCounting(async (registry, context) => {
      await registry.get("counting").invokeTool("echo", { q: "a" }, countingConfig, context);
    });
    const live = countingRegistry();
    const { registry, player } = createReplayRegistry(cassette, { mode: "lenient", live: live.registry });
    const adapter = registry.get("counting");
    const context = contextOf();
    expect((await adapter.invokeTool("echo", { q: "a" }, countingConfig, context)).output).toEqual({ call: 1, args: { q: "a" } });
    expect((await adapter.invokeTool("echo", { q: "a" }, countingConfig, context)).output).toEqual({ call: 1, args: { q: "a" } });
    expect((await adapter.invokeTool("echo", { q: "b" }, countingConfig, context)).output).toEqual({ call: 1, args: { q: "b" } });
    expect(live.adapter.calls).toBe(1);
    expect(player.report("cas")).toMatchObject({ mode: "lenient", matched: 1, reused: 1, live: 1, unmatched: [] });
  });

  it("lenient mode without a live registry still fails clearly", async () => {
    const cassette = await recordCounting(async () => undefined);
    const { registry } = createReplayRegistry(cassette, { mode: "lenient" });
    expect(registry.tryGet("counting")).toBeUndefined();
    const withAdapter = createReplayRegistry({ ...cassette, servers: [{ key: "registry:srv_counting", adapterId: "counting" }] }, { mode: "lenient" });
    await expect(withAdapter.registry.get("counting").invokeTool("echo", {}, countingConfig, contextOf())).rejects.toThrow(/Cassette replay \(lenient\)/);
  });

  it("round-trips the mock server: identical outputs, including time-dependent ones", async () => {
    const recorder = new McpCassetteRecorder();
    const config: MCPServerConfig = { serverId: "mock-mcp", connection: {} };
    const recording = createRecordingRegistry(createDefaultMCPRegistry(), recorder);
    const live = await recording.get("mock-mcp").invokeTool("get_current_time", { tz: "UTC" }, config, contextOf());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { registry } = createReplayRegistry(recorder.toCassette(), { live: createDefaultMCPRegistry() });
    const replayed = await registry.get("mock-mcp").invokeTool("get_current_time", { tz: "UTC" }, config, contextOf());
    expect(replayed).toEqual(live);
  });
});
