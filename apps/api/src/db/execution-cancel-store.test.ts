/**
 * The run-ending writes, on every store: `cancelExecution` and the final write's `unlessCanceled` guard. SQLite
 * always; Postgres too when TEST_POSTGRES_URL is set (each run gets its own database, dropped afterwards).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStore } from "./database.js";
import { PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";

interface Harness {
  store: Store;
  /** Runs raw SQL with `?` placeholders (the methods it stands in for are not on every store yet). */
  sql: (statement: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  close: () => Promise<void>;
}

async function sqliteHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "l2m-cancel-"));
  const store = await SqliteStore.create(path.join(dir, "orchestrator.db"));
  const raw = store as unknown as {
    exec: (sql: string, params: unknown[]) => void;
    queryAll: (sql: string, params: unknown[]) => Array<Record<string, unknown>>;
  };
  return {
    store,
    sql: async (statement, params) => {
      if (/^\s*select/i.test(statement)) return raw.queryAll(statement, params);
      raw.exec(statement, params);
      return [];
    },
    close: async () => {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function postgresHarness(url: string): Promise<Harness> {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `l2m_cancel_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const parsed = new URL(url);
  let store: PostgresStore;
  try {
    store = await PostgresStore.create({
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password)
    });
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.end();
    throw error;
  }
  const direct = new Pool({ connectionString: Object.assign(new URL(url), { pathname: `/${database}` }).toString(), max: 1 });
  return {
    store,
    sql: async (statement, params) => {
      let index = 0;
      const result = await direct.query(statement.replace(/\?/g, () => `$${++index}`), params);
      return result.rows as Array<Record<string, unknown>>;
    },
    close: async () => {
      await direct.end();
      await store.close();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  };
}

const kinds: Array<[string, () => Promise<Harness>]> = [["sqlite", sqliteHarness]];
if (process.env.TEST_POSTGRES_URL) kinds.push(["postgres", () => postgresHarness(process.env.TEST_POSTGRES_URL!)]);

describe.each(kinds)("run-ending writes (%s)", (_kind, open) => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await open();
  }, 60_000);
  afterAll(async () => {
    await harness?.close();
  }, 60_000);

  const startedAt = new Date(Date.now() - 1_000).toISOString();
  let seq = 0;
  const pausedRun = async (pausedStatus: "waiting_approval" | "resuming") => {
    const id = `run-${++seq}`;
    await harness.store.saveExecutionHistory({ id, workflowId: "wf", status: "waiting_approval", startedAt, completedAt: startedAt });
    await harness.store.saveWorkflowExecutionState({ id, workflowId: "wf", status: "waiting_approval", waitingNodeId: "gate", startedAt, state: {} });
    if (pausedStatus === "resuming") await harness.sql(`UPDATE workflow_executions SET status = 'resuming' WHERE id = ?`, [id]);
    const now = new Date().toISOString();
    await harness.sql(
      `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at)
       VALUES (?, ?, 'wf', 'default', 'gate', 'approval', ?, '{}', ?, ?)`,
      [`${id}-req`, id, pausedStatus === "resuming" ? "approved" : "pending", now, now]
    );
    return id;
  };
  const requestStatuses = async (id: string) =>
    (await harness.sql(`SELECT status FROM approval_requests WHERE execution_id = ?`, [id])).map((row) => String(row.status));

  it("a waiting run: canceled with its paused state deleted and its pending requests canceled, in one write", async () => {
    const id = await pausedRun("waiting_approval");
    const result = await harness.store.cancelExecution({ id, onlyFrom: ["waiting_approval"], error: "stop", deletePausedState: true });
    expect(result).toEqual({ outcome: "canceled", canceledRequestIds: [`${id}-req`] });
    expect((await harness.store.getExecutionHistory(id))?.status).toBe("canceled");
    expect(await harness.store.getWorkflowExecutionState(id)).toBeNull();
    expect(await requestStatuses(id)).toEqual(["canceled"]);
  });

  it("a claimed paused state refuses with decided and changes nothing, unless the caller cancels the claim", async () => {
    const id = await pausedRun("resuming");
    expect((await harness.store.cancelExecution({ id, onlyFrom: ["waiting_approval"], deletePausedState: true })).outcome).toBe("decided");
    expect((await harness.store.getExecutionHistory(id))?.status).toBe("waiting_approval");
    expect((await harness.store.getWorkflowExecutionState(id))?.status).toBe("resuming");
    expect((await harness.store.cancelExecution({ id, onlyFrom: ["waiting_approval", "running"], deletePausedState: true, cancelClaimed: true })).outcome).toBe("canceled");
    expect((await harness.store.getExecutionHistory(id))?.status).toBe("canceled");
    expect(await harness.store.getWorkflowExecutionState(id)).toBeNull();
    // The decided request keeps its decision.
    expect(await requestStatuses(id)).toEqual(["approved"]);
  });

  it("missing and not_cancelable", async () => {
    expect((await harness.store.cancelExecution({ id: "no-such-run", onlyFrom: ["running"] })).outcome).toBe("missing");
    const id = `run-${++seq}`;
    await harness.store.saveExecutionHistory({ id, workflowId: "wf", status: "success", startedAt, completedAt: new Date().toISOString() });
    expect((await harness.store.cancelExecution({ id, onlyFrom: ["running", "partial"] })).outcome).toBe("not_cancelable");
    expect((await harness.store.getExecutionHistory(id))?.status).toBe("success");
  });

  it("a final write that lands after a cancel keeps the run canceled; the stopped run's own canceled record still lands", async () => {
    const id = `run-${++seq}`;
    await harness.store.saveExecutionHistory({ id, workflowId: "wf", status: "running", startedAt }, { unlessFinished: true });
    expect((await harness.store.cancelExecution({ id, onlyFrom: ["running", "partial"], error: "stop" })).outcome).toBe("canceled");
    // The refused write says so, so the caller does not count the run as stored.
    expect(
      await harness.store.saveExecutionHistory({ id, workflowId: "wf", status: "success", startedAt, completedAt: new Date().toISOString() }, { unlessCanceled: true })
    ).toBe(false);
    expect((await harness.store.getExecutionHistory(id))?.status).toBe("canceled");
    expect(
      await harness.store.saveExecutionHistory(
        { id, workflowId: "wf", status: "canceled", startedAt, completedAt: new Date().toISOString(), nodeResultsJson: [{ nodeId: "a" }], error: "Workflow execution canceled." },
        { unlessCanceled: true }
      )
    ).toBe(true);
    const history = await harness.store.getExecutionHistory(id);
    expect(history?.status).toBe("canceled");
    expect(history?.nodeResults).toEqual([{ nodeId: "a" }]);
    // Any other finished record is replaced by a final write, as before.
    const other = `run-${++seq}`;
    await harness.store.saveExecutionHistory({ id: other, workflowId: "wf", status: "error", startedAt, completedAt: new Date().toISOString(), error: "x" });
    expect(
      await harness.store.saveExecutionHistory({ id: other, workflowId: "wf", status: "success", startedAt, completedAt: new Date().toISOString() }, { unlessCanceled: true })
    ).toBe(true);
    expect((await harness.store.getExecutionHistory(other))?.status).toBe("success");
    // A fresh insert is a write too.
    expect(await harness.store.saveExecutionHistory({ id: `run-${++seq}`, workflowId: "wf", status: "running", startedAt }, { unlessFinished: true })).toBe(true);
  });
});
