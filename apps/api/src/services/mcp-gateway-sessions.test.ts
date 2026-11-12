import { describe, expect, it } from "vitest";
import type { MCPExecutionContext } from "@ai-orchestrator/mcp-sdk";
import {
  GatewaySessionLimitError,
  GatewaySessionManager,
  emptySessionLabelMark,
  gatewayPrincipalScope,
  raiseSessionLabels,
  sessionCallLabels,
  sessionLabelsView,
  type GatewaySessionEndReason
} from "./mcp-gateway-sessions.js";
import {
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  classifyMessage,
  decodeCursor,
  encodeCursor,
  negotiateProtocolVersion,
  toolSuccess,
  versionAllowsBatches
} from "./mcp-gateway-protocol.js";
import { capRole, resolveMcpClientSubject } from "./mcp-client-service.js";

function makeManager(options: { idleMs?: number; maxSessions?: number } = {}) {
  let now = 1_000_000;
  const closed: MCPExecutionContext[] = [];
  const ended: Array<{ id: string; reason: GatewaySessionEndReason }> = [];
  const manager = new GatewaySessionManager({
    idleMs: options.idleMs ?? 60_000,
    maxSessions: options.maxSessions ?? 10,
    createContext: () => ({ resolveSecret: async () => undefined, runtimeState: new Map() }),
    closeContext: async (context) => {
      closed.push(context);
    },
    onEnded: (session, reason) => {
      ended.push({ id: session.id, reason });
    },
    now: () => now
  });
  return {
    manager,
    closed,
    ended,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

const sessionInput = { clientId: "c1", toolsetId: "t1", protocolVersion: "2025-11-25" as const, clientInfo: {} };

const principalInput = (clientId = "c1", toolsetId = "t1") => ({
  principalScope: gatewayPrincipalScope({ clientId, toolsetId, userId: "u1" }),
  clientId,
  toolsetId,
  protocolVersion: "2026-07-28",
  clientInfo: { name: "modern", version: "1" }
});

describe("GatewaySessionManager principal states (MCP 2026-07-28)", () => {
  it("keys a principal scope by client, toolset and the user the token acts for", () => {
    expect(gatewayPrincipalScope({ clientId: "c1", toolsetId: "t1", userId: "u1" })).toBe("client:c1/toolset:t1/user:u1");
    expect(gatewayPrincipalScope({ clientId: "c1", toolsetId: "t1" })).toBe("client:c1/toolset:t1");
  });

  it("creates one state per caller, reuses it, and never hands it out as a session", async () => {
    const { manager, advance } = makeManager();
    const first = await manager.principal(principalInput());
    expect(first.created).toBe(true);
    expect(first.state).toMatchObject({ era: "modern", principalScope: "client:c1/toolset:t1/user:u1", clientId: "c1", toolsetId: "t1", initialized: true });
    advance(5_000);
    const again = await manager.principal({ ...principalInput(), clientInfo: { name: "modern", version: "2" } });
    expect(again.created).toBe(false);
    expect(again.state).toBe(first.state);
    expect(again.state.clientInfo).toEqual({ name: "modern", version: "2" });
    expect(again.state.lastSeenAt).toBe(first.state.createdAt + 5_000);
    // No request can name it: a session lookup by its id finds nothing.
    expect(manager.get(first.state.id)).toBeUndefined();
    const other = await manager.principal(principalInput("c2"));
    expect(other.state).not.toBe(first.state);
    const legacy = await manager.create(sessionInput);
    expect(manager.get(legacy.id)?.era).toBe("legacy");
  });

  it("shares the session cap, expires when idle, and ends on revoke like sessions", async () => {
    const { manager, closed, ended, advance } = makeManager({ maxSessions: 2, idleMs: 60_000 });
    const legacy = await manager.create(sessionInput);
    const { state } = await manager.principal(principalInput());
    state.inFlight.set("modern:x", { controller: new AbortController() });
    legacy.inFlight.set("number:1", { controller: new AbortController() });
    await expect(manager.principal(principalInput("c2"))).rejects.toBeInstanceOf(GatewaySessionLimitError);
    state.inFlight.clear();
    // The idle principal state is the one evicted for a new caller.
    const next = await manager.principal(principalInput("c2"));
    expect(next.created).toBe(true);
    expect(ended).toEqual([{ id: state.id, reason: "evicted" }]);
    expect(manager.principalState(principalInput().principalScope)).toBeUndefined();
    // Back again: a fresh state (a new idle window), not the evicted one.
    legacy.inFlight.clear();
    const back = await manager.principal(principalInput());
    expect(back.created).toBe(true);
    expect(back.state.id).not.toBe(state.id);
    expect(closed).toContain(state.mcpContext);

    advance(61_000);
    expect(await manager.sweepIdle()).toBeGreaterThanOrEqual(1);
    expect(manager.principalState(principalInput().principalScope)).toBeUndefined();

    const revoked = await manager.principal(principalInput("c3"));
    expect(await manager.endWhere((entry) => entry.clientId === "c3", "revoked")).toBe(1);
    expect(manager.principalState(revoked.state.principalScope!)).toBeUndefined();
  });

  it("does not create two states for one caller when two first requests race past a full cap", async () => {
    const { manager } = makeManager({ maxSessions: 1 });
    await manager.create(sessionInput);
    const [a, b] = await Promise.all([manager.principal(principalInput()), manager.principal(principalInput())]);
    expect(a.state).toBe(b.state);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(manager.size).toBe(1);
  });
});

describe("GatewaySessionManager", () => {
  it("closes idle sessions and their contexts, but keeps sessions with a request in flight", async () => {
    const { manager, closed, ended, advance } = makeManager({ idleMs: 60_000 });
    const idle = await manager.create(sessionInput);
    const busy = await manager.create(sessionInput);
    busy.inFlight.set("number:1", { controller: new AbortController() });
    advance(61_000);
    expect(await manager.sweepIdle()).toBe(1);
    expect(manager.get(idle.id)).toBeUndefined();
    expect(manager.get(busy.id)).toBeDefined();
    expect(closed).toEqual([idle.mcpContext]);
    expect(ended).toEqual([{ id: idle.id, reason: "idle" }]);
  });

  it("evicts the least recently used idle session at the cap, and refuses when every session is busy", async () => {
    const { manager, ended, advance } = makeManager({ maxSessions: 2 });
    const first = await manager.create(sessionInput);
    advance(10);
    const second = await manager.create(sessionInput);
    advance(10);
    manager.touch(first);
    const third = await manager.create(sessionInput);
    expect(manager.get(second.id)).toBeUndefined();
    expect(ended).toEqual([{ id: second.id, reason: "evicted" }]);

    first.inFlight.set("a", { controller: new AbortController() });
    third.inFlight.set("b", { controller: new AbortController() });
    await expect(manager.create(sessionInput)).rejects.toBeInstanceOf(GatewaySessionLimitError);
  });

  it("aborts in-flight requests when a session ends", async () => {
    const { manager } = makeManager();
    const session = await manager.create(sessionInput);
    const controller = new AbortController();
    session.inFlight.set("number:1", { controller });
    await manager.end(session.id, "deleted");
    expect(controller.signal.aborted).toBe(true);
    expect(manager.size).toBe(0);
  });
});

describe("MCP gateway protocol helpers", () => {
  it("negotiates supported versions and allows batches only in 2025-03-26", () => {
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2025-11-25");
    expect(versionAllowsBatches("2025-03-26")).toBe(true);
    expect(versionAllowsBatches("2025-11-25")).toBe(false);
    expect(versionAllowsBatches("2026-07-28")).toBe(false);
    // The gateway's initialize versions are the MCP SDK's legacy set.
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
  });

  it("classifies requests, notifications, responses and invalid messages", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, method: "ping" }).kind).toBe("request");
    expect(classifyMessage({ jsonrpc: "2.0", method: "notifications/initialized" }).kind).toBe("notification");
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, result: {} }).kind).toBe("response");
    expect(classifyMessage({ jsonrpc: "1.0", id: 1, method: "ping" })).toEqual({ kind: "invalid", id: 1, reason: "Not a JSON-RPC 2.0 message" });
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, method: "ping", params: [1] }).kind).toBe("invalid");
  });

  it("round-trips cursors and rejects foreign ones", () => {
    expect(decodeCursor(encodeCursor(200))).toBe(200);
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ o: -1 })).toString("base64url"))).toBeNull();
  });

  it("adds structured content only for object outputs", () => {
    expect(toolSuccess({ a: 1 })).toEqual({ content: [{ type: "text", text: "{\n  \"a\": 1\n}" }], structuredContent: { a: 1 } });
    expect(toolSuccess("plain")).toEqual({ content: [{ type: "text", text: "plain" }] });
  });
});

describe("MCP client policy subject", () => {
  const client = {
    id: "mcc_1",
    name: "IDE",
    tokenPrefix: "l2m_mcp_x",
    toolsetIds: [],
    role: "admin" as const,
    createdBy: "usr_1",
    createdByEmail: "a@example.com",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: "",
    rateLimit: null,
    allowedIps: [],
    certFingerprints: [],
    certSubject: null
  };

  it("caps the client's role at its creator's current role and falls back to viewer without a creator", async () => {
    expect(capRole("admin", "builder")).toBe("builder");
    expect(capRole("viewer", "admin")).toBe("viewer");
    const asBuilder = resolveMcpClientSubject({ getUserById: async () => ({ id: "usr_1", email: "a@example.com", role: "builder" }) }, client);
    expect(await asBuilder).toMatchObject({ role: "builder", source: "client", clientId: "mcc_1", clientName: "IDE" });
    expect((await resolveMcpClientSubject({ getUserById: async () => null }, client)).role).toBe("viewer");
  });
});

describe("12.2 — session label marks", () => {
  it("only grows, never collects trusted or invalid class names, and starts each call with the client's own user label", () => {
    const mark = emptySessionLabelMark();
    expect(sessionCallLabels(mark).labels).toEqual({ provenance: ["user"], dataClasses: [], source: "propagated" });
    expect(raiseSessionLabels(mark, { provenance: ["trusted", "user"], dataClasses: [] }, true, 5)).toBe(false);
    expect(mark.raisedAt).toBeNull();
    expect(raiseSessionLabels(mark, { provenance: ["untrusted_external"], dataClasses: ["email", "Not A Class!"] }, true, 7)).toBe(true);
    expect(mark.raisedAt).toBe(7);
    // A later, cleaner result never lowers it; only the first raise reports true.
    expect(raiseSessionLabels(mark, { provenance: ["user"], dataClasses: [] }, true, 9)).toBe(false);
    expect(raiseSessionLabels(mark, { provenance: ["sensitive"], dataClasses: [] }, true, 9)).toBe(false);
    expect(sessionLabelsView(mark)).toEqual({ provenance: ["user", "untrusted_external", "sensitive"], dataClasses: ["email"] });
    expect(sessionCallLabels(mark).labels.provenance).toEqual(["user", "untrusted_external", "sensitive"]);
  });

  it("counts a result returned while the toolset did not track as outside content once it does", () => {
    const mark = emptySessionLabelMark();
    expect(raiseSessionLabels(mark, { provenance: ["user"], dataClasses: [] }, false)).toBe(false);
    expect(mark.provenance.size).toBe(0);
    const first = sessionCallLabels(mark, 11);
    expect(first).toEqual({ labels: { provenance: ["user", "untrusted_external"], dataClasses: [], source: "propagated" }, raised: true });
    expect(sessionCallLabels(mark).raised).toBe(false);
  });

  it("keeps a mark per session, and it is gone when the session ends or expires", async () => {
    const { manager, advance } = makeManager({ idleMs: 60_000 });
    const a = await manager.create(sessionInput);
    const b = await manager.create(sessionInput);
    raiseSessionLabels(a.labels, { provenance: ["untrusted_external"], dataClasses: [] }, true);
    expect(sessionLabelsView(b.labels).provenance).toEqual([]);
    expect(manager.list((session) => session.clientId === "c1").map((session) => session.id)).toEqual([a.id, b.id]);
    advance(61_000);
    expect(await manager.sweepIdle()).toBe(2);
    expect(manager.get(a.id)).toBeUndefined();
    const fresh = await manager.create(sessionInput);
    expect(sessionLabelsView(fresh.labels)).toEqual({ provenance: [], dataClasses: [] });
    expect(await manager.end(fresh.id, "deleted")).toBe(true);
    expect(manager.list(() => true)).toEqual([]);
  });
});
