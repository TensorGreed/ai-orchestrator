import { describe, expect, it } from "vitest";
import type { MCPExecutionContext } from "@ai-orchestrator/mcp-sdk";
import { GatewaySessionLimitError, GatewaySessionManager, type GatewaySessionEndReason } from "./mcp-gateway-sessions.js";
import {
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
    createdAt: ""
  };

  it("caps the client's role at its creator's current role and falls back to viewer without a creator", async () => {
    expect(capRole("admin", "builder")).toBe("builder");
    expect(capRole("viewer", "admin")).toBe("viewer");
    const asBuilder = resolveMcpClientSubject({ getUserById: async () => ({ id: "usr_1", email: "a@example.com", role: "builder" }) }, client);
    expect(await asBuilder).toMatchObject({ role: "builder", source: "client", clientId: "mcc_1", clientName: "IDE" });
    expect((await resolveMcpClientSubject({ getUserById: async () => null }, client)).role).toBe("viewer");
  });
});
