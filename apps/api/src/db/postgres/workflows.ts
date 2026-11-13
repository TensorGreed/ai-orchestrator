/**
 * Phase 13.1 — PostgresStore: Workflows, folders, projects, templates, workflow versions and workflow shares.
 * Plain functions over a PgContext; PostgresStore delegates here. Every method is implemented.
 */
import { DEFAULT_PROJECT_ID, keepPinnedDataMarks, type Folder, type Project, type Workflow, type WorkflowListItem } from "@ai-orchestrator/shared";
import type { PoolClient } from "pg";
import { ProjectNotEmptyError } from "../store-errors.js";
import { type Store } from "../store.js";
import { parseTagsJson, toNum, toStr } from "./helpers.js";
import { gateStateForWrite } from "./release.js";
import { legalHoldsOnWith, refuseIfHeld } from "./legal-holds.js";
import { LEGAL_HOLD_LOCK_SHARED_SQL } from "../legal-hold-sql.js";
import type { PgContext } from "./context.js";

// Workflow methods
type WorkflowListRow = {
  id: string;
  name: string;
  schema_version: string;
  workflow_version: number;
  created_at: string;
  updated_at: string;
  tags_json: string | null;
  project_id: string | null;
  folder_id: string | null;
};

const WORKFLOW_LIST_COLUMNS = "id, name, schema_version, workflow_version, created_at, updated_at, tags_json, project_id, folder_id";

function workflowListWhere(options: { projectId?: string; folderId?: string | null; search?: string; workflowIds?: string[] }): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.projectId) {
    params.push(DEFAULT_PROJECT_ID, options.projectId);
    clauses.push(`COALESCE(project_id, $${params.length - 1}) = $${params.length}`);
  }
  if (options.folderId === null) {
    clauses.push(`(folder_id IS NULL OR folder_id = '')`);
  } else if (typeof options.folderId === "string") {
    params.push(options.folderId);
    clauses.push(`folder_id = $${params.length}`);
  }
  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    clauses.push(`LOWER(name) LIKE $${params.length}`);
  }
  if (options.workflowIds) {
    if (options.workflowIds.length === 0) {
      clauses.push("1 = 0");
    } else {
      params.push(options.workflowIds);
      clauses.push(`id = ANY($${params.length}::text[])`);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function workflowListItemFromRow(row: WorkflowListRow): WorkflowListItem {
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    schemaVersion: toStr(row.schema_version),
    workflowVersion: toNum(row.workflow_version),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
    tags: parseTagsJson(row.tags_json),
    projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
    folderId: row.folder_id ? toStr(row.folder_id) : undefined
  };
}

function filterWorkflowsByTag(items: WorkflowListItem[], tag: string | undefined): WorkflowListItem[] {
  if (!tag || !tag.trim()) return items;
  const needle = tag.trim().toLowerCase();
  return items.filter((item) => (item.tags ?? []).some((value) => value.toLowerCase() === needle));
}

export async function listWorkflows(ctx: PgContext, options: {
  projectId?: string;
  folderId?: string | null;
  tag?: string;
  search?: string;
} = {}): Promise<WorkflowListItem[]> {
  const { where, params } = workflowListWhere(options);
  const rows = await ctx.query<WorkflowListRow>(
    `SELECT ${WORKFLOW_LIST_COLUMNS}
       FROM workflows
       ${where}
       ORDER BY updated_at DESC`,
    params
  );
  return filterWorkflowsByTag(rows.map(workflowListItemFromRow), options.tag);
}

export async function listWorkflowsPage(ctx: PgContext, options: Parameters<Store["listWorkflowsPage"]>[0]): ReturnType<Store["listWorkflowsPage"]> {
  const { where, params } = workflowListWhere(options);
  const select = `SELECT ${WORKFLOW_LIST_COLUMNS} FROM workflows ${where} ORDER BY updated_at DESC, id ASC`;
  if (options.tag && options.tag.trim()) {
    // The tag is matched on the parsed tag list, as listWorkflows does, so this filter runs here.
    const matched = filterWorkflowsByTag((await ctx.query<WorkflowListRow>(select, params)).map(workflowListItemFromRow), options.tag);
    return { items: matched.slice(options.offset, options.offset + options.limit), total: matched.length };
  }
  const count = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM workflows ${where}`, params);
  const rows = await ctx.query<WorkflowListRow>(`${select} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, options.limit, options.offset]);
  return { items: rows.map(workflowListItemFromRow), total: count ? toNum(count.count) : 0 };
}

export async function renameWorkflowTag(ctx: PgContext, workflowIds: string[], from: string, to: string | null): Promise<string[]> {
  if (workflowIds.length === 0) return [];
  return ctx.withTransaction(async (client) => {
    // Rows are locked in id order, so two renames over the same workflows never wait on each other in a cycle.
    const rows = await client.query<{ id: string; tags_json: string | null }>(
      `SELECT id, tags_json FROM workflows WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,
      [workflowIds]
    );
    const updatedAt = new Date().toISOString();
    const changed: string[] = [];
    for (const row of rows.rows) {
      const tags = parseTagsJson(row.tags_json) ?? [];
      if (!tags.includes(from)) continue;
      const next = [...new Set(tags.flatMap((tag) => (tag === from ? (to === null ? [] : [to]) : [tag])))];
      await client.query(`UPDATE workflows SET tags_json = $1, updated_at = $2 WHERE id = $3`, [JSON.stringify(next), updatedAt, row.id]);
      changed.push(toStr(row.id));
    }
    return changed;
  });
}

export async function getWorkflow(ctx: PgContext, id: string): Promise<Workflow | null> {
  const row = await ctx.queryOne<{
    id: string;
    workflow_json: string;
    created_at: string;
    updated_at: string;
    tags_json: string | null;
    project_id: string | null;
    folder_id: string | null;
  }>(
    `SELECT id, workflow_json, created_at, updated_at, tags_json, project_id, folder_id FROM workflows WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  const parsed = JSON.parse(toStr(row.workflow_json)) as Workflow;
  parsed.createdAt = toStr(row.created_at);
  parsed.updatedAt = toStr(row.updated_at);
  const tagsFromCol = parseTagsJson(row.tags_json);
  if (tagsFromCol !== undefined) parsed.tags = tagsFromCol;
  parsed.projectId = row.project_id ? toStr(row.project_id) : (parsed.projectId ?? DEFAULT_PROJECT_ID);
  parsed.folderId = row.folder_id ? toStr(row.folder_id) : undefined;
  return parsed;
}

/** `options.createdBy` (a user id) is stored only when the row is first inserted (Phase 10.2). */
export async function upsertWorkflow(ctx: PgContext, workflow: Workflow, options: { createdBy?: string | null } = {}): Promise<Workflow> {
  const now = new Date().toISOString();
  const existing = await ctx.store.getWorkflow(workflow.id);
  const createdAt = existing?.createdAt ?? now;
  const payload: Workflow = {
    // v74 — a pin copied from a sensitive run keeps its mark while its data is unchanged, whatever the client sent.
    ...keepPinnedDataMarks(existing, workflow),
    projectId: workflow.projectId ?? existing?.projectId ?? DEFAULT_PROJECT_ID,
    folderId: workflow.folderId ?? existing?.folderId,
    tags: Array.isArray(workflow.tags) ? workflow.tags.filter((t) => typeof t === "string") : existing?.tags,
    createdAt,
    updatedAt: now
  };
  const sql = `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at, tags_json, project_id, folder_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         schema_version = EXCLUDED.schema_version,
         workflow_version = EXCLUDED.workflow_version,
         workflow_json = EXCLUDED.workflow_json,
         updated_at = EXCLUDED.updated_at,
         tags_json = EXCLUDED.tags_json,
         project_id = EXCLUDED.project_id,
         folder_id = EXCLUDED.folder_id`;
  const params = [
    payload.id,
    payload.name,
    payload.schemaVersion,
    payload.workflowVersion,
    JSON.stringify(payload),
    createdAt,
    now,
    JSON.stringify(payload.tags ?? []),
    payload.projectId ?? DEFAULT_PROJECT_ID,
    payload.folderId ?? null,
    options.createdBy ?? null
  ];
  if (!existing) {
    await ctx.execute(sql, params);
    return payload;
  }
  // 13.3 — a held workflow's runs reach their project through the workflow, so it cannot leave a held project (or
  // move at all while a hold covers it or its rows). The hold check and the write share one transaction under the
  // legal-hold lock, read against the row as it is now.
  await ctx.withTransaction(async (client) => {
    // The lock first, before the row lock, as every hold-checked delete does.
    await client.query(LEGAL_HOLD_LOCK_SHARED_SQL);
    const current = await client.query<{ project_id: string | null }>(`SELECT project_id FROM workflows WHERE id = $1 FOR UPDATE`, [payload.id]);
    const currentProject = current.rows[0] ? (current.rows[0].project_id ?? DEFAULT_PROJECT_ID) : null;
    if (currentProject !== null && currentProject !== payload.projectId) {
      await refuseIfHeld(client, { kind: "workflow", id: payload.id }, "This workflow", "moved to another project");
    }
    await client.query(sql, params);
  });
  return payload;
}

export async function deleteWorkflow(ctx: PgContext, id: string, options: { refuseIfGateEnforced?: boolean } = {}): Promise<boolean> {
  // Read before the row goes: its nodes name its legacy session namespaces.
  const legacyNamespaces = ((await ctx.store.getWorkflow(id))?.nodes ?? []).map((node) => `${id}:${node.id}`);
  return ctx.withTransaction(async (client) => {
    const run = (sql: string, params: unknown[]) => client.query(sql, params);
    // 13.3 — first, before any row lock: nothing goes while a legal hold keeps the workflow, its project, or any of its
    // runs or golden runs (the lock is held to commit, so no hold is placed in between).
    await refuseIfHeld(client, { kind: "workflow", id }, "This workflow");
    // The workflow row is locked first, as a publish, an unpublish or a gate save does (workflow row, then the rest), so
    // a delete never holds a workflow version row while waiting for the workflow row. With `refuseIfGateEnforced` the
    // gate is then read before anything goes; a gate save holds the workflow row while it writes, so it is seen.
    // A workflow that is already gone is not refused: the delete finds nothing and the caller answers 404.
    // Retention pruning never waits for the rows this delete holds (it skips them, prune.ts), so the order of the
    // child tables below cannot deadlock with it.
    const locked = await run(`SELECT id FROM workflows WHERE id = $1 FOR UPDATE`, [id]);
    if (options.refuseIfGateEnforced && locked.rows.length > 0) await gateStateForWrite(client, id, true);
    await run(`DELETE FROM execution_history WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM workflow_executions WHERE workflow_id = $1`, [id]);
    // Phase 11.2 — decided requests stay as the audit trail; pending ones end with their paused run.
    const now = new Date().toISOString();
    await run(
      `UPDATE approval_requests SET status = 'canceled', reason = 'The workflow was deleted', decided_at = $1, updated_at = $1
         WHERE workflow_id = $2 AND status = 'pending'`,
      [now, id]
    );
    await run(`UPDATE approval_requests SET workflow_deleted_at = $1 WHERE workflow_id = $2 AND workflow_deleted_at IS NULL`, [now, id]);
    await run(`DELETE FROM mcp_cassettes WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM replay_recordings WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM replay_capture_settings WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM guard_events WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM guard_bindings WHERE scope = 'workflow' AND scope_id = $1`, [id]);
    // Workflow ids are chosen by the client, so a new workflow can reuse a deleted one's id: nothing keyed by the
    // old id may carry over (versions, shares, queue and dead-letter rows, eval runs, elicitations, and session state
    // under the old workflow's legacy default namespaces, exactly `<workflowId>:<nodeId>` for its nodes).
    await run(`DELETE FROM workflow_versions WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM workflow_shares WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM execution_queue WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM execution_queue_dlq WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM eval_results WHERE run_id IN (SELECT id FROM eval_runs WHERE workflow_id = $1)`, [id]);
    await run(`DELETE FROM eval_runs WHERE workflow_id = $1`, [id]);
    await run(`DELETE FROM mcp_elicitations WHERE workflow_id = $1`, [id]);
    // Phase 15.4 — the release gate and history outlive the workflow; pending release and gate case requests end.
    await run(
      `UPDATE release_approval_requests SET status = 'canceled', decided_by = 'system', decided_at = $1, decision_reason = 'The workflow was deleted', updated_at = $1
         WHERE workflow_id = $2 AND status = 'pending'`,
      [now, id]
    );
    await run(
      `UPDATE gate_case_requests SET status = 'canceled', decided_by = 'system', decided_at = $1, decision_reason = 'The workflow was deleted', updated_at = $1
         WHERE workflow_id = $2 AND status = 'pending'`,
      [now, id]
    );
    if (legacyNamespaces.length > 0) {
      for (const table of ["session_memory", "session_tool_cache", "session_artifacts"]) {
        await run(`DELETE FROM ${table} WHERE namespace = ANY($1::text[])`, [legacyNamespaces]);
      }
    }
    const result = await run(`DELETE FROM workflows WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  });
}

export async function countWorkflows(ctx: PgContext): Promise<number> {
  const row = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM workflows`);
  return row ? toNum(row.count) : 0;
}

export async function listProjects(ctx: PgContext): Promise<Project[]> {
  const rows = await ctx.query<{
    id: string;
    name: string;
    description: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }>(`SELECT id, name, description, created_by, created_at, updated_at FROM projects ORDER BY name COLLATE "C" ASC`);
  return rows.map((row) => ({
    id: toStr(row.id),
    name: toStr(row.name),
    description: row.description ? toStr(row.description) : undefined,
    createdBy: row.created_by ? toStr(row.created_by) : undefined,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  }));
}

export async function getProject(ctx: PgContext, id: string): Promise<Project | null> {
  const row = await ctx.queryOne<{
    id: string;
    name: string;
    description: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, description, created_by, created_at, updated_at FROM projects WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    description: row.description ? toStr(row.description) : undefined,
    createdBy: row.created_by ? toStr(row.created_by) : undefined,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function upsertProject(ctx: PgContext, input: {
  id: string;
  name: string;
  description?: string;
  createdBy?: string;
}): Promise<Project> {
  const now = new Date().toISOString();
  const existing = await ctx.store.getProject(input.id);
  const createdAt = existing?.createdAt ?? now;
  await ctx.execute(
    `INSERT INTO projects (id, name, description, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         updated_at = EXCLUDED.updated_at`,
    [input.id, input.name, input.description ?? null, input.createdBy ?? existing?.createdBy ?? null, createdAt, now]
  );
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    createdBy: input.createdBy ?? existing?.createdBy,
    createdAt,
    updatedAt: now
  };
}

export async function deleteProject(ctx: PgContext, id: string): Promise<boolean> {
  if (id === DEFAULT_PROJECT_ID) {
    throw new Error("Cannot delete the default project.");
  }
  // One transaction, so the project's own rows (folders, variables, memberships, shares) go together with it, and the
  // project row is locked against a concurrent delete or rename. The emptiness check is not atomic with writes into
  // the project: workflows, secrets and the other counted tables have no foreign key to projects, so a workflow saved
  // into this project between the count and the commit is left under a deleted project id. Accepted (as on SQLite
  // since the store went async); the route checks first and such a save is a race with an admin's delete.
  // user_project_roles has a foreign key to projects on Postgres, so its rows go before the project row.
  return ctx.withTransaction(async (client) => {
    const existing = await client.query(`SELECT id FROM projects WHERE id = $1`, [id]);
    if (existing.rows.length === 0) return false;
    await refuseIfHeld(client, { kind: "project", id }, "This project");
    await client.query(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [id]);
    // Never move a project's workflows or secrets into the default project.
    const count = async (table: string) =>
      toNum((await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = $1`, [id])).rows[0]?.count ?? 0);
    const counts = {
      workflows: await count("workflows"),
      secrets: await count("secrets"),
      knowledgeBases: await count("knowledge_bases"),
      mcpServers: await count("mcp_servers"),
      evalDatasets: await count("eval_datasets")
    };
    if (Object.values(counts).some((value) => value > 0)) throw new ProjectNotEmptyError(counts);
    await client.query(`DELETE FROM folders WHERE project_id = $1`, [id]);
    await client.query(`DELETE FROM variables WHERE project_id = $1`, [id]);
    await client.query(`DELETE FROM guard_bindings WHERE scope = 'project' AND scope_id = $1`, [id]);
    // 12.6 — a re-created project with the same id starts with no model allowlist.
    await client.query(`DELETE FROM model_allowlist_entries WHERE scope = 'project' AND project_id = $1`, [id]);
    // Memberships, roles and shares must not revive with a re-created id.
    for (const table of ["user_project_roles", "custom_roles", "workflow_shares", "secret_shares"]) {
      await client.query(`DELETE FROM ${table} WHERE project_id = $1`, [id]);
    }
    // 13.3 — and its retention values (a re-created project inherits the deployment's).
    await client.query(`DELETE FROM retention_policies WHERE scope_type = 'project' AND scope_id = $1`, [id]);
    await client.query(`DELETE FROM projects WHERE id = $1`, [id]);
    return true;
  });
}

export async function listFolders(ctx: PgContext, projectId?: string): Promise<Folder[]> {
  const rows = projectId
    ? await ctx.query<{
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders WHERE project_id = $1 ORDER BY name COLLATE "C" ASC`,
        [projectId]
      )
    : await ctx.query<{
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        created_at: string;
        updated_at: string;
      }>(`SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders ORDER BY project_id COLLATE "C", name COLLATE "C"`);
  return rows.map((row) => ({
    id: toStr(row.id),
    name: toStr(row.name),
    parentId: row.parent_id ? toStr(row.parent_id) : undefined,
    projectId: toStr(row.project_id),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  }));
}

export async function getFolder(ctx: PgContext, id: string): Promise<Folder | null> {
  const row = await ctx.queryOne<{
    id: string;
    name: string;
    parent_id: string | null;
    project_id: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    parentId: row.parent_id ? toStr(row.parent_id) : undefined,
    projectId: toStr(row.project_id),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function upsertFolder(ctx: PgContext, input: {
  id: string;
  name: string;
  parentId?: string;
  projectId: string;
}): Promise<Folder> {
  const now = new Date().toISOString();
  const existing = await ctx.store.getFolder(input.id);
  const createdAt = existing?.createdAt ?? now;
  await ctx.execute(
    `INSERT INTO folders (id, name, parent_id, project_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         parent_id = EXCLUDED.parent_id,
         project_id = EXCLUDED.project_id,
         updated_at = EXCLUDED.updated_at`,
    [input.id, input.name, input.parentId ?? null, input.projectId, createdAt, now]
  );
  return {
    id: input.id,
    name: input.name,
    parentId: input.parentId,
    projectId: input.projectId,
    createdAt,
    updatedAt: now
  };
}

export async function deleteFolder(ctx: PgContext, id: string): Promise<boolean> {
  const existing = await ctx.store.getFolder(id);
  if (!existing) return false;
  await ctx.execute(`UPDATE workflows SET folder_id = NULL WHERE folder_id = $1`, [id]);
  await ctx.execute(`UPDATE folders SET parent_id = $1 WHERE parent_id = $2`, [
    existing.parentId ?? null,
    id
  ]);
  await ctx.execute(`DELETE FROM folders WHERE id = $1`, [id]);
  return true;
}

export async function ensureDefaultProject(ctx: PgContext): Promise<Project> {
  const existing = await ctx.store.getProject(DEFAULT_PROJECT_ID);
  if (existing) {
    await ctx.execute(`UPDATE workflows SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    await ctx.execute(`UPDATE secrets SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    return existing;
  }
  const project = await ctx.store.upsertProject({
    id: DEFAULT_PROJECT_ID,
    name: "Default Project",
    description: "Personal workspace."
  });
  await ctx.execute(`UPDATE workflows SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
  await ctx.execute(`UPDATE secrets SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
  return project;
}

export async function listTemplates(ctx: PgContext, filters?: { category?: string; search?: string }): Promise<Array<{
  id: string; name: string; description: string; category: string;
  tags: string[]; author: string; nodeCount: number;
  createdAt: string; updatedAt: string;
}>> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;
  if (filters?.category) {
    clauses.push(`category = $${paramIdx++}`);
    params.push(filters.category);
  }
  if (filters?.search && filters.search.trim()) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    clauses.push(`(LOWER(name) LIKE $${paramIdx} OR LOWER(description) LIKE $${paramIdx + 1})`);
    paramIdx += 2;
    params.push(needle, needle);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await ctx.query<{
    id: string; name: string; description: string; category: string;
    tags: string; author: string; node_count: number;
    created_at: string; updated_at: string;
  }>(
    `SELECT id, name, description, category, tags, author, node_count, created_at, updated_at
       FROM workflow_templates ${where} ORDER BY category COLLATE "C", name COLLATE "C"`,
    params
  );
  return rows.map((row) => {
    let tags: string[] = [];
    try { const parsed = JSON.parse(toStr(row.tags)); if (Array.isArray(parsed)) tags = parsed.filter((t: unknown): t is string => typeof t === "string"); } catch { /* ignore */ }
    return {
      id: toStr(row.id),
      name: toStr(row.name),
      description: toStr(row.description),
      category: toStr(row.category),
      tags,
      author: toStr(row.author),
      nodeCount: toNum(row.node_count),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    };
  });
}

export async function getTemplate(ctx: PgContext, id: string): Promise<{
  id: string; name: string; description: string; category: string;
  tags: string[]; author: string; workflowJson: string; nodeCount: number;
  createdAt: string; updatedAt: string;
} | undefined> {
  const row = await ctx.queryOne<{
    id: string; name: string; description: string; category: string;
    tags: string; author: string; workflow_json: string; node_count: number;
    created_at: string; updated_at: string;
  }>(
    `SELECT id, name, description, category, tags, author, workflow_json, node_count, created_at, updated_at
       FROM workflow_templates WHERE id = $1`,
    [id]
  );
  if (!row) return undefined;
  let tags: string[] = [];
  try { const parsed = JSON.parse(toStr(row.tags)); if (Array.isArray(parsed)) tags = parsed.filter((t: unknown): t is string => typeof t === "string"); } catch { /* ignore */ }
  return {
    id: toStr(row.id),
    name: toStr(row.name),
    description: toStr(row.description),
    category: toStr(row.category),
    tags,
    author: toStr(row.author),
    workflowJson: toStr(row.workflow_json),
    nodeCount: toNum(row.node_count),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at)
  };
}

export async function upsertTemplate(ctx: PgContext, input: {
  id: string; name: string; description: string; category: string;
  tags: string[]; author: string; workflowJson: string; nodeCount: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await ctx.execute(
    `INSERT INTO workflow_templates (id, name, description, category, tags, author, workflow_json, node_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         category = EXCLUDED.category,
         tags = EXCLUDED.tags,
         author = EXCLUDED.author,
         workflow_json = EXCLUDED.workflow_json,
         node_count = EXCLUDED.node_count,
         updated_at = EXCLUDED.updated_at`,
    [
      input.id,
      input.name,
      input.description,
      input.category,
      JSON.stringify(input.tags),
      input.author,
      input.workflowJson,
      input.nodeCount,
      now,
      now
    ]
  );
}

export async function deleteTemplate(ctx: PgContext, id: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM workflow_templates WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function countTemplates(ctx: PgContext): Promise<number> {
  const row = await ctx.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM workflow_templates`);
  return row ? toNum(row.count) : 0;
}

type WorkflowVersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  workflow_json: string;
  created_by: string | null;
  change_note: string | null;
  created_at: string;
};

export async function listWorkflowVersions(ctx: PgContext, workflowId: string, limit = 100): ReturnType<Store["listWorkflowVersions"]> {
  const rows = await ctx.query<Omit<WorkflowVersionRow, "workflow_json">>(
    `SELECT id, workflow_id, version, created_by, change_note, created_at
       FROM workflow_versions WHERE workflow_id = $1 ORDER BY version DESC LIMIT $2`,
    [workflowId, Math.max(1, Math.min(500, limit))]
  );
  return rows.map((row) => ({
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    version: toNum(row.version),
    createdBy: row.created_by ? toStr(row.created_by) : null,
    changeNote: row.change_note ? toStr(row.change_note) : null,
    createdAt: toStr(row.created_at)
  }));
}

export async function getWorkflowVersion(ctx: PgContext, workflowId: string, version: number): ReturnType<Store["getWorkflowVersion"]> {
  const row = await ctx.queryOne<WorkflowVersionRow>(
    `SELECT id, workflow_id, version, workflow_json, created_by, change_note, created_at
       FROM workflow_versions WHERE workflow_id = $1 AND version = $2`,
    [workflowId, version]
  );
  if (!row) return null;
  return {
    id: toStr(row.id),
    workflowId: toStr(row.workflow_id),
    version: toNum(row.version),
    workflowJson: toStr(row.workflow_json),
    createdBy: row.created_by ? toStr(row.created_by) : null,
    changeNote: row.change_note ? toStr(row.change_note) : null,
    createdAt: toStr(row.created_at)
  };
}

export async function writeWorkflowVersion(ctx: PgContext, entry: Parameters<Store["writeWorkflowVersion"]>[0]): Promise<void> {
  await ctx.execute(
    `INSERT INTO workflow_versions (id, workflow_id, version, workflow_json, created_by, change_note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workflow_id, version) DO UPDATE SET
         workflow_json = EXCLUDED.workflow_json,
         change_note = EXCLUDED.change_note,
         created_by = EXCLUDED.created_by`,
    [entry.id, entry.workflowId, entry.version, entry.workflowJson, entry.createdBy ?? null, entry.changeNote ?? null, new Date().toISOString()]
  );
}

type Queryable = Pick<PoolClient, "query">;

/**
 * Keeps the newest `keep` unpinned versions; pinned ones never count and are never pruned (as SQLite). 13.3: nothing
 * is pruned while a legal hold covers the workflow (the definitions behind held runs). `db` is in a transaction.
 */
async function pruneVersions(db: Queryable, workflowId: string, keep: number): Promise<number> {
  if (keep <= 0) return 0;
  await db.query(LEGAL_HOLD_LOCK_SHARED_SQL);
  if ((await legalHoldsOnWith(db, { kind: "workflow", id: workflowId })).length > 0) return 0;
  const result = await db.query(
    `DELETE FROM workflow_versions WHERE id IN (
       SELECT id FROM workflow_versions WHERE workflow_id = $1 AND pinned = 0 ORDER BY version DESC OFFSET $2
     )`,
    [workflowId, keep]
  );
  return result.rowCount ?? 0;
}

export async function pruneWorkflowVersions(ctx: PgContext, workflowId: string, keep: number): Promise<number> {
  return ctx.withTransaction(async (client) => pruneVersions(client, workflowId, keep));
}

export async function maxWorkflowVersionNumber(ctx: PgContext, workflowId: string): Promise<number> {
  const row = await ctx.queryOne<{ max_version: number | null }>(
    `SELECT MAX(version) AS max_version FROM workflow_versions WHERE workflow_id = $1`,
    [workflowId]
  );
  return row && row.max_version !== null ? toNum(row.max_version) : 0;
}

/** Advisory-lock class for version numbers; the key space is documented in postgres-store.ts. */
export const ADVISORY_LOCK_CLASS_WORKFLOW_VERSIONS = 0x4c3257;

/**
 * Takes the next version number, inserts it and prunes, in one transaction. Appends to one workflow are serialised
 * by `pg_advisory_xact_lock(0x4c3257, hashtext(workflow id))`, taken before MAX(version) and held to commit, so each
 * append reads the previous one's committed number (READ COMMITTED: every statement sees what committed before it).
 * Appends to different workflows only share a lock on a hash collision, which costs a wait, never a wrong number.
 * A duplicate `id` (the primary key) is the caller's error and is thrown as is.
 */
export async function appendWorkflowVersion(ctx: PgContext, input: Parameters<Store["appendWorkflowVersion"]>[0]): ReturnType<Store["appendWorkflowVersion"]> {
  const createdAt = new Date().toISOString();
  const version = await ctx.withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [ADVISORY_LOCK_CLASS_WORKFLOW_VERSIONS, input.workflowId]);
    const row = (await client.query<{ max_version: number | null }>(
      `SELECT MAX(version) AS max_version FROM workflow_versions WHERE workflow_id = $1`,
      [input.workflowId]
    )).rows[0];
    const next = (row && row.max_version !== null ? toNum(row.max_version) : 0) + 1;
    await client.query(
      `INSERT INTO workflow_versions (id, workflow_id, version, workflow_json, created_by, change_note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.id, input.workflowId, next, input.workflowJson, input.createdBy ?? null, input.changeNote ?? null, createdAt]
    );
    if (input.retention > 0) await pruneVersions(client, input.workflowId, input.retention);
    return next;
  });
  return { id: input.id, version, createdAt };
}

export async function listWorkflowShares(ctx: PgContext, workflowId: string): ReturnType<Store["listWorkflowShares"]> {
  // SQLite reads these through the (workflow_id, project_id) primary key, so in project id order.
  const rows = await ctx.query<{ workflow_id: string; project_id: string; access_level: string; shared_by: string | null; created_at: string }>(
    `SELECT workflow_id, project_id, access_level, shared_by, created_at
       FROM workflow_shares WHERE workflow_id = $1 ORDER BY project_id COLLATE "C"`,
    [workflowId]
  );
  return rows.map((row) => ({
    workflowId: toStr(row.workflow_id),
    projectId: toStr(row.project_id),
    accessLevel: toStr(row.access_level),
    sharedBy: row.shared_by ? toStr(row.shared_by) : null,
    createdAt: toStr(row.created_at)
  }));
}

export async function listWorkflowsSharedToProject(ctx: PgContext, projectId: string): ReturnType<Store["listWorkflowsSharedToProject"]> {
  // SQLite reads these through idx_workflow_shares_project_id: ties in project id fall back to rowid (insertion) order.
  const rows = await ctx.query<{ workflow_id: string; project_id: string; access_level: string }>(
    `SELECT workflow_id, project_id, access_level FROM workflow_shares WHERE project_id = $1 ORDER BY created_at, workflow_id COLLATE "C"`,
    [projectId]
  );
  return rows.map((row) => ({
    workflowId: toStr(row.workflow_id),
    projectId: toStr(row.project_id),
    accessLevel: toStr(row.access_level)
  }));
}

export async function upsertWorkflowShare(ctx: PgContext, input: Parameters<Store["upsertWorkflowShare"]>[0]): Promise<void> {
  await ctx.execute(
    `INSERT INTO workflow_shares (workflow_id, project_id, access_level, shared_by, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workflow_id, project_id) DO UPDATE SET access_level = EXCLUDED.access_level`,
    [input.workflowId, input.projectId, input.accessLevel, input.sharedBy ?? null, new Date().toISOString()]
  );
}

export async function removeWorkflowShare(ctx: PgContext, workflowId: string, projectId: string): Promise<boolean> {
  const result = await ctx.pool.query(`DELETE FROM workflow_shares WHERE workflow_id = $1 AND project_id = $2`, [workflowId, projectId]);
  return (result.rowCount ?? 0) > 0;
}

export async function getWorkflowCreatedBy(ctx: PgContext, id: string): Promise<string | null> {
  const row = await ctx.queryOne<{ created_by: string | null }>(`SELECT created_by FROM workflows WHERE id = $1`, [id]);
  return row?.created_by ? toStr(row.created_by) : null;
}
