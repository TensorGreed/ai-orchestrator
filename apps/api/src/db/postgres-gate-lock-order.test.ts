/**
 * Postgres: a release gate save serialises with a builder's rollback, unpublish and workflow delete. Those lock the
 * workflow row and then read the gate; the gate save locks the workflow row before it writes the gate. Two stores
 * (two pools) on one schema: the builder's store is paused inside its transaction at a chosen query, while the
 * admin's store saves the gate as on and enforced. The builder's action either completes before the gate change
 * commits or is refused; it never completes after an enforced gate was committed. Postgres only (skipped without
 * TEST_POSTGRES_URL). SQLite runs each store write synchronously in one process, so nothing can commit inside it.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { Workflow } from "@ai-orchestrator/shared";
import type { PostgresStore } from "./postgres-store.js";
import type { ReleaseGateRecord, WorkflowReleaseRecord } from "./database.js";
import type { Store } from "./store.js";
import { ReleaseGateEnforcedError } from "./store-errors.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("postgres gate lock order");

type QueryFn = (...args: unknown[]) => Promise<unknown>;

/** Every pause's resume, so a failed test never leaves a transaction open behind it. */
const resumers: Array<() => void> = [];

/** Pauses the store's next transaction right after the first query whose text matches `after`. */
function pauseAfter(store: PostgresStore, after: RegExp): { reached: Promise<void>; resume: () => void } {
  let reach!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  resumers.push(resume);
  let armed = true;
  const wrapped = new WeakSet<PoolClient>();
  const pool = (store as unknown as { pool: Pool }).pool;
  const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<PoolClient>;
  // pool.query checks a client out with a callback; only the clients handed to transactions (no callback) are wrapped.
  (pool as unknown as { connect: (callback?: unknown) => unknown }).connect = (callback?: unknown) => {
    if (callback !== undefined) return connect(callback);
    return connect().then(wrap);
  };
  const wrap = (client: PoolClient): PoolClient => {
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client) as unknown as QueryFn;
    (client as unknown as { query: QueryFn }).query = async (...args: unknown[]) => {
      const result = await query(...args);
      const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: unknown })?.text ?? "");
      if (armed && after.test(text)) {
        armed = false;
        reach();
        await resumed;
      }
      return result;
    };
    return client;
  };
  return { reached, resume };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `promise` is still pending after `ms`. */
async function stillPending(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  const marker = Symbol("pending");
  const outcome = await Promise.race([promise.then(() => null, () => null), delay(ms).then(() => marker)]);
  return outcome === marker;
}

run("Postgres: gate saves serialise with builder release writes", () => {
  let primary: TestStore | undefined;
  let builderStore: PostgresStore | undefined;
  let watcher: Pool | undefined;

  afterEach(async () => {
    while (resumers.length > 0) resumers.pop()!();
    await watcher?.end();
    watcher = undefined;
    await builderStore?.close();
    builderStore = undefined;
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  async function open(): Promise<{ admin: Store; builder: PostgresStore }> {
    primary = await createTestStore({ kind: "postgres" });
    builderStore = await openTestStoreTwin(primary, { maxConnections: 2 });
    watcher = testStorePool(primary, { max: 1 });
    return { admin: primary.store, builder: builderStore };
  }

  /** Waits until some backend of this database waits on a row lock (the gate save behind the workflow row). */
  async function someoneWaitsOnALock(): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await watcher!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      );
      if ((result.rows[0]?.n ?? 0) > 0) return true;
      await delay(20);
    }
    return false;
  }

  const workflow = (id: string): Workflow =>
    ({ id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes: [], edges: [] }) as unknown as Workflow;

  const gateRecord = (workflowId: string, state: { enabled: boolean; enforced: boolean }, updatedAt: string): ReleaseGateRecord => ({
    workflowId,
    enabled: state.enabled,
    enforced: state.enforced,
    datasetIds: [],
    candidateOptions: {},
    policy: {},
    requireApproval: false,
    approvers: null,
    updatedAt,
    updatedBy: "admin@example.com",
    admittedFixtureIds: null,
    admissionUpdatedAt: null,
    admissionUpdatedBy: null
  });

  const release = (id: string, workflowId: string, version: number, verdict: string): Omit<WorkflowReleaseRecord, "previousVersion"> => ({
    id,
    workflowId,
    version,
    workflowHash: "h",
    replayRunId: null,
    verdict,
    reason: null,
    gateReasons: [],
    approval: null,
    publishedAt: new Date().toISOString(),
    publishedBy: "builder@example.com",
    publishedByUserId: null
  });

  /** v1 and v2 published (v2 live), and a gate that is off. */
  async function seed(store: Store, workflowId: string): Promise<ReleaseGateRecord> {
    await store.upsertWorkflow(workflow(workflowId));
    for (const version of [1, 2]) {
      await store.appendWorkflowVersion({ id: `${workflowId}-v${version}`, workflowId, workflowJson: JSON.stringify(workflow(workflowId)), retention: 0 });
      expect(await store.publishWorkflowVersion(release(`${workflowId}-p${version}`, workflowId, version, "pass"), version === 1 ? null : 1)).not.toBeNull();
    }
    const off = await store.saveReleaseGate({ gate: gateRecord(workflowId, { enabled: false, enforced: false }, "2026-10-28T00:00:00.000Z"), expected: null, updatedAt: "2026-10-28T00:00:00.000Z", updatedBy: "admin@example.com" });
    expect(off).not.toBeNull();
    return off!;
  }

  const enforce = (store: Store, current: ReleaseGateRecord) =>
    store.saveReleaseGate({
      gate: gateRecord(current.workflowId, { enabled: true, enforced: true }, "2026-10-28T00:00:01.000Z"),
      expected: current,
      updatedAt: "2026-10-28T00:00:01.000Z",
      updatedBy: "admin@example.com"
    });

  it("a rollback that read the gate as off holds the gate save until it commits", async () => {
    const { admin, builder } = await open();
    const current = await seed(admin, "wf-lock-rb");
    const pause = pauseAfter(builder, /FROM release_gates WHERE workflow_id/);
    const rollback = builder.publishWorkflowVersion(release("rb", "wf-lock-rb", 1, "rollback"), 2, { refuseIfGateEnforced: true });
    await pause.reached;

    const save = enforce(admin, current);
    expect(await someoneWaitsOnALock()).toBe(true);
    expect(await stillPending(save)).toBe(true);
    expect((await admin.getReleaseGate("wf-lock-rb"))?.enforced).toBe(false);

    pause.resume();
    expect(await rollback).toMatchObject({ version: 1, previousVersion: 2 });
    expect(await save).toMatchObject({ enabled: true, enforced: true });
    expect(await admin.getPublishedVersion("wf-lock-rb")).toBe(1);

    // After the enforced gate committed, the same builder rollback is refused and writes nothing.
    await expect(builder.publishWorkflowVersion(release("rb2", "wf-lock-rb", 2, "rollback"), 1, { refuseIfGateEnforced: true })).rejects.toBeInstanceOf(
      ReleaseGateEnforcedError
    );
    expect(await admin.getPublishedVersion("wf-lock-rb")).toBe(1);
  }, 60_000);

  it("an unpublish that starts while a gate save holds the workflow row waits, then sees the enforced gate", async () => {
    const { admin, builder } = await open();
    const current = await seed(admin, "wf-lock-un");
    // The gate save runs on the paused store this time: it stops after writing the gate, before its commit.
    const pause = pauseAfter(builder, /INSERT INTO release_gates/);
    const save = enforce(builder, current);
    await pause.reached;

    const unpublish = admin.unpublishWorkflowVersion({
      id: "un",
      workflowId: "wf-lock-un",
      reason: null,
      unpublishedAt: new Date().toISOString(),
      unpublishedBy: "builder@example.com",
      unpublishedByUserId: null,
      refuseIfGateEnforced: true
    });
    unpublish.catch(() => undefined);
    expect(await someoneWaitsOnALock()).toBe(true);
    expect(await stillPending(unpublish)).toBe(true);

    pause.resume();
    expect(await save).toMatchObject({ enabled: true, enforced: true });
    await expect(unpublish).rejects.toBeInstanceOf(ReleaseGateEnforcedError);
    expect(await admin.getPublishedVersion("wf-lock-un")).toBe(2);
  }, 60_000);

  it("a workflow delete that read the gate as off holds the gate save until it commits", async () => {
    const { admin, builder } = await open();
    const current = await seed(admin, "wf-lock-del");
    const pause = pauseAfter(builder, /FROM release_gates WHERE workflow_id/);
    const removal = builder.deleteWorkflow("wf-lock-del", { refuseIfGateEnforced: true });
    await pause.reached;

    const save = enforce(admin, current);
    expect(await someoneWaitsOnALock()).toBe(true);
    expect(await stillPending(save)).toBe(true);

    pause.resume();
    expect(await removal).toBe(true);
    expect(await admin.getWorkflow("wf-lock-del")).toBeNull();
    // The gate outlives the workflow; the save went through after the delete.
    expect(await save).toMatchObject({ enabled: true, enforced: true });
  }, 60_000);

  it("a gate save, a rollback, an unpublish and a delete of one workflow racing never deadlock", async () => {
    const { admin, builder } = await open();
    const current = await seed(admin, "wf-lock-mix");
    const results = await Promise.allSettled([
      builder.publishWorkflowVersion(release("mix-rb", "wf-lock-mix", 1, "rollback"), 2, { refuseIfGateEnforced: true }),
      enforce(admin, current),
      admin.unpublishWorkflowVersion({
        id: "mix-un",
        workflowId: "wf-lock-mix",
        reason: null,
        unpublishedAt: new Date().toISOString(),
        unpublishedBy: "admin@example.com",
        unpublishedByUserId: null
      }),
      builder.deleteWorkflow("wf-lock-mix")
    ]);
    const unexpected = results
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason)
      .filter((reason) => !(reason instanceof ReleaseGateEnforcedError));
    expect(unexpected).toEqual([]);
    expect((await admin.getReleaseGate("wf-lock-mix"))?.enforced).toBe(true);
  }, 60_000);
});
