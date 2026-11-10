/**
 * 13.3 R1 — store contract: per-project retention on both stores. Purges and counts narrowed to one project
 * (`projectId`) or to everything but some projects (`excludeProjects`), for each way a table's rows belong to a project
 * (own column, the workflow's project, the agent-memory session key); the stored per-project values; and the eval runs
 * that back a published version.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { RETENTION_PROJECT_KEYS, projectNamespacePrefix, type RetentionTable } from "../retention-tables.js";
import type { Store } from "../store.js";

const OLD = "2001-01-01T00:00:00.000Z";
const NEW = "2100-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";

async function project(store: Store, id: string): Promise<void> {
  await store.upsertProject({ id, name: `Project ${id}`, createdBy: "ana" });
}

async function workflow(store: Store, id: string, projectId: string): Promise<void> {
  await store.upsertWorkflow({ id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId } as never);
}

/** One old row of `table` owned as given: by its project column, its workflow, or its session key. */
function ownedRow(table: RetentionTable, tag: string, owner: { projectId?: string | null; workflowId?: string; namespace?: string }): string {
  const project = owner.projectId === undefined || owner.projectId === null ? "NULL" : `'${owner.projectId}'`;
  const workflowId = owner.workflowId ?? "wf-none";
  const namespace = owner.namespace ?? "ns";
  switch (table) {
    case "execution_history":
      return `INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('${tag}', '${workflowId}', 'success', '${OLD}')`;
    case "mcp_tool_calls":
      return `INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok, created_at, project_id)
        VALUES ('${tag}', 'run', '${workflowId}', 'n', 'http-mcp', 't', '${OLD}', 1, '${OLD}', ${project})`;
    case "guard_events":
      return `INSERT INTO guard_events (id, verdict_id, execution_id, node_id, placement, channel, requested_action, effective_action, verdict_action,
        profile_id, profile_version, profile_hash, created_at, project_id)
        VALUES ('${tag}', 'v', 'run', 'n', 'input', 'prompt', 'allow', 'allow', 'allow', 'p', 1, 'h', '${OLD}', ${project})`;
    case "approval_requests":
      return `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at)
        VALUES ('${tag}', 'run', '${workflowId}', ${owner.projectId ? `'${owner.projectId}'` : "'default'"}, 'gate', 'approval_gate', 'approved', '{}', '${OLD}', '${OLD}')`;
    case "mcp_cassettes":
      return `INSERT INTO mcp_cassettes (id, execution_id, workflow_id, project_id, cassette_json, created_at) VALUES ('${tag}', 'run', '${workflowId}', ${project}, '{}', '${OLD}')`;
    case "mcp_gateway_approvals":
      return `INSERT INTO mcp_gateway_approvals (id, client_id, toolset_id, server_id, tool_name, gateway_tool_name, args_hash, status, requested_at, expires_at, project_id)
        VALUES ('${tag}', 'c', 'ts', 's', 't', 'gt', 'h-${tag}', 'approved', '${OLD}', '${OLD}', ${project})`;
    case "execution_queue":
      return `INSERT INTO execution_queue (id, workflow_id, payload_json, status, attempts, max_attempts, scheduled_at, created_at, updated_at)
        VALUES ('${tag}', '${workflowId}', '{}', 'completed', 1, 3, '${OLD}', '${OLD}', '${OLD}')`;
    case "execution_queue_dlq":
      return `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, payload_json, attempts, final_error, failed_at, created_at)
        VALUES ('${tag}', 'q', '${workflowId}', '{}', 3, 'x', '${OLD}', '${OLD}')`;
    case "session_memory":
      return `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('${namespace}', '${tag}', '[]', '${OLD}', '${OLD}')`;
    case "session_artifacts":
      return `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, created_at, updated_at)
        VALUES ('${namespace}', 's', '${tag}', '{}', '${OLD}', '${OLD}')`;
    case "session_tool_cache":
      return `INSERT INTO session_tool_cache (id, namespace, session_id, tool_name, args_json, output_json, created_at)
        VALUES ('${tag}', '${namespace}', 's', 't', '{}', '{}', '${OLD}')`;
    default:
      throw new Error(`No owned row for ${table}`);
  }
}

const NAME_COLUMN: Partial<Record<RetentionTable, string>> = { session_memory: "session_id", session_artifacts: "artifact_key" };

describeStoreContract("store contract: per-project retention", (ctx) => {
  async function seed(statements: string[]): Promise<void> {
    const sql = testSql(ctx.store());
    for (const statement of statements) await sql.run(statement);
  }

  async function names(table: RetentionTable): Promise<string[]> {
    const column = NAME_COLUMN[table] ?? "id";
    const rows = await testSql(ctx.store()).all<{ name: string }>(`SELECT ${column} AS name FROM ${table} ORDER BY ${column}`);
    return rows.map((row) => String(row.name));
  }

  async function twoProjects(store: Store): Promise<void> {
    await project(store, "proj-a");
    await project(store, "proj-b");
    await workflow(store, "wf-a", "proj-a");
    await workflow(store, "wf-b", "proj-b");
  }

  /** For each project-owned table: a row of proj-a, one of proj-b, and one of no project where the table has such rows. */
  function rowsPerProject(table: RetentionTable): string[] {
    const key = RETENTION_PROJECT_KEYS[table];
    if (key === "namespace") {
      return [
        ownedRow(table, "a-scoped", { namespace: `${projectNamespacePrefix("proj-a")}support` }),
        ownedRow(table, "a-legacy", { namespace: "wf-a:agent-1" }),
        ownedRow(table, "b-scoped", { namespace: `${projectNamespacePrefix("proj-b")}support` }),
        ownedRow(table, "none", { namespace: "custom-namespace" })
      ];
    }
    if (key === "workflow") {
      return [ownedRow(table, "a-1", { workflowId: "wf-a" }), ownedRow(table, "b-1", { workflowId: "wf-b" }), ownedRow(table, "none", { workflowId: "wf-gone" })];
    }
    const rows = [ownedRow(table, "a-1", { projectId: "proj-a", workflowId: "wf-a" }), ownedRow(table, "b-1", { projectId: "proj-b", workflowId: "wf-b" })];
    // approval_requests.project_id is NOT NULL; every other project column may be empty.
    if (table !== "approval_requests") rows.push(ownedRow(table, "none", { projectId: null }));
    return rows;
  }

  it("every project-owned table: one project's rows, then everything but that project's", async () => {
    const store = ctx.store();
    await twoProjects(store);
    const tables = Object.keys(RETENTION_PROJECT_KEYS) as RetentionTable[];
    await seed(tables.flatMap(rowsPerProject));
    for (const table of tables) {
      const aRows = RETENTION_PROJECT_KEYS[table] === "namespace" ? ["a-legacy", "a-scoped"] : ["a-1"];
      expect(await store.countRetentionDue(table, { before: CUT, cap: 100, projectId: "proj-a" }), table).toBe(aRows.length);
      expect(await store.countRetentionDue(table, { before: CUT, cap: 100, excludeProjects: ["proj-a"] }), table).toBe(
        (await names(table)).length - aRows.length
      );
      // Only rows of proj-a go; proj-b's and those of no project stay.
      expect(await store.pruneRetentionTable(table, { before: CUT, limit: 100, projectId: "proj-a" }), table).toBe(aRows.length);
      expect((await names(table)).some((name) => aRows.includes(name)), table).toBe(false);
      // Everyone but proj-b: the rows of no project go, proj-b's stay.
      await store.pruneRetentionTable(table, { before: CUT, limit: 100, excludeProjects: ["proj-b"] });
      expect(await names(table), table).toEqual(["b-1", "b-scoped"].filter((name) => rowsPerProject(table).some((sql) => sql.includes(`'${name}'`))));
    }
  });

  it("several excluded projects, the age cut-off and the limit still apply", async () => {
    const store = ctx.store();
    await twoProjects(store);
    await project(store, "proj-c");
    await seed([
      ownedRow("guard_events", "a-1", { projectId: "proj-a" }),
      ownedRow("guard_events", "b-1", { projectId: "proj-b" }),
      ownedRow("guard_events", "c-1", { projectId: "proj-c" }),
      ownedRow("guard_events", "c-2", { projectId: "proj-c" }),
      ownedRow("guard_events", "c-3", { projectId: "proj-c" }),
      `INSERT INTO guard_events (id, verdict_id, execution_id, node_id, placement, channel, requested_action, effective_action, verdict_action,
        profile_id, profile_version, profile_hash, created_at, project_id)
        VALUES ('c-new', 'v', 'run', 'n', 'input', 'prompt', 'allow', 'allow', 'allow', 'p', 1, 'h', '${NEW}', 'proj-c')`
    ]);
    expect(await store.pruneRetentionTable("guard_events", { before: CUT, limit: 2, excludeProjects: ["proj-a", "proj-b"] })).toBe(2);
    expect(await store.pruneRetentionTable("guard_events", { before: CUT, limit: 100, excludeProjects: ["proj-a", "proj-b"] })).toBe(1);
    expect(await names("guard_events")).toEqual(["a-1", "b-1", "c-new"]);
  });

  it("runs follow their workflow's project now: a moved workflow's runs go with its new project", async () => {
    const store = ctx.store();
    await twoProjects(store);
    await seed([ownedRow("execution_history", "run-a", { workflowId: "wf-a" })]);
    await workflow(store, "wf-a", "proj-b");
    expect(await store.pruneRetentionTable("execution_history", { before: CUT, limit: 10, projectId: "proj-a" })).toBe(0);
    expect(await store.pruneRetentionTable("execution_history", { before: CUT, limit: 10, excludeProjects: ["proj-b"] })).toBe(0);
    expect(await store.pruneRetentionTable("execution_history", { before: CUT, limit: 10, projectId: "proj-b" })).toBe(1);
  });

  it("a project id with LIKE characters matches only its own session keys", async () => {
    const store = ctx.store();
    await project(store, "p_1");
    await project(store, "px1");
    await seed([
      ownedRow("session_memory", "under", { namespace: `${projectNamespacePrefix("p_1")}ns` }),
      ownedRow("session_memory", "other", { namespace: `${projectNamespacePrefix("px1")}ns` })
    ]);
    expect(await store.pruneRetentionTable("session_memory", { before: CUT, limit: 10, projectId: "p_1" })).toBe(1);
    expect(await names("session_memory")).toEqual(["other"]);
  });

  it("refuses a project condition on a table no project owns", async () => {
    const store = ctx.store();
    await expect(store.pruneRetentionTable("usage_events", { before: CUT, limit: 10, projectId: "proj-a" })).rejects.toThrow(/belong to no project/);
    await expect(store.countRetentionDue("ai_gateway_requests", { before: CUT, cap: 10, excludeProjects: ["proj-a"] })).rejects.toThrow(
      /belong to no project/
    );
  });

  it("stores, replaces and clears a project's values, and a project delete removes them", async () => {
    const store = ctx.store();
    await twoProjects(store);
    expect(await store.listRetentionPolicies()).toEqual([]);
    expect(await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 7, rule_events: 400 }, updatedBy: "ana@example.com" })).toEqual([]);
    await store.setRetentionPolicies({ scopeId: "proj-b", values: { agent_memory: 30 }, updatedBy: null });
    const all = await store.listRetentionPolicies();
    expect(all.map((policy) => [policy.scopeId, policy.dataClass, policy.days])).toEqual([
      ["proj-a", "rule_events", 400],
      ["proj-a", "runs", 7],
      ["proj-b", "agent_memory", 30]
    ]);
    expect(all[0]).toMatchObject({ scopeType: "project", updatedBy: "ana@example.com" });
    expect(Number.isNaN(Date.parse(all[0].updatedAt))).toBe(false);

    // Replace one, clear one, leave the rest; the values before the change come back.
    const before = await store.setRetentionPolicies({ scopeId: "proj-a", values: { runs: 14, rule_events: null }, updatedBy: "bo" });
    expect(before.map((policy) => [policy.dataClass, policy.days])).toEqual([
      ["rule_events", 400],
      ["runs", 7]
    ]);
    expect((await store.listRetentionPolicies({ scopeId: "proj-a" })).map((policy) => [policy.dataClass, policy.days, policy.updatedBy])).toEqual([
      ["runs", 14, "bo"]
    ]);

    await testSql(store).run(`DELETE FROM workflows WHERE id = 'wf-b'`);
    expect(await store.deleteProject("proj-b")).toBe(true);
    expect((await store.listRetentionPolicies()).map((policy) => policy.scopeId)).toEqual(["proj-a"]);
  });

  it("ignores stored rows of another scope or an unknown class", async () => {
    const store = ctx.store();
    await seed([
      `INSERT INTO retention_policies (id, scope_type, scope_id, data_class, days, updated_at) VALUES ('x1', 'organization', 'org', 'runs', 5, '${OLD}')`,
      `INSERT INTO retention_policies (id, scope_type, scope_id, data_class, days, updated_at) VALUES ('x2', 'project', 'proj-a', 'usage', 5, '${OLD}')`
    ]);
    expect(await store.listRetentionPolicies()).toEqual([]);
  });

  it("names the run ids that still have history", async () => {
    const store = ctx.store();
    await seed([ownedRow("execution_history", "run-1", {}), ownedRow("execution_history", "run-2", {})]);
    expect((await store.listExistingExecutionIds(["run-2", "gone", "run-1", "run-1"])).sort()).toEqual(["run-1", "run-2"]);
    expect(await store.listExistingExecutionIds([])).toEqual([]);
  });

  it("keeps the eval runs behind a workflow's current and previous published versions", async () => {
    const store = ctx.store();
    await workflow(store, "wf-1", "default");
    for (let version = 1; version <= 3; version += 1) {
      await store.appendWorkflowVersion({ id: `wf-1-v${version}`, workflowId: "wf-1", workflowJson: JSON.stringify({ id: "wf-1", version }), retention: 0 });
    }
    const release = (id: string, version: number, replayRunId: string | null) => ({
      id,
      workflowId: "wf-1",
      version,
      workflowHash: `hash-${version}`,
      replayRunId,
      verdict: "pass",
      reason: null,
      gateReasons: ["ok"],
      approval: null,
      publishedAt: new Date(Date.UTC(2026, 0, version)).toISOString(),
      publishedBy: "ana",
      publishedByUserId: "u-ana"
    });
    // One set, oldest first: ev-5 stays as the set's newest run whatever happens.
    for (const id of ["ev-1", "ev-2", "ev-3", "ev-4", "ev-5"]) {
      await store.createEvalRun({ id, datasetId: "set-x", workflowId: "wf-1" });
      await store.finalizeEvalRun({ id, status: "completed" });
    }
    expect(await store.publishWorkflowVersion(release("rel-1", 1, "ev-1"), null)).not.toBeNull();
    expect(await store.publishWorkflowVersion(release("rel-2", 2, "ev-2"), 1)).not.toBeNull();
    expect(await store.publishWorkflowVersion(release("rel-3", 3, "ev-3"), 2)).not.toBeNull();
    // v3 is published now and v2 before it: their evidence stays. v1's (ev-1) and ev-4 (no release) go.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await store.pruneEvalRuns({ before: future })).toBe(2);
    expect((await store.listEvalRuns()).map((run) => run.id).sort()).toEqual(["ev-2", "ev-3", "ev-5"]);
  });
});
