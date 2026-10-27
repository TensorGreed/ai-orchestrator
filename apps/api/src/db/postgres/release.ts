/**
 * Phase 13.1 — PostgresStore: Releases, publishing, gate admission and required cases.
 * Plain functions over a PgContext; PostgresStore delegates here. Each one behaves as the SqliteStore method of the
 * same name (row shapes, ordering, null vs undefined, result codes).
 *
 * Concurrency: every check-then-write runs in one transaction on one client and takes a row lock on what it checks
 * (`SELECT … FOR UPDATE`), or is a single conditional UPDATE whose row count is the answer, so a decision or a
 * publish applies once even when two API processes race on the same row.
 */
import type { PoolClient } from "pg";
import { GUARD_SIMULATION_JOB_DATASET_PREFIX } from "@ai-orchestrator/shared";
import type { Store, ReleaseApprovalDecisionInput, ReleaseGateCasesChange, GateCaseDecisionRecordInput } from "../store.js";
import type {
  ApprovalReadScope,
  GateCaseRequestRecord,
  GoldenSetSnapshot,
  ReleaseApprovalRequestRecord,
  ReleaseGateRecord,
  WorkflowReleaseRecord
} from "../database.js";
import type { PgContext } from "./context.js";

type Row = Record<string, unknown>;
type Queryable = Pick<PoolClient, "query">;

// ---- Row mapping (the same shapes as the SQLite store's mappers)

const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(typeof value === "string" ? value : String(value ?? ""));
  } catch {
    return null;
  }
}

function parseJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  const parsed = parseJsonSafe(raw);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  const parsed = parseJsonSafe(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseGateChecks(value: unknown): Array<{ code: string; measure: number | null }> | null {
  if (value === null || value === undefined) return null;
  const parsed = parseJsonSafe(value);
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && typeof (entry as Record<string, unknown>).code === "string")
    .map((entry) => ({ code: String(entry.code), measure: typeof entry.measure === "number" && Number.isFinite(entry.measure) ? entry.measure : null }));
}

function mapReleaseGateRow(row: Row): ReleaseGateRecord {
  const approvers = row.approvers_json ? parseJsonObject(row.approvers_json) : null;
  return {
    workflowId: String(row.workflow_id),
    enabled: Number(row.enabled) === 1,
    enforced: Number(row.enforced) === 1,
    datasetIds: parseJsonArray(row.dataset_ids_json),
    candidateOptions: parseJsonObject(row.candidate_options_json),
    policy: parseJsonObject(row.policy_json),
    requireApproval: Number(row.require_approval) === 1,
    approvers,
    updatedAt: String(row.updated_at),
    updatedBy: nullableText(row.updated_by),
    admittedFixtureIds: row.admitted_fixture_ids_json === null || row.admitted_fixture_ids_json === undefined ? null : parseJsonArray(row.admitted_fixture_ids_json),
    admissionUpdatedAt: nullableText(row.admission_updated_at),
    admissionUpdatedBy: nullableText(row.admission_updated_by)
  };
}

function mapGateCaseRequestRow(row: Row): GateCaseRequestRecord {
  const fixtures = parseJsonSafe(row.fixtures_json);
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowName: nullableText(row.workflow_name),
    projectId: String(row.project_id),
    action: row.action === "remove" ? "remove" : "admit",
    fixtures: Array.isArray(fixtures)
      ? fixtures
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => ({
            fixtureId: String(entry.fixtureId ?? ""),
            name: String(entry.name ?? entry.fixtureId ?? ""),
            datasetId: typeof entry.datasetId === "string" ? entry.datasetId : null
          }))
          .filter((entry) => entry.fixtureId)
      : [],
    spec: parseJsonObject(row.spec_json),
    gateAuthority: nullableText(row.gate_authority),
    status: String(row.status),
    requestReason: nullableText(row.request_reason),
    requestedByUserId: nullableText(row.requested_by_user_id),
    requestedBy: nullableText(row.requested_by),
    expiresAt: nullableText(row.expires_at),
    decidedByUserId: nullableText(row.decided_by_user_id),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    decisionReason: nullableText(row.decision_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapWorkflowReleaseRow(row: Row): WorkflowReleaseRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    version: Number(row.version),
    workflowHash: String(row.workflow_hash),
    previousVersion: nullableNumber(row.previous_version),
    replayRunId: nullableText(row.replay_run_id),
    verdict: String(row.verdict),
    reason: nullableText(row.reason),
    gateReasons: parseJsonArray(row.gate_reasons_json),
    approval: row.approval_json ? parseJsonObject(row.approval_json) : null,
    publishedAt: String(row.published_at),
    publishedBy: nullableText(row.published_by),
    publishedByUserId: nullableText(row.published_by_user_id)
  };
}

function mapReleaseApprovalRequestRow(row: Row): ReleaseApprovalRequestRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    workflowName: nullableText(row.workflow_name),
    projectId: String(row.project_id),
    version: Number(row.version),
    workflowHash: String(row.workflow_hash),
    replayRunId: nullableText(row.replay_run_id),
    origin: row.origin === "policy" ? "policy" : "blocked",
    gateReasons: parseJsonArray(row.gate_reasons_json),
    gateUpdatedAt: nullableText(row.gate_updated_at),
    gateChecks: parseGateChecks(row.gate_checks_json),
    gateAuthority: nullableText(row.gate_authority),
    publishedVersionAtRequest: nullableNumber(row.published_version_at_request),
    spec: parseJsonObject(row.spec_json),
    status: String(row.status),
    requestReason: nullableText(row.request_reason),
    requestedByUserId: nullableText(row.requested_by_user_id),
    requestedBy: nullableText(row.requested_by),
    expiresAt: nullableText(row.expires_at),
    decidedByUserId: nullableText(row.decided_by_user_id),
    decidedBy: nullableText(row.decided_by),
    decidedAt: nullableText(row.decided_at),
    decisionReason: nullableText(row.decision_reason),
    releaseId: nullableText(row.release_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

/** Whether two stored id lists name the same ids (null: nothing stored). */
function sameIdSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Thrown inside a transaction to roll it back and answer a refusal. */
class Refused extends Error {
  constructor(readonly outcome: string) {
    super(outcome);
  }
}

// ---- Shared statements (run on a pool or on a transaction's client)

async function readPublishedVersion(db: Queryable, workflowId: string, forUpdate: boolean): Promise<number | null> {
  const result = await db.query(`SELECT published_version FROM workflows WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [workflowId]);
  const row = result.rows[0] as Row | undefined;
  return row ? nullableNumber(row.published_version) : null;
}

async function readReleaseGate(db: Queryable, workflowId: string, forUpdate: boolean): Promise<ReleaseGateRecord | null> {
  const result = await db.query(`SELECT * FROM release_gates WHERE workflow_id = $1${forUpdate ? " FOR UPDATE" : ""}`, [workflowId]);
  const row = result.rows[0] as Row | undefined;
  return row ? mapReleaseGateRow(row) : null;
}

const RELEASE_GATE_COLUMNS = `workflow_id, enabled, enforced, dataset_ids_json, candidate_options_json, policy_json, require_approval, approvers_json, updated_at, updated_by`;

function releaseGateParams(record: ReleaseGateRecord): unknown[] {
  return [
    record.workflowId,
    record.enabled ? 1 : 0,
    record.enforced ? 1 : 0,
    JSON.stringify(record.datasetIds),
    JSON.stringify(record.candidateOptions),
    JSON.stringify(record.policy),
    record.requireApproval ? 1 : 0,
    record.approvers ? JSON.stringify(record.approvers) : null,
    record.updatedAt,
    record.updatedBy
  ];
}

async function writeReleaseGate(db: Queryable, record: ReleaseGateRecord): Promise<ReleaseGateRecord> {
  await db.query(
    `INSERT INTO release_gates (${RELEASE_GATE_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (workflow_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       enforced = EXCLUDED.enforced,
       dataset_ids_json = EXCLUDED.dataset_ids_json,
       candidate_options_json = EXCLUDED.candidate_options_json,
       policy_json = EXCLUDED.policy_json,
       require_approval = EXCLUDED.require_approval,
       approvers_json = EXCLUDED.approvers_json,
       updated_at = EXCLUDED.updated_at,
       updated_by = EXCLUDED.updated_by`,
    releaseGateParams(record)
  );
  return (await readReleaseGate(db, record.workflowId, false))!;
}

async function writeReleaseGateAdmission(db: Queryable, workflowId: string, admittedFixtureIds: string[] | null, updatedAt: string, updatedBy: string | null): Promise<void> {
  await db.query(`UPDATE release_gates SET admitted_fixture_ids_json = $1, admission_updated_at = $2, admission_updated_by = $3 WHERE workflow_id = $4`, [
    admittedFixtureIds === null ? null : JSON.stringify([...new Set(admittedFixtureIds)].sort()),
    updatedAt,
    updatedBy,
    workflowId
  ]);
}

async function decideReleaseRequestOn(db: Queryable, input: ReleaseApprovalDecisionInput): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.query(
    `UPDATE release_approval_requests
     SET status = $1, decided_by_user_id = $2, decided_by = $3, decided_at = $4, decision_reason = $5, release_id = $6, updated_at = $7
     WHERE id = $8 AND status = 'pending'`,
    [input.status, input.decidedByUserId ?? null, input.decidedBy ?? null, now, input.decisionReason ?? null, input.releaseId ?? null, now, input.id]
  );
  return (result.rowCount ?? 0) > 0;
}

async function decideGateCaseRequestOn(db: Queryable, input: GateCaseDecisionRecordInput): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.query(
    `UPDATE gate_case_requests
     SET status = $1, decided_by_user_id = $2, decided_by = $3, decided_at = $4, decision_reason = $5, updated_at = $6
     WHERE id = $7 AND status = 'pending'`,
    [input.status, input.decidedByUserId ?? null, input.decidedBy ?? null, now, input.decisionReason ?? null, now, input.id]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The publish itself, on a transaction's client: the workflow row is locked first, so two publishes of one workflow
 * run one after the other and the second sees the first's version (and is refused when it expected the old one).
 */
async function publishOn(client: PoolClient, release: Omit<WorkflowReleaseRecord, "previousVersion">, expectedPrevious: number | null): Promise<WorkflowReleaseRecord | null> {
  const current = await readPublishedVersion(client, release.workflowId, true);
  if (current !== expectedPrevious) return null;
  const pinned = await client.query(`UPDATE workflow_versions SET pinned = 1 WHERE workflow_id = $1 AND version = $2`, [release.workflowId, release.version]);
  if ((pinned.rowCount ?? 0) === 0) return null;
  await client.query(`UPDATE workflows SET published_version = $1 WHERE id = $2`, [release.version, release.workflowId]);
  await client.query(
    `INSERT INTO workflow_releases (id, workflow_id, version, workflow_hash, previous_version, replay_run_id, verdict, reason, gate_reasons_json, approval_json, published_at, published_by, published_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      release.id,
      release.workflowId,
      release.version,
      release.workflowHash,
      current,
      release.replayRunId,
      release.verdict,
      release.reason,
      JSON.stringify(release.gateReasons),
      release.approval ? JSON.stringify(release.approval) : null,
      release.publishedAt,
      release.publishedBy,
      release.publishedByUserId
    ]
  );
  return { ...release, previousVersion: current };
}

/** The WHERE clauses and params of an inbox listing (pending / decided / all, by workflow, by readable scope). */
function inboxFilter(filter: { status: "pending" | "decided" | "all"; workflowId?: string; scope?: ApprovalReadScope; now?: string }): { where: string; params: unknown[]; empty: boolean } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const now = filter.now ?? new Date().toISOString();
  if (filter.status === "pending") {
    params.push(now);
    clauses.push(`status = 'pending' AND (expires_at IS NULL OR expires_at > $${params.length})`);
  }
  if (filter.status === "decided") {
    params.push(now);
    clauses.push(`(status <> 'pending' OR (expires_at IS NOT NULL AND expires_at <= $${params.length}))`);
  }
  if (filter.workflowId) {
    params.push(filter.workflowId);
    clauses.push(`workflow_id = $${params.length}`);
  }
  if (filter.scope && !filter.scope.all) {
    const ids = filter.scope.workflowIds;
    if (ids.length === 0) return { where: "", params, empty: true };
    params.push([...ids]);
    clauses.push(`workflow_id = ANY($${params.length}::text[])`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params, empty: false };
}

// ---- Published version, pins, gates, releases

export async function getPublishedVersion(ctx: PgContext, workflowId: string): Promise<number | null> {
  return readPublishedVersion(ctx.pool, workflowId, false);
}

export async function isWorkflowVersionPinned(ctx: PgContext, workflowId: string, version: number): Promise<boolean> {
  const row = await ctx.queryOne<{ pinned: number }>(`SELECT pinned FROM workflow_versions WHERE workflow_id = $1 AND version = $2`, [workflowId, version]);
  return Number(row?.pinned ?? 0) === 1;
}

export async function getReleaseGate(ctx: PgContext, workflowId: string): Promise<ReleaseGateRecord | null> {
  return readReleaseGate(ctx.pool, workflowId, false);
}

export async function upsertReleaseGate(ctx: PgContext, record: ReleaseGateRecord): Promise<ReleaseGateRecord> {
  return writeReleaseGate(ctx.pool, record);
}

export async function listWorkflowReleases(ctx: PgContext, workflowId: string, limit = 100): Promise<WorkflowReleaseRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM workflow_releases WHERE workflow_id = $1 ORDER BY published_at DESC, id DESC LIMIT $2`, [
    workflowId,
    Math.max(1, Math.min(500, limit))
  ]);
  return rows.map(mapWorkflowReleaseRow);
}

export async function hasReleasedVersion(ctx: PgContext, workflowId: string, version: number): Promise<boolean> {
  return Boolean(await ctx.queryOne(`SELECT id FROM workflow_releases WHERE workflow_id = $1 AND version = $2 LIMIT 1`, [workflowId, version]));
}

export async function publishWorkflowVersion(
  ctx: PgContext,
  release: Omit<WorkflowReleaseRecord, "previousVersion">,
  expectedPrevious: number | null
): Promise<WorkflowReleaseRecord | null> {
  const refusal = new Refused("conflict");
  try {
    return await ctx.withTransaction(async (client) => {
      const committed = await publishOn(client, release, expectedPrevious);
      // A refusal leaves nothing behind (as the SQLite transaction did: it wrote nothing before refusing).
      if (!committed) throw refusal;
      return committed;
    });
  } catch (error) {
    if (error === refusal) return null;
    throw error;
  }
}

export async function listReplayRunIdsForHash(ctx: PgContext, workflowId: string, workflowHash: string): Promise<string[]> {
  // Phase 15.6 — a guard policy simulation's jobs are never release proof, so the judge never falls back to one.
  const rows = await ctx.query<{ id: string }>(
    `SELECT id FROM eval_runs WHERE kind = 'replay' AND workflow_id = $1 AND workflow_hash = $2 AND status = 'completed' AND dataset_id NOT LIKE $3 ORDER BY started_at DESC, id DESC`,
    [workflowId, workflowHash, `${GUARD_SIMULATION_JOB_DATASET_PREFIX}%`]
  );
  return rows.map((row) => String(row.id));
}

export async function setEvalRunSetSnapshot(ctx: PgContext, runId: string, snapshot: Record<string, GoldenSetSnapshot>): Promise<void> {
  await ctx.execute(`UPDATE eval_runs SET set_snapshot_json = $1 WHERE id = $2`, [JSON.stringify(snapshot), runId]);
}

export async function getEvalRunSetSnapshot(ctx: PgContext, runId: string): Promise<Record<string, GoldenSetSnapshot> | null> {
  const row = await ctx.queryOne<{ set_snapshot_json: string | null }>(`SELECT set_snapshot_json FROM eval_runs WHERE id = $1`, [runId]);
  if (!row?.set_snapshot_json) return null;
  try {
    const parsed = JSON.parse(String(row.set_snapshot_json)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, GoldenSetSnapshot> = {};
    for (const [datasetId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === "string") {
        out[datasetId] = { hash: entry, cases: null };
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { hash, cases } = entry as { hash?: unknown; cases?: unknown };
      if (typeof hash !== "string") continue;
      const fingerprints =
        cases && typeof cases === "object" && !Array.isArray(cases)
          ? Object.fromEntries(Object.entries(cases as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
          : null;
      out[datasetId] = { hash, cases: fingerprints };
    }
    return out;
  } catch {
    return null;
  }
}

export async function setExecutionRelease(ctx: PgContext, executionId: string, channel: "production" | "draft", version: number | null): Promise<void> {
  await ctx.execute(`UPDATE execution_history SET release_channel = $1, release_version = $2 WHERE id = $3`, [channel, version, executionId]);
}

export async function getExecutionRelease(ctx: PgContext, executionId: string): Promise<{ channel: "production" | "draft"; version: number | null } | null> {
  const row = await ctx.queryOne<{ release_channel: string | null; release_version: number | null }>(
    `SELECT release_channel, release_version FROM execution_history WHERE id = $1`,
    [executionId]
  );
  if (!row || !row.release_channel) return null;
  return { channel: row.release_channel === "production" ? "production" : "draft", version: nullableNumber(row.release_version) };
}

export async function listReleasedVersionHashes(ctx: PgContext, workflowId: string, version: number): Promise<string[]> {
  const rows = await ctx.query<{ workflow_hash: string }>(`SELECT DISTINCT workflow_hash FROM workflow_releases WHERE workflow_id = $1 AND version = $2`, [workflowId, version]);
  return rows.map((row) => String(row.workflow_hash));
}

export async function listEnabledReleaseGateWorkflowIds(ctx: PgContext): Promise<string[]> {
  const rows = await ctx.query<{ workflow_id: string }>(`SELECT workflow_id FROM release_gates WHERE enabled = 1`);
  return rows.map((row) => String(row.workflow_id));
}

// ---- Release approval requests

/** Each expired request is closed (and returned) by one caller only: the rows are locked (skipping rows another sweep or a decision holds; the next sweep finds them), then closed by id. */
export async function timeOutExpiredReleaseApprovalRequests(ctx: PgContext, nowIso: string): Promise<ReleaseApprovalRequestRecord[]> {
  return ctx.withTransaction(async (client) => {
    const expired = (
      await client.query(`SELECT * FROM release_approval_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY id FOR UPDATE SKIP LOCKED`, [nowIso])
    ).rows.map((row) => mapReleaseApprovalRequestRow(row as Row));
    if (expired.length === 0) return [];
    await client.query(
      `UPDATE release_approval_requests SET status = 'timed_out', decided_by = 'system', decided_at = $1, decision_reason = 'Nobody decided before the release request expired', updated_at = $1
       WHERE id = ANY($2::text[]) AND status = 'pending'`,
      [nowIso, expired.map((request) => request.id)]
    );
    return expired;
  });
}

export async function listPendingReleaseApprovalRequests(ctx: PgContext, workflowId: string, version: number, workflowHash: string): Promise<ReleaseApprovalRequestRecord[]> {
  const rows = await ctx.query<Row>(
    `SELECT * FROM release_approval_requests WHERE workflow_id = $1 AND version = $2 AND workflow_hash = $3 AND status = 'pending' ORDER BY created_at DESC`,
    [workflowId, version, workflowHash]
  );
  return rows.map(mapReleaseApprovalRequestRow);
}

export async function insertReleaseApprovalRequest(ctx: PgContext, record: ReleaseApprovalRequestRecord): Promise<ReleaseApprovalRequestRecord> {
  await ctx.execute(
    `INSERT INTO release_approval_requests (
       id, workflow_id, workflow_name, project_id, version, workflow_hash, replay_run_id, origin, gate_reasons_json, gate_updated_at, gate_checks_json, gate_authority,
       published_version_at_request, spec_json, status, request_reason, requested_by_user_id, requested_by, expires_at,
       decided_by_user_id, decided_by, decided_at, decision_reason, release_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [
      record.id,
      record.workflowId,
      record.workflowName,
      record.projectId,
      record.version,
      record.workflowHash,
      record.replayRunId,
      record.origin,
      JSON.stringify(record.gateReasons),
      record.gateUpdatedAt,
      record.gateChecks ? JSON.stringify(record.gateChecks) : null,
      record.gateAuthority ?? null,
      record.publishedVersionAtRequest,
      JSON.stringify(record.spec),
      record.status,
      record.requestReason,
      record.requestedByUserId,
      record.requestedBy,
      record.expiresAt,
      record.decidedByUserId,
      record.decidedBy,
      record.decidedAt,
      record.decisionReason,
      record.releaseId,
      record.createdAt,
      record.updatedAt
    ]
  );
  return (await getReleaseApprovalRequest(ctx, record.id))!;
}

export async function getReleaseApprovalRequest(ctx: PgContext, id: string): Promise<ReleaseApprovalRequestRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM release_approval_requests WHERE id = $1`, [id]);
  return row ? mapReleaseApprovalRequestRow(row) : null;
}

export async function listReleaseApprovalRequests(
  ctx: PgContext,
  filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number; scope?: ApprovalReadScope; now?: string }
): Promise<ReleaseApprovalRequestRecord[]> {
  const { where, params, empty } = inboxFilter(filter);
  if (empty) return [];
  const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
  const order = filter.status === "decided" ? "COALESCE(decided_at, updated_at) DESC" : "created_at DESC";
  const rows = await ctx.query<Row>(`SELECT * FROM release_approval_requests ${where} ORDER BY ${order}, id DESC LIMIT ${limit}`, params);
  return rows.map(mapReleaseApprovalRequestRow);
}

export async function decideReleaseApprovalRequest(ctx: PgContext, input: ReleaseApprovalDecisionInput): Promise<boolean> {
  return decideReleaseRequestOn(ctx.pool, input);
}

// ---- Gate admission and gate case requests

export async function setReleaseGateAdmission(ctx: PgContext, workflowId: string, admittedFixtureIds: string[] | null, updatedAt: string, updatedBy: string | null): Promise<void> {
  await writeReleaseGateAdmission(ctx.pool, workflowId, admittedFixtureIds, updatedAt, updatedBy);
}

export async function insertGateCaseRequest(ctx: PgContext, record: GateCaseRequestRecord): Promise<GateCaseRequestRecord> {
  await ctx.execute(
    `INSERT INTO gate_case_requests (
       id, workflow_id, workflow_name, project_id, action, fixtures_json, spec_json, gate_authority, status, request_reason, requested_by_user_id,
       requested_by, expires_at, decided_by_user_id, decided_by, decided_at, decision_reason, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [
      record.id,
      record.workflowId,
      record.workflowName,
      record.projectId,
      record.action,
      JSON.stringify(record.fixtures),
      JSON.stringify(record.spec),
      record.gateAuthority,
      record.status,
      record.requestReason,
      record.requestedByUserId,
      record.requestedBy,
      record.expiresAt,
      record.decidedByUserId,
      record.decidedBy,
      record.decidedAt,
      record.decisionReason,
      record.createdAt,
      record.updatedAt
    ]
  );
  return (await getGateCaseRequest(ctx, record.id))!;
}

export async function getGateCaseRequest(ctx: PgContext, id: string): Promise<GateCaseRequestRecord | null> {
  const row = await ctx.queryOne<Row>(`SELECT * FROM gate_case_requests WHERE id = $1`, [id]);
  return row ? mapGateCaseRequestRow(row) : null;
}

export async function listPendingGateCaseRequests(ctx: PgContext, workflowId: string): Promise<GateCaseRequestRecord[]> {
  const rows = await ctx.query<Row>(`SELECT * FROM gate_case_requests WHERE workflow_id = $1 AND status = 'pending' ORDER BY created_at DESC, id DESC`, [workflowId]);
  return rows.map(mapGateCaseRequestRow);
}

export async function listGateCaseRequests(
  ctx: PgContext,
  filter: { status: "pending" | "decided" | "all"; workflowId?: string; limit?: number; scope?: ApprovalReadScope; now?: string }
): Promise<GateCaseRequestRecord[]> {
  const { where, params, empty } = inboxFilter(filter);
  if (empty) return [];
  const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
  const order = filter.status === "decided" ? "COALESCE(decided_at, updated_at) DESC" : "created_at DESC";
  const rows = await ctx.query<Row>(`SELECT * FROM gate_case_requests ${where} ORDER BY ${order}, id DESC LIMIT ${limit}`, params);
  return rows.map(mapGateCaseRequestRow);
}

export async function timeOutExpiredGateCaseRequests(ctx: PgContext, nowIso: string): Promise<GateCaseRequestRecord[]> {
  return ctx.withTransaction(async (client) => {
    const expired = (
      await client.query(`SELECT * FROM gate_case_requests WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY id FOR UPDATE SKIP LOCKED`, [nowIso])
    ).rows.map((row) => mapGateCaseRequestRow(row as Row));
    if (expired.length === 0) return [];
    await client.query(
      `UPDATE gate_case_requests SET status = 'timed_out', decided_by = 'system', decided_at = $1, decision_reason = 'Nobody decided before the request expired', updated_at = $1
       WHERE id = ANY($2::text[]) AND status = 'pending'`,
      [nowIso, expired.map((request) => request.id)]
    );
    return expired;
  });
}

export async function decideGateCaseRequest(ctx: PgContext, input: GateCaseDecisionRecordInput): Promise<boolean> {
  return decideGateCaseRequestOn(ctx.pool, input);
}

/** Each run is read and rewritten under its row lock, so two markers never drop each other's reason. */
export async function markEvalRunsReleaseIneligible(ctx: PgContext, runIds: readonly string[], reason: string): Promise<string[]> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return [];
  return ctx.withTransaction(async (client) => {
    // Lock every run first, in id order, so two markers of overlapping runs never deadlock.
    const locked = await client.query(`SELECT id, candidate_json FROM eval_runs WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids]);
    const stored = new Map((locked.rows as Array<{ id: string; candidate_json: string | null }>).map((row) => [String(row.id), row]));
    const changed: string[] = [];
    for (const runId of ids) {
      const row = stored.get(runId);
      if (!row) continue;
      let candidate: Record<string, unknown> = {};
      try {
        const parsed = row.candidate_json ? (JSON.parse(row.candidate_json) as unknown) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) candidate = parsed as Record<string, unknown>;
      } catch {
        candidate = {};
      }
      const reasons = Array.isArray(candidate.releaseIneligibleReasons) ? candidate.releaseIneligibleReasons.map((entry) => String(entry)) : [];
      if (candidate.releaseEligible === false && reasons.includes(reason)) continue;
      const next = { ...candidate, releaseEligible: false, releaseIneligibleReasons: reasons.includes(reason) ? reasons : [...reasons, reason] };
      await client.query(`UPDATE eval_runs SET candidate_json = $1 WHERE id = $2`, [JSON.stringify(next), runId]);
      changed.push(runId);
    }
    return changed;
  });
}

// ---- Atomic multi-step operations

/**
 * Compare-and-set on the stored gate: the row is locked and compared with `expected`; with no row yet, the insert
 * itself is the check (ON CONFLICT DO NOTHING: a gate created meanwhile refuses this save).
 */
export async function saveReleaseGate(
  ctx: PgContext,
  input: { gate: ReleaseGateRecord | null; admittedFixtureIds?: string[] | null; expected: ReleaseGateRecord | null; updatedAt: string; updatedBy: string | null }
): Promise<ReleaseGateRecord | null> {
  const refusal = new Refused("changed");
  try {
    return await ctx.withTransaction(async (client) => {
      const workflowId = input.gate?.workflowId ?? input.expected?.workflowId ?? "";
      const current = await readReleaseGate(client, workflowId, true);
      if (JSON.stringify(current) !== JSON.stringify(input.expected)) return null;
      let saved: ReleaseGateRecord | null = current;
      if (input.gate && current === null) {
        const inserted = await client.query(
          `INSERT INTO release_gates (${RELEASE_GATE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (workflow_id) DO NOTHING`,
          releaseGateParams(input.gate)
        );
        if ((inserted.rowCount ?? 0) === 0) throw refusal;
        saved = await readReleaseGate(client, input.gate.workflowId, false);
      } else if (input.gate) {
        saved = await writeReleaseGate(client, input.gate);
      }
      if (!saved) return null;
      if (input.admittedFixtureIds !== undefined && !sameIdSet(input.admittedFixtureIds, current?.admittedFixtureIds ?? null)) {
        // As on SQLite, the answer is the gate as saved before this admission write.
        await writeReleaseGateAdmission(client, saved.workflowId, input.admittedFixtureIds, input.updatedAt, input.updatedBy);
      }
      return saved;
    });
  } catch (error) {
    if (error === refusal) return null;
    throw error;
  }
}

export async function updateReleaseGateCases(ctx: PgContext, change: ReleaseGateCasesChange): Promise<"ok" | "decided" | "changed"> {
  try {
    return await ctx.withTransaction(async (client) => {
      if (change.decideRequest && !(await decideGateCaseRequestOn(client, change.decideRequest))) throw new Refused("decided");
      if (change.expectedAdmittedFixtureIds !== undefined) {
        const gate = await readReleaseGate(client, change.workflowId, true);
        if (!gate || !sameIdSet(gate.admittedFixtureIds ?? null, change.expectedAdmittedFixtureIds)) throw new Refused("changed");
      }
      if (change.admittedFixtureIds !== undefined) {
        await writeReleaseGateAdmission(client, change.workflowId, change.admittedFixtureIds, change.updatedAt, change.updatedBy);
      }
      for (const fixtureId of change.deleteFixtureIds ?? []) {
        await client.query(`DELETE FROM eval_fixtures WHERE id = $1`, [fixtureId]);
      }
      if (change.required) {
        await client.query(`UPDATE eval_fixtures SET required = $1, updated_at = $2 WHERE id = $3`, [
          change.required.required ? 1 : 0,
          new Date().toISOString(),
          change.required.fixtureId
        ]);
      }
      return "ok" as const;
    });
  } catch (error) {
    if (error instanceof Refused) return error.outcome as "decided" | "changed";
    throw error;
  }
}

export async function approveReleaseRequestAndPublish(
  ctx: PgContext,
  decision: ReleaseApprovalDecisionInput,
  release: Omit<WorkflowReleaseRecord, "previousVersion">,
  expectedPrevious: number | null
): Promise<{ release: WorkflowReleaseRecord } | { refused: "decided" | "conflict" }> {
  try {
    return await ctx.withTransaction(async (client) => {
      if (!(await decideReleaseRequestOn(client, decision))) throw new Refused("decided");
      const committed = await publishOn(client, release, expectedPrevious);
      // Throwing rolls the decision back.
      if (!committed) throw new Refused("conflict");
      return { release: committed };
    });
  } catch (error) {
    if (error instanceof Refused) return { refused: error.outcome as "decided" | "conflict" };
    throw error;
  }
}
