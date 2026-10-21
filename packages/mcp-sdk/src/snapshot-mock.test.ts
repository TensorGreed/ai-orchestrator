import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import type { MCPServerConfig, McpCassette, McpSnapshotFile } from "@ai-orchestrator/shared";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { McpCassetteRecorder, createRecordingRegistry } from "./cassette";
import { handleMockRpc } from "./mock-stdio-server";
import { hashToolSnapshot, normalizeToolSnapshot } from "./schema-diff";
import { MCPRegistry } from "./registry";
import { SnapshotMockMCPServerAdapter, SnapshotMockServer, exampleFromSchema, parseCassette, parseSnapshotFile } from "./snapshot-mock";
import type { MCPExecutionContext } from "./types";

const ajv = new Ajv({ strict: false, allowUnionTypes: true });

const WEATHER_OUTPUT = {
  type: "object",
  $defs: { reading: { type: "object", properties: { at: { type: "string", format: "date-time" }, celsius: { type: "number", minimum: -90, maximum: 60 } }, required: ["at", "celsius"] } },
  properties: {
    city: { type: "string", minLength: 12 },
    unit: { type: "string", enum: ["C", "F"] },
    readings: { type: "array", items: { $ref: "#/$defs/reading" }, minItems: 2 },
    station: { allOf: [{ type: "object", properties: { id: { type: "integer", minimum: 3, multipleOf: 2 } }, required: ["id"] }, { properties: { email: { type: "string", format: "email" } } }] },
    alert: { oneOf: [{ type: "null" }, { type: "string" }] },
    ok: { type: "boolean" }
  },
  required: ["city", "unit", "readings", "station", "ok"],
  additionalProperties: false
};

const tools = [
  {
    name: "get_weather",
    description: "Current weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    annotations: { readOnlyHint: true, title: "Weather" },
    outputSchema: WEATHER_OUTPUT
  },
  { name: "send_alert", description: "Send an alert.", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { destructiveHint: true } }
];

const SNAPSHOT: McpSnapshotFile = {
  format: "l2m.mcp-snapshot",
  version: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  server: { id: "srv_weather", name: "Weather", adapterId: "http_mcp" },
  snapshot: { id: "mcpsnap_1", hash: hashToolSnapshot(normalizeToolSnapshot(tools)), createdAt: "2026-01-01T00:00:00.000Z", tools: normalizeToolSnapshot(tools) },
  catalog: {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    resources: [{ uri: "weather://stations", name: "stations", mimeType: "application/json" }],
    resourceTemplates: [{ uriTemplate: "weather://city/{name}", name: "city" }],
    prompts: [{ name: "forecast", description: "Forecast prompt", arguments: [{ name: "city", required: true }, { name: "days" }] }]
  }
};

const context = (): MCPExecutionContext => ({ resolveSecret: async () => undefined, runtimeState: new Map() });
const config = (connection: Record<string, unknown> = { snapshot: SNAPSHOT }): MCPServerConfig => ({ serverId: "snapshot_mock", registryServerId: "srv_mock", label: "Weather mock", connection });

describe("exampleFromSchema", () => {
  it("builds deterministic values that validate against the schema", () => {
    const example = exampleFromSchema(WEATHER_OUTPUT);
    expect(ajv.validate(WEATHER_OUTPUT, example)).toBe(true);
    expect(exampleFromSchema(WEATHER_OUTPUT)).toEqual(example);
    expect(example).toMatchObject({ unit: "C", ok: false, station: { id: 4, email: "user@example.com" }, alert: "example" });
    expect((example as { readings: unknown[] }).readings).toHaveLength(2);
    expect(exampleFromSchema({ type: "integer", exclusiveMinimum: 5 })).toBe(6);
    expect(exampleFromSchema({ type: ["null", "string"], format: "uuid" })).toBe("00000000-0000-4000-8000-000000000000");
    expect(exampleFromSchema({ const: 7 })).toBe(7);
    expect(exampleFromSchema({ type: "array", maxItems: 0, items: { type: "string" } })).toEqual([]);
  });
});

describe("snapshot mock adapter", () => {
  it("serves tools/list exactly as the snapshot describes it", async () => {
    const adapter = new SnapshotMockMCPServerAdapter();
    const discovered = await adapter.discoverTools(config(), context());
    expect(discovered.map((tool) => tool.name)).toEqual(["get_weather", "send_alert"]);
    expect(hashToolSnapshot(normalizeToolSnapshot(discovered))).toBe(SNAPSHOT.snapshot.hash);
    expect(discovered[0]).toMatchObject({ serverId: "snapshot_mock", serverLabel: "Weather mock", annotations: { readOnlyHint: true, title: "Weather" } });
    expect(await adapter.describeServer(config(), context())).toEqual({ tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } });
  });

  it("answers with outputs that validate against outputSchema, and a fixed text otherwise", async () => {
    const adapter = new SnapshotMockMCPServerAdapter();
    const weather = await adapter.invokeTool("get_weather", { city: "Toronto" }, config(), context());
    expect(weather.ok).toBe(true);
    expect(ajv.validate(WEATHER_OUTPUT, weather.structured)).toBe(true);
    const alert = await adapter.invokeTool("send_alert", { text: "hi" }, config(), context());
    expect(alert).toMatchObject({ ok: true, output: `Mock response from 'send_alert' (snapshot ${SNAPSHOT.snapshot.hash.slice(0, 12)}).` });
    const custom = await adapter.invokeTool("send_alert", {}, config({ snapshot: SNAPSHOT, fixedText: "queued" }), context());
    expect(custom.output).toBe("queued");
    const invalid = await adapter.invokeTool("get_weather", {}, config(), context());
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("Invalid arguments for get_weather") });
    const unknown = await adapter.invokeTool("nope", {}, config(), context());
    expect(unknown).toMatchObject({ ok: false, error: "Unknown tool: nope" });
  });

  it("serves resources and prompts from the catalog", async () => {
    const adapter = new SnapshotMockMCPServerAdapter();
    expect(await adapter.listResources(config(), context())).toEqual([{ uri: "weather://stations", name: "stations", mimeType: "application/json" }]);
    expect(await adapter.listResourceTemplates(config(), context())).toEqual([{ uriTemplate: "weather://city/{name}", name: "city" }]);
    const read = await adapter.readResource("weather://city/paris", config(), context());
    expect(read.contents[0]).toMatchObject({ uri: "weather://city/paris", text: "Mock content for weather://city/paris." });
    await expect(adapter.readResource("weather://unknown/x", config(), context())).rejects.toThrow("Resource not found");
    expect((await adapter.listPrompts(config(), context())).map((prompt) => prompt.name)).toEqual(["forecast"]);
    const prompt = await adapter.getPrompt("forecast", { city: "Oslo" }, config(), context());
    expect(prompt.messages[0].content).toEqual({ type: "text", text: 'Mock prompt \'forecast\'. Arguments: {"city":"Oslo"}' });
    await expect(adapter.getPrompt("forecast", {}, config(), context())).rejects.toThrow("requires: city");
  });

  it("answers from a cassette first, in recorded order", async () => {
    const recorder = new McpCassetteRecorder();
    const source = new MCPRegistry();
    source.register(new SnapshotMockMCPServerAdapter());
    const recording = createRecordingRegistry(source, recorder);
    // Record "real" answers by using a different fixed text, then serve them back.
    const recordConfig = { ...config({ snapshot: SNAPSHOT, fixedText: "recorded-1" }), registryServerId: "srv_weather" };
    await recording.get("snapshot_mock").invokeTool("send_alert", { text: "a" }, recordConfig, context());
    const cassette: McpCassette = parseCassette(JSON.parse(JSON.stringify(recorder.toCassette())));
    cassette.entries.push({ ...cassette.entries[0], seq: 2, result: { ok: true, output: "recorded-2", content: "recorded-2" } });

    const server = new SnapshotMockServer(SNAPSHOT, { cassette });
    expect(server.callTool("send_alert", { text: "a" }).content[0].text).toBe("recorded-1");
    expect(server.callTool("send_alert", { text: "a" }).content[0].text).toBe("recorded-2");
    expect(server.callTool("send_alert", { text: "a" }).content[0].text).toBe("recorded-2");
    // Different arguments fall back to any recording of the tool.
    expect(server.callTool("send_alert", { text: "zzz" }).content[0].text).toBe("recorded-1");

    const adapter = new SnapshotMockMCPServerAdapter({ loadSnapshot: () => SNAPSHOT, loadCassette: (id) => (id === "cas_1" ? cassette : null) });
    const viaSource = await adapter.invokeTool("send_alert", { text: "a" }, config({ sourceServerId: "srv_weather", cassetteId: "cas_1" }), context());
    expect(viaSource.output).toBe("recorded-1");
    const missing = await adapter.invokeTool("send_alert", {}, config({ sourceServerId: "srv_weather", cassetteId: "nope" }), context());
    expect(missing).toMatchObject({ ok: false, error: "Cassette not found for mock server: nope" });
    const noSource = await new SnapshotMockMCPServerAdapter().invokeTool("send_alert", {}, config({ sourceServerId: "srv_weather" }), context());
    expect(noSource.error).toContain("cannot load snapshots");
  });

  it("rejects files that are not snapshots", () => {
    expect(() => parseSnapshotFile({ format: "other" })).toThrow(/Not an L2M MCP snapshot file/);
    expect(() => parseCassette({})).toThrow(/Not an L2M MCP cassette/);
  });

  it("speaks JSON-RPC: initialize, tools, resources, prompts and errors", () => {
    const server = new SnapshotMockServer(SNAPSHOT);
    const init = handleMockRpc(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(init?.result).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: { name: "l2m-mock-srv_weather" } });
    expect(handleMockRpc(server, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(handleMockRpc(server, { jsonrpc: "2.0", id: 2, method: "tools/list" })?.result).toEqual({ tools: server.listTools() });
    expect(handleMockRpc(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } })?.error).toEqual({ code: -32602, message: "Unknown tool: nope" });
    expect(handleMockRpc(server, { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "x://y" } })?.error?.code).toBe(-32002);
    expect(handleMockRpc(server, { jsonrpc: "2.0", id: 5, method: "bogus" })?.error?.code).toBe(-32601);
  });
});

describe("snapshot mock over stdio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-snapshot-mock-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is a working MCP server for the stdio adapter", async () => {
    const snapshotPath = path.join(dir, "snapshot.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT));
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const stdioConfig: MCPServerConfig = {
      serverId: "stdio_mcp",
      connection: {
        command: process.execPath,
        args: ["--import", "tsx", path.join(packageRoot, "src/bin/snapshot-mock-stdio.ts"), "--snapshot", snapshotPath],
        cwd: packageRoot,
        timeoutMs: 20_000
      }
    };
    const adapter = new StdioMCPServerAdapter();
    const ctx = context();
    try {
      const discovered = await adapter.discoverTools(stdioConfig, ctx);
      expect(hashToolSnapshot(normalizeToolSnapshot(discovered))).toBe(SNAPSHOT.snapshot.hash);
      const weather = await adapter.invokeTool("get_weather", { city: "Lima" }, stdioConfig, ctx);
      expect(weather.ok).toBe(true);
      expect(ajv.validate(WEATHER_OUTPUT, weather.structured)).toBe(true);
      expect((await adapter.describeServer(stdioConfig, ctx)).prompts).toBeDefined();
      expect((await adapter.listResources(stdioConfig, ctx)).map((resource) => resource.uri)).toEqual(["weather://stations"]);
      const prompt = await adapter.getPrompt("forecast", { city: "Lima" }, stdioConfig, ctx);
      expect(prompt.messages).toHaveLength(1);
    } finally {
      await adapter.closeSessions(ctx);
    }
  }, 30_000);
});
