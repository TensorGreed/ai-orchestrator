/**
 * Phase 13.1 — the atomic store methods with two API instances: two PostgresStores (two pools) on one schema, racing
 * on the same rows. Each conditional write must apply once across instances, not only within one pool. Postgres only
 * (skipped without TEST_POSTGRES_URL).
 */
import { afterEach, describe, expect, it } from "vitest";
import { postgresStoreConfig } from "./create-store.js";
import { PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";
import { StoreReferenceMissingError } from "./store-errors.js";
import { testPostgresPool } from "../test-support/test-store.js";
import { createTestStore, noticePostgresSkipped, testPostgresSettings, testPostgresUrl, type TestStore } from "../test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("postgres two-instance races");

const spec = { kind: "approval_gate", approverRoles: [], approverUsers: [], allowSelfApproval: true, timeoutOutcome: "reject", requireRejectReason: false, editableFields: [] } as never;

run("two instances on one Postgres schema", () => {
  let primary: TestStore | undefined;
  let second: PostgresStore | undefined;

  async function open(): Promise<[Store, Store]> {
    primary = await createTestStore({ kind: "postgres" });
    second = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema: primary.schema!, maxConnections: 4 }));
    return [primary.store, second];
  }

  afterEach(async () => {
    await second?.close();
    second = undefined;
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  it("a queue job is claimed by exactly one instance", async () => {
    const [a, b] = await open();
    const ids = Array.from({ length: 30 }, (_, i) => `job-${i}`);
    const due = new Date(Date.now() - 1_000).toISOString();
    for (const id of ids) await a.enqueueExecution({ id, workflowId: "wf", payload: {}, scheduledAt: due });
    const drain = async (store: Store) => {
      const got: string[] = [];
      for (;;) {
        const batch = await store.dequeueNext(2);
        if (batch.length === 0) return got;
        got.push(...batch.map((job) => job.id));
      }
    };
    const [fromA, fromB, fromA2, fromB2] = await Promise.all([drain(a), drain(b), drain(a), drain(b)]);
    const all = [...fromA, ...fromB, ...fromA2, ...fromB2];
    expect(all.sort()).toEqual([...ids].sort());
  }, 60_000);

  it("two instances appending versions of one workflow take distinct numbers and keep each other's JSON", async () => {
    const [a, b] = await open();
    const appended = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).appendWorkflowVersion({ id: `v-${i}`, workflowId: "wf", workflowJson: JSON.stringify({ i }), retention: 0 }))
    );
    expect(appended.map((entry) => entry.version).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const entry of appended) {
      const row = await a.getWorkflowVersion("wf", entry.version);
      expect(JSON.parse(row!.workflowJson)).toEqual({ i: Number(entry.id.slice(2)) });
    }
  }, 60_000);

  it("80 concurrent appends to one workflow from two instances (10 connections each): no errors, versions 1..80", async () => {
    primary = await createTestStore({ kind: "postgres" });
    const wide = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema: primary.schema!, maxConnections: 10 }));
    second = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema: primary.schema!, maxConnections: 10 }));
    try {
      const stores = [wide, second];
      const results = await Promise.allSettled(
        Array.from({ length: 80 }, (_, i) => stores[i % 2]!.appendWorkflowVersion({ id: `w-${i}`, workflowId: "wf", workflowJson: JSON.stringify({ i }), retention: 5 }))
      );
      const failed = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
      expect(failed).toEqual([]);
      const versions = results.map((r) => (r as PromiseFulfilledResult<{ version: number }>).value.version).sort((a, b) => a - b);
      expect(versions).toEqual(Array.from({ length: 80 }, (_, i) => i + 1));
      expect((await wide.listWorkflowVersions("wf", 100)).map((v) => v.version)).toEqual([80, 79, 78, 77, 76]);
      // A different workflow is not held up by this one's lock (a per-workflow key).
      expect((await second.appendWorkflowVersion({ id: "other-1", workflowId: "wf-other", workflowJson: "{}", retention: 0 })).version).toBe(1);
    } finally {
      await wide.close();
    }
  }, 120_000);

  it("deleting a user while another instance logs them in: the delete never fails, no session is left behind", async () => {
    const [a, b] = await open();
    const outcomes = { saved: 0, refused: 0 };
    for (let round = 0; round < 15; round += 1) {
      const userId = `u-${round}`;
      await a.saveUser({ id: userId, email: `${userId}@example.com`, passwordHash: "x", role: "viewer" });
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const [deleted, ...writes] = await Promise.allSettled([
        a.deleteUser(userId),
        b.saveSession({ id: `s-${round}-1`, userId, expiresAt }),
        b.saveApiKey({ id: `k-${round}`, userId, name: "k", keyPrefix: `p${round}`, keyHash: "h" }),
        b.saveSession({ id: `s-${round}-2`, userId, expiresAt })
      ]);
      expect(deleted).toEqual({ status: "fulfilled", value: true });
      for (const write of writes) {
        if (write.status === "fulfilled") outcomes.saved += 1;
        else {
          expect(write.reason).toBeInstanceOf(StoreReferenceMissingError);
          outcomes.refused += 1;
        }
      }
    }
    const pool = testPostgresPool(primary!.schema);
    try {
      const left = await pool.query(`SELECT (SELECT COUNT(*) FROM sessions)::int + (SELECT COUNT(*) FROM api_keys)::int AS n`);
      expect(left.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
    expect(outcomes.saved + outcomes.refused).toBe(45);
  }, 120_000);

  it("an approval is decided once when two instances decide it at the same moment", async () => {
    const [a, b] = await open();
    for (let round = 0; round < 6; round += 1) {
      const execution = `run-${round}`;
      const startedAt = new Date().toISOString();
      await a.saveExecutionHistory({ id: execution, workflowId: "wf", status: "waiting_approval", startedAt });
      await a.saveWorkflowExecutionState({ id: execution, workflowId: "wf", status: "waiting_approval", waitingNodeId: "gate", startedAt, state: {} });
      await a.insertApprovalRequest({ id: `req-${round}`, executionId: execution, workflowId: "wf", projectId: "default", nodeId: "gate", kind: "approval_gate", spec });
      const results = await Promise.all([
        a.claimExecutionAndDecideApproval(execution, { id: `req-${round}`, status: "approved", decidedBy: "a" }),
        b.claimExecutionAndDecideApproval(execution, { id: `req-${round}`, status: "rejected", decidedBy: "b" })
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await b.getApprovalRequest(`req-${round}`))?.decidedBy).toBe(results[0] ? "a" : "b");
    }
  }, 60_000);

  it("a webhook replay fingerprint and an MFA backup code are each spent once across instances", async () => {
    const [a, b] = await open();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    for (let round = 0; round < 6; round += 1) {
      const key = { replayKey: `fp-${round}`, endpointKey: "ep", expiresAt };
      const saved = await Promise.all([a.saveWebhookReplayKey(key), b.saveWebhookReplayKey(key)]);
      expect(saved.sort()).toEqual([false, true]);
    }
    await a.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "admin" });
    await a.upsertMfaSecret({ userId: "u1", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: ["c1", "c2"], enabled: true, activatedAt: null });
    const spent = await Promise.all([
      a.replaceMfaBackupCodes({ userId: "u1", expected: ["c1", "c2"], next: ["c2"] }),
      b.replaceMfaBackupCodes({ userId: "u1", expected: ["c1", "c2"], next: ["c2"] })
    ]);
    expect(spent.sort()).toEqual([false, true]);
  }, 60_000);

  it("audit entries written by two instances form one valid chain", async () => {
    const [a, b] = await open();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? a : b).writeAuditLog({ id: `audit-${i}`, eventType: "test.event", category: "test", action: "write", outcome: "success" })
      )
    );
    const verified = await b.verifyAuditChain();
    expect(verified).toMatchObject({ ok: true, rowsChecked: 30 });
  }, 60_000);
});
