/**
 * Phase 13.1 — elicitations in cluster mode, with two services on one store and one in-process bus standing in for two
 * instances: an answer on the instance that does not hold the request is forwarded (sealed) and settled by the holder;
 * a stopped holder's request expires when answered and on the sweep; a starting instance leaves a live replica's
 * request alone; a forged bus message changes nothing. Without cluster options the service is the single-instance one.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { McpElicitationRecord } from "../db/database.js";
import type { AuditEventInput } from "./audit-service.js";
import { LocalClusterBus } from "./cluster-bus-local.js";
import { ELICITATION_ANSWER_MESSAGE, ELICITATION_HOLDER_GONE_REASON, McpElicitationAnswerError, McpElicitationService } from "./mcp-elicitation-service.js";
import { SecretService } from "./secret-service.js";
import { createTestStore, type TestStore } from "../test-support/test-store.js";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const question = {
  request: { message: "Which region?", requestedSchema: { type: "object" as const, properties: { region: { type: "string" as const, enum: ["eu", "us"] } } } },
  workflowId: "wf",
  nodeId: "n",
  serverId: "mock-mcp",
  toolName: "ask",
  triggerType: "manual",
  createdBy: "u-owner"
};

const owner = { userId: "u-owner", email: "owner@example.com", role: "builder" };

describe("MCP elicitations across instances", () => {
  let testStore: TestStore | undefined;
  const services: McpElicitationService[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.stop();
    await testStore?.cleanup();
    testStore = undefined;
  });

  async function setup(options: { live?: Set<string> } = {}) {
    testStore = await createTestStore();
    const store = testStore.store;
    const secrets = new SecretService(store, KEY);
    const bus = new LocalClusterBus("shared");
    const live = options.live ?? new Set(["a", "b"]);
    const audits: Array<{ instance: string; event: AuditEventInput }> = [];
    const make = (instanceId: string) => {
      const service = new McpElicitationService(store, {
        timeoutMs: 60_000,
        audit: (event) => {
          audits.push({ instance: instanceId, event });
        },
        cluster: { instanceId, bus, liveInstanceIds: async () => live, sealer: secrets, settleWaitMs: 3_000, settlePollMs: 10 }
      });
      services.push(service);
      return service;
    };
    return { store, bus, live, audits, a: make("a"), b: make("b"), secrets };
  }

  async function pendingOf(store: TestStore["store"], executionId: string): Promise<McpElicitationRecord> {
    return await until(async () => (await store.listMcpElicitations({ status: "pending", executionId }))[0], "the request to wait");
  }

  it("forwards an answer to the holder, which settles it and resumes the tool call", async () => {
    const { store, a, b, audits } = await setup();
    const asked = a.ask({ ...question, executionId: "exec-1" });
    const pending = await pendingOf(store, "exec-1");
    expect(pending.holderId).toBe("a");
    expect(a.isPendingHere(pending.id)).toBe(true);
    expect(b.isPendingHere(pending.id)).toBe(false);

    // Validation happens where the answer lands.
    await expect(b.answer(pending.id, { action: "accept", content: { region: "mars" } }, owner)).rejects.toMatchObject({ statusCode: 400 });
    await expect(b.answer(pending.id, { action: "accept", content: { region: "eu" } }, { userId: "someone", email: "s@example.com", role: "builder" })).rejects.toMatchObject({ statusCode: 403 });

    const settled = await b.answer(pending.id, { action: "accept", content: { region: "eu" } }, owner);
    expect(settled).toMatchObject({ id: pending.id, status: "accepted", answeredBy: owner.email });
    expect(await asked).toMatchObject({ action: "accept", content: { region: "eu" }, source: "user" });
    // The holder audits the answer, with who gave it, and never the content.
    const accepted = audits.filter((entry) => entry.event.eventType === "mcp_elicitation.accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ instance: "a", event: { actor: { userId: owner.userId, email: owner.email } } });
    expect(JSON.stringify(accepted[0]!.event.metadata)).not.toContain("\"eu\"");
  });

  it("expires the request when its holder stopped, instead of forwarding the answer", async () => {
    const { store, a, b, live } = await setup();
    void a.ask({ ...question, executionId: "exec-2" });
    const pending = await pendingOf(store, "exec-2");
    live.delete("a");
    const refused = await b.answer(pending.id, { action: "decline" }, owner).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(McpElicitationAnswerError);
    expect(refused).toMatchObject({ statusCode: 409 });
    expect(await store.getMcpElicitation(pending.id)).toMatchObject({ status: "expired", reason: ELICITATION_HOLDER_GONE_REASON });
  });

  it("the periodic sweep expires only the requests of stopped holders", async () => {
    const { store, a, b, live } = await setup();
    void a.ask({ ...question, executionId: "exec-live" });
    void b.ask({ ...question, executionId: "exec-own" });
    const fromA = await pendingOf(store, "exec-live");
    const fromB = await pendingOf(store, "exec-own");
    expect(await b.expireOrphaned()).toBe(0);
    live.delete("a");
    expect(await b.expireOrphaned()).toBe(1);
    expect((await store.getMcpElicitation(fromA.id))?.status).toBe("expired");
    expect((await store.getMcpElicitation(fromB.id))?.status).toBe("pending");
  });

  it("a starting instance expires unheld, its own and stopped holders' requests, never a live replica's", async () => {
    const { store, a, live } = await setup({ live: new Set(["a", "b", "c"]) });
    void a.ask({ ...question, executionId: "exec-a" });
    const held = await pendingOf(store, "exec-a");
    const row = (id: string, holderId: string | null) =>
      store.createMcpElicitation({
        id,
        executionId: `exec-${id}`,
        workflowId: "wf",
        nodeId: "n",
        serverId: "s",
        toolName: "t",
        message: "m",
        requestedSchema: { type: "object", properties: {} },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdBy: null,
        triggerType: "manual",
        ...(holderId ? { holderId } : {})
      });
    await row("unheld", null);
    await row("mine", "c");
    await row("dead", "gone");
    await row("live-c", "b");
    // "c" starts (restarting under its fixed id): its own old row is stale, "a" and "b" are live.
    live.add("c");
    const starting = new McpElicitationService(store, {
      timeoutMs: 60_000,
      audit: () => undefined,
      cluster: { instanceId: "c", bus: new LocalClusterBus("c"), liveInstanceIds: async () => live, sealer: new SecretService(store, KEY) }
    });
    services.push(starting);
    expect(await starting.expireStale()).toBe(3);
    const status = async (id: string) => (await store.getMcpElicitation(id))?.status;
    expect(await status("unheld")).toBe("expired");
    expect(await status("mine")).toBe("expired");
    expect(await status("dead")).toBe("expired");
    expect(await status("live-c")).toBe("pending");
    expect(await status(held.id)).toBe("pending");
  });

  it("ignores an answer on the bus that is not sealed with the master key", async () => {
    const { store, a, bus, secrets } = await setup();
    void a.ask({ ...question, executionId: "exec-3" });
    const pending = await pendingOf(store, "exec-3");
    const forged = JSON.stringify({ action: "accept", content: { region: "us" }, actor: { userId: "x", email: "x@example.com" } });
    await bus.publish("ctl", { t: ELICITATION_ANSWER_MESSAGE, id: pending.id, sealed: forged });
    // Sealed for another request: the seal binds the id.
    await bus.publish("ctl", { t: ELICITATION_ANSWER_MESSAGE, id: pending.id, sealed: secrets.sealValue(`${ELICITATION_ANSWER_MESSAGE}:elc_other`, forged) });
    // A valid one after them is the first to count, so the earlier two were ignored, not merely slow.
    await bus.publish("ctl", { t: ELICITATION_ANSWER_MESSAGE, id: pending.id, sealed: secrets.sealValue(`${ELICITATION_ANSWER_MESSAGE}:${pending.id}`, JSON.stringify({ action: "decline", actor: { userId: "y", email: "y@example.com" } })) });
    const settled = await until(async () => {
      const current = await store.getMcpElicitation(pending.id);
      return current?.status !== "pending" ? current : undefined;
    }, "the valid answer to settle the request");
    expect(settled).toMatchObject({ status: "declined", answeredBy: "y@example.com" });
  });

  it("without cluster options an answer elsewhere is refused as before", async () => {
    testStore = await createTestStore();
    const holder = new McpElicitationService(testStore.store, { timeoutMs: 60_000, audit: () => undefined });
    const other = new McpElicitationService(testStore.store, { timeoutMs: 60_000, audit: () => undefined });
    services.push(holder, other);
    void holder.ask({ ...question, executionId: "exec-4" });
    const pending = await pendingOf(testStore.store, "exec-4");
    expect(pending.holderId).toBeUndefined();
    await expect(other.answer(pending.id, { action: "decline" }, owner)).rejects.toMatchObject({ statusCode: 409 });
    // And a fresh start expires every pending row it does not hold.
    expect(await other.expireStale()).toBe(1);
  });
});
