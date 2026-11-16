/**
 * 12.7 — content rule events on log streams: opt-in per destination (`rule_events`), never implied by an empty
 * category list; queued, never sent inline; a full buffer drops rule events before audit events; GuardService hands
 * written rows on without waiting, skips eval runs and withholds evidence for runs started from sensitive content.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuardVerdictEvent } from "@ai-orchestrator/workflow-engine";
import type { GuardEventInsert } from "../db/database";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import { GuardService } from "./guard-service.js";
import { LogStreamingService, type LogStreamEvent } from "./log-streaming-service.js";
import { SecretService } from "./secret-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(options: { bufferSize?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-rule-streams-"));
  const store: Store = await openTestStore(path.join(dir, "db.sqlite"));
  await store.ensureDefaultProject();
  const key = crypto.randomBytes(32).toString("base64");
  const service = new LogStreamingService(store, key, { retryMaxAttempts: 1, ...(options.bufferSize ? { bufferSize: options.bufferSize } : {}) });
  const sent: Array<{ host: string; event: LogStreamEvent }> = [];
  service.registerAdapter({
    type: "syslog",
    async send(event, config) {
      sent.push({ host: String(config.host), event });
    }
  });
  cleanups.push(async () => {
    await service.stop();
    try {
      await store.close();
    } catch {
      // Already closed.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const destination = async (host: string, categories: string[]) =>
    await service.createDestination({ name: host, type: "syslog", categories, config: { host, port: 514 } });
  return { store, service, sent, destination, key };
}

function row(overrides: Partial<GuardEventInsert> = {}): GuardEventInsert {
  return {
    id: crypto.randomUUID(),
    verdictId: "vd-1",
    executionId: "exec-1",
    workflowId: "wf-1",
    projectId: "default",
    nodeId: "guard",
    placement: "node",
    iteration: null,
    toolName: null,
    channel: "prompt",
    detectorId: "dlp.patterns",
    category: "pii",
    dataClass: "email",
    score: 0.9,
    requestedAction: "block",
    effectiveAction: "block",
    verdictAction: "block",
    shadow: false,
    evidence: [{ evidence: "m***@e******.org", spans: [{ start: 0, end: 10 }], message: "Email address" }],
    profileId: "default",
    profileVersion: 1,
    profileHash: "h",
    latencyMs: 1,
    budgetExceeded: false,
    skippedDetectors: [],
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

const audit = { category: "workflow" as const, eventType: "workflow.update", action: "update", outcome: "success" as const };

describe("rule events on log streams", () => {
  it("only destinations that list rule_events receive them; an empty list keeps sending audit events only", async () => {
    const { service, sent, destination } = await setup();
    await destination("audit-only", []);
    await destination("rules-only", ["rule_events"]);
    await destination("both", ["*", "rule_events"]);
    await destination("workflow-and-rules", ["workflow", "rule_events"]);
    await destination("auth", ["auth"]);

    await service.dispatchRuleEvents([row()]);
    await service.dispatchAudit(audit);
    await service.flush();

    const got = (host: string) => sent.filter((entry) => entry.host === host).map((entry) => entry.event.category).sort();
    expect(got("audit-only")).toEqual(["workflow"]);
    expect(got("rules-only")).toEqual(["rule_events"]);
    expect(got("both")).toEqual(["rule_events", "workflow"]);
    expect(got("workflow-and-rules")).toEqual(["rule_events", "workflow"]);
    expect(got("auth")).toEqual([]);
  });

  it("a flush of an empty queue does not stop later flushes from sending", async () => {
    const { service, sent, destination } = await setup();
    await destination("audit-only", []);
    await service.flush();
    await service.dispatchAudit(audit);
    await service.flush();
    expect(sent.map((entry) => entry.event.eventType)).toEqual(["workflow.update"]);
  });

  it("leaves out clean checks below the destination's minimum level", async () => {
    const { service, sent } = await setup();
    await service.createDestination({ name: "info", type: "syslog", categories: ["rule_events"], config: { host: "info", port: 514 } });
    await service.createDestination({ name: "debug", type: "syslog", categories: ["rule_events"], minLevel: "debug", config: { host: "debug", port: 514 } });
    await service.dispatchRuleEvents([row({ detectorId: null, effectiveAction: "allow", requestedAction: "allow", verdictAction: "allow", evidence: [] })]);
    await service.flush();
    expect(sent.map((entry) => entry.host)).toEqual(["debug"]);
  });

  it("queues nothing when no destination opted in", async () => {
    const { service, sent, destination } = await setup();
    await destination("audit-only", []);
    await service.dispatchRuleEvents([row()]);
    await service.flush();
    expect(sent).toEqual([]);
  });

  it("a full buffer drops rule events before audit events", async () => {
    const { service, sent, destination } = await setup({ bufferSize: 3 });
    await destination("both", ["*", "rule_events"]);
    await service.dispatchAudit({ ...audit, eventType: "a1" });
    await service.dispatchRuleEvents([row({ id: "r1" }), row({ id: "r2" })]);
    // Full: an audit event pushes out the oldest rule event, a rule event arriving at audit events only is dropped.
    await service.dispatchAudit({ ...audit, eventType: "a2" });
    await service.dispatchAudit({ ...audit, eventType: "a3" });
    await service.dispatchRuleEvents([row({ id: "r3" })]);
    await service.flush();
    expect(sent.map((entry) => entry.event.eventType)).toEqual(["a1", "a2", "a3"]);
  });

  it("retries a failed send on the next flush, and keeps rule event evidence out of the delivery history", async () => {
    const { service, store, destination } = await setup();
    const attempts: string[] = [];
    service.registerAdapter({
      type: "syslog",
      async send(_event, config) {
        attempts.push(String(config.host));
        if (config.host === "down") throw new Error("connection refused");
      }
    });
    const down = await destination("down", ["rule_events"]);
    await destination("up", ["rule_events"]);
    await service.dispatchRuleEvents([row()]);
    await service.flush();
    // retryMaxAttempts is 1 here: the failure is final and recorded without the evidence.
    expect(attempts.sort()).toEqual(["down", "up"]);
    const history = await store.listLogStreamEvents({ destinationId: down.id, limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("failed");
    const payload = JSON.stringify(history[0]!.payload);
    expect(payload).toContain("l2m.rule_event");
    expect(payload).not.toContain("m***@");
  });

  it("puts a failed send behind the other destinations' sends until the next flush", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-rule-retry-"));
    const store: Store = await openTestStore(path.join(dir, "db.sqlite"));
    const service = new LogStreamingService(store, crypto.randomBytes(32).toString("base64"), { retryMaxAttempts: 3 });
    cleanups.push(async () => {
      await service.stop();
      try {
        await store.close();
      } catch {
        // Already closed.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const attempts: string[] = [];
    service.registerAdapter({
      type: "syslog",
      async send(_event, config) {
        attempts.push(String(config.host));
        if (config.host === "down") throw new Error("connection refused");
      }
    });
    for (const host of ["down", "up"]) await service.createDestination({ name: host, type: "syslog", categories: ["rule_events"], config: { host, port: 514 } });
    await service.dispatchRuleEvents([row()]);
    await service.flush();
    expect(attempts.sort()).toEqual(["down", "up"]);
    await service.flush();
    expect(attempts.filter((host) => host === "down")).toHaveLength(2);
  });

  it("queues without sending: a destination that hangs does not hold up the caller", async () => {
    const { service, destination } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let sends = 0;
    service.registerAdapter({
      type: "syslog",
      send: async () => {
        sends += 1;
        await gate;
      }
    });
    await destination("stuck", ["rule_events"]);
    const started = Date.now();
    await service.dispatchRuleEvents([row(), row()]);
    expect(Date.now() - started).toBeLessThan(1000);
    const draining = service.flush();
    try {
      // The first send starts after the destination is read from the store (slower on Postgres), then hangs.
      await vi.waitFor(() => expect(sends).toBe(1), { timeout: 5000 });
      // Still queued behind the stuck send, and the caller already returned.
      const queuedAt = Date.now();
      await service.dispatchRuleEvents([row()]);
      expect(Date.now() - queuedAt).toBeLessThan(1000);
      expect(sends).toBe(1);
    } finally {
      release();
    }
    await draining;
    expect(sends).toBe(3);
  });
});

describe("GuardService and the rule event stream", () => {
  function verdict(executionId: string): GuardVerdictEvent {
    return {
      executionId,
      workflowId: "",
      nodeId: "send_email",
      placement: "gateway",
      channel: "tool_input",
      toolName: "send_email",
      profile: { profileId: "default", version: 1, hash: "h" },
      verdict: {
        action: "block",
        blocked: true,
        channel: "tool_input",
        transformed: false,
        findings: [{ detectorId: "dlp.patterns", category: "pii", dataClass: "email", score: 1, evidence: "m***@e******.org", spans: [{ start: 0, end: 5 }], message: "Email address" }],
        actions: [{ detectorId: "dlp.patterns", category: "pii", dataClass: "email", score: 1, requested: "block", effective: "block", shadow: false }],
        shadowAction: "allow",
        protectedCount: 0,
        timings: { totalMs: 2, detectors: [] },
        budget: { limitMs: 100, exceeded: false, policy: "fail_closed", skippedDetectors: [] },
        profile: { id: "default", version: "1", hash: "h" }
      }
    } as unknown as GuardVerdictEvent;
  }

  async function guardWith(store: Store, key: string) {
    const guard = new GuardService(store, new SecretService(store, key), { autoApply: false });
    const streamed: Array<{ rows: GuardEventInsert[]; withholdEvidence: boolean }> = [];
    guard.setEventStream(async (rows, options) => {
      streamed.push({ rows, withholdEvidence: options.withholdEvidence });
    });
    return { guard, streamed };
  }

  it("hands written rows on after the write, for gateway checks too, and leaves eval runs out", async () => {
    const { store, key } = await setup();
    const { guard, streamed } = await guardWith(store, key);
    await guard.recordVerdict(verdict("mcpgw_1"), { executionId: "mcpgw_1", workflowId: "", projectId: null });
    await guard.recordVerdict(verdict("aigw_1"), { executionId: "aigw_1", workflowId: "", projectId: "default", sensitiveInput: true });
    await guard.recordVerdict(verdict("eval-1"), { executionId: "eval-1", workflowId: "wf", projectId: "default", runSource: "eval" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(streamed.map((entry) => [entry.rows[0]!.executionId, entry.withholdEvidence])).toEqual([
      ["mcpgw_1", false],
      ["aigw_1", true]
    ]);
    expect((await store.listGuardEvents({})).total).toBe(3);
  });

  it("a stream that fails or never settles does not slow down or fail the check", async () => {
    const { store, key } = await setup();
    const guard = new GuardService(store, new SecretService(store, key), { autoApply: false });
    guard.setEventStream(async () => await new Promise<void>(() => {}));
    const started = Date.now();
    await guard.recordVerdict(verdict("exec-a"), { executionId: "exec-a", workflowId: "wf", projectId: "default" });
    guard.setEventStream(async () => {
      throw new Error("destination down");
    });
    await guard.recordVerdict(verdict("exec-b"), { executionId: "exec-b", workflowId: "wf", projectId: "default" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await store.listGuardEvents({})).total).toBe(2);
  });
});
