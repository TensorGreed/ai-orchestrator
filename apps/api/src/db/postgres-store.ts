import pg, { Pool, type PoolConfig } from "pg";
import { randomUUID } from "node:crypto";
import type { ChatMessage, Folder, Project, Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import { DEFAULT_PROJECT_ID, isEmptyDataLabels, labelsForUntrackedSave, mergeDataLabels, parseStoredDataLabels, type DataLabels } from "@ai-orchestrator/shared";
import { runMigrations } from "./migrations.js";
import { queuedRunTimeoutMs, STUCK_JOB_MARGIN_MS } from "./queue-timeouts.js";
import { ProjectNotEmptyError, StoreNotImplementedError } from "./store-errors.js";
import type { CancelExecutionResult, Store } from "./store.js";
import type { PostgresSslSettings } from "../config.js";

export interface PostgresStoreConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** TLS: `false` (or absent) for none; otherwise certificates are verified unless `rejectUnauthorized` is false. */
  ssl?: PostgresSslSettings | false;
  maxConnections?: number;
  /**
   * Phase 13.1 — the schema every connection uses (`search_path`), created when missing. Tests give each file its own;
   * deployments leave it unset (the role's default, normally `public`).
   */
  schema?: string;
}

// Helper to safely parse JSON
/** Phase 16 — `{ labels }` from a stored labels column, parsed once; nothing when none were recorded. */
function labelsField(value: string | null | undefined): { labels?: DataLabels } {
  const labels = parseStoredDataLabels(value ?? null);
  return labels ? { labels } : {};
}

function parseJsonSafe(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseTagsJson(value: string | null | undefined): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = parseJsonSafe(value);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
}

function toNum(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

const MAX_SESSION_TOOL_CACHE_RECORDS = 400;

/** Phase 13.1 — first key of the advisory lock taken while migrating (second key: the schema). "L2M" in ASCII. */
const MIGRATION_LOCK_CLASS = 0x4c324d;

const PG_TIMESTAMPTZ_OID = 1184;

/**
 * Phase 13.1 — TIMESTAMPTZ values come back as ISO-8601 strings (`2026-10-26T07:00:00.000Z`), the shape the SQLite
 * store returns, instead of Date objects; every other type keeps pg's default parser.
 */
const POSTGRES_TYPES = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === PG_TIMESTAMPTZ_OID && format !== "binary") {
      return (value: string) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toISOString();
      };
    }
    return format === undefined ? pg.types.getTypeParser(oid) : pg.types.getTypeParser(oid, format);
  }) as typeof pg.types.getTypeParser
};

const PG_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function quotePgIdentifier(name: string): string {
  if (!PG_IDENTIFIER.test(name)) throw new Error(`Invalid Postgres schema name '${name}' (lower-case letters, digits and _ only).`);
  return `"${name}"`;
}

/** Phase 13.1 — the pg Pool settings for a store config (also used by the db:* scripts so TLS is handled once). */
export function postgresPoolConfig(config: PostgresStoreConfig, overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: config.ssl.rejectUnauthorized, ...(config.ssl.ca ? { ca: config.ssl.ca } : {}) } : false,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    types: POSTGRES_TYPES,
    ...(config.schema ? { options: `-c search_path=${quotePgIdentifier(config.schema)}` } : {}),
    ...overrides
  };
}

export class PostgresStore implements Store {
  /**
   * Store methods this store does not implement yet: each throws
   * StoreNotImplementedError (501). Feature checks read this through
   * `storeImplements` instead of probing for the method.
   */
  static readonly unimplemented: ReadonlySet<keyof Store> = new Set<keyof Store>([
    "acknowledgeMcpBreakingChange",
    "activateAuditSigningKey",
    "addGuardProfileVersion",
    "addKnowledgeBaseChunks",
    "anyGuardProfileUsesLabels",
    "appendWorkflowVersion",
    "approveReleaseRequestAndPublish",
    "bm25SearchKnowledgeBase",
    "cancelPendingApprovalRequests",
    "claimExecutionAndDecideApproval",
    "claimWorkflowExecutionForResume",
    "countObservedDestinationBlocks",
    "countProjectMemberships",
    "countReplayCapturesSince",
    "countReplayRecordingsForWorkflow",
    "countSecretsUsingExternalProvider",
    "countSubjectRows",
    "createAuditExportDestination",
    "createBudget",
    "createEvalDataset",
    "createEvalFixture",
    "createEvalRun",
    "createKnowledgeBase",
    "createMcpClient",
    "createMcpElicitation",
    "createMcpServer",
    "createMcpToolPolicy",
    "createMcpToolset",
    "decideApprovalRequest",
    "decideGateCaseRequest",
    "decideReleaseApprovalRequest",
    "deleteAuditExportDestination",
    "deleteBudget",
    "deleteCustomRole",
    "deleteDataDestination",
    "deleteEvalDataset",
    "deleteEvalFixture",
    "deleteEvalFixturesForRecording",
    "deleteExternalSecretCacheEntry",
    "deleteExternalSecretProvider",
    "deleteGitConfig",
    "deleteGuardProfile",
    "deleteKnowledgeBase",
    "deleteKnowledgeBaseChunksBySource",
    "deleteLogStreamDestination",
    "deleteMcpCassette",
    "deleteMcpOAuthConnection",
    "deleteMcpServer",
    "deleteMcpToolPolicy",
    "deleteMcpToolset",
    "deleteMcpUserOAuthConnection",
    "deleteMfaSecret",
    "replaceMfaBackupCodes",
    "deleteReplayRecording",
    "deleteSecret",
    "deleteSsoGroupMapping",
    "deleteSubjectRow",
    "deleteVariable",
    "evalFixtureIdsForRecording",
    "evalRunIdsForResults",
    "expireMcpElicitationsForExecution",
    "finalizeEvalRun",
    "findApiKeyByPrefix",
    "findDataDestinationByMatch",
    "findEvalFixtureByRecording",
    "findMcpClientByTokenPrefix",
    "findReplayRecordingIdForExecution",
    "findSsoIdentity",
    "findVariableByKey",
    "getActiveAuditSigningKey",
    "getApprovalRequest",
    "getAuditExportDestination",
    "getAuditSigningKey",
    "getBudget",
    "getCustomRole",
    "getDataDestination",
    "getEvalDataset",
    "getEvalFixture",
    "getEvalFixtureDatasetId",
    "getEvalResult",
    "getEvalRun",
    "getEvalRunSetSnapshot",
    "getExecutionManifest",
    "getExecutionRelease",
    "getExternalSecretCacheEntry",
    "getExternalSecretProvider",
    "getGateCaseRequest",
    "getGitConfig",
    "getGuardBinding",
    "getGuardProfile",
    "getGuardProfileVersion",
    "getGuardSimulation",
    "getGuardVaultByHash",
    "getGuardVaultByToken",
    "getKnowledgeBase",
    "getLatestBudgetAlert",
    "getLease",
    "getLogStreamDestination",
    "getMcpCassette",
    "getMcpCassetteForExecution",
    "getMcpCassetteSummary",
    "getMcpClient",
    "getMcpElicitation",
    "getMcpOAuthConnection",
    "getMcpServer",
    "getMcpServerCatalog",
    "getMcpToolPolicy",
    "getMcpToolSnapshot",
    "getMcpToolset",
    "getMcpToolsetBySlug",
    "getMcpUserOAuthConnection",
    "getMfaSecret",
    "getPendingApprovalRequestForExecution",
    "getProjectRole",
    "getPublishedVersion",
    "getReleaseApprovalRequest",
    "getReleaseGate",
    "getReplayCaptureSettings",
    "getReplayRecording",
    "getReplayRecordingSummary",
    "getSchemaMarker",
    "getVariable",
    "getWorkflowCreatedBy",
    "getWorkflowVersion",
    "guardEventStats",
    "guardProfileRevision",
    "hasActiveQueueItem",
    "hasReleasedVersion",
    "importGoldenSet",
    "insertApprovalRequest",
    "insertDataDestination",
    "insertGateCaseRequest",
    "insertGuardEvents",
    "insertGuardProfile",
    "insertGuardSimulation",
    "insertMcpToolCall",
    "insertReleaseApprovalRequest",
    "isWorkflowVersionPinned",
    "listApiKeys",
    "listApprovalRequests",
    "listApprovalRequestsForExecution",
    "listAuditExportDestinations",
    "listAuditExportRuns",
    "listAuditLogs",
    "listAuditLogsAfter",
    "listAuditLogsForExecution",
    "listAuditSigningKeys",
    "listBudgetAlerts",
    "listBudgets",
    "listCustomRoles",
    "listDataDestinations",
    "listEnabledReleaseGateWorkflowIds",
    "listEvalDatasets",
    "listEvalFixtures",
    "listEvalResults",
    "listEvalRuns",
    "listExpiredApprovalRequests",
    "listExpiredMcpElicitations",
    "listExternalSecretProviders",
    "listGateCaseRequests",
    "listGuardBindingsForProfile",
    "listGuardEvents",
    "listGuardEventsForExecution",
    "listGuardProfileVersions",
    "listGuardProfiles",
    "listGuardSimulations",
    "listKnowledgeBaseChunkPreviews",
    "listKnowledgeBaseChunks",
    "listKnowledgeBaseSources",
    "listKnowledgeBases",
    "listLeases",
    "listLogStreamDestinations",
    "listLogStreamEvents",
    "listMcpCassettes",
    "listMcpCassettesForEvalRun",
    "listMcpClients",
    "listMcpElicitations",
    "listMcpServerProbes",
    "listMcpServers",
    "listMcpToolCalls",
    "listMcpToolCallsForClient",
    "listMcpToolCallsForExecution",
    "listMcpToolClassifications",
    "listMcpToolPolicies",
    "listMcpToolSnapshots",
    "listMcpToolsets",
    "listMcpUserOAuthConnections",
    "listPendingGateCaseRequests",
    "listPendingReleaseApprovalRequests",
    "listProjectMembers",
    "listReleaseApprovalRequests",
    "listReleasedVersionHashes",
    "listReplayCaptures",
    "listReplayRecordings",
    "listReplayRunIdsForHash",
    "listResumingWorkflowExecutionIds",
    "listResumingWorkflowExecutions",
    "listRunningGuardSimulations",
    "listSecretShares",
    "listSecretsSharedToProject",
    "listSsoGroupMappings",
    "listUsageEvents",
    "listUserProjectRoles",
    "listVariables",
    "listWorkflowConfigsForDestinations",
    "listWorkflowReleases",
    "listWorkflowShares",
    "listWorkflowVersions",
    "listWorkflowsSharedToProject",
    "markEvalRunsReleaseIneligible",
    "maxWorkflowVersionNumber",
    "mcpCassetteBadgesForExecutions",
    "oldestReplayCaptureIds",
    "oldestReplayCaptures",
    "promoteReplayCapture",
    "promoteReplayCaptureToGoldenSet",
    "pruneAuditLogs",
    "pruneEvalRuns",
    "pruneExecutionManifests",
    "pruneGuardSimulations",
    "pruneLogStreamEvents",
    "pruneReplayCaptures",
    "pruneWorkflowVersions",
    "publishWorkflowVersion",
    "putGuardVault",
    "queryUsageRollup",
    "queryUsageTotals",
    "recordAuditExportRun",
    "recordBudgetAlert",
    "recordEvalResult",
    "recordGitSync",
    "recordLogStreamDispatch",
    "recordMcpServerProbe",
    "recordReplayCaptureDrop",
    "releaseExecutionClaimAndReopenApproval",
    "releaseLease",
    "releaseWorkflowExecutionClaim",
    "removeProjectRole",
    "removeSecretShare",
    "removeWorkflowShare",
    "reopenApprovalRequest",
    "replaceMcpToolCallsForExecution",
    "replayGoldenBadgesForExecutions",
    "revokeApiKey",
    "revokeMcpClient",
    "saveApiKey",
    "saveExecutionManifest",
    "saveExecutionRunContext",
    "saveMcpCassette",
    "saveReleaseGate",
    "saveReplayCaptureSettings",
    "saveReplayRecording",
    "saveReplayRecordingChecked",
    "setEvalFixtureRequired",
    "setEvalRunSetSnapshot",
    "setExecutionRelease",
    "setGuardBinding",
    "setMcpServerSandboxStatus",
    "setMcpToolClassification",
    "setReleaseGateAdmission",
    "settleMcpElicitation",
    "storageLocation",
    "subjectTextPage",
    "subjectTextRow",
    "sumReplayCaptureBytesForWorkflow",
    "sumReplayRecordingBytes",
    "sumReplayRecordingBytesForWorkflow",
    "summarizeMcpClientUsage",
    "timeOutExpiredGateCaseRequests",
    "timeOutExpiredReleaseApprovalRequests",
    "touchApiKey",
    "touchMcpClient",
    "tryAcquireLease",
    "updateAuditExportDestination",
    "updateBudget",
    "updateDataDestination",
    "updateEvalRunProgress",
    "updateEvalRunSummary",
    "updateGuardSimulation",
    "updateKnowledgeBase",
    "updateMcpServer",
    "updateMcpToolPolicy",
    "updateMcpToolset",
    "updateReleaseGateCases",
    "upsertCustomRole",
    "upsertExternalSecretCacheEntry",
    "upsertExternalSecretProvider",
    "upsertGitConfig",
    "upsertLogStreamDestination",
    "upsertMcpOAuthConnection",
    "upsertMcpServerCatalog",
    "upsertMcpUserOAuthConnection",
    "upsertMfaSecret",
    "upsertProjectRole",
    "upsertReleaseGate",
    "upsertSecretShare",
    "upsertSsoGroupMapping",
    "upsertSsoIdentity",
    "upsertVariable",
    "upsertWorkflowShare",
    "verifyAuditChain",
    "writeAuditLog",
    "writeLogStreamEvent",
    "writeUsageEvent",
    "writeWorkflowVersion"
  ]);

  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(config: PostgresStoreConfig): Promise<PostgresStore> {
    const pool = new Pool(postgresPoolConfig(config));
    try {
      const store = new PostgresStore(pool);
      await store.migrate(config.schema);
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async query<T extends object>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  private async queryOne<T extends object>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  private async execute(sql: string, params?: unknown[]): Promise<void> {
    await this.pool.query(sql, params);
  }

  /**
   * Runs the MIGRATIONS chain on one connection holding a session advisory lock (keyed by the schema), so two
   * instances starting together never run the same migration twice; the second waits, then finds nothing to do.
   * `schema` (tests) is created, under the lock, when missing.
   */
  private async migrate(schema?: string): Promise<void> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      const lockArgs = [MIGRATION_LOCK_CLASS, schema ?? null];
      await client.query(`SELECT pg_advisory_lock($1, hashtext(COALESCE($2::text, current_schema(), '')))`, lockArgs);
      try {
        if (schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schema)}`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await runMigrations(
          async (sql) => { await client.query(sql); },
          async () => {
            const result = await client.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0) as version FROM schema_migrations`);
            return toNum(result.rows[0]?.version);
          },
          async (version) => {
            await client.query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [version]);
          }
        );
      } finally {
        // If unlocking fails the connection is discarded below, which releases a session lock too.
        await client.query(`SELECT pg_advisory_unlock($1, hashtext(COALESCE($2::text, current_schema(), '')))`, lockArgs).catch(() => {
          discard = true;
        });
      }
    } finally {
      client.release(discard);
    }
  }

  // ---------------------------------------------------------------------------
  // Workflow methods
  // ---------------------------------------------------------------------------

  async listWorkflows(options: {
    projectId?: string;
    folderId?: string | null;
    tag?: string;
    search?: string;
  } = {}): Promise<WorkflowListItem[]> {
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
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.query<{
      id: string;
      name: string;
      schema_version: string;
      workflow_version: number;
      created_at: string;
      updated_at: string;
      tags_json: string | null;
      project_id: string | null;
      folder_id: string | null;
    }>(
      `SELECT id, name, schema_version, workflow_version, created_at, updated_at, tags_json, project_id, folder_id
       FROM workflows
       ${where}
       ORDER BY updated_at DESC`,
      params
    );
    const mapped = rows.map((row) => {
      const tags = parseTagsJson(row.tags_json);
      return {
        id: toStr(row.id),
        name: toStr(row.name),
        schemaVersion: toStr(row.schema_version),
        workflowVersion: toNum(row.workflow_version),
        createdAt: toStr(row.created_at),
        updatedAt: toStr(row.updated_at),
        tags,
        projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
        folderId: row.folder_id ? toStr(row.folder_id) : undefined
      };
    });
    if (options.tag && options.tag.trim()) {
      const needle = options.tag.trim().toLowerCase();
      return mapped.filter((item) =>
        (item.tags ?? []).some((tag) => tag.toLowerCase() === needle)
      );
    }
    return mapped;
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    const row = await this.queryOne<{
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
  async upsertWorkflow(workflow: Workflow, options: { createdBy?: string | null } = {}): Promise<Workflow> {
    const now = new Date().toISOString();
    const existing = await this.getWorkflow(workflow.id);
    const createdAt = existing?.createdAt ?? now;
    const payload: Workflow = {
      ...workflow,
      projectId: workflow.projectId ?? existing?.projectId ?? DEFAULT_PROJECT_ID,
      folderId: workflow.folderId ?? existing?.folderId,
      tags: Array.isArray(workflow.tags) ? workflow.tags.filter((t) => typeof t === "string") : existing?.tags,
      createdAt,
      updatedAt: now
    };

    await this.execute(
      `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at, tags_json, project_id, folder_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         schema_version = EXCLUDED.schema_version,
         workflow_version = EXCLUDED.workflow_version,
         workflow_json = EXCLUDED.workflow_json,
         updated_at = EXCLUDED.updated_at,
         tags_json = EXCLUDED.tags_json,
         project_id = EXCLUDED.project_id,
         folder_id = EXCLUDED.folder_id`,
      [
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
      ]
    );
    return payload;
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    // Read before the row goes: its nodes name its legacy session namespaces.
    const legacyNamespaces = ((await this.getWorkflow(id))?.nodes ?? []).map((node) => `${id}:${node.id}`);
    await this.execute(`DELETE FROM execution_history WHERE workflow_id = $1`, [id]);
    await this.execute(`DELETE FROM workflow_executions WHERE workflow_id = $1`, [id]);
    // A re-created workflow with the same id must not inherit the old one's
    // queue rows or its legacy default-namespace session state (exactly
    // `<workflowId>:<nodeId>` for its nodes).
    await this.execute(`DELETE FROM execution_queue WHERE workflow_id = $1`, [id]);
    await this.execute(`DELETE FROM execution_queue_dlq WHERE workflow_id = $1`, [id]);
    if (legacyNamespaces.length > 0) {
      for (const table of ["session_memory", "session_tool_cache", "session_artifacts"]) {
        await this.execute(`DELETE FROM ${table} WHERE namespace = ANY($1::text[])`, [legacyNamespaces]);
      }
    }
    const result = await this.pool.query(`DELETE FROM workflows WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async countWorkflows(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM workflows`);
    return row ? toNum(row.count) : 0;
  }

  // ---------------------------------------------------------------------------
  // Secrets
  // ---------------------------------------------------------------------------

  async listSecrets(
    options: { projectId?: string } = {}
  ): ReturnType<Store["listSecrets"]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.projectId) {
      params.push(DEFAULT_PROJECT_ID, options.projectId);
      clauses.push(`COALESCE(project_id, $${params.length - 1}) = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.query<{
      id: string;
      name: string;
      provider: string;
      created_at: string;
      project_id: string | null;
    }>(
      `SELECT id, name, provider, created_at, project_id FROM secrets ${where} ORDER BY created_at DESC`,
      params
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      name: toStr(row.name),
      provider: toStr(row.provider),
      created_at: toStr(row.created_at),
      projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
      // External secret providers are SQLite only in this release: every Postgres secret is a local one.
      source: "local" as const,
      externalProviderId: null,
      externalKey: null
    }));
  }

  async getSecret(id: string): ReturnType<Store["getSecret"]> {
    const row = await this.queryOne<{
      id: string;
      name: string;
      provider: string;
      iv: string;
      auth_tag: string;
      ciphertext: string;
      created_at: string;
      project_id: string | null;
    }>(
      `SELECT id, name, provider, iv, auth_tag, ciphertext, created_at, project_id FROM secrets WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      name: toStr(row.name),
      provider: toStr(row.provider),
      iv: toStr(row.iv),
      auth_tag: toStr(row.auth_tag),
      ciphertext: toStr(row.ciphertext),
      created_at: toStr(row.created_at),
      projectId: row.project_id ? toStr(row.project_id) : DEFAULT_PROJECT_ID,
      source: "local",
      externalProviderId: null,
      externalKey: null
    };
  }

  async saveSecret(input: {
    id: string;
    name: string;
    provider: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    projectId?: string;
  }): Promise<void> {
    await this.execute(
      `INSERT INTO secrets (id, name, provider, iv, auth_tag, ciphertext, created_at, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         provider = EXCLUDED.provider,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         ciphertext = EXCLUDED.ciphertext,
         project_id = EXCLUDED.project_id`,
      [
        input.id,
        input.name,
        input.provider,
        input.iv,
        input.authTag,
        input.ciphertext,
        new Date().toISOString(),
        input.projectId ?? DEFAULT_PROJECT_ID
      ]
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 4.2 — projects & folders
  // ---------------------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    const rows = await this.query<{
      id: string;
      name: string;
      description: string | null;
      created_by: string | null;
      created_at: string;
      updated_at: string;
    }>(`SELECT id, name, description, created_by, created_at, updated_at FROM projects ORDER BY name ASC`);
    return rows.map((row) => ({
      id: toStr(row.id),
      name: toStr(row.name),
      description: row.description ? toStr(row.description) : undefined,
      createdBy: row.created_by ? toStr(row.created_by) : undefined,
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    }));
  }

  async getProject(id: string): Promise<Project | null> {
    const row = await this.queryOne<{
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

  async upsertProject(input: {
    id: string;
    name: string;
    description?: string;
    createdBy?: string;
  }): Promise<Project> {
    const now = new Date().toISOString();
    const existing = await this.getProject(input.id);
    const createdAt = existing?.createdAt ?? now;
    await this.execute(
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

  async deleteProject(id: string): Promise<boolean> {
    if (id === DEFAULT_PROJECT_ID) {
      throw new Error("Cannot delete the default project.");
    }
    const existing = await this.getProject(id);
    if (!existing) return false;
    // Never move a project's workflows or secrets into the default project.
    const count = async (table: string) =>
      toNum((await this.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM ${table} WHERE project_id = $1`, [id]))?.count ?? 0);
    const counts = { workflows: await count("workflows"), secrets: await count("secrets"),
      knowledgeBases: await count("knowledge_bases"),
      mcpServers: await count("mcp_servers"),
      evalDatasets: await count("eval_datasets")
    };
    if (Object.values(counts).some((value) => value > 0)) throw new ProjectNotEmptyError(counts);
    await this.execute(`DELETE FROM folders WHERE project_id = $1`, [id]);
    await this.execute(`DELETE FROM variables WHERE project_id = $1`, [id]);
    await this.execute(`DELETE FROM guard_bindings WHERE scope = 'project' AND scope_id = $1`, [id]);
    // Memberships, roles and shares must not revive with a re-created id.
    for (const table of ["user_project_roles", "custom_roles", "workflow_shares", "secret_shares"]) {
      await this.execute(`DELETE FROM ${table} WHERE project_id = $1`, [id]);
    }
    await this.execute(`DELETE FROM projects WHERE id = $1`, [id]);
    return true;
  }

  async listFolders(projectId?: string): Promise<Folder[]> {
    const rows = projectId
      ? await this.query<{
          id: string;
          name: string;
          parent_id: string | null;
          project_id: string;
          created_at: string;
          updated_at: string;
        }>(
          `SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders WHERE project_id = $1 ORDER BY name ASC`,
          [projectId]
        )
      : await this.query<{
          id: string;
          name: string;
          parent_id: string | null;
          project_id: string;
          created_at: string;
          updated_at: string;
        }>(`SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders ORDER BY project_id, name`);
    return rows.map((row) => ({
      id: toStr(row.id),
      name: toStr(row.name),
      parentId: row.parent_id ? toStr(row.parent_id) : undefined,
      projectId: toStr(row.project_id),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    }));
  }

  async getFolder(id: string): Promise<Folder | null> {
    const row = await this.queryOne<{
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

  async upsertFolder(input: {
    id: string;
    name: string;
    parentId?: string;
    projectId: string;
  }): Promise<Folder> {
    const now = new Date().toISOString();
    const existing = await this.getFolder(input.id);
    const createdAt = existing?.createdAt ?? now;
    await this.execute(
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

  async deleteFolder(id: string): Promise<boolean> {
    const existing = await this.getFolder(id);
    if (!existing) return false;
    await this.execute(`UPDATE workflows SET folder_id = NULL WHERE folder_id = $1`, [id]);
    await this.execute(`UPDATE folders SET parent_id = $1 WHERE parent_id = $2`, [
      existing.parentId ?? null,
      id
    ]);
    await this.execute(`DELETE FROM folders WHERE id = $1`, [id]);
    return true;
  }

  async ensureDefaultProject(): Promise<Project> {
    const existing = await this.getProject(DEFAULT_PROJECT_ID);
    if (existing) {
      await this.execute(`UPDATE workflows SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
      await this.execute(`UPDATE secrets SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
      return existing;
    }
    const project = await this.upsertProject({
      id: DEFAULT_PROJECT_ID,
      name: "Default Project",
      description: "Personal workspace."
    });
    await this.execute(`UPDATE workflows SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    await this.execute(`UPDATE secrets SET project_id = $1 WHERE project_id IS NULL`, [DEFAULT_PROJECT_ID]);
    return project;
  }

  // ---------------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------------

  async countUsers(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM users`);
    return row ? toNum(row.count) : 0;
  }

  async getUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      email: toStr(row.email),
      passwordHash: toStr(row.password_hash),
      role: toStr(row.role),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    };
  }

  async getUserById(id: string): Promise<{
    id: string;
    email: string;
    passwordHash: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      email: toStr(row.email),
      passwordHash: toStr(row.password_hash),
      role: toStr(row.role),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    };
  }

  async saveUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: string;
  }): Promise<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const now = new Date().toISOString();
    const existing = await this.getUserById(input.id);
    const createdAt = existing?.createdAt ?? now;
    await this.execute(
      `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = EXCLUDED.updated_at`,
      [input.id, input.email.toLowerCase(), input.passwordHash, input.role, createdAt, now]
    );
    return { id: input.id, email: input.email.toLowerCase(), role: input.role, createdAt, updatedAt: now };
  }

  async listUsers(): Promise<Array<{
    id: string;
    email: string;
    role: string;
    createdAt: string;
    updatedAt: string;
  }>> {
    const rows = await this.query<{
      id: string;
      email: string;
      role: string;
      created_at: string;
      updated_at: string;
    }>(`SELECT id, email, role, created_at, updated_at FROM users ORDER BY created_at DESC`);
    return rows.map((r: { id: string; email: string; role: string; created_at: string; updated_at: string }) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  async updateUserRole(id: string, role: string): Promise<boolean> {
    const existing = await this.getUserById(id);
    if (!existing) return false;
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE users SET role = $1, updated_at = $2 WHERE id = $3`,
      [role, now, id]
    );
    return true;
  }

  async deleteUser(id: string): Promise<boolean> {
    const existing = await this.getUserById(id);
    if (!existing) return false;
    await this.execute(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await this.execute(`DELETE FROM users WHERE id = $1`, [id]);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async getSession(sessionId: string): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      user_id: string;
      expires_at: string;
      created_at: string;
      last_seen_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, created_at, last_seen_at, revoked_at FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      userId: toStr(row.user_id),
      expiresAt: toStr(row.expires_at),
      createdAt: toStr(row.created_at),
      lastSeenAt: toStr(row.last_seen_at),
      revokedAt: row.revoked_at ? toStr(row.revoked_at) : null
    };
  }

  async saveSession(input: {
    id: string;
    userId: string;
    expiresAt: string;
  }): Promise<{
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  }> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [input.id, input.userId, input.expiresAt, now, now]
    );
    return { id: input.id, userId: input.userId, expiresAt: input.expiresAt, createdAt: now, lastSeenAt: now };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.execute(
      `UPDATE sessions SET last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.execute(
      `UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
      [new Date().toISOString(), sessionId]
    );
  }

  async revokeExpiredSessions(): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL AND expires_at <= $2`,
      [now, now]
    );
  }

  // ---------------------------------------------------------------------------
  // Session Memory
  // ---------------------------------------------------------------------------

  async loadSessionMemory(namespace: string, sessionId: string): Promise<ChatMessage[]> {
    const row = await this.queryOne<{ messages_json: string }>(
      `SELECT messages_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
      [namespace, sessionId]
    );
    if (!row) return [];
    try {
      const parsed = JSON.parse(toStr(row.messages_json));
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }

  /** Migration 37 — the labels stored with a session's memory; null when none were recorded. */
  async loadSessionMemoryLabels(namespace: string, sessionId: string): Promise<DataLabels | null> {
    const row = await this.queryOne<{ labels_json: string | null }>(
      `SELECT labels_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
      [namespace, sessionId]
    );
    return row ? parseStoredDataLabels(row.labels_json) : null;
  }

  /** Saves a session's memory; `labels` (Phase 16) only while the run tracks labels, merged with the stored ones; none keeps stored labels plus `untrusted_external`. */
  async saveSessionMemory(namespace: string, sessionId: string, messages: ChatMessage[], labels?: DataLabels): Promise<void> {
    const row = await this.queryOne<{ created_at: string; labels_json: string | null }>(
      `SELECT created_at, labels_json FROM session_memory WHERE namespace = $1 AND session_id = $2`,
      [namespace, sessionId]
    );
    const now = new Date().toISOString();
    const createdAt = row ? toStr(row.created_at) : now;
    if (labels) {
      const merged = mergeDataLabels([parseStoredDataLabels(row?.labels_json ?? null), labels].filter((entry): entry is DataLabels => Boolean(entry)));
      const labelsJson = merged && !isEmptyDataLabels(merged) ? JSON.stringify({ ...merged, source: "propagated" }) : row?.labels_json ?? null;
      await this.execute(
        `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (namespace, session_id) DO UPDATE SET
           messages_json = EXCLUDED.messages_json,
           labels_json = EXCLUDED.labels_json,
           updated_at = EXCLUDED.updated_at`,
        [namespace, sessionId, JSON.stringify(messages), labelsJson, createdAt, now]
      );
      return;
    }
    // An untracked save keeps the stored labels and adds `untrusted_external` (the old messages are still in memory).
    const kept = labelsForUntrackedSave(parseStoredDataLabels(row?.labels_json ?? null));
    await this.execute(
      `INSERT INTO session_memory (namespace, session_id, messages_json, labels_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (namespace, session_id) DO UPDATE SET
         messages_json = EXCLUDED.messages_json,
         labels_json = EXCLUDED.labels_json,
         updated_at = EXCLUDED.updated_at`,
      [namespace, sessionId, JSON.stringify(messages), kept ? JSON.stringify(kept) : null, createdAt, now]
    );
  }

  // ---------------------------------------------------------------------------
  // Session Tool Cache
  // ---------------------------------------------------------------------------

  async saveSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    labels?: DataLabels;
  }): Promise<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    createdAt: string;
  }> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.execute(
      `INSERT INTO session_tool_cache (id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.namespace,
        input.sessionId,
        input.toolName,
        input.toolCallId ?? null,
        JSON.stringify(input.args ?? {}),
        JSON.stringify(input.output ?? null),
        input.error ?? null,
        input.summary === undefined ? null : JSON.stringify(input.summary),
        input.labels && !isEmptyDataLabels(input.labels) ? JSON.stringify(input.labels) : null,
        now
      ]
    );

    // Prune old records
    await this.execute(
      `DELETE FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2
         AND id NOT IN (
           SELECT id FROM session_tool_cache
           WHERE namespace = $1 AND session_id = $2
           ORDER BY created_at DESC
           LIMIT $3
         )`,
      [input.namespace, input.sessionId, MAX_SESSION_TOOL_CACHE_RECORDS]
    );

    return {
      id,
      namespace: input.namespace,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      args: input.args ?? {},
      output: input.output ?? null,
      error: input.error,
      summary: input.summary,
      ...(input.labels && !isEmptyDataLabels(input.labels) ? { labels: input.labels } : {}),
      createdAt: now
    };
  }

  async listSessionToolCalls(input: {
    namespace: string;
    sessionId: string;
    toolName?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    error?: string;
    summary?: unknown;
    createdAt: string;
  }>> {
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
        ? Math.min(Math.floor(input.limit), 200)
        : 20;

    let rows: Array<{
      id: string;
      namespace: string;
      session_id: string;
      tool_name: string;
      tool_call_id: string | null;
      args_json: string;
      error: string | null;
      summary_json: string | null;
      labels_json: string | null;
      created_at: string;
    }>;

    if (input.toolName) {
      rows = await this.query(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, labels_json, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2 AND tool_name = $3
         ORDER BY created_at DESC LIMIT $4`,
        [input.namespace, input.sessionId, input.toolName, limit]
      );
    } else {
      rows = await this.query(
        `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, error, summary_json, labels_json, created_at
         FROM session_tool_cache
         WHERE namespace = $1 AND session_id = $2
         ORDER BY created_at DESC LIMIT $3`,
        [input.namespace, input.sessionId, limit]
      );
    }

    return rows.map((row) => {
      const argsParsed = parseJsonSafe(row.args_json);
      const args =
        argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
          ? (argsParsed as Record<string, unknown>)
          : {};
      return {
        id: toStr(row.id),
        namespace: toStr(row.namespace),
        sessionId: toStr(row.session_id),
        toolName: toStr(row.tool_name),
        toolCallId: row.tool_call_id ? toStr(row.tool_call_id) : undefined,
        args,
        error: row.error ? toStr(row.error) : undefined,
        summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
        ...labelsField(row.labels_json),
        createdAt: toStr(row.created_at)
      };
    });
  }

  async getSessionToolCall(input: {
    namespace: string;
    sessionId: string;
    id: string;
  }): Promise<{
    id: string;
    namespace: string;
    sessionId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
    output: unknown;
    error?: string;
    summary?: unknown;
    createdAt: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      namespace: string;
      session_id: string;
      tool_name: string;
      tool_call_id: string | null;
      args_json: string;
      output_json: string;
      error: string | null;
      summary_json: string | null;
      labels_json: string | null;
      created_at: string;
    }>(
      `SELECT id, namespace, session_id, tool_name, tool_call_id, args_json, output_json, error, summary_json, labels_json, created_at
       FROM session_tool_cache
       WHERE namespace = $1 AND session_id = $2 AND id = $3`,
      [input.namespace, input.sessionId, input.id]
    );
    if (!row) return null;

    const argsParsed = parseJsonSafe(row.args_json);
    const args =
      argsParsed && typeof argsParsed === "object" && !Array.isArray(argsParsed)
        ? (argsParsed as Record<string, unknown>)
        : {};

    return {
      id: toStr(row.id),
      namespace: toStr(row.namespace),
      sessionId: toStr(row.session_id),
      toolName: toStr(row.tool_name),
      toolCallId: row.tool_call_id ? toStr(row.tool_call_id) : undefined,
      args,
      output: parseJsonSafe(row.output_json),
      error: row.error ? toStr(row.error) : undefined,
      summary: row.summary_json ? parseJsonSafe(row.summary_json) : undefined,
      ...labelsField(row.labels_json),
      createdAt: toStr(row.created_at)
    };
  }

  // ---------------------------------------------------------------------------
  // Session Artifacts
  // ---------------------------------------------------------------------------

  /** Saves a session artifact; `labels` (Phase 16) only while the run tracks labels, replacing the stored ones (none keeps stored labels plus `untrusted_external`). */
  async saveSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels;
  }): Promise<{
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const existing = await this.queryOne<{ created_at: string; labels_json: string | null }>(
      `SELECT created_at, labels_json
       FROM session_artifacts
       WHERE namespace = $1 AND session_id = $2 AND artifact_key = $3`,
      [input.namespace, input.sessionId, input.artifactKey]
    );
    const now = new Date().toISOString();
    const createdAt = existing ? toStr(existing.created_at) : now;

    // A tracked save replaces the labels; an untracked one (none given) keeps the stored labels plus `untrusted_external`.
    const labels = input.labels === undefined ? labelsForUntrackedSave(parseStoredDataLabels(existing?.labels_json ?? null)) ?? undefined : !isEmptyDataLabels(input.labels) ? input.labels : undefined;
    await this.execute(
      `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (namespace, session_id, artifact_key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         labels_json = EXCLUDED.labels_json,
         updated_at = EXCLUDED.updated_at`,
      [input.namespace, input.sessionId, input.artifactKey, JSON.stringify(input.value ?? null), labels ? JSON.stringify({ ...labels, source: "propagated" }) : null, createdAt, now]
    );

    return {
      namespace: input.namespace,
      sessionId: input.sessionId,
      artifactKey: input.artifactKey,
      value: input.value ?? null,
      ...(labels ? { labels } : {}),
      createdAt,
      updatedAt: now
    };
  }

  async loadSessionArtifact(input: {
    namespace: string;
    sessionId: string;
    artifactKey: string;
  }): Promise<{
    namespace: string;
    sessionId: string;
    artifactKey: string;
    value: unknown;
    labels?: DataLabels | null;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const row = await this.queryOne<{
      namespace: string;
      session_id: string;
      artifact_key: string;
      value_json: string;
      labels_json: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT namespace, session_id, artifact_key, value_json, labels_json, created_at, updated_at
       FROM session_artifacts
       WHERE namespace = $1 AND session_id = $2 AND artifact_key = $3`,
      [input.namespace, input.sessionId, input.artifactKey]
    );

    if (!row) {
      return null;
    }

    return {
      namespace: toStr(row.namespace),
      sessionId: toStr(row.session_id),
      artifactKey: toStr(row.artifact_key),
      value: parseJsonSafe(row.value_json),
      ...labelsField(row.labels_json),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    };
  }

  // ---------------------------------------------------------------------------
  // Webhook security
  // ---------------------------------------------------------------------------

  async clearExpiredWebhookSecurityState(nowIso = new Date().toISOString()): Promise<void> {
    await this.execute(`DELETE FROM webhook_replay_keys WHERE expires_at <= $1`, [nowIso]);
    await this.execute(`DELETE FROM webhook_idempotency WHERE expires_at <= $1`, [nowIso]);
  }

  async hasWebhookReplayKey(replayKey: string): Promise<boolean> {
    const row = await this.queryOne<{ replay_key: string }>(
      `SELECT replay_key FROM webhook_replay_keys WHERE replay_key = $1`,
      [replayKey]
    );
    return Boolean(row);
  }

  async saveWebhookReplayKey(input: { replayKey: string; endpointKey: string; expiresAt: string }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO webhook_replay_keys (replay_key, endpoint_key, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (replay_key) DO NOTHING`,
      [input.replayKey, input.endpointKey, new Date().toISOString(), input.expiresAt]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getWebhookIdempotency(input: { endpointKey: string; idempotencyKey: string }): Promise<{
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    result: unknown;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
  } | null> {
    const row = await this.queryOne<{
      endpoint_key: string;
      idempotency_key: string;
      request_hash: string;
      status: string;
      result_json: string | null;
      created_at: string;
      updated_at: string;
      expires_at: string;
    }>(
      `SELECT endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at
       FROM webhook_idempotency
       WHERE endpoint_key = $1 AND idempotency_key = $2`,
      [input.endpointKey, input.idempotencyKey]
    );
    if (!row) return null;
    return {
      endpointKey: toStr(row.endpoint_key),
      idempotencyKey: toStr(row.idempotency_key),
      requestHash: toStr(row.request_hash),
      status: toStr(row.status),
      result: row.result_json ? parseJsonSafe(row.result_json) : null,
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at),
      expiresAt: toStr(row.expires_at)
    };
  }

  async saveWebhookIdempotencyPending(input: {
    endpointKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO webhook_idempotency (endpoint_key, idempotency_key, request_hash, status, result_json, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, 'pending', NULL, $4, $5, $6)`,
      [input.endpointKey, input.idempotencyKey, input.requestHash, now, now, input.expiresAt]
    );
  }

  async saveWebhookIdempotencyResult(input: {
    endpointKey: string;
    idempotencyKey: string;
    status: "success" | "error" | "partial" | "waiting_approval" | "canceled";
    result: unknown;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE webhook_idempotency SET status = $1, result_json = $2, updated_at = $3
       WHERE endpoint_key = $4 AND idempotency_key = $5`,
      [input.status, JSON.stringify(input.result ?? null), now, input.endpointKey, input.idempotencyKey]
    );
  }

  // ---------------------------------------------------------------------------
  // Execution History
  // ---------------------------------------------------------------------------

  async saveExecutionHistory(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    triggerType?: string;
    triggeredBy?: string;
    inputJson?: unknown;
    outputJson?: unknown;
    nodeResultsJson?: unknown;
    customData?: unknown;
    error?: string;
  }, options?: { unlessFinished?: boolean; unlessCanceled?: boolean }): Promise<boolean> {
    const guard = options?.unlessFinished
      ? `
       WHERE NOT (execution_history.status IN ('success', 'error', 'canceled') OR (execution_history.status = 'partial' AND execution_history.completed_at IS NOT NULL))`
      : options?.unlessCanceled
        ? `
       WHERE execution_history.status <> 'canceled' OR EXCLUDED.status = 'canceled'`
        : "";
    const result = await this.pool.query(
      `INSERT INTO execution_history (id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, input_json, output_json, node_results_json, custom_data_json, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status = EXCLUDED.status,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         duration_ms = EXCLUDED.duration_ms,
         trigger_type = EXCLUDED.trigger_type,
         triggered_by = EXCLUDED.triggered_by,
         input_json = EXCLUDED.input_json,
         output_json = EXCLUDED.output_json,
         node_results_json = EXCLUDED.node_results_json,
         custom_data_json = EXCLUDED.custom_data_json,
         error = EXCLUDED.error${guard}`,
      [
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        input.status,
        input.startedAt,
        input.completedAt ?? null,
        typeof input.durationMs === "number" ? Math.floor(input.durationMs) : null,
        input.triggerType ?? null,
        input.triggeredBy ?? null,
        input.inputJson === undefined ? null : JSON.stringify(input.inputJson),
        input.outputJson === undefined ? null : JSON.stringify(input.outputJson),
        input.nodeResultsJson === undefined ? null : JSON.stringify(input.nodeResultsJson),
        input.customData === undefined ? null : JSON.stringify(input.customData),
        input.error ?? null
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listExecutionHistory(input: {
    page?: number;
    pageSize?: number;
    status?: string;
    workflowId?: string;
    workflowIds?: string[];
    triggerType?: string;
    startedFrom?: string;
    startedTo?: string;
  }): Promise<{
    total: number;
    page: number;
    pageSize: number;
    items: Array<{
      id: string;
      workflowId: string;
      workflowName: string | null;
      status: string;
      startedAt: string;
      completedAt: string | null;
      durationMs: number | null;
      triggerType: string | null;
      triggeredBy: string | null;
      customData: unknown;
      error: string | null;
      createdAt: string;
    }>;
  }> {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const whereParams: unknown[] = [];
    let paramIdx = 1;

    if (input.status) {
      whereParts.push(`status = $${paramIdx++}`);
      whereParams.push(input.status);
    }
    if (input.workflowId) {
      whereParts.push(`workflow_id = $${paramIdx++}`);
      whereParams.push(input.workflowId);
    }
    if (input.workflowIds) {
      if (input.workflowIds.length === 0) {
        whereParts.push("1 = 0");
      } else {
        whereParts.push(`workflow_id IN (${input.workflowIds.map(() => `$${paramIdx++}`).join(", ")})`);
        whereParams.push(...input.workflowIds);
      }
    }
    if (input.triggerType) {
      whereParts.push(`trigger_type = $${paramIdx++}`);
      whereParams.push(input.triggerType);
    }
    if (input.startedFrom) {
      whereParts.push(`started_at >= $${paramIdx++}`);
      whereParams.push(input.startedFrom);
    }
    if (input.startedTo) {
      whereParts.push(`started_at <= $${paramIdx++}`);
      whereParams.push(input.startedTo);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const countRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_history ${whereClause}`,
      whereParams
    );
    const total = countRow ? toNum(countRow.count) : 0;

    const rows = await this.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      status: string;
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      trigger_type: string | null;
      triggered_by: string | null;
      custom_data_json: string | null;
      error: string | null;
      created_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, custom_data_json, error, created_at
       FROM execution_history
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...whereParams, pageSize, offset]
    );

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: toStr(row.id),
        workflowId: toStr(row.workflow_id),
        workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
        status: toStr(row.status),
        startedAt: toStr(row.started_at),
        completedAt: row.completed_at ? toStr(row.completed_at) : null,
        durationMs: row.duration_ms === null ? null : toNum(row.duration_ms),
        triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
        triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
        customData: parseJsonSafe(row.custom_data_json),
        error: row.error ? toStr(row.error) : null,
        createdAt: toStr(row.created_at)
      }))
    };
  }

  async getExecutionHistory(id: string): Promise<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    input: unknown;
    output: unknown;
    nodeResults: unknown;
    customData: unknown;
    error: string | null;
    createdAt: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      status: string;
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      trigger_type: string | null;
      triggered_by: string | null;
      input_json: string | null;
      output_json: string | null;
      node_results_json: string | null;
      custom_data_json: string | null;
      error: string | null;
      created_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, status, started_at, completed_at, duration_ms, trigger_type, triggered_by, input_json, output_json, node_results_json, custom_data_json, error, created_at
       FROM execution_history WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      status: toStr(row.status),
      startedAt: toStr(row.started_at),
      completedAt: row.completed_at ? toStr(row.completed_at) : null,
      durationMs: row.duration_ms === null ? null : toNum(row.duration_ms),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      input: parseJsonSafe(row.input_json),
      output: parseJsonSafe(row.output_json),
      nodeResults: parseJsonSafe(row.node_results_json),
      customData: parseJsonSafe(row.custom_data_json),
      error: row.error ? toStr(row.error) : null,
      createdAt: toStr(row.created_at)
    };
  }

  async cancelExecution(input: {
    id: string;
    onlyFrom: readonly string[];
    completedAt?: string;
    error?: string;
    deletePausedState?: boolean;
    cancelClaimed?: boolean;
  }): Promise<CancelExecutionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(`SELECT status, started_at, completed_at FROM execution_history WHERE id = $1 FOR UPDATE`, [input.id]);
      const existing = found.rows[0] as { status: string; started_at: unknown; completed_at: unknown } | undefined;
      const refuse = (outcome: CancelExecutionResult["outcome"]): CancelExecutionResult => ({ outcome, canceledRequestIds: [] });
      const result = await (async (): Promise<CancelExecutionResult> => {
        if (!existing) return refuse("missing");
        const open = existing.status !== "partial" || !existing.completed_at;
        if (!input.onlyFrom.includes(existing.status) || !open) return refuse("not_cancelable");
        if (input.deletePausedState) {
          const paused = await client.query(`SELECT status FROM workflow_executions WHERE id = $1 FOR UPDATE`, [input.id]);
          const pausedStatus = (paused.rows[0] as { status: string } | undefined)?.status;
          if (pausedStatus !== undefined && pausedStatus !== "waiting_approval" && !input.cancelClaimed) return refuse("decided");
          if (pausedStatus !== undefined) await client.query(`DELETE FROM workflow_executions WHERE id = $1`, [input.id]);
        }
        const completedAt = input.completedAt ?? new Date().toISOString();
        const canceledRequestIds: string[] = [];
        if (input.deletePausedState) {
          const canceled = await client.query(
            `UPDATE approval_requests SET status = 'canceled', reason = $1, decided_at = $2, updated_at = $2 WHERE execution_id = $3 AND status = 'pending' RETURNING id`,
            [input.error ?? "Execution canceled", completedAt, input.id]
          );
          for (const row of canceled.rows as Array<{ id: unknown }>) canceledRequestIds.push(toStr(row.id));
        }
        const started = Date.parse(toStr(existing.started_at));
        const completed = Date.parse(completedAt);
        const durationMs = Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, Math.floor(completed - started)) : null;
        await client.query(
          `UPDATE execution_history SET status = 'canceled', completed_at = $1, duration_ms = $2, error = $3 WHERE id = $4`,
          [completedAt, durationMs, input.error ?? "Execution canceled", input.id]
        );
        return { outcome: "canceled", canceledRequestIds };
      })();
      await client.query(result.outcome === "canceled" ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneExecutionHistory(input: { before: string }): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM execution_history WHERE started_at < $1`,
      [input.before]
    );
    // Phase 10.1 — tool-call telemetry follows the execution-history retention.
    await this.pool.query(`DELETE FROM mcp_tool_calls WHERE started_at < $1`, [input.before]);
    return result.rowCount ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Workflow execution state (approval flows)
  // ---------------------------------------------------------------------------

  async saveWorkflowExecutionState(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    status: string;
    waitingNodeId: string;
    approvalMessage?: string;
    timeoutMinutes?: number;
    triggerType?: string;
    triggeredBy?: string;
    startedAt: string;
    state: unknown;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO workflow_executions (id, workflow_id, workflow_name, status, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, state_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         workflow_name = EXCLUDED.workflow_name,
         status = EXCLUDED.status,
         waiting_node_id = EXCLUDED.waiting_node_id,
         approval_message = EXCLUDED.approval_message,
         timeout_minutes = EXCLUDED.timeout_minutes,
         trigger_type = EXCLUDED.trigger_type,
         triggered_by = EXCLUDED.triggered_by,
         started_at = EXCLUDED.started_at,
         state_json = EXCLUDED.state_json,
         updated_at = EXCLUDED.updated_at`,
      [
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        input.status,
        input.waitingNodeId,
        input.approvalMessage ?? null,
        typeof input.timeoutMinutes === "number" ? Math.floor(input.timeoutMinutes) : null,
        input.triggerType ?? null,
        input.triggeredBy ?? null,
        input.startedAt,
        JSON.stringify(input.state),
        now,
        now
      ]
    );
  }

  async getWorkflowExecutionState(id: string): Promise<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    status: string;
    waitingNodeId: string;
    approvalMessage: string | null;
    timeoutMinutes: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    startedAt: string;
    state: unknown;
    createdAt: string;
    updatedAt: string;
  } | null> {
    const row = await this.queryOne<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      status: string;
      waiting_node_id: string;
      approval_message: string | null;
      timeout_minutes: number | null;
      trigger_type: string | null;
      triggered_by: string | null;
      started_at: string;
      state_json: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, status, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, state_json, created_at, updated_at
       FROM workflow_executions WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    let state: unknown = null;
    try { state = JSON.parse(toStr(row.state_json)); } catch { state = null; }
    return {
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      status: toStr(row.status),
      waitingNodeId: toStr(row.waiting_node_id),
      approvalMessage: row.approval_message ? toStr(row.approval_message) : null,
      timeoutMinutes: row.timeout_minutes === null ? null : toNum(row.timeout_minutes),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      startedAt: toStr(row.started_at),
      state,
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    };
  }

  async listPendingApprovals(): Promise<Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    waitingNodeId: string;
    approvalMessage: string | null;
    timeoutMinutes: number | null;
    triggerType: string | null;
    triggeredBy: string | null;
    startedAt: string;
    createdAt: string;
    updatedAt: string;
  }>> {
    const rows = await this.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      waiting_node_id: string;
      approval_message: string | null;
      timeout_minutes: number | null;
      trigger_type: string | null;
      triggered_by: string | null;
      started_at: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, waiting_node_id, approval_message, timeout_minutes, trigger_type, triggered_by, started_at, created_at, updated_at
       FROM workflow_executions
       WHERE status = 'waiting_approval'
       ORDER BY created_at DESC`
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      waitingNodeId: toStr(row.waiting_node_id),
      approvalMessage: row.approval_message ? toStr(row.approval_message) : null,
      timeoutMinutes: row.timeout_minutes === null ? null : toNum(row.timeout_minutes),
      triggerType: row.trigger_type ? toStr(row.trigger_type) : null,
      triggeredBy: row.triggered_by ? toStr(row.triggered_by) : null,
      startedAt: toStr(row.started_at),
      createdAt: toStr(row.created_at),
      updatedAt: toStr(row.updated_at)
    }));
  }

  async deleteWorkflowExecution(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM workflow_executions WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // Execution Queue
  // ---------------------------------------------------------------------------

  async enqueueExecution(input: {
    id: string;
    workflowId: string;
    workflowName?: string;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    scheduledAt?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO execution_queue (id, workflow_id, workflow_name, payload_json, status, priority, attempts, max_attempts, last_error, scheduled_at, started_at, completed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, 0, $6, NULL, $7, NULL, NULL, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.workflowId,
        input.workflowName ?? null,
        JSON.stringify(input.payload),
        input.priority ?? 0,
        input.maxAttempts ?? 3,
        input.scheduledAt ?? now,
        now,
        now
      ]
    );
  }

  async dequeueNext(limit = 1): Promise<Array<{
    id: string;
    workflowId: string;
    workflowName: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    scheduledAt: string;
  }>> {
    const now = new Date().toISOString();
    const rows = await this.query<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      payload_json: string;
      attempts: number;
      max_attempts: number;
      scheduled_at: string;
    }>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts, scheduled_at
       FROM execution_queue
       WHERE status = 'pending' AND scheduled_at <= $1
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT $2`,
      [now, limit]
    );

    if (rows.length === 0) return [];

    for (const row of rows) {
      await this.execute(
        `UPDATE execution_queue SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3`,
        [now, now, row.id]
      );
    }

    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(toStr(row.payload_json));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch { /* ignore */ }
      return {
        id: toStr(row.id),
        workflowId: toStr(row.workflow_id),
        workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
        payload,
        attempts: toNum(row.attempts),
        maxAttempts: toNum(row.max_attempts),
        scheduledAt: toStr(row.scheduled_at)
      };
    });
  }

  async markQueueItemRunning(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE execution_queue SET status = 'running', started_at = $1, updated_at = $2 WHERE id = $3`,
      [now, now, id]
    );
  }

  async markQueueItemCompleted(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `UPDATE execution_queue SET status = 'completed', completed_at = $1, updated_at = $2 WHERE id = $3`,
      [now, now, id]
    );
  }

  /** Retries with backoff until max attempts; `retryable: false` moves the job to the DLQ now. */
  async markQueueItemFailed(id: string, error: string, options: { retryable?: boolean } = {}): Promise<void> {
    const now = new Date().toISOString();
    const row = await this.queryOne<{
      id: string;
      workflow_id: string;
      workflow_name: string | null;
      payload_json: string;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, workflow_id, workflow_name, payload_json, attempts, max_attempts FROM execution_queue WHERE id = $1`,
      [id]
    );
    if (!row) return;

    const attempts = toNum(row.attempts) + 1;
    const maxAttempts = toNum(row.max_attempts);

    if (attempts >= maxAttempts || options.retryable === false) {
      const dlqId = randomUUID();
      await this.execute(
        `INSERT INTO execution_queue_dlq (id, original_id, workflow_id, workflow_name, payload_json, attempts, final_error, failed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          dlqId,
          toStr(row.id),
          toStr(row.workflow_id),
          row.workflow_name ? toStr(row.workflow_name) : null,
          toStr(row.payload_json),
          attempts,
          error,
          now,
          now
        ]
      );
      await this.execute(
        `UPDATE execution_queue SET status = 'dead', attempts = $1, last_error = $2, updated_at = $3 WHERE id = $4`,
        [attempts, error, now, id]
      );
    } else {
      const backoffMs = 1000 * Math.pow(2, attempts - 1);
      const retryAt = new Date(Date.now() + backoffMs).toISOString();
      await this.execute(
        `UPDATE execution_queue SET status = 'pending', attempts = $1, last_error = $2, scheduled_at = $3, updated_at = $4 WHERE id = $5`,
        [attempts, error, retryAt, now, id]
      );
    }
  }

  async requeueStuckItems(stuckAfterMs = 600_000, excludeIds: string[] = [], marginMs = STUCK_JOB_MARGIN_MS): Promise<number> {
    const nowMs = Date.now();
    const stuckBefore = new Date(nowMs - stuckAfterMs).toISOString();
    const candidates = await this.pool.query(
      `SELECT id, started_at, payload_json FROM execution_queue
       WHERE status = 'running' AND started_at <= $1 AND NOT (id = ANY($2::text[]))`,
      [stuckBefore, excludeIds]
    );
    const ids = candidates.rows
      .filter((row: { started_at: Date | string; payload_json: string }) => {
        // A job may carry its own, longer run time limit; it is not stuck before that limit and the margin have passed.
        const runTimeout = queuedRunTimeoutMs(row.payload_json);
        return runTimeout === null || new Date(row.started_at).getTime() <= nowMs - Math.max(stuckAfterMs, runTimeout + marginMs);
      })
      .map((row: { id: string }) => row.id);
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE execution_queue SET status = 'pending', started_at = NULL, updated_at = $1
       WHERE status = 'running' AND id = ANY($2::text[]) AND started_at <= $3`,
      [new Date(nowMs).toISOString(), ids, stuckBefore]
    );
    return result.rowCount ?? 0;
  }

  async reconcileOrphanedExecutions(input: {
    error: string;
    startedBefore?: string;
  }): Promise<Array<{ id: string; workflowId: string }>> {
    const completedAt = new Date().toISOString();
    const result = await this.pool.query(
      `UPDATE execution_history
       SET status = 'error', completed_at = $1, error = $2,
           duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM ($4::timestamptz - started_at::timestamptz)) * 1000)::bigint)
       WHERE status = 'running'
         AND ($3::timestamptz IS NULL OR started_at < $3::timestamptz)
         AND id NOT IN (SELECT id FROM execution_queue WHERE status IN ('pending', 'running'))
       RETURNING id, workflow_id`,
      [completedAt, input.error, input.startedBefore ?? null, completedAt]
    );
    return result.rows.map((row: { id: string; workflow_id: string }) => ({ id: row.id, workflowId: row.workflow_id }));
  }

  async getQueueDepth(): Promise<{ pending: number; running: number; dlq: number }> {
    const pendingRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'pending'`
    );
    const runningRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_queue WHERE status = 'running'`
    );
    const dlqRow = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM execution_queue_dlq`
    );
    return {
      pending: pendingRow ? toNum(pendingRow.count) : 0,
      running: runningRow ? toNum(runningRow.count) : 0,
      dlq: dlqRow ? toNum(dlqRow.count) : 0
    };
  }

  async listDlqItems(limit = 50, workflowIds?: string[]): Promise<Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }>> {
    if (workflowIds && workflowIds.length === 0) return [];
    const scope = workflowIds ? `WHERE workflow_id IN (${workflowIds.map((_, index) => `$${index + 1}`).join(", ")})` : "";
    const rows = await this.query<{
      id: string;
      original_id: string;
      workflow_id: string;
      workflow_name: string | null;
      attempts: number;
      final_error: string;
      failed_at: string;
    }>(
      `SELECT id, original_id, workflow_id, workflow_name, attempts, final_error, failed_at
       FROM execution_queue_dlq
       ${scope}
       ORDER BY failed_at DESC
       LIMIT $${(workflowIds?.length ?? 0) + 1}`,
      [...(workflowIds ?? []), limit]
    );
    return rows.map((row) => ({
      id: toStr(row.id),
      originalId: toStr(row.original_id),
      workflowId: toStr(row.workflow_id),
      workflowName: row.workflow_name ? toStr(row.workflow_name) : null,
      attempts: toNum(row.attempts),
      finalError: toStr(row.final_error),
      failedAt: toStr(row.failed_at)
    }));
  }

  async getTriggerState(workflowId: string, nodeId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.query<{ state_json: string }>(
      `SELECT state_json FROM trigger_state WHERE workflow_id = $1 AND node_id = $2`,
      [workflowId, nodeId]
    );
    const row = rows[0];
    if (!row) return null;
    try {
      return JSON.parse(toStr(row.state_json)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async saveTriggerState(input: {
    workflowId: string;
    nodeId: string;
    triggerType: string;
    state: Record<string, unknown>;
  }): Promise<void> {
    await this.query(
      `INSERT INTO trigger_state (workflow_id, node_id, trigger_type, state_json, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workflow_id, node_id) DO UPDATE SET
         state_json = EXCLUDED.state_json,
         trigger_type = EXCLUDED.trigger_type,
         updated_at = EXCLUDED.updated_at`,
      [input.workflowId, input.nodeId, input.triggerType, JSON.stringify(input.state), new Date().toISOString()]
    );
  }

  async deleteTriggerStatesForWorkflow(workflowId: string): Promise<void> {
    await this.query(`DELETE FROM trigger_state WHERE workflow_id = $1`, [workflowId]);
  }

  // ---------------------------------------------------------------------------
  // Workflow Templates (Phase 7.4)
  // ---------------------------------------------------------------------------

  async listTemplates(filters?: { category?: string; search?: string }): Promise<Array<{
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
    const rows = await this.query<{
      id: string; name: string; description: string; category: string;
      tags: string; author: string; node_count: number;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, name, description, category, tags, author, node_count, created_at, updated_at
       FROM workflow_templates ${where} ORDER BY category, name`,
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

  async getTemplate(id: string): Promise<{
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
    createdAt: string; updatedAt: string;
  } | undefined> {
    const row = await this.queryOne<{
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

  async upsertTemplate(input: {
    id: string; name: string; description: string; category: string;
    tags: string[]; author: string; workflowJson: string; nodeCount: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
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

  async deleteTemplate(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM workflow_templates WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async countTemplates(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM workflow_templates`);
    return row ? toNum(row.count) : 0;
  }

  // ---------------------------------------------------------------------------
  // Notification Configs (Phase 7.5)
  // ---------------------------------------------------------------------------

  async listNotificationConfigs(): Promise<Array<{
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
    createdAt: string; updatedAt: string;
  }>> {
    const rows = await this.query<{
      id: string; channel: string; enabled: number;
      config_json: string; events: string;
      created_at: string; updated_at: string;
    }>(`SELECT id, channel, enabled, config_json, events, created_at, updated_at FROM notification_configs ORDER BY created_at`);
    return rows.map(r => ({
      id: toStr(r.id),
      channel: toStr(r.channel),
      enabled: toNum(r.enabled) === 1,
      config: JSON.parse(toStr(r.config_json) || "{}"),
      events: JSON.parse(toStr(r.events) || '["execution.failure"]'),
      createdAt: toStr(r.created_at),
      updatedAt: toStr(r.updated_at)
    }));
  }

  async upsertNotificationConfig(input: {
    id: string; channel: string; enabled: boolean;
    config: Record<string, unknown>; events: string[];
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.execute(
      `INSERT INTO notification_configs (id, channel, enabled, config_json, events, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET channel=EXCLUDED.channel, enabled=EXCLUDED.enabled,
         config_json=EXCLUDED.config_json, events=EXCLUDED.events, updated_at=EXCLUDED.updated_at`,
      [input.id, input.channel, input.enabled ? 1 : 0,
       JSON.stringify(input.config), JSON.stringify(input.events), now, now]
    );
  }

  async deleteNotificationConfig(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM notification_configs WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ---- Not yet implemented on Postgres: each throws StoreNotImplementedError, which the API answers with 501.

  // Store lifecycle
  async storageLocation(..._args: Parameters<Store["storageLocation"]>): ReturnType<Store["storageLocation"]> {
    throw new StoreNotImplementedError("storageLocation");
  }
  async getSchemaMarker(..._args: Parameters<Store["getSchemaMarker"]>): ReturnType<Store["getSchemaMarker"]> {
    throw new StoreNotImplementedError("getSchemaMarker");
  }

  // Releases, publishing and gate admission
  async getPublishedVersion(..._args: Parameters<Store["getPublishedVersion"]>): ReturnType<Store["getPublishedVersion"]> {
    throw new StoreNotImplementedError("getPublishedVersion");
  }
  async isWorkflowVersionPinned(..._args: Parameters<Store["isWorkflowVersionPinned"]>): ReturnType<Store["isWorkflowVersionPinned"]> {
    throw new StoreNotImplementedError("isWorkflowVersionPinned");
  }
  async getReleaseGate(..._args: Parameters<Store["getReleaseGate"]>): ReturnType<Store["getReleaseGate"]> {
    throw new StoreNotImplementedError("getReleaseGate");
  }
  async upsertReleaseGate(..._args: Parameters<Store["upsertReleaseGate"]>): ReturnType<Store["upsertReleaseGate"]> {
    throw new StoreNotImplementedError("upsertReleaseGate");
  }
  async listWorkflowReleases(..._args: Parameters<Store["listWorkflowReleases"]>): ReturnType<Store["listWorkflowReleases"]> {
    throw new StoreNotImplementedError("listWorkflowReleases");
  }
  async hasReleasedVersion(..._args: Parameters<Store["hasReleasedVersion"]>): ReturnType<Store["hasReleasedVersion"]> {
    throw new StoreNotImplementedError("hasReleasedVersion");
  }
  async listReplayRunIdsForHash(..._args: Parameters<Store["listReplayRunIdsForHash"]>): ReturnType<Store["listReplayRunIdsForHash"]> {
    throw new StoreNotImplementedError("listReplayRunIdsForHash");
  }
  async setEvalRunSetSnapshot(..._args: Parameters<Store["setEvalRunSetSnapshot"]>): ReturnType<Store["setEvalRunSetSnapshot"]> {
    throw new StoreNotImplementedError("setEvalRunSetSnapshot");
  }
  async getEvalRunSetSnapshot(..._args: Parameters<Store["getEvalRunSetSnapshot"]>): ReturnType<Store["getEvalRunSetSnapshot"]> {
    throw new StoreNotImplementedError("getEvalRunSetSnapshot");
  }
  async setExecutionRelease(..._args: Parameters<Store["setExecutionRelease"]>): ReturnType<Store["setExecutionRelease"]> {
    throw new StoreNotImplementedError("setExecutionRelease");
  }
  async getExecutionRelease(..._args: Parameters<Store["getExecutionRelease"]>): ReturnType<Store["getExecutionRelease"]> {
    throw new StoreNotImplementedError("getExecutionRelease");
  }
  async listReleasedVersionHashes(..._args: Parameters<Store["listReleasedVersionHashes"]>): ReturnType<Store["listReleasedVersionHashes"]> {
    throw new StoreNotImplementedError("listReleasedVersionHashes");
  }
  async listEnabledReleaseGateWorkflowIds(..._args: Parameters<Store["listEnabledReleaseGateWorkflowIds"]>): ReturnType<Store["listEnabledReleaseGateWorkflowIds"]> {
    throw new StoreNotImplementedError("listEnabledReleaseGateWorkflowIds");
  }
  async timeOutExpiredReleaseApprovalRequests(..._args: Parameters<Store["timeOutExpiredReleaseApprovalRequests"]>): ReturnType<Store["timeOutExpiredReleaseApprovalRequests"]> {
    throw new StoreNotImplementedError("timeOutExpiredReleaseApprovalRequests");
  }
  async listPendingReleaseApprovalRequests(..._args: Parameters<Store["listPendingReleaseApprovalRequests"]>): ReturnType<Store["listPendingReleaseApprovalRequests"]> {
    throw new StoreNotImplementedError("listPendingReleaseApprovalRequests");
  }
  async insertReleaseApprovalRequest(..._args: Parameters<Store["insertReleaseApprovalRequest"]>): ReturnType<Store["insertReleaseApprovalRequest"]> {
    throw new StoreNotImplementedError("insertReleaseApprovalRequest");
  }
  async getReleaseApprovalRequest(..._args: Parameters<Store["getReleaseApprovalRequest"]>): ReturnType<Store["getReleaseApprovalRequest"]> {
    throw new StoreNotImplementedError("getReleaseApprovalRequest");
  }
  async listReleaseApprovalRequests(..._args: Parameters<Store["listReleaseApprovalRequests"]>): ReturnType<Store["listReleaseApprovalRequests"]> {
    throw new StoreNotImplementedError("listReleaseApprovalRequests");
  }
  async decideReleaseApprovalRequest(..._args: Parameters<Store["decideReleaseApprovalRequest"]>): ReturnType<Store["decideReleaseApprovalRequest"]> {
    throw new StoreNotImplementedError("decideReleaseApprovalRequest");
  }
  async setReleaseGateAdmission(..._args: Parameters<Store["setReleaseGateAdmission"]>): ReturnType<Store["setReleaseGateAdmission"]> {
    throw new StoreNotImplementedError("setReleaseGateAdmission");
  }
  async insertGateCaseRequest(..._args: Parameters<Store["insertGateCaseRequest"]>): ReturnType<Store["insertGateCaseRequest"]> {
    throw new StoreNotImplementedError("insertGateCaseRequest");
  }
  async getGateCaseRequest(..._args: Parameters<Store["getGateCaseRequest"]>): ReturnType<Store["getGateCaseRequest"]> {
    throw new StoreNotImplementedError("getGateCaseRequest");
  }
  async listPendingGateCaseRequests(..._args: Parameters<Store["listPendingGateCaseRequests"]>): ReturnType<Store["listPendingGateCaseRequests"]> {
    throw new StoreNotImplementedError("listPendingGateCaseRequests");
  }
  async listGateCaseRequests(..._args: Parameters<Store["listGateCaseRequests"]>): ReturnType<Store["listGateCaseRequests"]> {
    throw new StoreNotImplementedError("listGateCaseRequests");
  }
  async timeOutExpiredGateCaseRequests(..._args: Parameters<Store["timeOutExpiredGateCaseRequests"]>): ReturnType<Store["timeOutExpiredGateCaseRequests"]> {
    throw new StoreNotImplementedError("timeOutExpiredGateCaseRequests");
  }
  async decideGateCaseRequest(..._args: Parameters<Store["decideGateCaseRequest"]>): ReturnType<Store["decideGateCaseRequest"]> {
    throw new StoreNotImplementedError("decideGateCaseRequest");
  }
  async markEvalRunsReleaseIneligible(..._args: Parameters<Store["markEvalRunsReleaseIneligible"]>): ReturnType<Store["markEvalRunsReleaseIneligible"]> {
    throw new StoreNotImplementedError("markEvalRunsReleaseIneligible");
  }

  // Guard simulations
  async insertGuardSimulation(..._args: Parameters<Store["insertGuardSimulation"]>): ReturnType<Store["insertGuardSimulation"]> {
    throw new StoreNotImplementedError("insertGuardSimulation");
  }
  async updateGuardSimulation(..._args: Parameters<Store["updateGuardSimulation"]>): ReturnType<Store["updateGuardSimulation"]> {
    throw new StoreNotImplementedError("updateGuardSimulation");
  }
  async getGuardSimulation(..._args: Parameters<Store["getGuardSimulation"]>): ReturnType<Store["getGuardSimulation"]> {
    throw new StoreNotImplementedError("getGuardSimulation");
  }
  async listGuardSimulations(..._args: Parameters<Store["listGuardSimulations"]>): ReturnType<Store["listGuardSimulations"]> {
    throw new StoreNotImplementedError("listGuardSimulations");
  }
  async listRunningGuardSimulations(..._args: Parameters<Store["listRunningGuardSimulations"]>): ReturnType<Store["listRunningGuardSimulations"]> {
    throw new StoreNotImplementedError("listRunningGuardSimulations");
  }
  async pruneGuardSimulations(..._args: Parameters<Store["pruneGuardSimulations"]>): ReturnType<Store["pruneGuardSimulations"]> {
    throw new StoreNotImplementedError("pruneGuardSimulations");
  }

  // MCP cassettes
  async saveMcpCassette(..._args: Parameters<Store["saveMcpCassette"]>): ReturnType<Store["saveMcpCassette"]> {
    throw new StoreNotImplementedError("saveMcpCassette");
  }
  async getMcpCassetteSummary(..._args: Parameters<Store["getMcpCassetteSummary"]>): ReturnType<Store["getMcpCassetteSummary"]> {
    throw new StoreNotImplementedError("getMcpCassetteSummary");
  }
  async getMcpCassette(..._args: Parameters<Store["getMcpCassette"]>): ReturnType<Store["getMcpCassette"]> {
    throw new StoreNotImplementedError("getMcpCassette");
  }
  async getMcpCassetteForExecution(..._args: Parameters<Store["getMcpCassetteForExecution"]>): ReturnType<Store["getMcpCassetteForExecution"]> {
    throw new StoreNotImplementedError("getMcpCassetteForExecution");
  }
  async listMcpCassettesForEvalRun(..._args: Parameters<Store["listMcpCassettesForEvalRun"]>): ReturnType<Store["listMcpCassettesForEvalRun"]> {
    throw new StoreNotImplementedError("listMcpCassettesForEvalRun");
  }
  async listMcpCassettes(..._args: Parameters<Store["listMcpCassettes"]>): ReturnType<Store["listMcpCassettes"]> {
    throw new StoreNotImplementedError("listMcpCassettes");
  }
  async mcpCassetteBadgesForExecutions(..._args: Parameters<Store["mcpCassetteBadgesForExecutions"]>): ReturnType<Store["mcpCassetteBadgesForExecutions"]> {
    throw new StoreNotImplementedError("mcpCassetteBadgesForExecutions");
  }
  async deleteMcpCassette(..._args: Parameters<Store["deleteMcpCassette"]>): ReturnType<Store["deleteMcpCassette"]> {
    throw new StoreNotImplementedError("deleteMcpCassette");
  }

  // MCP registry, probes, telemetry, OAuth, elicitations, policies, toolsets and clients
  async createMcpServer(..._args: Parameters<Store["createMcpServer"]>): ReturnType<Store["createMcpServer"]> {
    throw new StoreNotImplementedError("createMcpServer");
  }
  async updateMcpServer(..._args: Parameters<Store["updateMcpServer"]>): ReturnType<Store["updateMcpServer"]> {
    throw new StoreNotImplementedError("updateMcpServer");
  }
  async deleteMcpServer(..._args: Parameters<Store["deleteMcpServer"]>): ReturnType<Store["deleteMcpServer"]> {
    throw new StoreNotImplementedError("deleteMcpServer");
  }
  async setMcpServerSandboxStatus(..._args: Parameters<Store["setMcpServerSandboxStatus"]>): ReturnType<Store["setMcpServerSandboxStatus"]> {
    throw new StoreNotImplementedError("setMcpServerSandboxStatus");
  }
  async getMcpServer(..._args: Parameters<Store["getMcpServer"]>): ReturnType<Store["getMcpServer"]> {
    throw new StoreNotImplementedError("getMcpServer");
  }
  async listMcpServers(..._args: Parameters<Store["listMcpServers"]>): ReturnType<Store["listMcpServers"]> {
    throw new StoreNotImplementedError("listMcpServers");
  }
  async recordMcpServerProbe(..._args: Parameters<Store["recordMcpServerProbe"]>): ReturnType<Store["recordMcpServerProbe"]> {
    throw new StoreNotImplementedError("recordMcpServerProbe");
  }
  async listMcpServerProbes(..._args: Parameters<Store["listMcpServerProbes"]>): ReturnType<Store["listMcpServerProbes"]> {
    throw new StoreNotImplementedError("listMcpServerProbes");
  }
  async getMcpToolSnapshot(..._args: Parameters<Store["getMcpToolSnapshot"]>): ReturnType<Store["getMcpToolSnapshot"]> {
    throw new StoreNotImplementedError("getMcpToolSnapshot");
  }
  async listMcpToolSnapshots(..._args: Parameters<Store["listMcpToolSnapshots"]>): ReturnType<Store["listMcpToolSnapshots"]> {
    throw new StoreNotImplementedError("listMcpToolSnapshots");
  }
  async acknowledgeMcpBreakingChange(..._args: Parameters<Store["acknowledgeMcpBreakingChange"]>): ReturnType<Store["acknowledgeMcpBreakingChange"]> {
    throw new StoreNotImplementedError("acknowledgeMcpBreakingChange");
  }
  async replaceMcpToolCallsForExecution(..._args: Parameters<Store["replaceMcpToolCallsForExecution"]>): ReturnType<Store["replaceMcpToolCallsForExecution"]> {
    throw new StoreNotImplementedError("replaceMcpToolCallsForExecution");
  }
  async insertMcpToolCall(..._args: Parameters<Store["insertMcpToolCall"]>): ReturnType<Store["insertMcpToolCall"]> {
    throw new StoreNotImplementedError("insertMcpToolCall");
  }
  async listMcpToolCallsForClient(..._args: Parameters<Store["listMcpToolCallsForClient"]>): ReturnType<Store["listMcpToolCallsForClient"]> {
    throw new StoreNotImplementedError("listMcpToolCallsForClient");
  }
  async summarizeMcpClientUsage(..._args: Parameters<Store["summarizeMcpClientUsage"]>): ReturnType<Store["summarizeMcpClientUsage"]> {
    throw new StoreNotImplementedError("summarizeMcpClientUsage");
  }
  async listMcpToolCalls(..._args: Parameters<Store["listMcpToolCalls"]>): ReturnType<Store["listMcpToolCalls"]> {
    throw new StoreNotImplementedError("listMcpToolCalls");
  }
  async getMcpOAuthConnection(..._args: Parameters<Store["getMcpOAuthConnection"]>): ReturnType<Store["getMcpOAuthConnection"]> {
    throw new StoreNotImplementedError("getMcpOAuthConnection");
  }
  async upsertMcpOAuthConnection(..._args: Parameters<Store["upsertMcpOAuthConnection"]>): ReturnType<Store["upsertMcpOAuthConnection"]> {
    throw new StoreNotImplementedError("upsertMcpOAuthConnection");
  }
  async getMcpUserOAuthConnection(..._args: Parameters<Store["getMcpUserOAuthConnection"]>): ReturnType<Store["getMcpUserOAuthConnection"]> {
    throw new StoreNotImplementedError("getMcpUserOAuthConnection");
  }
  async listMcpUserOAuthConnections(..._args: Parameters<Store["listMcpUserOAuthConnections"]>): ReturnType<Store["listMcpUserOAuthConnections"]> {
    throw new StoreNotImplementedError("listMcpUserOAuthConnections");
  }
  async upsertMcpUserOAuthConnection(..._args: Parameters<Store["upsertMcpUserOAuthConnection"]>): ReturnType<Store["upsertMcpUserOAuthConnection"]> {
    throw new StoreNotImplementedError("upsertMcpUserOAuthConnection");
  }
  async deleteMcpUserOAuthConnection(..._args: Parameters<Store["deleteMcpUserOAuthConnection"]>): ReturnType<Store["deleteMcpUserOAuthConnection"]> {
    throw new StoreNotImplementedError("deleteMcpUserOAuthConnection");
  }
  async deleteMcpOAuthConnection(..._args: Parameters<Store["deleteMcpOAuthConnection"]>): ReturnType<Store["deleteMcpOAuthConnection"]> {
    throw new StoreNotImplementedError("deleteMcpOAuthConnection");
  }
  async getMcpServerCatalog(..._args: Parameters<Store["getMcpServerCatalog"]>): ReturnType<Store["getMcpServerCatalog"]> {
    throw new StoreNotImplementedError("getMcpServerCatalog");
  }
  async upsertMcpServerCatalog(..._args: Parameters<Store["upsertMcpServerCatalog"]>): ReturnType<Store["upsertMcpServerCatalog"]> {
    throw new StoreNotImplementedError("upsertMcpServerCatalog");
  }
  async createMcpElicitation(..._args: Parameters<Store["createMcpElicitation"]>): ReturnType<Store["createMcpElicitation"]> {
    throw new StoreNotImplementedError("createMcpElicitation");
  }
  async getMcpElicitation(..._args: Parameters<Store["getMcpElicitation"]>): ReturnType<Store["getMcpElicitation"]> {
    throw new StoreNotImplementedError("getMcpElicitation");
  }
  async listMcpElicitations(..._args: Parameters<Store["listMcpElicitations"]>): ReturnType<Store["listMcpElicitations"]> {
    throw new StoreNotImplementedError("listMcpElicitations");
  }
  async settleMcpElicitation(..._args: Parameters<Store["settleMcpElicitation"]>): ReturnType<Store["settleMcpElicitation"]> {
    throw new StoreNotImplementedError("settleMcpElicitation");
  }
  async expireMcpElicitationsForExecution(..._args: Parameters<Store["expireMcpElicitationsForExecution"]>): ReturnType<Store["expireMcpElicitationsForExecution"]> {
    throw new StoreNotImplementedError("expireMcpElicitationsForExecution");
  }
  async listExpiredMcpElicitations(..._args: Parameters<Store["listExpiredMcpElicitations"]>): ReturnType<Store["listExpiredMcpElicitations"]> {
    throw new StoreNotImplementedError("listExpiredMcpElicitations");
  }
  async listMcpToolPolicies(..._args: Parameters<Store["listMcpToolPolicies"]>): ReturnType<Store["listMcpToolPolicies"]> {
    throw new StoreNotImplementedError("listMcpToolPolicies");
  }
  async getMcpToolPolicy(..._args: Parameters<Store["getMcpToolPolicy"]>): ReturnType<Store["getMcpToolPolicy"]> {
    throw new StoreNotImplementedError("getMcpToolPolicy");
  }
  async createMcpToolPolicy(..._args: Parameters<Store["createMcpToolPolicy"]>): ReturnType<Store["createMcpToolPolicy"]> {
    throw new StoreNotImplementedError("createMcpToolPolicy");
  }
  async updateMcpToolPolicy(..._args: Parameters<Store["updateMcpToolPolicy"]>): ReturnType<Store["updateMcpToolPolicy"]> {
    throw new StoreNotImplementedError("updateMcpToolPolicy");
  }
  async deleteMcpToolPolicy(..._args: Parameters<Store["deleteMcpToolPolicy"]>): ReturnType<Store["deleteMcpToolPolicy"]> {
    throw new StoreNotImplementedError("deleteMcpToolPolicy");
  }
  async listMcpToolClassifications(..._args: Parameters<Store["listMcpToolClassifications"]>): ReturnType<Store["listMcpToolClassifications"]> {
    throw new StoreNotImplementedError("listMcpToolClassifications");
  }
  async setMcpToolClassification(..._args: Parameters<Store["setMcpToolClassification"]>): ReturnType<Store["setMcpToolClassification"]> {
    throw new StoreNotImplementedError("setMcpToolClassification");
  }
  async listMcpToolsets(..._args: Parameters<Store["listMcpToolsets"]>): ReturnType<Store["listMcpToolsets"]> {
    throw new StoreNotImplementedError("listMcpToolsets");
  }
  async getMcpToolset(..._args: Parameters<Store["getMcpToolset"]>): ReturnType<Store["getMcpToolset"]> {
    throw new StoreNotImplementedError("getMcpToolset");
  }
  async getMcpToolsetBySlug(..._args: Parameters<Store["getMcpToolsetBySlug"]>): ReturnType<Store["getMcpToolsetBySlug"]> {
    throw new StoreNotImplementedError("getMcpToolsetBySlug");
  }
  async createMcpToolset(..._args: Parameters<Store["createMcpToolset"]>): ReturnType<Store["createMcpToolset"]> {
    throw new StoreNotImplementedError("createMcpToolset");
  }
  async updateMcpToolset(..._args: Parameters<Store["updateMcpToolset"]>): ReturnType<Store["updateMcpToolset"]> {
    throw new StoreNotImplementedError("updateMcpToolset");
  }
  async deleteMcpToolset(..._args: Parameters<Store["deleteMcpToolset"]>): ReturnType<Store["deleteMcpToolset"]> {
    throw new StoreNotImplementedError("deleteMcpToolset");
  }
  async createMcpClient(..._args: Parameters<Store["createMcpClient"]>): ReturnType<Store["createMcpClient"]> {
    throw new StoreNotImplementedError("createMcpClient");
  }
  async getMcpClient(..._args: Parameters<Store["getMcpClient"]>): ReturnType<Store["getMcpClient"]> {
    throw new StoreNotImplementedError("getMcpClient");
  }
  async findMcpClientByTokenPrefix(..._args: Parameters<Store["findMcpClientByTokenPrefix"]>): ReturnType<Store["findMcpClientByTokenPrefix"]> {
    throw new StoreNotImplementedError("findMcpClientByTokenPrefix");
  }
  async listMcpClients(..._args: Parameters<Store["listMcpClients"]>): ReturnType<Store["listMcpClients"]> {
    throw new StoreNotImplementedError("listMcpClients");
  }
  async revokeMcpClient(..._args: Parameters<Store["revokeMcpClient"]>): ReturnType<Store["revokeMcpClient"]> {
    throw new StoreNotImplementedError("revokeMcpClient");
  }
  async touchMcpClient(..._args: Parameters<Store["touchMcpClient"]>): ReturnType<Store["touchMcpClient"]> {
    throw new StoreNotImplementedError("touchMcpClient");
  }
  async listMcpToolCallsForExecution(..._args: Parameters<Store["listMcpToolCallsForExecution"]>): ReturnType<Store["listMcpToolCallsForExecution"]> {
    throw new StoreNotImplementedError("listMcpToolCallsForExecution");
  }

  // Guard profiles, bindings, events and vault
  async listGuardProfiles(..._args: Parameters<Store["listGuardProfiles"]>): ReturnType<Store["listGuardProfiles"]> {
    throw new StoreNotImplementedError("listGuardProfiles");
  }
  async getGuardProfile(..._args: Parameters<Store["getGuardProfile"]>): ReturnType<Store["getGuardProfile"]> {
    throw new StoreNotImplementedError("getGuardProfile");
  }
  async guardProfileRevision(..._args: Parameters<Store["guardProfileRevision"]>): ReturnType<Store["guardProfileRevision"]> {
    throw new StoreNotImplementedError("guardProfileRevision");
  }
  async anyGuardProfileUsesLabels(..._args: Parameters<Store["anyGuardProfileUsesLabels"]>): ReturnType<Store["anyGuardProfileUsesLabels"]> {
    throw new StoreNotImplementedError("anyGuardProfileUsesLabels");
  }
  async countObservedDestinationBlocks(..._args: Parameters<Store["countObservedDestinationBlocks"]>): ReturnType<Store["countObservedDestinationBlocks"]> {
    throw new StoreNotImplementedError("countObservedDestinationBlocks");
  }
  async getGuardProfileVersion(..._args: Parameters<Store["getGuardProfileVersion"]>): ReturnType<Store["getGuardProfileVersion"]> {
    throw new StoreNotImplementedError("getGuardProfileVersion");
  }
  async listGuardProfileVersions(..._args: Parameters<Store["listGuardProfileVersions"]>): ReturnType<Store["listGuardProfileVersions"]> {
    throw new StoreNotImplementedError("listGuardProfileVersions");
  }
  async insertGuardProfile(..._args: Parameters<Store["insertGuardProfile"]>): ReturnType<Store["insertGuardProfile"]> {
    throw new StoreNotImplementedError("insertGuardProfile");
  }
  async addGuardProfileVersion(..._args: Parameters<Store["addGuardProfileVersion"]>): ReturnType<Store["addGuardProfileVersion"]> {
    throw new StoreNotImplementedError("addGuardProfileVersion");
  }
  async deleteGuardProfile(..._args: Parameters<Store["deleteGuardProfile"]>): ReturnType<Store["deleteGuardProfile"]> {
    throw new StoreNotImplementedError("deleteGuardProfile");
  }
  async getGuardBinding(..._args: Parameters<Store["getGuardBinding"]>): ReturnType<Store["getGuardBinding"]> {
    throw new StoreNotImplementedError("getGuardBinding");
  }
  async listGuardBindingsForProfile(..._args: Parameters<Store["listGuardBindingsForProfile"]>): ReturnType<Store["listGuardBindingsForProfile"]> {
    throw new StoreNotImplementedError("listGuardBindingsForProfile");
  }
  async setGuardBinding(..._args: Parameters<Store["setGuardBinding"]>): ReturnType<Store["setGuardBinding"]> {
    throw new StoreNotImplementedError("setGuardBinding");
  }
  async insertGuardEvents(..._args: Parameters<Store["insertGuardEvents"]>): ReturnType<Store["insertGuardEvents"]> {
    throw new StoreNotImplementedError("insertGuardEvents");
  }
  async listGuardEvents(..._args: Parameters<Store["listGuardEvents"]>): ReturnType<Store["listGuardEvents"]> {
    throw new StoreNotImplementedError("listGuardEvents");
  }
  async listGuardEventsForExecution(..._args: Parameters<Store["listGuardEventsForExecution"]>): ReturnType<Store["listGuardEventsForExecution"]> {
    throw new StoreNotImplementedError("listGuardEventsForExecution");
  }
  async guardEventStats(..._args: Parameters<Store["guardEventStats"]>): ReturnType<Store["guardEventStats"]> {
    throw new StoreNotImplementedError("guardEventStats");
  }
  async getGuardVaultByToken(..._args: Parameters<Store["getGuardVaultByToken"]>): ReturnType<Store["getGuardVaultByToken"]> {
    throw new StoreNotImplementedError("getGuardVaultByToken");
  }
  async getGuardVaultByHash(..._args: Parameters<Store["getGuardVaultByHash"]>): ReturnType<Store["getGuardVaultByHash"]> {
    throw new StoreNotImplementedError("getGuardVaultByHash");
  }
  async putGuardVault(..._args: Parameters<Store["putGuardVault"]>): ReturnType<Store["putGuardVault"]> {
    throw new StoreNotImplementedError("putGuardVault");
  }

  // Data destinations
  async listWorkflowConfigsForDestinations(..._args: Parameters<Store["listWorkflowConfigsForDestinations"]>): ReturnType<Store["listWorkflowConfigsForDestinations"]> {
    throw new StoreNotImplementedError("listWorkflowConfigsForDestinations");
  }
  async listDataDestinations(..._args: Parameters<Store["listDataDestinations"]>): ReturnType<Store["listDataDestinations"]> {
    throw new StoreNotImplementedError("listDataDestinations");
  }
  async getDataDestination(..._args: Parameters<Store["getDataDestination"]>): ReturnType<Store["getDataDestination"]> {
    throw new StoreNotImplementedError("getDataDestination");
  }
  async findDataDestinationByMatch(..._args: Parameters<Store["findDataDestinationByMatch"]>): ReturnType<Store["findDataDestinationByMatch"]> {
    throw new StoreNotImplementedError("findDataDestinationByMatch");
  }
  async insertDataDestination(..._args: Parameters<Store["insertDataDestination"]>): ReturnType<Store["insertDataDestination"]> {
    throw new StoreNotImplementedError("insertDataDestination");
  }
  async updateDataDestination(..._args: Parameters<Store["updateDataDestination"]>): ReturnType<Store["updateDataDestination"]> {
    throw new StoreNotImplementedError("updateDataDestination");
  }
  async deleteDataDestination(..._args: Parameters<Store["deleteDataDestination"]>): ReturnType<Store["deleteDataDestination"]> {
    throw new StoreNotImplementedError("deleteDataDestination");
  }

  // Knowledge bases
  async createKnowledgeBase(..._args: Parameters<Store["createKnowledgeBase"]>): ReturnType<Store["createKnowledgeBase"]> {
    throw new StoreNotImplementedError("createKnowledgeBase");
  }
  async updateKnowledgeBase(..._args: Parameters<Store["updateKnowledgeBase"]>): ReturnType<Store["updateKnowledgeBase"]> {
    throw new StoreNotImplementedError("updateKnowledgeBase");
  }
  async deleteKnowledgeBase(..._args: Parameters<Store["deleteKnowledgeBase"]>): ReturnType<Store["deleteKnowledgeBase"]> {
    throw new StoreNotImplementedError("deleteKnowledgeBase");
  }
  async getKnowledgeBase(..._args: Parameters<Store["getKnowledgeBase"]>): ReturnType<Store["getKnowledgeBase"]> {
    throw new StoreNotImplementedError("getKnowledgeBase");
  }
  async listKnowledgeBases(..._args: Parameters<Store["listKnowledgeBases"]>): ReturnType<Store["listKnowledgeBases"]> {
    throw new StoreNotImplementedError("listKnowledgeBases");
  }
  async addKnowledgeBaseChunks(..._args: Parameters<Store["addKnowledgeBaseChunks"]>): ReturnType<Store["addKnowledgeBaseChunks"]> {
    throw new StoreNotImplementedError("addKnowledgeBaseChunks");
  }
  async listKnowledgeBaseChunks(..._args: Parameters<Store["listKnowledgeBaseChunks"]>): ReturnType<Store["listKnowledgeBaseChunks"]> {
    throw new StoreNotImplementedError("listKnowledgeBaseChunks");
  }
  async bm25SearchKnowledgeBase(..._args: Parameters<Store["bm25SearchKnowledgeBase"]>): ReturnType<Store["bm25SearchKnowledgeBase"]> {
    throw new StoreNotImplementedError("bm25SearchKnowledgeBase");
  }
  async listKnowledgeBaseChunkPreviews(..._args: Parameters<Store["listKnowledgeBaseChunkPreviews"]>): ReturnType<Store["listKnowledgeBaseChunkPreviews"]> {
    throw new StoreNotImplementedError("listKnowledgeBaseChunkPreviews");
  }
  async deleteKnowledgeBaseChunksBySource(..._args: Parameters<Store["deleteKnowledgeBaseChunksBySource"]>): ReturnType<Store["deleteKnowledgeBaseChunksBySource"]> {
    throw new StoreNotImplementedError("deleteKnowledgeBaseChunksBySource");
  }
  async listKnowledgeBaseSources(..._args: Parameters<Store["listKnowledgeBaseSources"]>): ReturnType<Store["listKnowledgeBaseSources"]> {
    throw new StoreNotImplementedError("listKnowledgeBaseSources");
  }

  // Evals (datasets, fixtures, runs, results)
  async createEvalDataset(..._args: Parameters<Store["createEvalDataset"]>): ReturnType<Store["createEvalDataset"]> {
    throw new StoreNotImplementedError("createEvalDataset");
  }
  async listEvalDatasets(..._args: Parameters<Store["listEvalDatasets"]>): ReturnType<Store["listEvalDatasets"]> {
    throw new StoreNotImplementedError("listEvalDatasets");
  }
  async getEvalDataset(..._args: Parameters<Store["getEvalDataset"]>): ReturnType<Store["getEvalDataset"]> {
    throw new StoreNotImplementedError("getEvalDataset");
  }
  async deleteEvalDataset(..._args: Parameters<Store["deleteEvalDataset"]>): ReturnType<Store["deleteEvalDataset"]> {
    throw new StoreNotImplementedError("deleteEvalDataset");
  }
  async createEvalFixture(..._args: Parameters<Store["createEvalFixture"]>): ReturnType<Store["createEvalFixture"]> {
    throw new StoreNotImplementedError("createEvalFixture");
  }
  async listEvalFixtures(..._args: Parameters<Store["listEvalFixtures"]>): ReturnType<Store["listEvalFixtures"]> {
    throw new StoreNotImplementedError("listEvalFixtures");
  }
  async getEvalFixture(..._args: Parameters<Store["getEvalFixture"]>): ReturnType<Store["getEvalFixture"]> {
    throw new StoreNotImplementedError("getEvalFixture");
  }
  async findEvalFixtureByRecording(..._args: Parameters<Store["findEvalFixtureByRecording"]>): ReturnType<Store["findEvalFixtureByRecording"]> {
    throw new StoreNotImplementedError("findEvalFixtureByRecording");
  }
  async getEvalFixtureDatasetId(..._args: Parameters<Store["getEvalFixtureDatasetId"]>): ReturnType<Store["getEvalFixtureDatasetId"]> {
    throw new StoreNotImplementedError("getEvalFixtureDatasetId");
  }
  async deleteEvalFixture(..._args: Parameters<Store["deleteEvalFixture"]>): ReturnType<Store["deleteEvalFixture"]> {
    throw new StoreNotImplementedError("deleteEvalFixture");
  }
  async setEvalFixtureRequired(..._args: Parameters<Store["setEvalFixtureRequired"]>): ReturnType<Store["setEvalFixtureRequired"]> {
    throw new StoreNotImplementedError("setEvalFixtureRequired");
  }
  async createEvalRun(..._args: Parameters<Store["createEvalRun"]>): ReturnType<Store["createEvalRun"]> {
    throw new StoreNotImplementedError("createEvalRun");
  }
  async updateEvalRunProgress(..._args: Parameters<Store["updateEvalRunProgress"]>): ReturnType<Store["updateEvalRunProgress"]> {
    throw new StoreNotImplementedError("updateEvalRunProgress");
  }
  async pruneEvalRuns(..._args: Parameters<Store["pruneEvalRuns"]>): ReturnType<Store["pruneEvalRuns"]> {
    throw new StoreNotImplementedError("pruneEvalRuns");
  }
  async finalizeEvalRun(..._args: Parameters<Store["finalizeEvalRun"]>): ReturnType<Store["finalizeEvalRun"]> {
    throw new StoreNotImplementedError("finalizeEvalRun");
  }
  async updateEvalRunSummary(..._args: Parameters<Store["updateEvalRunSummary"]>): ReturnType<Store["updateEvalRunSummary"]> {
    throw new StoreNotImplementedError("updateEvalRunSummary");
  }
  async listEvalRuns(..._args: Parameters<Store["listEvalRuns"]>): ReturnType<Store["listEvalRuns"]> {
    throw new StoreNotImplementedError("listEvalRuns");
  }
  async getEvalRun(..._args: Parameters<Store["getEvalRun"]>): ReturnType<Store["getEvalRun"]> {
    throw new StoreNotImplementedError("getEvalRun");
  }
  async recordEvalResult(..._args: Parameters<Store["recordEvalResult"]>): ReturnType<Store["recordEvalResult"]> {
    throw new StoreNotImplementedError("recordEvalResult");
  }
  async listEvalResults(..._args: Parameters<Store["listEvalResults"]>): ReturnType<Store["listEvalResults"]> {
    throw new StoreNotImplementedError("listEvalResults");
  }
  async getEvalResult(..._args: Parameters<Store["getEvalResult"]>): ReturnType<Store["getEvalResult"]> {
    throw new StoreNotImplementedError("getEvalResult");
  }
  async evalFixtureIdsForRecording(..._args: Parameters<Store["evalFixtureIdsForRecording"]>): ReturnType<Store["evalFixtureIdsForRecording"]> {
    throw new StoreNotImplementedError("evalFixtureIdsForRecording");
  }
  async evalRunIdsForResults(..._args: Parameters<Store["evalRunIdsForResults"]>): ReturnType<Store["evalRunIdsForResults"]> {
    throw new StoreNotImplementedError("evalRunIdsForResults");
  }
  async deleteEvalFixturesForRecording(..._args: Parameters<Store["deleteEvalFixturesForRecording"]>): ReturnType<Store["deleteEvalFixturesForRecording"]> {
    throw new StoreNotImplementedError("deleteEvalFixturesForRecording");
  }

  // Replay recordings, capture and subject rows
  async saveReplayRecording(..._args: Parameters<Store["saveReplayRecording"]>): ReturnType<Store["saveReplayRecording"]> {
    throw new StoreNotImplementedError("saveReplayRecording");
  }
  async getReplayRecordingSummary(..._args: Parameters<Store["getReplayRecordingSummary"]>): ReturnType<Store["getReplayRecordingSummary"]> {
    throw new StoreNotImplementedError("getReplayRecordingSummary");
  }
  async getReplayRecording(..._args: Parameters<Store["getReplayRecording"]>): ReturnType<Store["getReplayRecording"]> {
    throw new StoreNotImplementedError("getReplayRecording");
  }
  async listReplayRecordings(..._args: Parameters<Store["listReplayRecordings"]>): ReturnType<Store["listReplayRecordings"]> {
    throw new StoreNotImplementedError("listReplayRecordings");
  }
  async sumReplayRecordingBytesForWorkflow(..._args: Parameters<Store["sumReplayRecordingBytesForWorkflow"]>): ReturnType<Store["sumReplayRecordingBytesForWorkflow"]> {
    throw new StoreNotImplementedError("sumReplayRecordingBytesForWorkflow");
  }
  async sumReplayRecordingBytes(..._args: Parameters<Store["sumReplayRecordingBytes"]>): ReturnType<Store["sumReplayRecordingBytes"]> {
    throw new StoreNotImplementedError("sumReplayRecordingBytes");
  }
  async findReplayRecordingIdForExecution(..._args: Parameters<Store["findReplayRecordingIdForExecution"]>): ReturnType<Store["findReplayRecordingIdForExecution"]> {
    throw new StoreNotImplementedError("findReplayRecordingIdForExecution");
  }
  async countReplayRecordingsForWorkflow(..._args: Parameters<Store["countReplayRecordingsForWorkflow"]>): ReturnType<Store["countReplayRecordingsForWorkflow"]> {
    throw new StoreNotImplementedError("countReplayRecordingsForWorkflow");
  }
  async listReplayCaptures(..._args: Parameters<Store["listReplayCaptures"]>): ReturnType<Store["listReplayCaptures"]> {
    throw new StoreNotImplementedError("listReplayCaptures");
  }
  async countReplayCapturesSince(..._args: Parameters<Store["countReplayCapturesSince"]>): ReturnType<Store["countReplayCapturesSince"]> {
    throw new StoreNotImplementedError("countReplayCapturesSince");
  }
  async oldestReplayCaptureIds(..._args: Parameters<Store["oldestReplayCaptureIds"]>): ReturnType<Store["oldestReplayCaptureIds"]> {
    throw new StoreNotImplementedError("oldestReplayCaptureIds");
  }
  async pruneReplayCaptures(..._args: Parameters<Store["pruneReplayCaptures"]>): ReturnType<Store["pruneReplayCaptures"]> {
    throw new StoreNotImplementedError("pruneReplayCaptures");
  }
  async promoteReplayCapture(..._args: Parameters<Store["promoteReplayCapture"]>): ReturnType<Store["promoteReplayCapture"]> {
    throw new StoreNotImplementedError("promoteReplayCapture");
  }
  async getReplayCaptureSettings(..._args: Parameters<Store["getReplayCaptureSettings"]>): ReturnType<Store["getReplayCaptureSettings"]> {
    throw new StoreNotImplementedError("getReplayCaptureSettings");
  }
  async saveReplayCaptureSettings(..._args: Parameters<Store["saveReplayCaptureSettings"]>): ReturnType<Store["saveReplayCaptureSettings"]> {
    throw new StoreNotImplementedError("saveReplayCaptureSettings");
  }
  async recordReplayCaptureDrop(..._args: Parameters<Store["recordReplayCaptureDrop"]>): ReturnType<Store["recordReplayCaptureDrop"]> {
    throw new StoreNotImplementedError("recordReplayCaptureDrop");
  }
  async subjectTextPage(..._args: Parameters<Store["subjectTextPage"]>): ReturnType<Store["subjectTextPage"]> {
    throw new StoreNotImplementedError("subjectTextPage");
  }
  async subjectTextRow(..._args: Parameters<Store["subjectTextRow"]>): ReturnType<Store["subjectTextRow"]> {
    throw new StoreNotImplementedError("subjectTextRow");
  }
  async countSubjectRows(..._args: Parameters<Store["countSubjectRows"]>): ReturnType<Store["countSubjectRows"]> {
    throw new StoreNotImplementedError("countSubjectRows");
  }
  async deleteSubjectRow(..._args: Parameters<Store["deleteSubjectRow"]>): ReturnType<Store["deleteSubjectRow"]> {
    throw new StoreNotImplementedError("deleteSubjectRow");
  }
  async sumReplayCaptureBytesForWorkflow(..._args: Parameters<Store["sumReplayCaptureBytesForWorkflow"]>): ReturnType<Store["sumReplayCaptureBytesForWorkflow"]> {
    throw new StoreNotImplementedError("sumReplayCaptureBytesForWorkflow");
  }
  async oldestReplayCaptures(..._args: Parameters<Store["oldestReplayCaptures"]>): ReturnType<Store["oldestReplayCaptures"]> {
    throw new StoreNotImplementedError("oldestReplayCaptures");
  }
  async replayGoldenBadgesForExecutions(..._args: Parameters<Store["replayGoldenBadgesForExecutions"]>): ReturnType<Store["replayGoldenBadgesForExecutions"]> {
    throw new StoreNotImplementedError("replayGoldenBadgesForExecutions");
  }
  async deleteReplayRecording(..._args: Parameters<Store["deleteReplayRecording"]>): ReturnType<Store["deleteReplayRecording"]> {
    throw new StoreNotImplementedError("deleteReplayRecording");
  }

  // Workflow versions
  async listWorkflowVersions(..._args: Parameters<Store["listWorkflowVersions"]>): ReturnType<Store["listWorkflowVersions"]> {
    throw new StoreNotImplementedError("listWorkflowVersions");
  }
  async getWorkflowVersion(..._args: Parameters<Store["getWorkflowVersion"]>): ReturnType<Store["getWorkflowVersion"]> {
    throw new StoreNotImplementedError("getWorkflowVersion");
  }
  async writeWorkflowVersion(..._args: Parameters<Store["writeWorkflowVersion"]>): ReturnType<Store["writeWorkflowVersion"]> {
    throw new StoreNotImplementedError("writeWorkflowVersion");
  }
  async pruneWorkflowVersions(..._args: Parameters<Store["pruneWorkflowVersions"]>): ReturnType<Store["pruneWorkflowVersions"]> {
    throw new StoreNotImplementedError("pruneWorkflowVersions");
  }
  async maxWorkflowVersionNumber(..._args: Parameters<Store["maxWorkflowVersionNumber"]>): ReturnType<Store["maxWorkflowVersionNumber"]> {
    throw new StoreNotImplementedError("maxWorkflowVersionNumber");
  }
  async appendWorkflowVersion(..._args: Parameters<Store["appendWorkflowVersion"]>): ReturnType<Store["appendWorkflowVersion"]> {
    throw new StoreNotImplementedError("appendWorkflowVersion");
  }
  async publishWorkflowVersion(..._args: Parameters<Store["publishWorkflowVersion"]>): ReturnType<Store["publishWorkflowVersion"]> {
    throw new StoreNotImplementedError("publishWorkflowVersion");
  }

  // RBAC: project roles, custom roles, SSO group mappings
  async countProjectMemberships(..._args: Parameters<Store["countProjectMemberships"]>): ReturnType<Store["countProjectMemberships"]> {
    throw new StoreNotImplementedError("countProjectMemberships");
  }
  async listProjectMembers(..._args: Parameters<Store["listProjectMembers"]>): ReturnType<Store["listProjectMembers"]> {
    throw new StoreNotImplementedError("listProjectMembers");
  }
  async listUserProjectRoles(..._args: Parameters<Store["listUserProjectRoles"]>): ReturnType<Store["listUserProjectRoles"]> {
    throw new StoreNotImplementedError("listUserProjectRoles");
  }
  async getProjectRole(..._args: Parameters<Store["getProjectRole"]>): ReturnType<Store["getProjectRole"]> {
    throw new StoreNotImplementedError("getProjectRole");
  }
  async upsertProjectRole(..._args: Parameters<Store["upsertProjectRole"]>): ReturnType<Store["upsertProjectRole"]> {
    throw new StoreNotImplementedError("upsertProjectRole");
  }
  async removeProjectRole(..._args: Parameters<Store["removeProjectRole"]>): ReturnType<Store["removeProjectRole"]> {
    throw new StoreNotImplementedError("removeProjectRole");
  }
  async listCustomRoles(..._args: Parameters<Store["listCustomRoles"]>): ReturnType<Store["listCustomRoles"]> {
    throw new StoreNotImplementedError("listCustomRoles");
  }
  async getCustomRole(..._args: Parameters<Store["getCustomRole"]>): ReturnType<Store["getCustomRole"]> {
    throw new StoreNotImplementedError("getCustomRole");
  }
  async upsertCustomRole(..._args: Parameters<Store["upsertCustomRole"]>): ReturnType<Store["upsertCustomRole"]> {
    throw new StoreNotImplementedError("upsertCustomRole");
  }
  async deleteCustomRole(..._args: Parameters<Store["deleteCustomRole"]>): ReturnType<Store["deleteCustomRole"]> {
    throw new StoreNotImplementedError("deleteCustomRole");
  }
  async listSsoGroupMappings(..._args: Parameters<Store["listSsoGroupMappings"]>): ReturnType<Store["listSsoGroupMappings"]> {
    throw new StoreNotImplementedError("listSsoGroupMappings");
  }
  async upsertSsoGroupMapping(..._args: Parameters<Store["upsertSsoGroupMapping"]>): ReturnType<Store["upsertSsoGroupMapping"]> {
    throw new StoreNotImplementedError("upsertSsoGroupMapping");
  }
  async deleteSsoGroupMapping(..._args: Parameters<Store["deleteSsoGroupMapping"]>): ReturnType<Store["deleteSsoGroupMapping"]> {
    throw new StoreNotImplementedError("deleteSsoGroupMapping");
  }

  // Workflow and secret shares
  async listWorkflowShares(..._args: Parameters<Store["listWorkflowShares"]>): ReturnType<Store["listWorkflowShares"]> {
    throw new StoreNotImplementedError("listWorkflowShares");
  }
  async listWorkflowsSharedToProject(..._args: Parameters<Store["listWorkflowsSharedToProject"]>): ReturnType<Store["listWorkflowsSharedToProject"]> {
    throw new StoreNotImplementedError("listWorkflowsSharedToProject");
  }
  async upsertWorkflowShare(..._args: Parameters<Store["upsertWorkflowShare"]>): ReturnType<Store["upsertWorkflowShare"]> {
    throw new StoreNotImplementedError("upsertWorkflowShare");
  }
  async removeWorkflowShare(..._args: Parameters<Store["removeWorkflowShare"]>): ReturnType<Store["removeWorkflowShare"]> {
    throw new StoreNotImplementedError("removeWorkflowShare");
  }
  async listSecretShares(..._args: Parameters<Store["listSecretShares"]>): ReturnType<Store["listSecretShares"]> {
    throw new StoreNotImplementedError("listSecretShares");
  }
  async listSecretsSharedToProject(..._args: Parameters<Store["listSecretsSharedToProject"]>): ReturnType<Store["listSecretsSharedToProject"]> {
    throw new StoreNotImplementedError("listSecretsSharedToProject");
  }
  async upsertSecretShare(..._args: Parameters<Store["upsertSecretShare"]>): ReturnType<Store["upsertSecretShare"]> {
    throw new StoreNotImplementedError("upsertSecretShare");
  }
  async removeSecretShare(..._args: Parameters<Store["removeSecretShare"]>): ReturnType<Store["removeSecretShare"]> {
    throw new StoreNotImplementedError("removeSecretShare");
  }

  // Workflows and templates
  async getWorkflowCreatedBy(..._args: Parameters<Store["getWorkflowCreatedBy"]>): ReturnType<Store["getWorkflowCreatedBy"]> {
    throw new StoreNotImplementedError("getWorkflowCreatedBy");
  }

  // Users, sessions, API keys, MFA and SSO identities
  async saveApiKey(..._args: Parameters<Store["saveApiKey"]>): ReturnType<Store["saveApiKey"]> {
    throw new StoreNotImplementedError("saveApiKey");
  }
  async listApiKeys(..._args: Parameters<Store["listApiKeys"]>): ReturnType<Store["listApiKeys"]> {
    throw new StoreNotImplementedError("listApiKeys");
  }
  async findApiKeyByPrefix(..._args: Parameters<Store["findApiKeyByPrefix"]>): ReturnType<Store["findApiKeyByPrefix"]> {
    throw new StoreNotImplementedError("findApiKeyByPrefix");
  }
  async touchApiKey(..._args: Parameters<Store["touchApiKey"]>): ReturnType<Store["touchApiKey"]> {
    throw new StoreNotImplementedError("touchApiKey");
  }
  async revokeApiKey(..._args: Parameters<Store["revokeApiKey"]>): ReturnType<Store["revokeApiKey"]> {
    throw new StoreNotImplementedError("revokeApiKey");
  }
  async getMfaSecret(..._args: Parameters<Store["getMfaSecret"]>): ReturnType<Store["getMfaSecret"]> {
    throw new StoreNotImplementedError("getMfaSecret");
  }
  async upsertMfaSecret(..._args: Parameters<Store["upsertMfaSecret"]>): ReturnType<Store["upsertMfaSecret"]> {
    throw new StoreNotImplementedError("upsertMfaSecret");
  }
  async replaceMfaBackupCodes(..._args: Parameters<Store["replaceMfaBackupCodes"]>): ReturnType<Store["replaceMfaBackupCodes"]> {
    throw new StoreNotImplementedError("replaceMfaBackupCodes");
  }
  async deleteMfaSecret(..._args: Parameters<Store["deleteMfaSecret"]>): ReturnType<Store["deleteMfaSecret"]> {
    throw new StoreNotImplementedError("deleteMfaSecret");
  }
  async findSsoIdentity(..._args: Parameters<Store["findSsoIdentity"]>): ReturnType<Store["findSsoIdentity"]> {
    throw new StoreNotImplementedError("findSsoIdentity");
  }
  async upsertSsoIdentity(..._args: Parameters<Store["upsertSsoIdentity"]>): ReturnType<Store["upsertSsoIdentity"]> {
    throw new StoreNotImplementedError("upsertSsoIdentity");
  }

  // Secrets and external secret providers
  async deleteSecret(..._args: Parameters<Store["deleteSecret"]>): ReturnType<Store["deleteSecret"]> {
    throw new StoreNotImplementedError("deleteSecret");
  }
  async listExternalSecretProviders(..._args: Parameters<Store["listExternalSecretProviders"]>): ReturnType<Store["listExternalSecretProviders"]> {
    throw new StoreNotImplementedError("listExternalSecretProviders");
  }
  async getExternalSecretProvider(..._args: Parameters<Store["getExternalSecretProvider"]>): ReturnType<Store["getExternalSecretProvider"]> {
    throw new StoreNotImplementedError("getExternalSecretProvider");
  }
  async upsertExternalSecretProvider(..._args: Parameters<Store["upsertExternalSecretProvider"]>): ReturnType<Store["upsertExternalSecretProvider"]> {
    throw new StoreNotImplementedError("upsertExternalSecretProvider");
  }
  async deleteExternalSecretProvider(..._args: Parameters<Store["deleteExternalSecretProvider"]>): ReturnType<Store["deleteExternalSecretProvider"]> {
    throw new StoreNotImplementedError("deleteExternalSecretProvider");
  }
  async countSecretsUsingExternalProvider(..._args: Parameters<Store["countSecretsUsingExternalProvider"]>): ReturnType<Store["countSecretsUsingExternalProvider"]> {
    throw new StoreNotImplementedError("countSecretsUsingExternalProvider");
  }
  async getExternalSecretCacheEntry(..._args: Parameters<Store["getExternalSecretCacheEntry"]>): ReturnType<Store["getExternalSecretCacheEntry"]> {
    throw new StoreNotImplementedError("getExternalSecretCacheEntry");
  }
  async upsertExternalSecretCacheEntry(..._args: Parameters<Store["upsertExternalSecretCacheEntry"]>): ReturnType<Store["upsertExternalSecretCacheEntry"]> {
    throw new StoreNotImplementedError("upsertExternalSecretCacheEntry");
  }
  async deleteExternalSecretCacheEntry(..._args: Parameters<Store["deleteExternalSecretCacheEntry"]>): ReturnType<Store["deleteExternalSecretCacheEntry"]> {
    throw new StoreNotImplementedError("deleteExternalSecretCacheEntry");
  }

  // Execution history and paused executions
  async claimWorkflowExecutionForResume(..._args: Parameters<Store["claimWorkflowExecutionForResume"]>): ReturnType<Store["claimWorkflowExecutionForResume"]> {
    throw new StoreNotImplementedError("claimWorkflowExecutionForResume");
  }
  async listResumingWorkflowExecutionIds(..._args: Parameters<Store["listResumingWorkflowExecutionIds"]>): ReturnType<Store["listResumingWorkflowExecutionIds"]> {
    throw new StoreNotImplementedError("listResumingWorkflowExecutionIds");
  }
  async listResumingWorkflowExecutions(..._args: Parameters<Store["listResumingWorkflowExecutions"]>): ReturnType<Store["listResumingWorkflowExecutions"]> {
    throw new StoreNotImplementedError("listResumingWorkflowExecutions");
  }
  async releaseWorkflowExecutionClaim(..._args: Parameters<Store["releaseWorkflowExecutionClaim"]>): ReturnType<Store["releaseWorkflowExecutionClaim"]> {
    throw new StoreNotImplementedError("releaseWorkflowExecutionClaim");
  }

  // Approval requests
  async insertApprovalRequest(..._args: Parameters<Store["insertApprovalRequest"]>): ReturnType<Store["insertApprovalRequest"]> {
    throw new StoreNotImplementedError("insertApprovalRequest");
  }
  async getApprovalRequest(..._args: Parameters<Store["getApprovalRequest"]>): ReturnType<Store["getApprovalRequest"]> {
    throw new StoreNotImplementedError("getApprovalRequest");
  }
  async getPendingApprovalRequestForExecution(..._args: Parameters<Store["getPendingApprovalRequestForExecution"]>): ReturnType<Store["getPendingApprovalRequestForExecution"]> {
    throw new StoreNotImplementedError("getPendingApprovalRequestForExecution");
  }
  async listApprovalRequestsForExecution(..._args: Parameters<Store["listApprovalRequestsForExecution"]>): ReturnType<Store["listApprovalRequestsForExecution"]> {
    throw new StoreNotImplementedError("listApprovalRequestsForExecution");
  }
  async listApprovalRequests(..._args: Parameters<Store["listApprovalRequests"]>): ReturnType<Store["listApprovalRequests"]> {
    throw new StoreNotImplementedError("listApprovalRequests");
  }
  async listExpiredApprovalRequests(..._args: Parameters<Store["listExpiredApprovalRequests"]>): ReturnType<Store["listExpiredApprovalRequests"]> {
    throw new StoreNotImplementedError("listExpiredApprovalRequests");
  }
  async decideApprovalRequest(..._args: Parameters<Store["decideApprovalRequest"]>): ReturnType<Store["decideApprovalRequest"]> {
    throw new StoreNotImplementedError("decideApprovalRequest");
  }
  async reopenApprovalRequest(..._args: Parameters<Store["reopenApprovalRequest"]>): ReturnType<Store["reopenApprovalRequest"]> {
    throw new StoreNotImplementedError("reopenApprovalRequest");
  }
  async cancelPendingApprovalRequests(..._args: Parameters<Store["cancelPendingApprovalRequests"]>): ReturnType<Store["cancelPendingApprovalRequests"]> {
    throw new StoreNotImplementedError("cancelPendingApprovalRequests");
  }

  // Execution queue
  async hasActiveQueueItem(..._args: Parameters<Store["hasActiveQueueItem"]>): ReturnType<Store["hasActiveQueueItem"]> {
    throw new StoreNotImplementedError("hasActiveQueueItem");
  }

  // Triggers, git sync and leases
  async getGitConfig(..._args: Parameters<Store["getGitConfig"]>): ReturnType<Store["getGitConfig"]> {
    throw new StoreNotImplementedError("getGitConfig");
  }
  async upsertGitConfig(..._args: Parameters<Store["upsertGitConfig"]>): ReturnType<Store["upsertGitConfig"]> {
    throw new StoreNotImplementedError("upsertGitConfig");
  }
  async deleteGitConfig(..._args: Parameters<Store["deleteGitConfig"]>): ReturnType<Store["deleteGitConfig"]> {
    throw new StoreNotImplementedError("deleteGitConfig");
  }
  async recordGitSync(..._args: Parameters<Store["recordGitSync"]>): ReturnType<Store["recordGitSync"]> {
    throw new StoreNotImplementedError("recordGitSync");
  }
  async getLease(..._args: Parameters<Store["getLease"]>): ReturnType<Store["getLease"]> {
    throw new StoreNotImplementedError("getLease");
  }
  async tryAcquireLease(..._args: Parameters<Store["tryAcquireLease"]>): ReturnType<Store["tryAcquireLease"]> {
    throw new StoreNotImplementedError("tryAcquireLease");
  }
  async releaseLease(..._args: Parameters<Store["releaseLease"]>): ReturnType<Store["releaseLease"]> {
    throw new StoreNotImplementedError("releaseLease");
  }
  async listLeases(..._args: Parameters<Store["listLeases"]>): ReturnType<Store["listLeases"]> {
    throw new StoreNotImplementedError("listLeases");
  }

  // Audit log, log streaming, audit export, signing keys and execution manifests
  async writeAuditLog(..._args: Parameters<Store["writeAuditLog"]>): ReturnType<Store["writeAuditLog"]> {
    throw new StoreNotImplementedError("writeAuditLog");
  }
  async verifyAuditChain(..._args: Parameters<Store["verifyAuditChain"]>): ReturnType<Store["verifyAuditChain"]> {
    throw new StoreNotImplementedError("verifyAuditChain");
  }
  async listAuditLogs(..._args: Parameters<Store["listAuditLogs"]>): ReturnType<Store["listAuditLogs"]> {
    throw new StoreNotImplementedError("listAuditLogs");
  }
  async pruneAuditLogs(..._args: Parameters<Store["pruneAuditLogs"]>): ReturnType<Store["pruneAuditLogs"]> {
    throw new StoreNotImplementedError("pruneAuditLogs");
  }
  async listLogStreamDestinations(..._args: Parameters<Store["listLogStreamDestinations"]>): ReturnType<Store["listLogStreamDestinations"]> {
    throw new StoreNotImplementedError("listLogStreamDestinations");
  }
  async getLogStreamDestination(..._args: Parameters<Store["getLogStreamDestination"]>): ReturnType<Store["getLogStreamDestination"]> {
    throw new StoreNotImplementedError("getLogStreamDestination");
  }
  async upsertLogStreamDestination(..._args: Parameters<Store["upsertLogStreamDestination"]>): ReturnType<Store["upsertLogStreamDestination"]> {
    throw new StoreNotImplementedError("upsertLogStreamDestination");
  }
  async deleteLogStreamDestination(..._args: Parameters<Store["deleteLogStreamDestination"]>): ReturnType<Store["deleteLogStreamDestination"]> {
    throw new StoreNotImplementedError("deleteLogStreamDestination");
  }
  async recordLogStreamDispatch(..._args: Parameters<Store["recordLogStreamDispatch"]>): ReturnType<Store["recordLogStreamDispatch"]> {
    throw new StoreNotImplementedError("recordLogStreamDispatch");
  }
  async writeLogStreamEvent(..._args: Parameters<Store["writeLogStreamEvent"]>): ReturnType<Store["writeLogStreamEvent"]> {
    throw new StoreNotImplementedError("writeLogStreamEvent");
  }
  async listLogStreamEvents(..._args: Parameters<Store["listLogStreamEvents"]>): ReturnType<Store["listLogStreamEvents"]> {
    throw new StoreNotImplementedError("listLogStreamEvents");
  }
  async pruneLogStreamEvents(..._args: Parameters<Store["pruneLogStreamEvents"]>): ReturnType<Store["pruneLogStreamEvents"]> {
    throw new StoreNotImplementedError("pruneLogStreamEvents");
  }
  async createAuditExportDestination(..._args: Parameters<Store["createAuditExportDestination"]>): ReturnType<Store["createAuditExportDestination"]> {
    throw new StoreNotImplementedError("createAuditExportDestination");
  }
  async updateAuditExportDestination(..._args: Parameters<Store["updateAuditExportDestination"]>): ReturnType<Store["updateAuditExportDestination"]> {
    throw new StoreNotImplementedError("updateAuditExportDestination");
  }
  async deleteAuditExportDestination(..._args: Parameters<Store["deleteAuditExportDestination"]>): ReturnType<Store["deleteAuditExportDestination"]> {
    throw new StoreNotImplementedError("deleteAuditExportDestination");
  }
  async listAuditExportDestinations(..._args: Parameters<Store["listAuditExportDestinations"]>): ReturnType<Store["listAuditExportDestinations"]> {
    throw new StoreNotImplementedError("listAuditExportDestinations");
  }
  async getAuditExportDestination(..._args: Parameters<Store["getAuditExportDestination"]>): ReturnType<Store["getAuditExportDestination"]> {
    throw new StoreNotImplementedError("getAuditExportDestination");
  }
  async listAuditLogsAfter(..._args: Parameters<Store["listAuditLogsAfter"]>): ReturnType<Store["listAuditLogsAfter"]> {
    throw new StoreNotImplementedError("listAuditLogsAfter");
  }
  async recordAuditExportRun(..._args: Parameters<Store["recordAuditExportRun"]>): ReturnType<Store["recordAuditExportRun"]> {
    throw new StoreNotImplementedError("recordAuditExportRun");
  }
  async listAuditExportRuns(..._args: Parameters<Store["listAuditExportRuns"]>): ReturnType<Store["listAuditExportRuns"]> {
    throw new StoreNotImplementedError("listAuditExportRuns");
  }
  async getExecutionManifest(..._args: Parameters<Store["getExecutionManifest"]>): ReturnType<Store["getExecutionManifest"]> {
    throw new StoreNotImplementedError("getExecutionManifest");
  }
  async saveExecutionRunContext(..._args: Parameters<Store["saveExecutionRunContext"]>): ReturnType<Store["saveExecutionRunContext"]> {
    throw new StoreNotImplementedError("saveExecutionRunContext");
  }
  async saveExecutionManifest(..._args: Parameters<Store["saveExecutionManifest"]>): ReturnType<Store["saveExecutionManifest"]> {
    throw new StoreNotImplementedError("saveExecutionManifest");
  }
  async listAuditLogsForExecution(..._args: Parameters<Store["listAuditLogsForExecution"]>): ReturnType<Store["listAuditLogsForExecution"]> {
    throw new StoreNotImplementedError("listAuditLogsForExecution");
  }
  async pruneExecutionManifests(..._args: Parameters<Store["pruneExecutionManifests"]>): ReturnType<Store["pruneExecutionManifests"]> {
    throw new StoreNotImplementedError("pruneExecutionManifests");
  }
  async listAuditSigningKeys(..._args: Parameters<Store["listAuditSigningKeys"]>): ReturnType<Store["listAuditSigningKeys"]> {
    throw new StoreNotImplementedError("listAuditSigningKeys");
  }
  async getAuditSigningKey(..._args: Parameters<Store["getAuditSigningKey"]>): ReturnType<Store["getAuditSigningKey"]> {
    throw new StoreNotImplementedError("getAuditSigningKey");
  }
  async getActiveAuditSigningKey(..._args: Parameters<Store["getActiveAuditSigningKey"]>): ReturnType<Store["getActiveAuditSigningKey"]> {
    throw new StoreNotImplementedError("getActiveAuditSigningKey");
  }
  async activateAuditSigningKey(..._args: Parameters<Store["activateAuditSigningKey"]>): ReturnType<Store["activateAuditSigningKey"]> {
    throw new StoreNotImplementedError("activateAuditSigningKey");
  }

  // Variables
  async listVariables(..._args: Parameters<Store["listVariables"]>): ReturnType<Store["listVariables"]> {
    throw new StoreNotImplementedError("listVariables");
  }
  async getVariable(..._args: Parameters<Store["getVariable"]>): ReturnType<Store["getVariable"]> {
    throw new StoreNotImplementedError("getVariable");
  }
  async upsertVariable(..._args: Parameters<Store["upsertVariable"]>): ReturnType<Store["upsertVariable"]> {
    throw new StoreNotImplementedError("upsertVariable");
  }
  async deleteVariable(..._args: Parameters<Store["deleteVariable"]>): ReturnType<Store["deleteVariable"]> {
    throw new StoreNotImplementedError("deleteVariable");
  }
  async findVariableByKey(..._args: Parameters<Store["findVariableByKey"]>): ReturnType<Store["findVariableByKey"]> {
    throw new StoreNotImplementedError("findVariableByKey");
  }

  // Usage and budgets
  async writeUsageEvent(..._args: Parameters<Store["writeUsageEvent"]>): ReturnType<Store["writeUsageEvent"]> {
    throw new StoreNotImplementedError("writeUsageEvent");
  }
  async queryUsageRollup(..._args: Parameters<Store["queryUsageRollup"]>): ReturnType<Store["queryUsageRollup"]> {
    throw new StoreNotImplementedError("queryUsageRollup");
  }
  async queryUsageTotals(..._args: Parameters<Store["queryUsageTotals"]>): ReturnType<Store["queryUsageTotals"]> {
    throw new StoreNotImplementedError("queryUsageTotals");
  }
  async listUsageEvents(..._args: Parameters<Store["listUsageEvents"]>): ReturnType<Store["listUsageEvents"]> {
    throw new StoreNotImplementedError("listUsageEvents");
  }
  async createBudget(..._args: Parameters<Store["createBudget"]>): ReturnType<Store["createBudget"]> {
    throw new StoreNotImplementedError("createBudget");
  }
  async updateBudget(..._args: Parameters<Store["updateBudget"]>): ReturnType<Store["updateBudget"]> {
    throw new StoreNotImplementedError("updateBudget");
  }
  async deleteBudget(..._args: Parameters<Store["deleteBudget"]>): ReturnType<Store["deleteBudget"]> {
    throw new StoreNotImplementedError("deleteBudget");
  }
  async getBudget(..._args: Parameters<Store["getBudget"]>): ReturnType<Store["getBudget"]> {
    throw new StoreNotImplementedError("getBudget");
  }
  async listBudgets(..._args: Parameters<Store["listBudgets"]>): ReturnType<Store["listBudgets"]> {
    throw new StoreNotImplementedError("listBudgets");
  }
  async recordBudgetAlert(..._args: Parameters<Store["recordBudgetAlert"]>): ReturnType<Store["recordBudgetAlert"]> {
    throw new StoreNotImplementedError("recordBudgetAlert");
  }
  async getLatestBudgetAlert(..._args: Parameters<Store["getLatestBudgetAlert"]>): ReturnType<Store["getLatestBudgetAlert"]> {
    throw new StoreNotImplementedError("getLatestBudgetAlert");
  }
  async listBudgetAlerts(..._args: Parameters<Store["listBudgetAlerts"]>): ReturnType<Store["listBudgetAlerts"]> {
    throw new StoreNotImplementedError("listBudgetAlerts");
  }

  // Atomic multi-step operations (each runs in one transaction)
  async claimExecutionAndDecideApproval(..._args: Parameters<Store["claimExecutionAndDecideApproval"]>): ReturnType<Store["claimExecutionAndDecideApproval"]> {
    throw new StoreNotImplementedError("claimExecutionAndDecideApproval");
  }
  async releaseExecutionClaimAndReopenApproval(..._args: Parameters<Store["releaseExecutionClaimAndReopenApproval"]>): ReturnType<Store["releaseExecutionClaimAndReopenApproval"]> {
    throw new StoreNotImplementedError("releaseExecutionClaimAndReopenApproval");
  }
  async saveReleaseGate(..._args: Parameters<Store["saveReleaseGate"]>): ReturnType<Store["saveReleaseGate"]> {
    throw new StoreNotImplementedError("saveReleaseGate");
  }
  async updateReleaseGateCases(..._args: Parameters<Store["updateReleaseGateCases"]>): ReturnType<Store["updateReleaseGateCases"]> {
    throw new StoreNotImplementedError("updateReleaseGateCases");
  }
  async approveReleaseRequestAndPublish(..._args: Parameters<Store["approveReleaseRequestAndPublish"]>): ReturnType<Store["approveReleaseRequestAndPublish"]> {
    throw new StoreNotImplementedError("approveReleaseRequestAndPublish");
  }
  async saveReplayRecordingChecked(..._args: Parameters<Store["saveReplayRecordingChecked"]>): ReturnType<Store["saveReplayRecordingChecked"]> {
    throw new StoreNotImplementedError("saveReplayRecordingChecked");
  }
  async promoteReplayCaptureToGoldenSet(..._args: Parameters<Store["promoteReplayCaptureToGoldenSet"]>): ReturnType<Store["promoteReplayCaptureToGoldenSet"]> {
    throw new StoreNotImplementedError("promoteReplayCaptureToGoldenSet");
  }
  async importGoldenSet(..._args: Parameters<Store["importGoldenSet"]>): ReturnType<Store["importGoldenSet"]> {
    throw new StoreNotImplementedError("importGoldenSet");
  }
}
