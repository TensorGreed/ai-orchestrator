import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCPRegistry, type MCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import type { MCPServerConfig, MCPToolDefinition } from "@ai-orchestrator/shared";
import { SqliteStore } from "../db/database.js";
import { McpProbeService, deriveStatus, latencyStats, percentile } from "./mcp-probe-service.js";

class ScriptedAdapter implements MCPServerAdapter {
  readonly definition = {
    id: "scripted",
    label: "Scripted",
    description: "Test adapter",
    configSchema: {},
    authSchema: {}
  };
  tools: MCPToolDefinition[] = [];
  fail: string | null = null;
  hang = false;
  closed = 0;
  seenConfigs: MCPServerConfig[] = [];

  async discoverTools(config: MCPServerConfig) {
    this.seenConfigs.push(config);
    if (this.hang) return new Promise<MCPToolDefinition[]>(() => undefined);
    if (this.fail) throw new Error(this.fail);
    return this.tools;
  }

  async invokeTool() {
    return { ok: true, output: null };
  }

  closeSessions() {
    this.closed += 1;
  }
}

const tool = (name: string, required: string[] = [], extra: Record<string, unknown> = {}): MCPToolDefinition => ({
  serverId: "scripted",
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: { query: { type: "string" }, ...extra }, required }
});

describe("McpProbeService", () => {
  let tempDir: string;
  let store: SqliteStore;
  let adapter: ScriptedAdapter;
  let leader: boolean;
  let service: McpProbeService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-probe-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    adapter = new ScriptedAdapter();
    const registry = new MCPRegistry();
    registry.register(adapter);
    leader = true;
    service = new McpProbeService(
      store,
      registry,
      { resolveSecret: async () => undefined, isLeader: () => leader },
      { defaultIntervalMs: 60_000, probeTimeoutMs: 200, keepProbes: 3 }
    );
    store.createMcpServer({
      id: "mcp_1",
      name: "Issues",
      adapterId: "scripted",
      connection: { endpoint: "http://127.0.0.1:9/mcp" },
      secretId: "sec_1",
      owner: "ops@example.com"
    });
  });

  afterEach(() => {
    service.stop();
    try { store.close(); } catch { /* may already be closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores a baseline snapshot on the first successful probe", async () => {
    adapter.tools = [tool("search")];
    const outcome = await service.probe("mcp_1");

    expect(outcome.probe.ok).toBe(true);
    expect(outcome.snapshot).toMatchObject({ toolCount: 1, breaking: false, changes: [], previousSnapshotId: null });
    expect(outcome.server).toMatchObject({
      status: "healthy",
      toolCount: 1,
      currentSnapshotId: outcome.snapshot!.id,
      pendingBreakingSnapshotId: null,
      lastProbeOk: true
    });
    expect(adapter.seenConfigs[0]).toMatchObject({
      serverId: "scripted",
      registryServerId: "mcp_1",
      connection: { endpoint: "http://127.0.0.1:9/mcp" },
      secretRef: { secretId: "sec_1" }
    });
    expect(adapter.closed).toBeGreaterThan(0);
  });

  it("does not store a new snapshot when the schema hash is unchanged", async () => {
    adapter.tools = [tool("search")];
    const first = await service.probe("mcp_1");
    const second = await service.probe("mcp_1");

    expect(second.snapshot).toBeUndefined();
    expect(second.probe.snapshotId).toBe(first.snapshot!.id);
    expect(store.listMcpToolSnapshots("mcp_1")).toHaveLength(1);
  });

  it("records a non-breaking change without blocking", async () => {
    adapter.tools = [tool("search")];
    await service.probe("mcp_1");
    adapter.tools = [tool("search"), tool("create")];
    const outcome = await service.probe("mcp_1");

    expect(outcome.snapshot).toMatchObject({ breaking: false, changes: [{ kind: "tool_added", tool: "create" }] });
    expect(outcome.server.pendingBreakingSnapshotId).toBeNull();
  });

  it("marks a breaking change as pending until it is acknowledged", async () => {
    adapter.tools = [tool("search")];
    await service.probe("mcp_1");
    adapter.tools = [tool("search", ["query", "repo"], { repo: { type: "string" } })];
    const outcome = await service.probe("mcp_1");

    expect(outcome.snapshot?.breaking).toBe(true);
    expect(outcome.server.pendingBreakingSnapshotId).toBe(outcome.snapshot!.id);

    const acknowledged = store.acknowledgeMcpBreakingChange("mcp_1", "admin@example.com");
    expect(acknowledged).toMatchObject({ id: outcome.snapshot!.id, acknowledgedBy: "admin@example.com" });
    expect(store.getMcpServer("mcp_1")?.pendingBreakingSnapshotId).toBeNull();
    expect(store.acknowledgeMcpBreakingChange("mcp_1", "admin@example.com")).toBeNull();
  });

  it("marks the server down on failure and degraded after recovering", async () => {
    adapter.fail = "connect ECONNREFUSED";
    const failed = await service.probe("mcp_1");
    expect(failed.probe).toMatchObject({ ok: false, error: "connect ECONNREFUSED", snapshotId: null });
    expect(failed.server.status).toBe("down");

    adapter.fail = null;
    adapter.tools = [tool("search")];
    const recovered = await service.probe("mcp_1");
    expect(recovered.server.status).toBe("degraded");
  });

  it("times out a hanging server and still closes its session", async () => {
    adapter.hang = true;
    const outcome = await service.probe("mcp_1");
    expect(outcome.probe.ok).toBe(false);
    expect(outcome.probe.error).toContain("timed out");
    expect(adapter.closed).toBeGreaterThan(0);
  });

  it("fails cleanly when the adapter is not registered", async () => {
    store.updateMcpServer("mcp_1", { adapterId: "gone" });
    const outcome = await service.probe("mcp_1");
    expect(outcome.probe).toMatchObject({ ok: false, error: "Unknown MCP adapter: gone" });
  });

  it("keeps only the configured number of probes", async () => {
    adapter.tools = [tool("search")];
    for (let i = 0; i < 5; i += 1) {
      await service.probe("mcp_1");
    }
    expect(store.listMcpServerProbes("mcp_1")).toHaveLength(3);
  });

  it("only probes due servers, and only on the leader", async () => {
    adapter.tools = [tool("search")];
    store.createMcpServer({ id: "mcp_off", name: "Off", adapterId: "scripted", probeEnabled: false });

    leader = false;
    await service.tick();
    expect(adapter.seenConfigs).toHaveLength(0);

    leader = true;
    await service.tick();
    expect(adapter.seenConfigs.map((config) => config.registryServerId)).toEqual(["mcp_1"]);

    await service.tick();
    expect(adapter.seenConfigs).toHaveLength(1);

    await service.tick(Date.now() + 61_000);
    expect(adapter.seenConfigs).toHaveLength(2);

    store.updateMcpServer("mcp_1", { probeIntervalMs: 600_000 });
    await service.tick(Date.now() + 120_000);
    expect(adapter.seenConfigs).toHaveLength(2);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    adapter.tools = [tool("search")];
    const [a, b] = await Promise.all([service.probe("mcp_1"), service.probe("mcp_1")]);
    expect(a.probe.id).toBe(b.probe.id);
    expect(adapter.seenConfigs).toHaveLength(1);
  });

  it("lists deployment-wide servers in every project", () => {
    store.createMcpServer({ id: "mcp_a", name: "A only", adapterId: "scripted", projectId: "proj_a" });
    store.createMcpServer({ id: "mcp_b", name: "B only", adapterId: "scripted", projectId: "proj_b" });
    expect(store.listMcpServers({ projectId: "proj_a" }).map((server) => server.id)).toEqual(["mcp_a", "mcp_1"]);
    expect(store.listMcpServers().map((server) => server.id)).toEqual(["mcp_a", "mcp_b", "mcp_1"]);
  });

  it("deletes probes and snapshots with the server", async () => {
    adapter.tools = [tool("search")];
    await service.probe("mcp_1");
    expect(store.deleteMcpServer("mcp_1")).toBe(true);
    expect(store.listMcpServerProbes("mcp_1")).toEqual([]);
    expect(store.listMcpToolSnapshots("mcp_1")).toEqual([]);
    expect(store.deleteMcpServer("mcp_1")).toBe(false);
  });
});

describe("probe statistics", () => {
  const probe = (ok: boolean, latencyMs: number) => ({
    id: "p",
    serverId: "s",
    startedAt: "",
    ok,
    latencyMs,
    toolCount: 0,
    error: null,
    snapshotId: null
  });

  it("computes nearest-rank percentiles", () => {
    const sorted = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(percentile(sorted, 50)).toBe(100);
    expect(percentile(sorted, 95)).toBe(190);
    expect(percentile([], 50)).toBeNull();
  });

  it("ignores failed probes for latency but counts them in the error rate", () => {
    expect(latencyStats([probe(true, 10), probe(false, 5000), probe(true, 30), probe(true, 20)])).toEqual({
      samples: 4,
      p50Ms: 20,
      p95Ms: 30,
      errorRate: 0.25
    });
    expect(latencyStats([])).toEqual({ samples: 0, p50Ms: null, p95Ms: null, errorRate: null });
  });

  it("derives status from the newest probes", () => {
    expect(deriveStatus([])).toBe("unknown");
    expect(deriveStatus([{ ok: false }, { ok: true }])).toBe("down");
    expect(deriveStatus([{ ok: true }, { ok: true }])).toBe("healthy");
    expect(deriveStatus([{ ok: true }, { ok: false }])).toBe("degraded");
    expect(deriveStatus([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: false }])).toBe("healthy");
  });
});
