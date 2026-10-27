/**
 * Phase 13.1 — store contract: production capture (candidate recordings, capture settings, retention), on both
 * stores. Candidates are written with saveReplayRecording (the replay domain).
 */
import { expect, it } from "vitest";
import { REPLAY_CAPTURE_API_KEY_FILTER, REPLAY_CAPTURE_STATUSES } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";

type Insert = Parameters<Store["saveReplayRecording"]>[0];

function recording(id: string, overrides: Partial<Insert> = {}): Insert {
  return {
    id,
    workflowId: "wf-1",
    projectId: "p1",
    name: `Run ${id}`,
    notes: null,
    sourceExecutionId: `ex-${id}`,
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "hash-1",
    workflowSavedVersion: 2,
    capturedWorkflowJson: "{}",
    inputJson: "{}",
    nodeOutputsJson: "{}",
    factsJson: "{}",
    mcpCassetteJson: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 100,
    truncated: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    createdBy: null,
    status: "candidate",
    capturedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

describeStoreContract("store contract: replay capture", (ctx) => {
  it("lists a workflow's candidates newest first with filters, total and paging", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("c1", { capturedAt: "2026-10-01T10:00:00.000Z" }));
    await store.saveReplayRecording(recording("c2", { capturedAt: "2026-10-02T10:00:00.000Z", sourceStatus: "error", sourceTriggerType: "webhook" }));
    await store.saveReplayRecording(
      recording("c3", {
        capturedAt: "2026-10-03T10:00:00.000Z",
        capabilities: {
          mcp: "cassette",
          models: "tape",
          memory: "empty",
          workflowSource: "captured",
          capture: { rate: 0.5, masked: true, dataClasses: ["email"], values: { email: 2 }, notDetectableAfterMasking: [], keptFromWorkflow: 1, publishedVersion: 3, source: "api_key" }
        }
      })
    );
    await store.saveReplayRecording(recording("g1", { status: "golden", capturedAt: "2026-10-04T10:00:00.000Z" }));
    await store.saveReplayRecording(recording("o1", { workflowId: "wf-2", capturedAt: "2026-10-04T10:00:00.000Z" }));

    const all = await store.listReplayCaptures({ workflowId: "wf-1" });
    expect(all.total).toBe(3);
    expect(all.items.map((item) => item.id)).toEqual(["c3", "c2", "c1"]);
    expect(all.items[0]).toMatchObject({
      status: "candidate",
      capturedAt: "2026-10-03T10:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      workflowSavedVersion: 2,
      truncated: false,
      bytes: 100,
      capabilities: { mcp: "cassette", models: "tape", capture: { rate: 0.5, masked: true, source: "api_key", values: { email: 2 }, publishedVersion: 3 } }
    });
    expect((await store.listReplayCaptures({ workflowId: "wf-1", runStatus: "error" })).items.map((i) => i.id)).toEqual(["c2"]);
    expect((await store.listReplayCaptures({ workflowId: "wf-1", trigger: "webhook" })).items.map((i) => i.id)).toEqual(["c2"]);
    expect((await store.listReplayCaptures({ workflowId: "wf-1", trigger: REPLAY_CAPTURE_API_KEY_FILTER })).items.map((i) => i.id)).toEqual(["c3"]);
    // A NUL character anywhere in the stored capabilities never fails the API-key filter.
    await store.saveReplayRecording(
      recording("c4", {
        capturedAt: "2026-09-01T10:00:00.000Z",
        capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured", note: "a\u0000b", capture: { source: "api_key" } } as never
      })
    );
    expect((await store.listReplayCaptures({ workflowId: "wf-1", trigger: REPLAY_CAPTURE_API_KEY_FILTER })).items.map((i) => i.id)).toEqual(["c3", "c4"]);
    await store.deleteReplayRecording("c4");
    // Nor does a lone surrogate (stored as the escape `\ud800`, which jsonb refuses).
    await store.saveReplayRecording(
      recording("c5", {
        capturedAt: "2026-09-01T10:00:00.000Z",
        capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured", note: "a\uD800b\uDC00", capture: { source: "api_key" } } as never
      })
    );
    expect((await store.listReplayCaptures({ workflowId: "wf-1", trigger: REPLAY_CAPTURE_API_KEY_FILTER })).items.map((i) => i.id)).toEqual(["c3", "c5"]);
    await store.deleteReplayRecording("c5");
    expect(
      (await store.listReplayCaptures({ workflowId: "wf-1", from: "2026-10-02T10:00:00.000Z", to: "2026-10-03T10:00:00.000Z" })).items.map((i) => i.id)
    ).toEqual(["c3", "c2"]);
    const page = await store.listReplayCaptures({ workflowId: "wf-1", limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 3 });
    expect(page.items.map((i) => i.id)).toEqual(["c2"]);

    expect(await store.countReplayCapturesSince("wf-1", "2026-10-02T00:00:00.000Z")).toBe(3); // c2, c3 and the golden g1
    expect(await store.countReplayCapturesSince("wf-1", "2027-01-01T00:00:00.000Z")).toBe(0);
    expect(await store.oldestReplayCaptureIds("wf-1", 2)).toEqual(["c1", "c2"]);
    expect(await store.oldestReplayCaptureIds("wf-1", 0)).toEqual([]);
    expect(await store.oldestReplayCaptures("wf-1", 10)).toEqual([
      { id: "c1", bytes: 100 },
      { id: "c2", bytes: 100 },
      { id: "c3", bytes: 100 }
    ]);
    expect(await store.oldestReplayCaptures("wf-1", 0)).toEqual([{ id: "c1", bytes: 100 }]);
    expect(await store.sumReplayCaptureBytesForWorkflow("wf-1")).toBe(300);
    expect(await store.sumReplayCaptureBytesForWorkflow("none")).toBe(0);
  });

  it("promotes a candidate once and prunes only old candidates", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("c1", { capturedAt: "2026-09-01T00:00:00.000Z" }));
    await store.saveReplayRecording(recording("c2", { capturedAt: "2026-09-02T00:00:00.000Z" }));
    await store.saveReplayRecording(recording("g1", { status: "golden", capturedAt: "2026-08-01T00:00:00.000Z" }));
    const promotion = {
      name: "Promoted",
      capturedWorkflowJson: "{\"a\":1}",
      inputJson: null,
      nodeOutputsJson: "{}",
      factsJson: "{}",
      mcpCassetteJson: null,
      modelTapeJson: null,
      memorySeedJson: null,
      bytes: 42,
      workflowHash: "hash-2",
      createdBy: "alice"
    };
    expect(await store.promoteReplayCapture("c1", promotion)).toBe(true);
    expect(await store.promoteReplayCapture("c1", promotion)).toBe(false);
    expect(await store.promoteReplayCapture("missing", promotion)).toBe(false);
    expect(await store.getReplayRecordingSummary("c1")).toMatchObject({ status: "golden", name: "Promoted", bytes: 42, workflowHash: "hash-2", createdBy: "alice" });
    expect((await store.listReplayCaptures({ workflowId: "wf-1" })).items.map((i) => i.id)).toEqual(["c2"]);

    expect(await store.pruneReplayCaptures("2026-09-01T00:00:00.000Z")).toBe(0);
    expect(await store.pruneReplayCaptures("2026-10-01T00:00:00.000Z")).toBe(1);
    expect(await store.getReplayRecordingSummary("c2")).toBeNull();
    expect(await store.getReplayRecordingSummary("g1")).not.toBeNull();
  });

  it("saves capture settings, upserts them and records drops on an existing row only", async () => {
    const store = ctx.store();
    expect(await store.getReplayCaptureSettings("wf-1")).toBeNull();
    await store.recordReplayCaptureDrop("wf-1", "rate", "2026-10-01T00:00:00.000Z");
    expect(await store.getReplayCaptureSettings("wf-1")).toBeNull();

    const saved = await store.saveReplayCaptureSettings({
      workflowId: "wf-1",
      enabled: true,
      rate: 0.25,
      maxPerDay: 5,
      onlyStatuses: ["error"],
      dlp: false,
      dlpOffReason: "synthetic data",
      targetDatasetId: "ds-1",
      updatedBy: "alice",
      updatedAt: "2026-10-01T00:00:00.000Z"
    });
    expect(saved).toEqual({
      workflowId: "wf-1",
      enabled: true,
      rate: 0.25,
      maxPerDay: 5,
      onlyStatuses: ["error"],
      dlp: false,
      dlpOffReason: "synthetic data",
      targetDatasetId: "ds-1",
      updatedAt: "2026-10-01T00:00:00.000Z",
      updatedBy: "alice",
      lastDropOutcome: null,
      lastDropAt: null
    });
    await store.recordReplayCaptureDrop("wf-1", "daily_limit", "2026-10-02T00:00:00.000Z");
    const again = await store.saveReplayCaptureSettings({
      workflowId: "wf-1",
      enabled: false,
      rate: 1,
      maxPerDay: 20,
      onlyStatuses: [...REPLAY_CAPTURE_STATUSES],
      dlp: true,
      dlpOffReason: null,
      targetDatasetId: null,
      updatedBy: null
    });
    expect(again).toMatchObject({
      enabled: false,
      rate: 1,
      dlp: true,
      dlpOffReason: null,
      targetDatasetId: null,
      updatedBy: null,
      onlyStatuses: [...REPLAY_CAPTURE_STATUSES],
      lastDropOutcome: "daily_limit",
      lastDropAt: "2026-10-02T00:00:00.000Z"
    });
    expect(again.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await store.getReplayCaptureSettings("wf-1")).toEqual(again);
  });
});
