/**
 * 13.3 — the retention service on both stores (Postgres when TEST_POSTGRES_URL is set): the same rows as the old
 * history prune when nothing new is set, the new classes kept until their setting is set, the per-purge row cap,
 * leader-only purges, one instance at a time, the throttled nudge, and the purge log, metric and audit row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetentionPurgeClass } from "@ai-orchestrator/shared";
import { resolveRetentionSettings, type AppConfig } from "../config.js";
import { RETENTION_TABLES, type RetentionTable } from "../db/retention-tables.js";
import type { Store } from "../db/store.js";
import type { AuditEventInput } from "./audit-service.js";
import { RETENTION_LEASE_NAME, RetentionService, type RetentionServiceOptions } from "./retention-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore, type TestStoreKind } from "../test-support/test-store.js";
import { testSql } from "../test-support/test-sql.js";
import { retentionRowSql } from "../test-support/retention-rows.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const OLD = "2001-01-01T00:00:00.000Z";
/** Ten days before NOW: inside a 30-day retention, outside a 5-day one. */
const RECENT = "2026-10-31T12:00:00.000Z";
const NEW = "2100-01-01T00:00:00.000Z";
const ALL_TABLES = Object.keys(RETENTION_TABLES) as RetentionTable[];
/** The tables whose rows the tests compare (the purge log is the service's own). */
const DATA_TABLES = ALL_TABLES.filter((table) => table !== "retention_runs");

type Settings = Partial<Pick<AppConfig, "RETENTION_MAX_ROWS_PER_TICK" | "AGENT_MEMORY_RETENTION_DAYS" | "AI_GATEWAY_REQUEST_RETENTION_DAYS">> & {
  USAGE_EVENTS_RETENTION_DAYS?: number;
};

function makeService(store: Store, options: Partial<RetentionServiceOptions> & { env?: Settings } = {}): RetentionService {
  const { env, ...rest } = options;
  return new RetentionService({
    store,
    settings: resolveRetentionSettings({ USAGE_EVENTS_RETENTION_DAYS: 0, ...env }),
    executionHistoryDays: 30,
    evalRunDays: 90,
    intervalMs: 3_600_000,
    instanceId: "instance-a",
    isLeader: () => true,
    now: () => NOW,
    ...rest
  });
}

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("retention service");

for (const kind of kinds) {
  describe(`retention service [${kind}]`, () => {
    const opened: TestStore[] = [];
    const twins: Store[] = [];
    afterEach(async () => {
      vi.useRealTimers();
      for (const twin of twins.splice(0)) await twin.close().catch(() => undefined);
      for (const test of opened.splice(0)) await test.cleanup().catch(() => undefined);
    }, 60_000);

    async function open(): Promise<Store> {
      const test = await createTestStore({ kind });
      opened.push(test);
      return test.store;
    }

    /** A second store on the same database (a second instance); SQLite: the same store, as two processes cannot share it. */
    async function secondInstance(): Promise<Store> {
      const first = opened[opened.length - 1]!;
      if (kind === "sqlite") return first.store;
      const twin = await openTestStoreTwin(first);
      twins.push(twin);
      return twin;
    }

    async function seed(store: Store, statements: string[]): Promise<void> {
      const sql = testSql(store);
      for (const statement of statements) await sql.run(statement);
    }

    /** Two old rows and one new row of every data table. */
    const everyTable = () =>
      DATA_TABLES.flatMap((table) => [retentionRowSql(table, "old-1", OLD), retentionRowSql(table, "old-2", OLD), retentionRowSql(table, "new-1", NEW)]);

    async function rowsOf(store: Store, table: RetentionTable): Promise<number> {
      const row = await testSql(store).get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`);
      return Number(row?.n ?? 0);
    }

    async function snapshot(store: Store): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const table of DATA_TABLES) out[table] = await rowsOf(store, table);
      return out;
    }

    it("with nothing new set, deletes exactly what the old history prune deleted", async () => {
      const legacy = await open();
      const current = await open();
      await seed(legacy, everyTable());
      await seed(current, everyTable());
      await legacy.pruneExecutionHistory({ before: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() });
      const result = await makeService(current).tick("interval");
      expect(result.status).toBe("ran");
      expect(await snapshot(current)).toEqual(await snapshot(legacy));
      // Agent memory, usage and gateway requests were never pruned, and still are not.
      expect(await snapshot(current)).toMatchObject({
        execution_history: 1,
        mcp_tool_calls: 1,
        session_memory: 3,
        session_artifacts: 3,
        session_tool_cache: 3,
        usage_events: 3,
        ai_gateway_requests: 3
      });
      if (result.status === "ran") {
        expect(result.run.counts).toEqual({ runs: 2, tool_calls: 2, rule_events: 2, cassettes_approvals: 6, queue: 4 });
        expect(result.run.outcome).toBe("ok");
      }
    }, 60_000);

    it("usage events: kept when the setting is unset; older rows deleted once it is set", async () => {
      const store = await open();
      await seed(store, [retentionRowSql("usage_events", "old-1", OLD), retentionRowSql("usage_events", "recent-1", RECENT), retentionRowSql("usage_events", "new-1", NEW)]);
      await makeService(store).tick("interval");
      expect(await rowsOf(store, "usage_events")).toBe(3);
      await makeService(store, { env: { USAGE_EVENTS_RETENTION_DAYS: 30 } }).tick("interval");
      expect(await rowsOf(store, "usage_events")).toBe(2);
      await makeService(store, { env: { USAGE_EVENTS_RETENTION_DAYS: 5 } }).tick("interval");
      expect(await rowsOf(store, "usage_events")).toBe(1);
    }, 60_000);

    it("agent memory and gateway requests: kept until their settings are set", async () => {
      const store = await open();
      const tables: RetentionTable[] = ["session_memory", "session_artifacts", "session_tool_cache", "ai_gateway_requests"];
      await seed(store, tables.flatMap((table) => [retentionRowSql(table, "old-1", OLD), retentionRowSql(table, "new-1", NEW)]));
      await makeService(store, { env: { AGENT_MEMORY_RETENTION_DAYS: 0 } }).tick("interval");
      for (const table of tables) expect(await rowsOf(store, table), table).toBe(2);
      const result = await makeService(store, { env: { AGENT_MEMORY_RETENTION_DAYS: 30, AI_GATEWAY_REQUEST_RETENTION_DAYS: 30 } }).tick("interval");
      for (const table of tables) expect(await rowsOf(store, table), table).toBe(1);
      expect(result.status === "ran" && result.run.counts).toMatchObject({ agent_memory: 3, gateway_requests: 1 });
    }, 60_000);

    it("caps each table per purge, marks the class capped, and the next purge goes on", async () => {
      const store = await open();
      await seed(store, Array.from({ length: 2_300 }, (_, i) => retentionRowSql("mcp_tool_calls", `old-${i}`, OLD)));
      const service = makeService(store, { env: { RETENTION_MAX_ROWS_PER_TICK: 1_000 } });
      const first = await service.tick("interval");
      expect(first.status === "ran" && first.run).toMatchObject({ counts: { tool_calls: 1_000 }, capped: ["tool_calls"] });
      const view = await service.view();
      expect(view.classes.find((entry) => entry.class === "tool_calls")).toMatchObject({ backlog: 1_300, backlogCapped: false, days: 30 });
      await service.tick("interval");
      const third = await service.tick("interval");
      expect(third.status === "ran" && third.run).toMatchObject({ counts: { tool_calls: 300 }, capped: [] });
      expect(await rowsOf(store, "mcp_tool_calls")).toBe(0);
    }, 60_000);

    it("only the leader purges: a follower deletes and records nothing", async () => {
      await open();
      const leaderStore = opened[0]!.store;
      const followerStore = await secondInstance();
      await seed(leaderStore, everyTable());
      const follower = makeService(followerStore, { instanceId: "instance-b", isLeader: () => false });
      expect(await follower.tick("interval")).toEqual({ status: "skipped", why: "not_leader" });
      expect(await rowsOf(leaderStore, "execution_history")).toBe(3);
      expect(await leaderStore.listRetentionRuns(10)).toEqual([]);
      const leader = makeService(leaderStore, { instanceId: "instance-a" });
      expect((await leader.tick("interval")).status).toBe("ran");
      const runs = await leaderStore.listRetentionRuns(10);
      expect(runs.map((run) => run.instanceId)).toEqual(["instance-a"]);
    }, 60_000);

    it("two instances that both lead (HA off) never purge at once: the lease lets one through", async () => {
      await open();
      const storeA = opened[0]!.store;
      const storeB = await secondInstance();
      await seed(storeA, Array.from({ length: 1_500 }, (_, i) => retentionRowSql("execution_history", `old-${i}`, OLD)));
      const a = makeService(storeA, { instanceId: "instance-a" });
      const b = makeService(storeB, { instanceId: "instance-b" });
      // B already holds the lease (its purge is under way): A skips without deleting anything.
      expect(await storeB.tryAcquireLease({ leaseName: RETENTION_LEASE_NAME, holderId: "instance-b", ttlMs: 60_000 })).toBe(true);
      expect(await a.tick("interval")).toEqual({ status: "skipped", why: "lease_held" });
      expect(await rowsOf(storeA, "execution_history")).toBe(1_500);
      await storeB.releaseLease(RETENTION_LEASE_NAME, "instance-b");

      const results = await Promise.all([a.tick("interval"), b.tick("interval")]);
      const ran = results.filter((result) => result.status === "ran");
      const deleted = ran.reduce((sum, result) => sum + (result.status === "ran" ? (result.run.counts.runs ?? 0) : 0), 0);
      // Whoever ran, every row went exactly once and the log holds one purge per run.
      expect(deleted).toBe(1_500);
      expect(await rowsOf(storeA, "execution_history")).toBe(0);
      expect((await storeA.listRetentionRuns(10)).length).toBe(ran.length);
      if (ran.length === 2) {
        // The two ran one after the other: the second found nothing left.
        expect(ran.map((result) => (result.status === "ran" ? (result.run.counts.runs ?? 0) : 0)).sort((x, y) => x - y)).toEqual([0, 1_500]);
      }
      // The lease is given back after each purge.
      expect((await storeA.listLeases()).filter((lease) => lease.leaseName === RETENTION_LEASE_NAME)).toEqual([]);
    }, 60_000);

    it("the nudge after a run purges at most once a minute per instance", async () => {
      const store = await open();
      let now = NOW.getTime();
      const service = makeService(store, { now: () => new Date(now) });
      const tick = vi.spyOn(service, "tick");
      service.nudge();
      service.nudge();
      await service.idle();
      now += 30_000;
      service.nudge();
      expect(tick).toHaveBeenCalledTimes(1);
      now += 31_000;
      service.nudge();
      await service.idle();
      expect(tick).toHaveBeenCalledTimes(2);
      expect(tick).toHaveBeenCalledWith("write");
      await service.stop();
      now += 120_000;
      service.nudge();
      expect(tick).toHaveBeenCalledTimes(2);
    }, 60_000);

    it("records scheduled purges always, after-run purges only when they did something; audits and counts deletions", async () => {
      const store = await open();
      const audit = vi.fn(async (_event: AuditEventInput) => undefined);
      const metrics = { recordRetentionDeleted: vi.fn((_cls: RetentionPurgeClass, _n: number) => undefined) };
      // A clock that moves a second per reading, so the purges are listed in the order they ran.
      let tick = 0;
      const service = makeService(store, { audit, metrics, now: () => new Date(NOW.getTime() + 1_000 * tick++) });
      await service.tick("write");
      expect(await store.listRetentionRuns(10)).toEqual([]);
      await service.tick("startup");
      expect((await store.listRetentionRuns(10)).map((run) => [run.reason, run.outcome, run.counts])).toEqual([["startup", "ok", {}]]);
      expect(audit).not.toHaveBeenCalled();
      expect(metrics.recordRetentionDeleted).not.toHaveBeenCalled();

      await seed(store, [retentionRowSql("execution_history", "old-1", OLD), retentionRowSql("guard_events", "old-1", OLD)]);
      await service.tick("write");
      const runs = await store.listRetentionRuns(10);
      expect(runs[0]).toMatchObject({ reason: "write", outcome: "ok", counts: { runs: 1, rule_events: 1 } });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0]![0]).toMatchObject({
        eventType: "retention.purged",
        category: "system",
        actor: { type: "system" },
        metadata: { reason: "write", counts: { runs: 1, rule_events: 1 }, deleted: 2 }
      });
      expect(metrics.recordRetentionDeleted.mock.calls).toEqual([
        ["runs", 1],
        ["rule_events", 1]
      ]);
      const view = await service.view();
      expect(view.lastRun?.reason).toBe("write");
      // The next interval purge is due one interval after the last scheduled one (the start-up purge).
      const startup = runs.find((run) => run.reason === "startup")!;
      expect(view.nextRunAt).toBe(new Date(Date.parse(startup.startedAt) + 3_600_000).toISOString());
    }, 60_000);

    it("a failing class is recorded and the others still run", async () => {
      const store = await open();
      await seed(store, [retentionRowSql("execution_history", "old-1", OLD), retentionRowSql("usage_events", "old-1", OLD)]);
      const service = makeService(store, { env: { USAGE_EVENTS_RETENTION_DAYS: 30 } });
      service.register({
        class: "tool_calls",
        setting: "EXECUTION_HISTORY_RETENTION_DAYS",
        days: () => 30,
        run: async () => {
          throw new Error("disk on fire");
        }
      });
      const result = await service.tick("interval");
      expect(result.status === "ran" && result.run).toMatchObject({ outcome: "partial", counts: { runs: 1, usage: 1 }, error: "tool_calls: disk on fire" });
      expect(await rowsOf(store, "usage_events")).toBe(0);
    }, 60_000);

    it("keeps the purge log 90 days", async () => {
      const store = await open();
      await seed(store, [retentionRowSql("retention_runs", "ancient", OLD), retentionRowSql("retention_runs", "recent", RECENT)]);
      await makeService(store).tick("interval");
      expect((await store.listRetentionRuns(10)).map((run) => run.id)).not.toContain("ancient");
      expect((await store.listRetentionRuns(10)).map((run) => run.id)).toContain("recent");
    }, 60_000);

    it("the view lists every class with its setting and keeps backlog empty for kept-forever classes", async () => {
      const store = await open();
      await seed(store, [retentionRowSql("usage_events", "old-1", OLD)]);
      const view = await makeService(store).view();
      expect(view.classes.map((entry) => entry.class)).toEqual([
        "runs",
        "tool_calls",
        "rule_events",
        "cassettes_approvals",
        "queue",
        "agent_memory",
        "usage",
        "gateway_requests",
        "eval_runs"
      ]);
      expect(view.classes.find((entry) => entry.class === "usage")).toMatchObject({ setting: "USAGE_EVENTS_RETENTION_DAYS", days: 0, cutoff: null, backlog: null });
      expect(view.classes.find((entry) => entry.class === "runs")).toMatchObject({ days: 30, backlog: 0 });
      expect(view).toMatchObject({ maxRowsPerTick: 50_000, bounds: { minDays: 1, maxDays: null }, lastRun: null, nextRunAt: null });
      expect(await makeService(store).effectiveRetention("any-project", "usage")).toEqual({ days: 0, source: "deployment", setting: "USAGE_EVENTS_RETENTION_DAYS" });
    }, 60_000);
  });
}

describe("resolveRetentionSettings", () => {
  it("defaults keep everything new and cap a purge at 50 000 rows per table", () => {
    expect(resolveRetentionSettings({ USAGE_EVENTS_RETENTION_DAYS: 0 })).toEqual({
      maxRowsPerTick: 50_000,
      minDays: 1,
      maxDays: null,
      agentMemoryDays: 0,
      aiGatewayRequestDays: 0,
      usageEventDays: 0
    });
  });

  it("refuses a maximum below the minimum", () => {
    expect(() => resolveRetentionSettings({ USAGE_EVENTS_RETENTION_DAYS: 0, RETENTION_MIN_DAYS: 30, RETENTION_MAX_DAYS: 7 })).toThrow(/RETENTION_MAX_DAYS \(7\) is below RETENTION_MIN_DAYS \(30\)/);
  });
});
