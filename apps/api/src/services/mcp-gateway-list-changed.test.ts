/**
 * G3b — the hub that tells watched `subscriptions/listen` streams about tool list changes: hints coalesce into one
 * check, only a changed fingerprint notifies, a gone scope ends its streams, a failed read sends nothing, the bus and a
 * reconnect hint, nothing runs while nothing is watched, and the admin routes that may change a tool list are known.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalClusterBus } from "./cluster-bus-local.js";
import {
  GATEWAY_TOOLS_CHANGED_MESSAGE,
  GatewayListChangedHub,
  isGatewayToolsChangedMessage,
  isToolListMutation,
  toolListFingerprint,
  type ToolListScopeState,
  type ToolListWatcher
} from "./mcp-gateway-list-changed.js";

const hubs: GatewayListChangedHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
  vi.useRealTimers();
});

function makeHub(options: { states?: Map<string, ToolListScopeState | Error>; checkMs?: number; bus?: LocalClusterBus } = {}) {
  const states = options.states ?? new Map<string, ToolListScopeState | Error>();
  const reads: string[] = [];
  const warnings: string[] = [];
  const hub = new GatewayListChangedHub({
    state: async (scope) => {
      reads.push(`${scope.toolsetId}/${scope.clientId}`);
      const state = states.get(`${scope.toolsetId}/${scope.clientId}`) ?? { kind: "gone" };
      if (state instanceof Error) throw state;
      return state;
    },
    checkMs: options.checkMs ?? 0,
    debounceMs: 20,
    ...(options.bus ? { bus: options.bus } : {}),
    logger: { warn: (_fields, message) => warnings.push(message) }
  });
  hubs.push(hub);
  return { hub, states, reads, warnings };
}

function watcher(toolsetId: string, clientId: string, fingerprint: string) {
  const events: string[] = [];
  const entry: ToolListWatcher = {
    scope: { toolsetId, clientId },
    fingerprint,
    onChanged: () => events.push("changed"),
    onGone: () => events.push("gone")
  };
  return { entry, events };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GatewayListChangedHub", () => {
  it("notifies only watchers whose fingerprint changed, once per change, with one read per scope", async () => {
    const { hub, states, reads } = makeHub();
    states.set("ts/c1", { kind: "list", fingerprint: "A" });
    states.set("ts/c2", { kind: "list", fingerprint: "B" });
    const first = watcher("ts", "c1", "A");
    const second = watcher("ts", "c1", "A");
    const other = watcher("ts", "c2", "B");
    for (const entry of [first, second, other]) hub.watch(entry.entry);

    await hub.check();
    expect([first.events, second.events, other.events]).toEqual([[], [], []]);
    expect(reads).toEqual(["ts/c1", "ts/c2"]);

    states.set("ts/c1", { kind: "list", fingerprint: "A2" });
    await hub.check();
    expect([first.events, second.events, other.events]).toEqual([["changed"], ["changed"], []]);
    expect(first.entry.fingerprint).toBe("A2");
    await hub.check();
    expect(first.events).toEqual(["changed"]);
  });

  it("coalesces hints into one check and drops them while nothing is watched", async () => {
    const { hub, states, reads } = makeHub();
    hub.hint();
    await tick(60);
    expect(reads).toHaveLength(0);
    expect(hub.generation).toBe(1);

    states.set("ts/c", { kind: "list", fingerprint: "A" });
    hub.watch(watcher("ts", "c", "A").entry);
    for (let i = 0; i < 5; i += 1) hub.hint();
    await tick(80);
    expect(reads).toEqual(["ts/c"]);
    expect(hub.generation).toBe(6);
  });

  it("ends the streams of a scope that is gone, and stops checking a scope nobody watches", async () => {
    const { hub, states, reads } = makeHub();
    states.set("ts/c", { kind: "list", fingerprint: "A" });
    const stream = watcher("ts", "c", "A");
    const unwatch = hub.watch(stream.entry);
    states.set("ts/c", { kind: "gone" });
    await hub.check();
    expect(stream.events).toEqual(["gone"]);
    unwatch();
    expect(hub.size).toBe(0);
    await hub.check();
    expect(reads).toHaveLength(1);
  });

  it("sends nothing when a read fails, and logs it", async () => {
    const { hub, states, warnings } = makeHub();
    states.set("ts/c", new Error("database is down"));
    const stream = watcher("ts", "c", "A");
    hub.watch(stream.entry);
    await hub.check();
    expect(stream.events).toEqual([]);
    expect(warnings).toEqual(["Could not check an MCP gateway tool list for changes"]);
  });

  it("runs a check asked for during a check once more after it", async () => {
    const { hub, states, reads } = makeHub();
    states.set("ts/c", { kind: "list", fingerprint: "A" });
    const stream = watcher("ts", "c", "A");
    hub.watch(stream.entry);
    const running = hub.check();
    states.set("ts/c", { kind: "list", fingerprint: "B" });
    const again = hub.check();
    await Promise.all([running, again]);
    expect(reads).toHaveLength(2);
    expect(stream.events).toEqual(["changed"]);
  });

  it("checks after a tools-changed message on the bus and after a resync, and ignores other messages", async () => {
    const bus = new LocalClusterBus("a");
    const { hub, states, reads } = makeHub({ bus });
    states.set("ts/c", { kind: "list", fingerprint: "B" });
    const stream = watcher("ts", "c", "A");
    hub.watch(stream.entry);
    await bus.publish("ctl", { t: "workflow_changed", id: "wf" });
    await bus.publish("ctl", { t: GATEWAY_TOOLS_CHANGED_MESSAGE, v: 99 });
    await tick(60);
    expect(reads).toHaveLength(0);
    await bus.publish("ctl", { t: GATEWAY_TOOLS_CHANGED_MESSAGE });
    await tick(60);
    expect(stream.events).toEqual(["changed"]);
    hub.stop();
    await bus.publish("ctl", { t: GATEWAY_TOOLS_CHANGED_MESSAGE });
    await tick(60);
    expect(reads).toHaveLength(1);
  });

  it("checks periodically only while a stream is watched", async () => {
    vi.useFakeTimers();
    const { hub, states, reads } = makeHub({ checkMs: 1_000 });
    states.set("ts/c", { kind: "list", fingerprint: "A" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toHaveLength(0);
    const unwatch = hub.watch(watcher("ts", "c", "A").entry);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(reads).toHaveLength(2);
    unwatch();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toHaveLength(2);
  });
});

describe("tool list change helpers", () => {
  it("fingerprints lists by content and order", () => {
    const a = { name: "a", inputSchema: { type: "object" } };
    const b = { name: "b", inputSchema: { type: "object" } };
    expect(toolListFingerprint([a, b])).toBe(toolListFingerprint([{ ...a }, { ...b }]));
    expect(toolListFingerprint([a, b])).not.toBe(toolListFingerprint([b, a]));
    expect(toolListFingerprint([a])).not.toBe(toolListFingerprint([{ ...a, description: "x" }]));
  });

  it("recognises the bus message, up to this build's version", () => {
    expect(isGatewayToolsChangedMessage({ v: 1, t: GATEWAY_TOOLS_CHANGED_MESSAGE })).toBe(true);
    expect(isGatewayToolsChangedMessage({ v: 2, t: GATEWAY_TOOLS_CHANGED_MESSAGE })).toBe(false);
    expect(isGatewayToolsChangedMessage({ v: 1, t: "cancel" })).toBe(false);
  });

  it("knows which successful admin requests may change a tool list", () => {
    expect(isToolListMutation("PUT", "/api/mcp/toolsets/:id", 200)).toBe(true);
    expect(isToolListMutation("DELETE", "/api/mcp/toolsets/:id/members/:memberId", 200)).toBe(true);
    expect(isToolListMutation("POST", "/api/mcp/policies", 201)).toBe(true);
    expect(isToolListMutation("PUT", "/api/mcp/servers/:id/tools/:toolName/classification", 200)).toBe(true);
    expect(isToolListMutation("POST", "/api/mcp/clients/:id/revoke", 200)).toBe(true);
    expect(isToolListMutation("PUT", "/api/data-destinations/:id", 200)).toBe(true);
    // Reads, failures, simulations and other routes do not.
    expect(isToolListMutation("GET", "/api/mcp/toolsets", 200)).toBe(false);
    expect(isToolListMutation("PUT", "/api/mcp/toolsets/:id", 400)).toBe(false);
    expect(isToolListMutation("POST", "/api/mcp/policies/simulate", 200)).toBe(false);
    expect(isToolListMutation("POST", "/mcp/:toolset", 200)).toBe(false);
    expect(isToolListMutation("POST", "/api/mcp/toolsetsx", 200)).toBe(false);
    expect(isToolListMutation("POST", undefined, 200)).toBe(false);
  });
});
