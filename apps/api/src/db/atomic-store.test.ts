import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { MfaService } from "../services/mfa-service.js";
import { WorkflowVersionService } from "../services/workflow-version-service.js";
import { SqliteStore } from "./database.js";
import type { Store } from "./store.js";

// Two callers that read the same state before either writes: on Postgres every store call yields, so each
// check-then-act must be one conditional write. These tests interleave the two callers by hand.

const dirs: string[] = [];
const stores: SqliteStore[] = [];

async function openStore(): Promise<SqliteStore> {
  const dir = mkdtempSync(path.join(tmpdir(), "l2m-atomic-"));
  dirs.push(dir);
  const store = await SqliteStore.create(path.join(dir, "orchestrator.db"));
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("atomic store writes under interleaving", () => {
  it("a webhook replay fingerprint is claimed by exactly one of two concurrent requests", async () => {
    const store = await openStore();
    const key = { replayKey: "fp-1", endpointKey: "ep", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const results = await Promise.all([store.saveWebhookReplayKey(key), store.saveWebhookReplayKey(key)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.hasWebhookReplayKey("fp-1")).toBe(true);
  });

  it("a backup code is spent once when two sign-ins read the same codes before either writes", async () => {
    const store = await openStore();
    await store.upsertMfaSecret({ userId: "u1", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: ["a", "b"], enabled: true, activatedAt: null });
    const first = (await store.getMfaSecret("u1"))!;
    const second = (await store.getMfaSecret("u1"))!;
    const results = await Promise.all([
      store.replaceMfaBackupCodes({ userId: "u1", expected: first.backupCodes, next: ["b"] }),
      store.replaceMfaBackupCodes({ userId: "u1", expected: second.backupCodes, next: ["b"] })
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await store.getMfaSecret("u1"))!.backupCodes).toEqual(["b"]);
    // The other code still works, once.
    expect(await store.replaceMfaBackupCodes({ userId: "u1", expected: ["b"], next: [] })).toBe(true);
    expect(await store.replaceMfaBackupCodes({ userId: "u1", expected: ["b"], next: [] })).toBe(false);
  });

  it("MfaService: two sign-ins whose reads both land before either write spend a backup code once", async () => {
    const store = await openStore();
    // Every read yields to the event loop, as a networked store does.
    const slow = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "getMfaSecret" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return result;
        };
      }
    }) as Store;
    const mfa = new MfaService(slow, randomBytes(32).toString("base64"));
    const { backupCodes } = await mfa.enroll("u2", "u2@example.com");
    await store.upsertMfaSecret({ ...(await store.getMfaSecret("u2"))!, enabled: true, activatedAt: new Date().toISOString() });
    const results = await Promise.all([mfa.verify("u2", backupCodes[0]!), mfa.verify("u2", backupCodes[0]!)]);
    expect(results.sort()).toEqual([false, true]);
    expect((await store.getMfaSecret("u2"))!.backupCodes).toHaveLength(backupCodes.length - 1);
  });

  it("a release gate saved by two editors from the same starting point keeps one of them", async () => {
    const store = await openStore();
    await store.upsertWorkflow({ id: "wf-gate", name: "Gate", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    const gate = (updatedBy: string) => ({
      workflowId: "wf-gate",
      enabled: true,
      enforced: false,
      datasetIds: [],
      candidateOptions: {},
      policy: {},
      requireApproval: false,
      approvers: null,
      updatedAt: new Date().toISOString(),
      updatedBy
    });
    const results = await Promise.all(
      ["ana", "bo"].map((who) => store.saveReleaseGate({ gate: gate(who) as never, expected: null, updatedAt: new Date().toISOString(), updatedBy: who }))
    );
    expect(results.filter((result) => result === null)).toHaveLength(1);
    const kept = results.find((result) => result !== null)!;
    expect((await store.getReleaseGate("wf-gate"))?.updatedBy).toBe(kept.updatedBy);
  });

  it("a run saved as a golden run by two requests at once is saved once", async () => {
    const store = await openStore();
    await store.upsertWorkflow({ id: "wf-rec", name: "Rec", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
    const row = (id: string) => ({
      id,
      workflowId: "wf-rec",
      projectId: "default",
      name: id,
      notes: null,
      sourceExecutionId: "exec-1",
      sourceTriggerType: "manual",
      sourceStatus: "success",
      workflowHash: "h",
      workflowSavedVersion: null,
      capturedWorkflowJson: "{}",
      inputJson: null,
      nodeOutputsJson: "{}",
      factsJson: "{}",
      mcpCassetteJson: null,
      capabilities: { mcp: "cassette", models: "live", memory: "empty", workflowSource: "captured" },
      bytes: 10,
      truncated: false,
      createdAt: new Date().toISOString(),
      createdBy: null
    });
    const results = await Promise.all([
      store.saveReplayRecordingChecked(row("rec_a") as never, { uniqueExecution: true }),
      store.saveReplayRecordingChecked(row("rec_b") as never, { uniqueExecution: true })
    ]);
    expect(results.filter((result) => "saved" in result)).toHaveLength(1);
    expect(results.find((result) => !("saved" in result))).toMatchObject({ refused: "duplicate" });
  });

  it("two saves of one workflow at once get two version numbers, and neither replaces the other", async () => {
    const store = await openStore();
    const base = { id: "wf-ver", name: "Ver", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] };
    await store.upsertWorkflow(base as never);
    const versions = new WorkflowVersionService(store);
    const saved = await Promise.all([
      versions.snapshot({ workflow: { ...base, name: "first" } as never, changeNote: "a" }),
      versions.snapshot({ workflow: { ...base, name: "second" } as never, changeNote: "b" })
    ]);
    expect(saved.map((summary) => summary.version).sort()).toEqual([1, 2]);
    for (const summary of saved) {
      const row = await store.getWorkflowVersion("wf-ver", summary.version);
      // The summary's id and note are the stored row's, and each save kept its own JSON.
      expect(row?.id).toBe(summary.id);
      expect(row?.changeNote).toBe(summary.changeNote);
      expect(JSON.parse(row!.workflowJson).name).toBe(summary.changeNote === "a" ? "first" : "second");
    }
    expect((await store.listWorkflowVersions("wf-ver", 10)).length).toBe(2);
  });

  it("appending a version takes the next number and prunes past the retention in the same write", async () => {
    const store = await openStore();
    const appended = await Promise.all(
      [1, 2, 3, 4].map((n) => store.appendWorkflowVersion({ id: `wfv-${n}`, workflowId: "wf-keep", workflowJson: JSON.stringify({ n }), createdBy: null, changeNote: `v${n}`, retention: 2 }))
    );
    expect(appended.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
    expect((await store.listWorkflowVersions("wf-keep", 10)).map((entry) => entry.version).sort()).toEqual([3, 4]);
    expect(await store.maxWorkflowVersionNumber("wf-keep")).toBe(4);
  });

  it("a progress write that commits after the final write does not reopen the run", async () => {
    const store = await openStore();
    const base = { id: "run-1", workflowId: "wf-run", startedAt: new Date().toISOString() };
    await store.saveExecutionHistory({ ...base, status: "running" }, { unlessFinished: true });
    expect((await store.getExecutionHistory("run-1"))?.status).toBe("running");
    await store.saveExecutionHistory({ ...base, status: "waiting_approval", completedAt: base.startedAt }, { unlessFinished: true });
    await store.saveExecutionHistory({ ...base, status: "running" }, { unlessFinished: true });
    expect((await store.getExecutionHistory("run-1"))?.status).toBe("running");
    for (const finished of ["success", "error", "canceled", "partial"]) {
      const id = `run-${finished}`;
      await store.saveExecutionHistory({ ...base, id, status: finished, completedAt: new Date().toISOString(), error: finished === "error" ? "boom" : undefined });
      await store.saveExecutionHistory({ ...base, id, status: "running" }, { unlessFinished: true });
      expect((await store.getExecutionHistory(id))?.status).toBe(finished);
      expect((await store.getExecutionHistory(id))?.completedAt).toBeTruthy();
    }
    // A final write is not a progress write: it always lands.
    await store.saveExecutionHistory({ ...base, id: "run-success", status: "error", completedAt: new Date().toISOString(), error: "late" });
    expect((await store.getExecutionHistory("run-success"))?.status).toBe("error");
  });
});
