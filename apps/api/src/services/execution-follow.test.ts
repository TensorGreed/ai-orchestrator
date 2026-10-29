import { describe, expect, it } from "vitest";
import { followExecution } from "./execution-follow.js";
import type { RunEventName, RunRelay, RunRelayEnd } from "./run-event-relay.js";

/** A relay the test drives: events through `emit`, the end through `end`. */
function fakeRelay() {
  let onEvent: (name: RunEventName, payload: Record<string, unknown>) => void = () => undefined;
  let resolveEnd: (end: RunRelayEnd) => void = () => undefined;
  const state = { closed: 0, checked: 0, waited: false };
  const relay: RunRelay = {
    ended: () => {
      state.waited = true;
      return new Promise<RunRelayEnd>((resolve) => {
        resolveEnd = resolve;
      });
    },
    check: () => void (state.checked += 1),
    close: () => {
      state.closed += 1;
      resolveEnd({ kind: "closed" } as RunRelayEnd);
    }
  };
  return {
    relay,
    state,
    attach: (handler: typeof onEvent) => (onEvent = handler),
    emit: (name: RunEventName, payload: Record<string, unknown>) => onEvent(name, payload),
    end: (end: RunRelayEnd) => resolveEnd(end)
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("followExecution", () => {
  it("relays only the elicitations the viewer may see, keeping the order of every event", async () => {
    const fake = fakeRelay();
    const sent: Array<[string, unknown]> = [];
    let releaseCheck: (visible: boolean) => void = () => undefined;
    const checks: string[] = [];
    const follower = followExecution({
      open: async (onEvent) => {
        fake.attach(onEvent);
        return fake.relay;
      },
      readExecution: async () => ({ id: "run-1", status: "running" }),
      elicitationVisible: (id) => {
        checks.push(id);
        if (id === "mine") return new Promise<boolean>((resolve) => (releaseCheck = resolve));
        return Promise.resolve(false);
      },
      send: (event, payload) => void sent.push([event, payload]),
      waitMs: 1_000
    });
    await flush();
    fake.emit("node_start", { nodeId: "a" });
    fake.emit("mcp_elicitation", { phase: "created", elicitation: { id: "theirs" } });
    fake.emit("mcp_elicitation", { phase: "created", elicitation: { id: "mine" } });
    // Waits for the pending check, so it cannot overtake the elicitation before it.
    fake.emit("node_complete", { nodeId: "a" });
    fake.emit("mcp_elicitation", { phase: "settled", elicitation: { id: "mine" } });
    fake.emit("mcp_elicitation", { phase: "created", elicitation: {} });
    await flush();
    expect(sent.map(([event]) => event)).toEqual(["execution", "node_start"]);
    releaseCheck(true);
    await flush();
    fake.end({ kind: "result", result: { status: "success" } } as RunRelayEnd);
    await follower.done;
    expect(sent.map(([event, payload]) => (event === "mcp_elicitation" ? `${event}:${(payload as { phase: string }).phase}` : event))).toEqual([
      "execution",
      "node_start",
      "mcp_elicitation:created",
      "node_complete",
      "mcp_elicitation:settled",
      "result"
    ]);
    // One check per elicitation; an event without an id is never shown.
    expect(checks).toEqual(["theirs", "mine"]);
    expect(fake.state.closed).toBe(1);
  });

  it("a client gone while the relay opens releases it at once and sends nothing", async () => {
    const fake = fakeRelay();
    const sent: string[] = [];
    let opened: (relay: RunRelay) => void = () => undefined;
    let reads = 0;
    const follower = followExecution({
      open: () => new Promise<RunRelay>((resolve) => (opened = resolve)),
      readExecution: async () => {
        reads += 1;
        return null;
      },
      elicitationVisible: async () => true,
      send: (event) => void sent.push(event),
      waitMs: 60_000
    });
    follower.close();
    opened(fake.relay);
    await follower.done;
    expect(fake.state.closed).toBe(1);
    expect(fake.state.waited).toBe(false);
    expect(reads).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a client gone while it waits releases the relay, and a settled run is checked at once", async () => {
    const fake = fakeRelay();
    const sent: string[] = [];
    const follower = followExecution({
      open: async () => fake.relay,
      readExecution: async () => ({ id: "run-2", status: "success", completedAt: "c" }),
      elicitationVisible: async () => true,
      send: (event) => void sent.push(event),
      waitMs: 60_000
    });
    await flush();
    expect(fake.state.checked).toBe(1);
    follower.close();
    await follower.done;
    expect(fake.state.closed).toBe(1);
    expect(sent).toEqual(["execution"]);
  });
});
