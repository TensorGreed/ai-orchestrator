/**
 * 13.3 R1 — per-project retention in the retention service, on both stores (Postgres when TEST_POSTGRES_URL is set):
 * resolving a class's days (inherit, override, bounds), two projects each keeping their own runs, rule events kept
 * longer than the runs they came from, agent memory per project, the row cap shared across a class's passes, the
 * backlog and the admin page's list of projects with their own values.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveRetentionSettings, type AppConfig } from "../config.js";
import { projectNamespacePrefix } from "../db/retention-tables.js";
import type { Store } from "../db/store.js";
import { RetentionService, type RetentionServiceOptions, type RetentionStep } from "./retention-service.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind } from "../test-support/test-store.js";
import { testSql } from "../test-support/test-sql.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

type Bounds = Partial<Pick<AppConfig, "RETENTION_MIN_DAYS" | "RETENTION_MAX_DAYS" | "RETENTION_MAX_ROWS_PER_TICK" | "AGENT_MEMORY_RETENTION_DAYS">>;

function makeService(store: Store, options: Partial<RetentionServiceOptions> & { env?: Bounds } = {}): RetentionService {
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

const run = (id: string, workflowId: string, at: string) =>
  `INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('${id}', '${workflowId}', 'success', '${at}')`;
const ruleEvent = (id: string, executionId: string, projectId: string, at: string) =>
  `INSERT INTO guard_events (id, verdict_id, execution_id, node_id, placement, channel, requested_action, effective_action, verdict_action,
    profile_id, profile_version, profile_hash, created_at, project_id)
    VALUES ('${id}', 'v', '${executionId}', 'n', 'input', 'prompt', 'allow', 'allow', 'allow', 'p', 1, 'h', '${at}', '${projectId}')`;
const memory = (sessionId: string, namespace: string, at: string) =>
  `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('${namespace}', '${sessionId}', '[]', '${at}', '${at}')`;

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("retention service per project");

for (const kind of kinds) {
  describe(`retention service per project [${kind}]`, () => {
    const opened: TestStore[] = [];
    afterEach(async () => {
      for (const test of opened.splice(0)) await test.cleanup().catch(() => undefined);
    }, 60_000);

    async function open(): Promise<Store> {
      const test = await createTestStore({ kind });
      opened.push(test);
      const store = test.store;
      for (const id of ["proj-a", "proj-b"]) await store.upsertProject({ id, name: `Project ${id}`, createdBy: "ana" });
      for (const [id, projectId] of [
        ["wf-a", "proj-a"],
        ["wf-b", "proj-b"],
        ["wf-d", "default"]
      ]) {
        await store.upsertWorkflow({ id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId } as never);
      }
      return store;
    }

    async function seed(store: Store, statements: string[]): Promise<void> {
      const sql = testSql(store);
      for (const statement of statements) await sql.run(statement);
    }

    async function ids(store: Store, table: string, column = "id"): Promise<string[]> {
      const rows = await testSql(store).all<{ id: string }>(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`);
      return rows.map((row) => String(row.id));
    }

    it("resolves a class: the deployment's value, a project's own, and a stored value outside today's bounds", async () => {
      const store = await open();
      const service = makeService(store, { env: { RETENTION_MIN_DAYS: 5, RETENTION_MAX_DAYS: 400 } });
      expect(await service.effectiveRetention("proj-a", "runs")).toEqual({ days: 30, source: "deployment", setting: "EXECUTION_HISTORY_RETENTION_DAYS" });
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7, rule_events: 1000, agent_memory: 0 }, updatedBy: "ana" });
      // runs governs the classes that go with runs.
      expect(await service.effectiveRetention("proj-a", "runs")).toMatchObject({ days: 7, source: "project" });
      expect(await service.effectiveRetention("proj-a", "queue")).toMatchObject({ days: 7, source: "project" });
      expect(await service.effectiveRetention("proj-a", "cassettes_approvals")).toMatchObject({ days: 7, source: "project" });
      // Saved before the maximum was lowered: the maximum applies; keep-forever under a maximum is the maximum.
      expect(await service.effectiveRetention("proj-a", "rule_events")).toMatchObject({ days: 400, source: "project" });
      expect(await service.effectiveRetention("proj-a", "agent_memory")).toMatchObject({ days: 400, source: "project" });
      // Classes only the deployment sets, rows of no project and other projects inherit.
      expect(await service.effectiveRetention("proj-a", "usage")).toMatchObject({ source: "deployment" });
      expect(await service.effectiveRetention(null, "runs")).toMatchObject({ days: 30, source: "deployment" });
      expect(await service.effectiveRetention("proj-b", "runs")).toMatchObject({ days: 30, source: "deployment" });

      const view = await service.projectView("proj-a", true);
      expect(view.bounds).toEqual({ minDays: 5, maxDays: 400 });
      expect(view.classes.map((entry) => [entry.class, entry.days, entry.effectiveDays, entry.clamped])).toEqual([
        ["runs", 7, 7, false],
        ["tool_calls", null, 30, false],
        ["rule_events", 1000, 400, true],
        ["agent_memory", 0, 400, true]
      ]);
      expect(view.classes[1]).toMatchObject({ deploymentDays: 30, deploymentSetting: "EXECUTION_HISTORY_RETENTION_DAYS" });
    });

    it("two projects keep their own runs; the rest follow the deployment", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7 }, updatedBy: "ana" });
      await store.setRetentionPolicies({ scopeId: "proj-b", values: { runs: 365 }, updatedBy: "ana" });
      await seed(store, [
        run("a-10d", "wf-a", daysAgo(10)),
        run("a-3d", "wf-a", daysAgo(3)),
        run("b-100d", "wf-b", daysAgo(100)),
        run("b-400d", "wf-b", daysAgo(400)),
        run("d-40d", "wf-d", daysAgo(40)),
        run("d-10d", "wf-d", daysAgo(10))
      ]);
      const result = await makeService(store).tick("manual");
      expect(result).toMatchObject({ status: "ran", deleted: 3 });
      expect(await ids(store, "execution_history")).toEqual(["a-3d", "b-100d", "d-10d"]);
    });

    it("a project's own value applies when the deployment keeps the class forever", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7 }, updatedBy: "ana" });
      await seed(store, [run("a-10d", "wf-a", daysAgo(10)), run("d-1000d", "wf-d", daysAgo(1000))]);
      await makeService(store, { executionHistoryDays: 0 }).tick("manual");
      expect(await ids(store, "execution_history")).toEqual(["d-1000d"]);
    });

    it("a project that keeps a class forever keeps it while the deployment purges", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 0 }, updatedBy: "ana" });
      await seed(store, [run("a-1000d", "wf-a", daysAgo(1000)), run("d-40d", "wf-d", daysAgo(40))]);
      await makeService(store).tick("manual");
      expect(await ids(store, "execution_history")).toEqual(["a-1000d"]);
    });

    it("rule events kept longer than runs outlive the run they came from", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7, rule_events: 400 }, updatedBy: "ana" });
      await seed(store, [run("a-run", "wf-a", daysAgo(60)), ruleEvent("ev-a", "a-run", "proj-a", daysAgo(60)), ruleEvent("ev-a-old", "gone", "proj-a", daysAgo(500))]);
      await makeService(store).tick("manual");
      expect(await ids(store, "execution_history")).toEqual([]);
      expect(await ids(store, "guard_events")).toEqual(["ev-a"]);
      expect(await store.listExistingExecutionIds(["a-run"])).toEqual([]);
    });

    it("agent memory per project: scoped keys, a workflow's older keys, and keys of no project", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { agent_memory: 7 }, updatedBy: "ana" });
      await seed(store, [
        memory("a-scoped", `${projectNamespacePrefix("proj-a")}support`, daysAgo(10)),
        memory("a-legacy", "wf-a:agent", daysAgo(10)),
        memory("b-scoped", `${projectNamespacePrefix("proj-b")}support`, daysAgo(10)),
        memory("custom", "shared-namespace", daysAgo(10))
      ]);
      // The deployment keeps agent memory (unset): only proj-a's go.
      await makeService(store).tick("manual");
      expect(await ids(store, "session_memory", "session_id")).toEqual(["b-scoped", "custom"]);
    });

    it("the row cap holds per table across a class's passes", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7 }, updatedBy: "ana" });
      const rows = [
        ...Array.from({ length: 700 }, (_, i) => run(`a-${String(i).padStart(4, "0")}`, "wf-a", daysAgo(10))),
        ...Array.from({ length: 700 }, (_, i) => run(`d-${String(i).padStart(4, "0")}`, "wf-d", daysAgo(40)))
      ];
      await seed(store, rows);
      const service = makeService(store, { env: { RETENTION_MAX_ROWS_PER_TICK: 1000 } });
      const first = await service.tick("manual");
      expect(first.status === "ran" && first.run.counts.runs).toBe(1000);
      expect(first.status === "ran" && first.run.capped).toContain("runs");
      expect((await service.view()).classes.find((entry) => entry.class === "runs")?.backlog).toBe(400);
      await service.tick("manual");
      expect(await ids(store, "execution_history")).toEqual([]);
    }, 60_000);

    it("the backlog counts each project's own cutoff; the admin page lists projects with their own values", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7, tool_calls: 90 }, updatedBy: "ana" });
      await seed(store, [run("a-10d", "wf-a", daysAgo(10)), run("d-10d", "wf-d", daysAgo(10)), run("d-40d", "wf-d", daysAgo(40))]);
      const view = await makeService(store).view();
      expect(view.classes.find((entry) => entry.class === "runs")).toMatchObject({ days: 30, backlog: 2 });
      expect(view.projectOverrides).toEqual([{ projectId: "proj-a", projectName: "Project proj-a", classes: { runs: 7, tool_calls: 90 } }]);
    });

    it("skips the classes projects can set when their values cannot be read, and purges the rest", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 400 }, updatedBy: "ana" });
      await seed(store, [run("a-40d", "wf-a", daysAgo(40))]);
      const failing = new Proxy(store, {
        get(target, property, receiver) {
          if (property === "listRetentionPolicies") return async () => Promise.reject(new Error("db down"));
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
      });
      const result = await makeService(failing as Store).tick("manual");
      expect(result.status === "ran" && result.run.outcome).toBe("partial");
      expect(result.status === "ran" && result.run.error).toMatch(/project values: db down/);
      expect(await ids(store, "execution_history")).toEqual(["a-40d"]);
    });

    it("skips a class whose registered purge cannot apply project values while a project has one", async () => {
      const store = await open();
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 400 }, updatedBy: "ana" });
      const calls: unknown[] = [];
      const service = makeService(store);
      const unscoped: RetentionStep = {
        class: "runs",
        setting: "EXECUTION_HISTORY_RETENTION_DAYS",
        days: () => 30,
        async run(input) {
          calls.push(input);
          return { deleted: 0, capped: false };
        }
      };
      service.register(unscoped);
      const result = await service.tick("manual");
      expect(calls).toEqual([]);
      expect(result.status === "ran" && result.run.error).toMatch(/runs: skipped/);
    });
  });
}
