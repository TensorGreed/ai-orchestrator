/**
 * Phase 13.1 — store contract: a NUL character (U+0000) in free text. Postgres TEXT cannot hold it (22021), so the
 * Postgres store writes every string parameter with U+0000 replaced by U+FFFD (postgres/context.ts); SQLite keeps the
 * NUL. Either way the write succeeds, reads back, and the audit chain still verifies, because the Postgres hash
 * covers the value as stored.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { ReplayRecordingInsert } from "../database.js";

const NUL = "\u0000";

function recording(id: string, notes: string): ReplayRecordingInsert {
  return {
    id,
    workflowId: "wf-1",
    projectId: "default",
    name: `Run ${id}`,
    notes,
    sourceExecutionId: `exec-${id}`,
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "hash-1",
    workflowSavedVersion: 1,
    capturedWorkflowJson: JSON.stringify({ id: "wf-1", nodes: [] }),
    inputJson: JSON.stringify({ q: `in${NUL}put` }),
    nodeOutputsJson: "{}",
    factsJson: "{}",
    mcpCassetteJson: null,
    modelTapeJson: null,
    memorySeedJson: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 10,
    truncated: false,
    createdAt: new Date().toISOString(),
    createdBy: "tester",
    status: "golden",
    capturedAt: null
  };
}

describeStoreContract("store contract: NUL characters in free text", (ctx) => {
  /** What a string reads back as on this store. */
  const stored = (value: string) => (ctx.kind === "postgres" ? value.replaceAll(NUL, "�") : value);

  it("an eval result error, a fixture name and a guard simulation error with a NUL are written and read back", async () => {
    const store = ctx.store();
    await store.createEvalDataset({ id: "ds", name: `Set${NUL}`, workflowId: "wf-1" });
    await store.createEvalFixture({ id: "fx", datasetId: "ds", name: `Case ${NUL} one`, input: { q: NUL } });
    await store.createEvalRun({ id: "run", datasetId: "ds", workflowId: "wf-1" });
    await store.recordEvalResult({ id: "res", runId: "run", fixtureId: "fx", status: "error", error: `tool said ${NUL}binary${NUL}` });
    expect((await store.getEvalResult("run", "res"))?.error).toBe(stored(`tool said ${NUL}binary${NUL}`));
    expect((await store.listEvalFixtures("ds")).map((f) => [f.name, f.input])).toEqual([[stored(`Case ${NUL} one`), { q: NUL }]]);

    await store.insertGuardSimulation({
      id: "sim",
      profileId: "p",
      sourceKind: "inline",
      sourceVersion: null,
      simulatedHash: "hash",
      baseVersion: null,
      jobIds: [],
      detail: null,
      status: "running",
      createdAt: new Date().toISOString(),
      createdBy: "a@example.com",
      createdByUserId: null
    });
    expect(await store.updateGuardSimulation({ id: "sim", status: "failed", error: `boom${NUL}`, finishedAt: new Date().toISOString() })).toBe(true);
    expect((await store.getGuardSimulation("sim"))?.error).toBe(stored(`boom${NUL}`));
  });

  it("a replay recording note and a guard profile name with a NUL are written and read back", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("rec", `note ${NUL}`));
    expect((await store.getReplayRecording("rec"))?.notes).toBe(stored(`note ${NUL}`));
    expect((await store.getReplayRecording("rec"))?.input).toEqual({ q: `in${NUL}put` });
    await store.insertGuardProfile({ id: "gp", name: `Guard${NUL}`, description: NUL, builtIn: false, document: { name: NUL }, hash: "h", note: null, createdBy: null });
    expect(await store.getGuardProfile("gp")).toMatchObject({ name: stored(`Guard${NUL}`), description: stored(NUL) });
  });

  it("a lookup by a NUL-bearing key finds nothing instead of failing", async () => {
    const store = ctx.store();
    expect(await store.getWorkflow(`wf${NUL}`)).toBeNull();
    expect(await store.getUserByEmail(`a${NUL}@example.com`)).toBeNull();
    expect(await store.getReplayRecording(`rec${NUL}`)).toBeNull();
  });

  it("an audit message and actor with a NUL are stored, and the chain still verifies", async () => {
    const store = ctx.store();
    await store.writeAuditLog({ id: "a1", eventType: "auth.login", category: "auth", action: "login", outcome: "failure", message: `bad ${NUL} input`, userAgent: `ua${NUL}`, metadata: { raw: NUL } });
    await store.writeAuditLog({ id: "a2", eventType: "auth.login", category: "auth", action: "login", outcome: "success", actorEmail: `x${NUL}@example.com` });
    const page = await store.listAuditLogs();
    const first = page.items.find((item) => item.id === "a1");
    expect(first).toMatchObject({ message: stored(`bad ${NUL} input`), userAgent: stored(`ua${NUL}`), metadata: { raw: NUL } });
    expect(page.items.find((item) => item.id === "a2")?.actorEmail).toBe(stored(`x${NUL}@example.com`));
    expect(await store.verifyAuditChain()).toMatchObject({ ok: true, rowsChecked: 2 });
  });
});
