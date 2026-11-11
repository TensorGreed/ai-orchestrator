/**
 * 13.3 — the legal-hold service: what each scope holds, the audit rows and the `data.legal_hold_changed` alert (sent
 * only to channels that pick it, never to environment channels by default), and that a subject hold never records the
 * value it was looked up by.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGAL_HOLD_CHANGED_EVENT, LEGAL_HOLD_NOTIFICATION_OPTIONS, type ReplayFindSubjectResult } from "@ai-orchestrator/shared";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import type { AuditEventInput } from "./audit-service.js";
import { LegalHoldRequestError, LegalHoldService } from "./legal-hold-service.js";
import { NotificationService, type NotificationEvent } from "./notification-service.js";

let store: Store;
let dir: string;
const actor = { userId: "u1", email: "counsel@example.com" };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-legal-hold-"));
  store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function service(overrides: Partial<ConstructorParameters<typeof LegalHoldService>[0]> = {}) {
  const audits: Array<Omit<AuditEventInput, "actor">> = [];
  const notes: NotificationEvent[] = [];
  const svc = new LegalHoldService({
    store,
    audit: async (event) => {
      audits.push(event);
    },
    notify: async (event) => {
      notes.push(event);
    },
    now: () => new Date("2026-11-10T12:00:00.000Z"),
    ...overrides
  });
  return { svc, audits, notes };
}

const base = { name: "Acme v. Doe", reason: "Litigation hold" };

describe("LegalHoldService", () => {
  it("places a project hold: audited and announced, then released with a reason", async () => {
    const { svc, audits, notes } = service();
    await store.upsertProject({ id: "p1", name: "P1" });
    const hold = await svc.place({ ...base, scopeType: "project", scopeId: "p1", matterRef: " M-7 " }, actor);
    expect(hold).toMatchObject({ scopeType: "project", scopeId: "p1", status: "active", matterRef: "M-7", createdBy: "counsel@example.com" });
    expect(audits[0]).toMatchObject({ category: "data_protection", eventType: "legal_hold.placed", resourceId: hold.id, projectId: "p1" });
    expect(notes[0]).toMatchObject({ type: LEGAL_HOLD_CHANGED_EVENT, legalHold: { change: "placed", name: "Acme v. Doe", scopeType: "project", scopeId: "p1" } });

    const released = await svc.release(hold.id, "Settled", actor);
    expect(released).toMatchObject({ changed: true, hold: { status: "released", releaseReason: "Settled", releasedBy: "counsel@example.com" } });
    expect(audits[1]).toMatchObject({ eventType: "legal_hold.released", metadata: expect.objectContaining({ releaseReason: "Settled" }) });
    expect(notes[1]?.legalHold?.change).toBe("released");
    // A second release changes nothing and announces nothing.
    expect((await svc.release(hold.id, "again", actor))?.changed).toBe(false);
    expect(audits).toHaveLength(2);
    expect(await svc.release("missing", "r", actor)).toBeNull();
  });

  it("refuses a project or workflow that does not exist, and a runs hold naming no existing run", async () => {
    const { svc, audits } = service();
    await expect(svc.place({ ...base, scopeType: "project", scopeId: "nope" }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(svc.place({ ...base, scopeType: "workflow", scopeId: "nope" }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(svc.place({ ...base, scopeType: "runs", executionIds: ["nope"] }, actor)).rejects.toBeInstanceOf(LegalHoldRequestError);
    expect(audits).toHaveLength(0);
  });

  it("a runs hold names the runs that exist and says how many did not", async () => {
    const { svc, audits } = service();
    await store.saveExecutionHistory({ id: "run-1", workflowId: "wf", status: "success", startedAt: "2026-01-01T00:00:00.000Z" });
    const hold = await svc.place({ ...base, scopeType: "runs", executionIds: ["run-1", "run-1", "ghost"] }, actor);
    expect(hold).toMatchObject({ scopeType: "runs", scopeId: hold.id, itemCount: 1 });
    expect(audits[0]?.metadata).toMatchObject({ runs: 1, missingRuns: 1 });
    expect((await svc.on({ executionId: "run-1" })).map((h) => h.id)).toEqual([hold.id]);
    expect(await svc.on({ executionId: "run-2" })).toEqual([]);
  });

  it("a subject hold holds the rows the lookup finds, and never records the value", async () => {
    const value = "jane.doe@example.com";
    const findSubject = vi.fn(async (): Promise<ReplayFindSubjectResult> => ({
      dataClass: "email",
      classesTried: ["email"],
      callingCode: null,
      matches: [
        { kind: "execution", id: "run-9", workflowId: "wf", projectId: "default", name: "r", status: null, matchedAs: ["raw"], fields: ["input"], hits: [], certainty: "exact" },
        { kind: "recording", id: "rec-9", workflowId: "wf", projectId: "default", name: "g", status: "golden", matchedAs: ["raw"], fields: ["input"], hits: [], certainty: "exact" }
      ],
      counts: { recording: 1, fixture: 0, eval_result: 0, execution: 1, cassette: 0 },
      searched: { recording: 1, fixture: 0, eval_result: 0, execution: 1, cassette: 0 },
      covered: [],
      notCovered: []
    }));
    const { svc, audits, notes } = service({ findSubject });
    const hold = await svc.place({ ...base, scopeType: "subject", subject: { value } }, actor);
    expect(findSubject).toHaveBeenCalledWith({ value });
    expect(hold).toMatchObject({ scopeType: "subject", scopeId: hold.id, itemCount: 2 });
    expect((await store.listLegalHoldItems(hold.id, { offset: 0, limit: 10 })).items.map((i) => `${i.kind}:${i.rowId}`).sort()).toEqual([
      "execution:run-9",
      "recording:rec-9"
    ]);
    const stored = JSON.stringify([await store.getLegalHold(hold.id), audits, notes]);
    expect(stored).not.toContain(value);
    expect(stored).not.toContain("jane");
  });

  it("a subject hold the lookup finds nothing for, or with no lookup, is refused", async () => {
    const none = service({
      findSubject: async () => ({ dataClass: null, classesTried: [], callingCode: null, matches: [], counts: {} as never, searched: {} as never, covered: [], notCovered: [] })
    });
    await expect(none.svc.place({ ...base, scopeType: "subject", subject: { value: "nobody@example.com" } }, actor)).rejects.toMatchObject({ status: 400 });
    const unavailable = service();
    await expect(unavailable.svc.place({ ...base, scopeType: "subject", subject: { value: "x@example.com" } }, actor)).rejects.toMatchObject({ status: 503 });
  });

  it("a failed notification does not fail the hold", async () => {
    const warn = vi.fn();
    const { svc } = service({ notify: async () => Promise.reject(new Error("smtp down")), logger: { warn } });
    await store.upsertProject({ id: "p2", name: "P2" });
    expect((await svc.place({ ...base, scopeType: "project", scopeId: "p2" }, actor)).status).toBe("active");
    expect(warn).toHaveBeenCalled();
  });
});

describe("data.legal_hold_changed alerts", () => {
  it("reach only a stored channel that picked the event, never the environment channels; they name the hold, never items", async () => {
    const sent: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      return new Response("ok", { status: 200 });
    });
    const config = parseConfig({ NOTIFICATIONS_ENABLED: "true", NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.test/env" });
    const notifications = new NotificationService(config, () => [
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/picked" }, events: [LEGAL_HOLD_CHANGED_EVENT] },
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/other" }, events: ["execution.failure"] }
    ]);
    await notifications.notify({
      type: LEGAL_HOLD_CHANGED_EVENT,
      workflowId: "",
      workflowName: "",
      timestamp: "2026-11-10T12:00:00.000Z",
      legalHold: { change: "placed", id: "lh_1", name: "Acme v. Doe", scopeType: "subject", scopeId: null, itemCount: 4, by: "counsel@example.com" }
    });
    expect(sent.map((entry) => entry.url)).toEqual(["https://hooks.slack.test/picked"]);
    const text = (JSON.parse(sent[0]!.body) as { text: string }).text;
    expect(text).toMatch(/Legal hold placed/);
    expect(text).toMatch(/Acme v. Doe/);
    expect(text).toMatch(/4 rows/);
    expect(LEGAL_HOLD_NOTIFICATION_OPTIONS.map((option) => option.value)).toEqual([LEGAL_HOLD_CHANGED_EVENT]);
  });
});
