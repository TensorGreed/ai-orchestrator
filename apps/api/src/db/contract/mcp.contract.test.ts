/**
 * Phase 13.1 — store contract: MCP registry, probes and snapshots, tool-call telemetry, OAuth connection rows,
 * catalogs, elicitations, tool policies and classifications, gateway toolsets and clients. The same assertions run on
 * SQLite and, with TEST_POSTGRES_URL, on Postgres.
 */
import { expect, it } from "vitest";
import type { Store } from "../store.js";
import type { McpToolCallWrite } from "../database.js";
import { describeStoreContract } from "../../test-support/test-store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function iso(offsetMs: number): string {
  return new Date(Date.parse("2026-10-26T07:00:00.000Z") + offsetMs).toISOString();
}

function call(id: string, overrides: Partial<McpToolCallWrite> = {}): McpToolCallWrite {
  return {
    id,
    executionId: "exec-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    registryServerId: "srv-1",
    adapterId: "http-mcp",
    toolName: "search",
    startedAt: iso(0),
    durationMs: 12,
    ok: true,
    error: null,
    turnInputTokens: 10,
    turnOutputTokens: 5,
    estimatedCostUsd: 0.0125,
    ...overrides
  };
}

async function addServer(store: Store, id: string, overrides: Partial<Parameters<Store["createMcpServer"]>[0]> = {}) {
  await store.createMcpServer({ id, name: `Server ${id}`, adapterId: "http-mcp", connection: { url: `http://${id}` }, ...overrides });
}

function elicitation(id: string, overrides: Partial<Parameters<Store["createMcpElicitation"]>[0]> = {}): Parameters<Store["createMcpElicitation"]>[0] {
  return {
    id,
    executionId: "exec-1",
    workflowId: "wf-1",
    nodeId: "node-1",
    serverId: "srv-1",
    toolName: "ask",
    message: "Which one?",
    requestedSchema: { type: "object", properties: { choice: { type: "string" } } },
    expiresAt: iso(60_000),
    createdBy: "user-1",
    triggerType: "manual",
    ...overrides
  };
}

function policy(id: string, overrides: Partial<Parameters<Store["createMcpToolPolicy"]>[0]> = {}): Parameters<Store["createMcpToolPolicy"]>[0] {
  return {
    id,
    name: `Rule ${id}`,
    description: null,
    effect: "deny",
    projectId: null,
    roles: ["viewer"],
    serverId: null,
    toolPattern: "*",
    enabled: true,
    createdBy: "admin",
    ...overrides
  };
}

describeStoreContract("store contract: MCP", (ctx) => {
  it("creates, reads, updates and lists servers; names sort by code point; project filter keeps global ones", async () => {
    const store = ctx.store();
    await addServer(store, "s1", { name: "beta", projectId: "p1", probeIntervalMs: 5000, blockOnBreakingChange: true, sampling: { allow: true, maxTokens: 50 } });
    await addServer(store, "s2", { name: "Alpha", probeEnabled: false });
    await addServer(store, "s3", { name: "gamma", projectId: "p2" });
    const s1 = await store.getMcpServer("s1");
    expect(s1).toMatchObject({
      id: "s1",
      name: "beta",
      description: null,
      adapterId: "http-mcp",
      connection: { url: "http://s1" },
      secretId: null,
      projectId: "p1",
      probeEnabled: true,
      probeIntervalMs: 5000,
      blockOnBreakingChange: true,
      status: "unknown",
      lastProbeAt: null,
      lastProbeOk: null,
      lastProbeLatencyMs: null,
      toolCount: 0,
      currentSnapshotId: null,
      pendingBreakingSnapshotId: null,
      sandbox: null,
      sandboxStatus: null,
      credentialMode: "service",
      delegatedFallback: "none"
    });
    expect(s1?.sampling).toMatchObject({ allow: true, maxTokens: 50 });
    expect(s1?.createdAt).toMatch(ISO);
    expect((await store.getMcpServer("s2"))?.probeEnabled).toBe(false);
    expect(await store.getMcpServer("missing")).toBeNull();

    expect((await store.listMcpServers()).map((s) => s.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect((await store.listMcpServers({ projectId: "p1" })).map((s) => s.id)).toEqual(["s2", "s1"]);

    expect(await store.updateMcpServer("s1", {})).toBe(false);
    expect(await store.updateMcpServer("s1", { name: "Beta 2", description: "d", connection: { url: "x" }, probeEnabled: false, credentialMode: "delegated", delegatedFallback: "owner", sampling: null })).toBe(true);
    const updated = await store.getMcpServer("s1");
    expect(updated).toMatchObject({ name: "Beta 2", description: "d", connection: { url: "x" }, probeEnabled: false, credentialMode: "delegated", delegatedFallback: "owner" });
    expect(updated?.sampling.allow).toBe(false);
    expect(await store.updateMcpServer("missing", { name: "x" })).toBe(true);

    await store.setMcpServerSandboxStatus("s1", { state: "ok" } as never);
    expect((await store.getMcpServer("s1"))?.sandboxStatus).toEqual({ state: "ok" });
    await store.setMcpServerSandboxStatus("s1", null);
    expect((await store.getMcpServer("s1"))?.sandboxStatus).toBeNull();
  });

  it("records probes and snapshots, prunes history, and acknowledges a breaking change", async () => {
    const store = ctx.store();
    await addServer(store, "srv-1");
    const snapshot = {
      id: "snap-1",
      serverId: "srv-1",
      hash: "h1",
      tools: [{ name: "search", inputSchema: { type: "object" } }],
      toolCount: 1,
      previousSnapshotId: null,
      changes: [{ tool: "search", kind: "removed", breaking: true, detail: "gone" }],
      breaking: true,
      createdAt: iso(0)
    };
    await store.recordMcpServerProbe({
      probe: { id: "p1", serverId: "srv-1", startedAt: iso(0), ok: true, latencyMs: 30, toolCount: 1, error: null, snapshotId: "snap-1" },
      status: "healthy",
      snapshot,
      keepProbes: 2
    });
    let server = await store.getMcpServer("srv-1");
    expect(server).toMatchObject({ status: "healthy", lastProbeAt: iso(0), lastProbeOk: true, lastProbeLatencyMs: 30, toolCount: 1, currentSnapshotId: "snap-1", pendingBreakingSnapshotId: "snap-1" });

    await store.recordMcpServerProbe({
      probe: { id: "p2", serverId: "srv-1", startedAt: iso(1000), ok: false, latencyMs: 0, toolCount: 0, error: "down", snapshotId: null },
      status: "down",
      keepProbes: 2
    });
    server = await store.getMcpServer("srv-1");
    expect(server).toMatchObject({ status: "down", lastProbeOk: false, lastProbeError: "down", toolCount: 1, currentSnapshotId: "snap-1" });
    await store.recordMcpServerProbe({
      probe: { id: "p3", serverId: "srv-1", startedAt: iso(2000), ok: true, latencyMs: 5, toolCount: 1, error: null, snapshotId: "snap-1" },
      status: "healthy",
      keepProbes: 2
    });
    const probes = await store.listMcpServerProbes("srv-1");
    expect(probes.map((p) => p.id)).toEqual(["p3", "p2"]);
    expect(probes[1]).toEqual({ id: "p2", serverId: "srv-1", startedAt: iso(1000), ok: false, latencyMs: 0, toolCount: 0, error: "down", snapshotId: null });
    expect((await store.listMcpServerProbes("srv-1", 1)).map((p) => p.id)).toEqual(["p3"]);

    const snap = await store.getMcpToolSnapshot("snap-1");
    expect(snap).toEqual({ ...snapshot, acknowledgedAt: null, acknowledgedBy: null });
    expect(await store.getMcpToolSnapshot("missing")).toBeNull();
    await store.recordMcpServerProbe({
      probe: { id: "p4", serverId: "srv-1", startedAt: iso(3000), ok: true, latencyMs: 5, toolCount: 0, error: null, snapshotId: "snap-2" },
      status: "healthy",
      snapshot: { ...snapshot, id: "snap-2", hash: "h2", previousSnapshotId: "snap-1", breaking: false, changes: [], createdAt: iso(3000) },
      keepProbes: 10
    });
    expect((await store.listMcpToolSnapshots("srv-1")).map((s) => s.id)).toEqual(["snap-2", "snap-1"]);
    expect((await store.listMcpToolSnapshots("srv-1", 1)).map((s) => s.id)).toEqual(["snap-2"]);
    expect((await store.getMcpServer("srv-1"))?.pendingBreakingSnapshotId).toBe("snap-1");

    const acked = await store.acknowledgeMcpBreakingChange("srv-1", "admin");
    expect(acked).toMatchObject({ id: "snap-1", acknowledgedBy: "admin" });
    expect(acked?.acknowledgedAt).toMatch(ISO);
    expect((await store.getMcpServer("srv-1"))?.pendingBreakingSnapshotId).toBeNull();
    expect(await store.acknowledgeMcpBreakingChange("srv-1", "admin")).toBeNull();
    expect(await store.acknowledgeMcpBreakingChange("missing", "admin")).toBeNull();
  });

  it("probes with the same start time are listed newest insert first", async () => {
    const store = ctx.store();
    await addServer(store, "srv-1");
    for (const id of ["pa", "pb", "pc"]) {
      await store.recordMcpServerProbe({
        probe: { id, serverId: "srv-1", startedAt: iso(0), ok: true, latencyMs: 1, toolCount: 0, error: null, snapshotId: null },
        status: "healthy",
        keepProbes: 2
      });
    }
    expect((await store.listMcpServerProbes("srv-1")).map((p) => p.id)).toEqual(["pc", "pb"]);
  });

  it("snapshots of one creation time keep insertion order after one of them is updated (acknowledged)", async () => {
    const store = ctx.store();
    await addServer(store, "srv-1");
    const base = { serverId: "srv-1", tools: [], toolCount: 0, previousSnapshotId: null, changes: [], createdAt: iso(0) };
    const ids = ["snap-c", "snap-a", "snap-b"];
    for (const [i, id] of ids.entries()) {
      await store.recordMcpServerProbe({
        probe: { id: `p-${id}`, serverId: "srv-1", startedAt: iso(0), ok: true, latencyMs: 1, toolCount: 0, error: null, snapshotId: id },
        status: "healthy",
        snapshot: { ...base, id, hash: id, breaking: i === 0 },
        keepProbes: 10
      });
    }
    const newestFirst = [...ids].reverse();
    expect((await store.listMcpToolSnapshots("srv-1")).map((s) => s.id)).toEqual(newestFirst);
    expect((await store.acknowledgeMcpBreakingChange("srv-1", "admin"))?.id).toBe("snap-c");
    expect((await store.listMcpToolSnapshots("srv-1")).map((s) => s.id)).toEqual(newestFirst);
    expect((await store.listMcpServerProbes("srv-1")).map((p) => p.id)).toEqual(newestFirst.map((id) => `p-${id}`));
  });

  it("tool calls of one start time written in one transaction are listed in insertion order", async () => {
    const store = ctx.store();
    const ids = ["k3", "k1", "k5", "k2", "k4"];
    await store.replaceMcpToolCallsForExecution("exec-1", ids.map((id) => call(id)));
    expect((await store.listMcpToolCalls({ registryServerId: "srv-1", since: iso(0) })).map((r) => r.id)).toEqual(ids);
  });

  it("deletes a server with its dependent rows", async () => {
    const store = ctx.store();
    await addServer(store, "srv-1");
    await addServer(store, "srv-2");
    await store.recordMcpServerProbe({
      probe: { id: "p1", serverId: "srv-1", startedAt: iso(0), ok: true, latencyMs: 1, toolCount: 0, error: null, snapshotId: null },
      status: "healthy",
      keepProbes: 5
    });
    await store.insertMcpToolCall(call("c1"));
    await store.insertMcpToolCall(call("c2", { registryServerId: "srv-2" }));
    await store.setMcpToolClassification({ registryServerId: "srv-1", toolName: "search", readOnly: true, setBy: null });
    await store.upsertMcpServerCatalog("srv-1", { capabilities: {}, resources: [], resourceTemplates: [], prompts: [] });
    await store.createMcpToolset({
      id: "ts1", slug: "ts1", name: "TS", description: null, projectId: null, enabled: true, createdBy: null,
      members: [{ kind: "server", serverId: "srv-1", toolGlob: null }, { kind: "server", serverId: "srv-2", toolGlob: "a*" }]
    });
    expect(await store.deleteMcpServer("srv-1")).toBe(true);
    expect(await store.deleteMcpServer("srv-1")).toBe(false);
    expect(await store.getMcpServer("srv-1")).toBeNull();
    expect(await store.listMcpServerProbes("srv-1")).toEqual([]);
    expect(await store.listMcpToolClassifications("srv-1")).toEqual([]);
    expect(await store.getMcpServerCatalog("srv-1")).toBeNull();
    expect((await store.listMcpToolCallsForExecution("exec-1")).map((c) => c.id)).toEqual(["c2"]);
    expect((await store.getMcpToolset("ts1"))?.members).toEqual([expect.objectContaining({ serverId: "srv-2", toolGlob: "a*" })]);
  });

  it("records tool calls, replaces an execution's workflow calls, and filters by server, client and time", async () => {
    const store = ctx.store();
    await store.insertMcpToolCall(call("g1", { source: "gateway", clientId: "cl-b", registryServerId: null, startedAt: iso(500), ok: false, error: "boom", rejection: "rate_limited" }));
    await store.replaceMcpToolCallsForExecution("exec-1", [call("c1", { startedAt: iso(100) }), call("c2", { startedAt: iso(0), registryServerId: null, samplingRequests: 2, samplingInputTokens: 3, samplingOutputTokens: 4 })]);
    await store.replaceMcpToolCallsForExecution("exec-1", [call("c3", { startedAt: iso(50), durationMs: null, turnInputTokens: null, turnOutputTokens: null, estimatedCostUsd: null })]);
    const rows = await store.listMcpToolCallsForExecution("exec-1");
    expect(rows.map((r) => r.id)).toEqual(["c3", "g1"]);
    expect(rows[0]).toMatchObject({ durationMs: null, turnInputTokens: null, estimatedCostUsd: null, samplingRequests: null, source: "workflow", clientId: null, rejection: null, ok: true });
    expect(rows[0]?.createdAt).toMatch(ISO);
    expect(rows[1]).toMatchObject({ source: "gateway", clientId: "cl-b", ok: false, error: "boom", rejection: "rate_limited" });

    await store.insertMcpToolCall(call("c4", { executionId: "exec-2", startedAt: iso(10), registryServerId: null, samplingRequests: 2, samplingInputTokens: 3, samplingOutputTokens: 4, estimatedCostUsd: 0.5 }));
    const inline = await store.listMcpToolCalls({ registryServerId: null, since: iso(0) });
    expect(inline.map((r) => r.id)).toEqual(["c4"]);
    expect(inline[0]).toMatchObject({ samplingRequests: 2, samplingInputTokens: 3, samplingOutputTokens: 4, estimatedCostUsd: 0.5 });
    expect((await store.listMcpToolCalls({ registryServerId: "srv-1", since: iso(0) })).map((r) => r.id)).toEqual(["c3"]);
    expect(await store.listMcpToolCalls({ registryServerId: "srv-1", since: iso(60) })).toEqual([]);

    await store.insertMcpToolCall(call("g2", { source: "gateway", clientId: "cl-b", startedAt: iso(900), executionId: "exec-3" }));
    await store.insertMcpToolCall(call("g3", { source: "gateway", clientId: "cl-A", startedAt: iso(700), executionId: "exec-3" }));
    expect((await store.listMcpToolCallsForClient("cl-b", iso(0))).map((r) => r.id)).toEqual(["g1", "g2"]);
    expect((await store.listMcpToolCallsForClient("cl-b", iso(600))).map((r) => r.id)).toEqual(["g2"]);
    const usage = await store.summarizeMcpClientUsage(iso(0));
    expect([...usage].sort((a, b) => (a.clientId < b.clientId ? -1 : 1))).toEqual([
      { clientId: "cl-A", calls: 1, errors: 0, lastCalledAt: iso(700) },
      { clientId: "cl-b", calls: 2, errors: 1, lastCalledAt: iso(900) }
    ]);
    expect(await store.summarizeMcpClientUsage(iso(10_000))).toEqual([]);
  });

  it("upserts, reads and deletes server OAuth connection rows", async () => {
    const store = ctx.store();
    expect(await store.getMcpOAuthConnection("srv-1")).toBeNull();
    const base = {
      serverId: "srv-1", secretId: "sec-1", state: "connected" as const, subject: "me", scope: "read", authorizationServer: "https://as",
      clientRegistration: "dynamic" as const, clientId: "cid", expiresAt: iso(3_600_000), hasRefreshToken: true, lastRefreshAt: null,
      connectedAt: iso(0), connectedBy: "admin", lastError: null
    };
    const saved = await store.upsertMcpOAuthConnection(base);
    expect(saved).toMatchObject(base);
    expect(saved.updatedAt).toMatch(ISO);
    const again = await store.upsertMcpOAuthConnection({ ...base, state: "error", hasRefreshToken: false, lastError: "bad", subject: "" });
    expect(again).toMatchObject({ state: "error", hasRefreshToken: false, lastError: "bad", subject: null });
    expect(await store.getMcpOAuthConnection("srv-1")).toEqual(again);
    expect(await store.deleteMcpOAuthConnection("srv-1")).toBe(true);
    expect(await store.deleteMcpOAuthConnection("srv-1")).toBe(false);
  });

  it("upserts, lists and deletes per-user OAuth connection rows", async () => {
    const store = ctx.store();
    const base = {
      serverId: "srv-1", userId: "u-b", secretId: null, state: "not_connected" as const, subject: null, scope: null, authorizationServer: null,
      clientRegistration: null, clientId: null, expiresAt: null, hasRefreshToken: false, lastRefreshAt: null, connectedAt: null, lastError: null
    };
    await store.upsertMcpUserOAuthConnection(base);
    await store.upsertMcpUserOAuthConnection({ ...base, userId: "U-a" });
    await store.upsertMcpUserOAuthConnection({ ...base, serverId: "srv-0", userId: "u-b", state: "connected", connectedAt: iso(0) });
    expect(await store.getMcpUserOAuthConnection("srv-1", "u-b")).toMatchObject(base);
    expect(await store.getMcpUserOAuthConnection("srv-1", "nobody")).toBeNull();
    expect((await store.listMcpUserOAuthConnections()).map((r) => `${r.serverId}/${r.userId}`)).toEqual(["srv-0/u-b", "srv-1/U-a", "srv-1/u-b"]);
    expect((await store.listMcpUserOAuthConnections({ serverId: "srv-1" })).map((r) => r.userId)).toEqual(["U-a", "u-b"]);
    expect((await store.listMcpUserOAuthConnections({ userId: "u-b" })).map((r) => r.serverId)).toEqual(["srv-0", "srv-1"]);
    expect((await store.listMcpUserOAuthConnections({ serverId: "srv-0", userId: "u-b" }))[0]).toMatchObject({ state: "connected", connectedAt: iso(0) });
    const updated = await store.upsertMcpUserOAuthConnection({ ...base, state: "expired" });
    expect(updated.state).toBe("expired");
    expect(await store.deleteMcpUserOAuthConnection("srv-1", "u-b")).toBe(true);
    expect(await store.deleteMcpUserOAuthConnection("srv-1", "u-b")).toBe(false);
  });

  it("upserts and reads a server catalog", async () => {
    const store = ctx.store();
    expect(await store.getMcpServerCatalog("srv-1")).toBeNull();
    const saved = await store.upsertMcpServerCatalog("srv-1", {
      capabilities: { resources: {} } as never,
      resources: [{ uri: "file://a", name: "a" }] as never,
      resourceTemplates: [],
      prompts: [{ name: "p" }] as never
    });
    expect(saved).toMatchObject({ serverId: "srv-1", capabilities: { resources: {} }, resources: [{ uri: "file://a", name: "a" }], resourceTemplates: [], prompts: [{ name: "p" }] });
    expect(saved.updatedAt).toMatch(ISO);
    const replaced = await store.upsertMcpServerCatalog("srv-1", { capabilities: {}, resources: [], resourceTemplates: [], prompts: [] });
    expect(replaced).toMatchObject({ resources: [], prompts: [] });
    expect(await store.getMcpServerCatalog("srv-1")).toEqual(replaced);
  });

  it("creates, lists, settles and expires elicitations; the first answer wins", async () => {
    const store = ctx.store();
    const created = await store.createMcpElicitation(elicitation("e1", { workflowName: "WF", registryServerId: "reg-1", serverName: "Srv" }));
    expect(created).toMatchObject({
      id: "e1", executionId: "exec-1", workflowName: "WF", registryServerId: "reg-1", serverName: "Srv", status: "pending",
      requestedSchema: { type: "object", properties: { choice: { type: "string" } } }, expiresAt: iso(60_000), createdBy: "user-1", triggerType: "manual"
    });
    expect(created.createdAt).toMatch(ISO);
    expect("answeredAt" in created).toBe(false);
    const bare = await store.createMcpElicitation(elicitation("e2", { expiresAt: iso(-1000), createdBy: null, triggerType: null }));
    expect("workflowName" in bare).toBe(false);
    expect(bare).toMatchObject({ createdBy: null, triggerType: null });
    await store.createMcpElicitation(elicitation("e3", { executionId: "exec-2" }));
    expect(await store.getMcpElicitation("missing")).toBeNull();

    expect((await store.listExpiredMcpElicitations(iso(0))).map((e) => e.id)).toEqual(["e2"]);
    expect((await store.listMcpElicitations({ executionId: "exec-1" })).map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect(await store.listMcpElicitations({ limit: 1 })).toHaveLength(1);

    expect(await store.settleMcpElicitation("e1", { status: "accepted", answeredBy: "user-1" })).toBe(true);
    expect(await store.settleMcpElicitation("e1", { status: "declined", answeredBy: "user-2" })).toBe(false);
    expect(await store.settleMcpElicitation("missing", { status: "declined" })).toBe(false);
    const settled = await store.getMcpElicitation("e1");
    expect(settled).toMatchObject({ status: "accepted", answeredBy: "user-1" });
    expect(settled?.answeredAt).toMatch(ISO);
    expect((await store.listMcpElicitations({ status: "pending" })).map((e) => e.id).sort()).toEqual(["e2", "e3"]);

    expect(await store.expireMcpElicitationsForExecution("exec-1", "run ended")).toBe(1);
    expect(await store.getMcpElicitation("e2")).toMatchObject({ status: "expired", reason: "run ended" });
    expect(await store.expireMcpElicitationsForExecution("exec-1", "again")).toBe(0);
    expect((await store.getMcpElicitation("e3"))?.status).toBe("pending");
  });

  it("tool policies: evaluation order is creation order, also within one millisecond; update and delete", async () => {
    const store = ctx.store();
    const ids = ["z", "a", "m", "b", "y"];
    for (const id of ids) await store.createMcpToolPolicy(policy(id));
    expect((await store.listMcpToolPolicies()).map((p) => p.id)).toEqual(ids);
    const got = await store.getMcpToolPolicy("a");
    expect(got).toMatchObject({ id: "a", name: "Rule a", effect: "deny", roles: ["viewer"], toolPattern: "*", annotationHint: null, kind: "tool", enabled: true, createdBy: "admin" });
    expect(got?.createdAt).toMatch(ISO);
    expect(await store.getMcpToolPolicy("missing")).toBeNull();

    const updated = await store.updateMcpToolPolicy("a", { effect: "allow", roles: ["admin", "builder"], toolPattern: "fs_*", annotationHint: "read_only", kind: "resource", enabled: false, serverId: "srv-1" });
    expect(updated).toMatchObject({ effect: "allow", roles: ["admin", "builder"], toolPattern: "fs_*", annotationHint: "read_only", kind: "resource", enabled: false, serverId: "srv-1" });
    expect(await store.updateMcpToolPolicy("a", {})).toEqual(updated);
    expect(await store.updateMcpToolPolicy("missing", { effect: "allow" })).toBeNull();
    expect((await store.listMcpToolPolicies()).map((p) => p.id)).toEqual(ids);
    expect(await store.deleteMcpToolPolicy("a")).toBe(true);
    expect(await store.deleteMcpToolPolicy("a")).toBe(false);
  });

  it("tool classifications: set, override, list in code-point order, remove", async () => {
    const store = ctx.store();
    const set = await store.setMcpToolClassification({ registryServerId: "srv-1", toolName: "write", readOnly: false, setBy: "admin" });
    expect(set).toMatchObject({ registryServerId: "srv-1", toolName: "write", readOnly: false, setBy: "admin" });
    expect(set?.setAt).toMatch(ISO);
    await store.setMcpToolClassification({ registryServerId: "srv-1", toolName: "Read", readOnly: true, setBy: null });
    await store.setMcpToolClassification({ registryServerId: "srv-0", toolName: "x", readOnly: true, setBy: null });
    await store.setMcpToolClassification({ registryServerId: "srv-1", toolName: "write", readOnly: true, setBy: "other" });
    expect((await store.listMcpToolClassifications("srv-1")).map((c) => [c.toolName, c.readOnly, c.setBy])).toEqual([
      ["Read", true, null],
      ["write", true, "other"]
    ]);
    expect((await store.listMcpToolClassifications()).map((c) => `${c.registryServerId}/${c.toolName}`)).toEqual(["srv-0/x", "srv-1/Read", "srv-1/write"]);
    expect(await store.setMcpToolClassification({ registryServerId: "srv-1", toolName: "write", readOnly: null, setBy: "admin" })).toBeNull();
    expect((await store.listMcpToolClassifications("srv-1")).map((c) => c.toolName)).toEqual(["Read"]);
  });

  it("toolsets: create with ordered members, list case-insensitively, look up by slug, update, delete", async () => {
    const store = ctx.store();
    const created = await store.createMcpToolset({
      id: "ts1", slug: "beta", name: "beta", description: "d", projectId: "p1", enabled: true, createdBy: "admin",
      members: [{ kind: "server", serverId: "srv-1", toolGlob: "read_*" }, { kind: "workflow", workflowId: "wf-1" }]
    });
    expect(created).toMatchObject({ id: "ts1", slug: "beta", description: "d", projectId: "p1", enabled: true, createdBy: "admin" });
    expect(created.members.map((m) => m.kind)).toEqual(["server", "workflow"]);
    expect(created.members[0]).toMatchObject({ kind: "server", serverId: "srv-1", toolGlob: "read_*" });
    expect(created.members[0]?.id).toMatch(/^mtm_/);
    expect(created.createdAt).toMatch(ISO);
    await store.createMcpToolset({ id: "ts2", slug: "alpha", name: "Alpha", description: null, projectId: null, enabled: false, createdBy: null, members: [] });
    await store.createMcpToolset({ id: "ts3", slug: "zz", name: "Gamma", description: null, projectId: null, enabled: true, createdBy: null, members: [] });
    await store.createMcpToolset({ id: "ts4", slug: "aa", name: "gamma", description: null, projectId: null, enabled: true, createdBy: null, members: [] });
    expect((await store.listMcpToolsets()).map((t) => t.id)).toEqual(["ts2", "ts1", "ts4", "ts3"]);
    expect((await store.getMcpToolsetBySlug("beta"))?.id).toBe("ts1");
    expect(await store.getMcpToolsetBySlug("nope")).toBeNull();
    expect(await store.getMcpToolset("missing")).toBeNull();

    const keptId = created.members[1]!.id;
    const updated = await store.updateMcpToolset("ts1", {
      name: "Beta 2", enabled: false, description: null,
      members: [{ kind: "workflow", workflowId: "wf-1", id: keptId }, { kind: "server", serverId: "srv-2", toolGlob: null }]
    });
    expect(updated).toMatchObject({ name: "Beta 2", enabled: false, description: null, slug: "beta" });
    expect(updated?.members[0]).toEqual({ id: keptId, kind: "workflow", workflowId: "wf-1" });
    expect(updated?.members[1]).toMatchObject({ kind: "server", serverId: "srv-2", toolGlob: null });
    const touched = await store.updateMcpToolset("ts1", {});
    expect(touched?.members).toEqual(updated?.members);
    expect(await store.updateMcpToolset("missing", { name: "x" })).toBeNull();

    await store.createMcpClient({ id: "c1", name: "C1", tokenPrefix: "pre1", tokenHash: "hash1", toolsetIds: ["ts1", "ts2"], role: "builder", createdBy: null, createdByEmail: null, expiresAt: null });
    expect(await store.deleteMcpToolset("ts1")).toBe(true);
    expect(await store.deleteMcpToolset("ts1")).toBe(false);
    expect(await store.getMcpToolset("ts1")).toBeNull();
    expect((await store.getMcpClient("c1"))?.toolsetIds).toEqual(["ts2"]);
  });

  it("gateway clients: create, find by prefix with the hash, list newest first, touch, revoke once", async () => {
    const store = ctx.store();
    const created = await store.createMcpClient({
      id: "c1", name: "First", tokenPrefix: "pre1", tokenHash: "hash1", toolsetIds: ["ts1"], role: "operator",
      createdBy: "u1", createdByEmail: "u1@example.com", expiresAt: iso(86_400_000)
    });
    expect(created).toEqual({
      id: "c1", name: "First", tokenPrefix: "pre1", toolsetIds: ["ts1"], role: "operator", createdBy: "u1", createdByEmail: "u1@example.com",
      expiresAt: iso(86_400_000), lastUsedAt: null, revokedAt: null, createdAt: created.createdAt
    });
    expect(created.createdAt).toMatch(ISO);
    expect("tokenHash" in created).toBe(false);
    for (const id of ["c2", "c3"]) {
      await store.createMcpClient({ id, name: id, tokenPrefix: `pre-${id}`, tokenHash: "h", toolsetIds: [], role: "viewer", createdBy: null, createdByEmail: null, expiresAt: null });
    }
    expect((await store.listMcpClients()).map((c) => c.id)).toEqual(["c3", "c2", "c1"]);
    expect((await store.listMcpClients()).every((c) => !("tokenHash" in c))).toBe(true);
    expect(await store.findMcpClientByTokenPrefix("pre1")).toMatchObject({ id: "c1", tokenHash: "hash1" });
    expect(await store.findMcpClientByTokenPrefix("nope")).toBeNull();
    expect(await store.getMcpClient("missing")).toBeNull();

    await store.touchMcpClient("c1", iso(5000));
    expect((await store.getMcpClient("c1"))?.lastUsedAt).toBe(iso(5000));
    const revoked = await store.revokeMcpClient("c1");
    expect(revoked?.revokedAt).toMatch(ISO);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await store.revokeMcpClient("c1"))?.revokedAt).toBe(revoked?.revokedAt);
    expect(await store.revokeMcpClient("missing")).toBeNull();
  });

  it("two settles of one elicitation at once: exactly one wins", async () => {
    const store = ctx.store();
    for (let round = 0; round < 10; round += 1) {
      const id = `race-${round}`;
      await store.createMcpElicitation(elicitation(id));
      const results = await Promise.all([
        store.settleMcpElicitation(id, { status: "accepted", answeredBy: "a" }),
        store.settleMcpElicitation(id, { status: "declined", answeredBy: "b" })
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const settled = await store.getMcpElicitation(id);
      expect(settled?.answeredBy).toBe(results[0] ? "a" : "b");
      expect(settled?.status).toBe(results[0] ? "accepted" : "declined");
    }
  });
});
