import pg, { type Pool, type PoolClient, type PoolConfig } from "pg";
import { runMigrations } from "./migrations.js";
import type { Store } from "./store.js";
import type { PostgresSslSettings } from "../config.js";
import { createPgContext, type PgContext } from "./postgres/context.js";
import { createPostgresPool, type PoolErrorLogger } from "./postgres/pool.js";
import { PG_TIMESTAMPTZ_OID, parseTimestamptz, toNum } from "./postgres/helpers.js";
import * as approvals from "./postgres/approvals.js";
import * as audit from "./postgres/audit.js";
import * as auth from "./postgres/auth.js";
import * as capture from "./postgres/capture.js";
import * as data_destinations from "./postgres/data-destinations.js";
import * as data_labels from "./postgres/data-labels.js";
import * as evals from "./postgres/eval.js";
import * as executions from "./postgres/executions.js";
import * as guard from "./postgres/guard.js";
import * as guard_simulation from "./postgres/guard-simulation.js";
import * as knowledge from "./postgres/knowledge.js";
import * as mcp from "./postgres/mcp.js";
import * as misc from "./postgres/misc.js";
import * as queue from "./postgres/queue.js";
import * as release from "./postgres/release.js";
import * as replay from "./postgres/replay.js";
import * as schedules from "./postgres/schedules.js";
import * as secrets from "./postgres/secrets.js";
import * as sessions from "./postgres/sessions.js";
import * as webhooks from "./postgres/webhooks.js";
import * as workflows from "./postgres/workflows.js";
import { ADVISORY_LOCK_CLASS_LEADER, PgLeaderLock, type LeaderLock, type PgLeaderLockOptions } from "./postgres/leader-lock.js";

export { parseTimestamptz };

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

/**
 * Phase 13.1 — L2M's advisory-lock key space. Two-key locks `(class, key)`; each class is one purpose, so locks taken
 * for different purposes never collide:
 *   0x4c324d ("L2M")  migrations — key: hashtext(schema). Held while the chain runs or is reversed (boot, db:rollback,
 *                     db:restore); see withMigrationLock.
 *   0x4c324e ("L2N")  leader election (reserved for the scheduler/queue leader lock).
 *   0x4c324f ("L2O")  audit writes (postgres/audit.ts) — key 1: the audit-log chain append; key 2: signing-key
 *                     activation. Keys 3 and 4 (MCP policies / clients before v40) are retired; do not reuse them.
 *   0x4c3257 ("L2W")  workflow version numbers (postgres/workflows.ts) — key: hashtext(workflow id). Held by
 *                     appendWorkflowVersion from reading MAX(version) to commit.
 *   0x4c3252 ("L2R")  golden-run saves, capture promotions and golden-set imports — one key for the deployment,
 *                     held for the transaction (pg_advisory_xact_lock); see ADVISORY_LOCK_CLASS_REPLAY_GOLDEN in
 *                     postgres/replay.ts.
 * Add a new class here rather than reusing one.
 */
export const ADVISORY_LOCK_CLASS_MIGRATIONS = 0x4c324d;
export { ADVISORY_LOCK_CLASS_LEADER };
/** Phase 13.1 — application_name of the dedicated leader-lock connection. */
export const LEADER_APPLICATION_NAME = "l2m-leader";

/** TIMESTAMPTZ through parseTimestamptz; every other type keeps pg's default parser. */
const POSTGRES_TYPES = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === PG_TIMESTAMPTZ_OID && format !== "binary") {
      return parseTimestamptz;
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

/**
 * Phase 13.1 — runs `fn` on one connection holding the migrations advisory lock for `schema` (the connection's
 * current schema when unset), so booting instances, db:rollback and db:restore never run or reverse the chain at the
 * same time. The lock is released afterwards, also when `fn` throws; a connection whose unlock fails is discarded,
 * which releases a session lock too.
 */
export async function withMigrationLock<T>(pool: Pool, schema: string | undefined, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    const lockArgs = [ADVISORY_LOCK_CLASS_MIGRATIONS, schema ?? null];
    await client.query(`SELECT pg_advisory_lock($1, hashtext(COALESCE($2::text, current_schema(), '')))`, lockArgs);
    try {
      return await fn(client);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1, hashtext(COALESCE($2::text, current_schema(), '')))`, lockArgs).catch(() => {
        discard = true;
      });
    }
  } finally {
    client.release(discard);
  }
}

/** The applied chain version on this connection (0 for none). */
export async function currentChainVersion(client: Pool | PoolClient): Promise<number> {
  const result = await client.query<{ version: string | number | null }>(`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`);
  return toNum(result.rows[0]?.version);
}

/** Creates `schema_migrations` when missing. */
export async function ensureMigrationsTable(client: Pool | PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Applies every pending chain migration on `client` (call it inside withMigrationLock). Returns the NOTICE messages
 * the migrations raised (for example how many running guard simulations v39 interrupted), for one startup line each.
 */
export async function applyMigrationChain(client: PoolClient): Promise<string[]> {
  const notices: string[] = [];
  const onNotice = (notice: { message?: string }) => {
    if (notice.message?.startsWith("L2M ")) notices.push(notice.message.slice(4));
  };
  client.on("notice", onNotice);
  try {
    await ensureMigrationsTable(client);
    await runMigrations(
      async (sql) => { await client.query(sql); },
      () => currentChainVersion(client),
      async (version) => {
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [version]);
      }
    );
  } finally {
    client.off("notice", onNotice);
  }
  return notices;
}

export class PostgresStore implements Store {
  private readonly pool: Pool;
  private readonly ctx: PgContext;

  /** Phase 13.1 — one-line notes from this start's migrations (e.g. simulations an upgrade interrupted), for the log. */
  readonly upgradeNotes: string[] = [];

  private readonly config: PostgresStoreConfig;
  private readonly leaderLocks = new Set<PgLeaderLock>();

  private constructor(pool: Pool, config: PostgresStoreConfig) {
    this.pool = pool;
    this.config = config;
    this.ctx = createPgContext(pool, this);
  }

  static async create(config: PostgresStoreConfig, options: { logger?: PoolErrorLogger } = {}): Promise<PostgresStore> {
    // An idle connection the server ends is logged, not an unhandled 'error' event that ends the process.
    const pool = createPostgresPool(postgresPoolConfig(config), { label: "store", ...(options.logger ? { logger: options.logger } : {}) });
    try {
      const store = new PostgresStore(pool, config);
      await store.migrate(config.schema);
      return store;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  private closing: Promise<void> | undefined;

  async close(): Promise<void> {
    // Idempotent like SqliteStore.close: the app's onClose and a caller may both close it; both wait for the end.
    // promise-ok: kept and awaited below (and by every later close)
    this.closing ??= (async () => {
      await Promise.all([...this.leaderLocks].map((lock) => lock.release()));
      await this.pool.end();
    })();
    await this.closing;
  }

  /**
   * Phase 13.1 — the leader lock for `leaseName`: a session advisory lock on a dedicated connection (not one of the
   * pool's), released when the lock is released, the store closes, or the connection ends.
   */
  leaderLock(input: {
    leaseName: string;
    holderId: string;
    ttlMs: number;
    /** HA_RENEW_INTERVAL_MS: how often the lock is checked; sizes the session's liveness settings. */
    renewIntervalMs?: number;
    logger?: PgLeaderLockOptions["logger"];
  }): LeaderLock {
    const lock = new PgLeaderLock({
      // Named, so an operator can find the leader's session (pg_stat_activity.application_name).
      clientConfig: postgresPoolConfig(this.config, { max: 1, application_name: LEADER_APPLICATION_NAME }),
      pool: this.pool,
      ...input
    });
    this.leaderLocks.add(lock);
    return lock;
  }

  /**
   * Runs the MIGRATIONS chain under the migrations advisory lock (keyed by the schema), so two instances starting
   * together never run the same migration twice; the second waits, then finds nothing to do. `schema` (tests) is
   * created, under the lock, when missing.
   */
  private async migrate(schema?: string): Promise<void> {
    const notes = await withMigrationLock(this.pool, schema, async (client) => {
      if (schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schema)}`);
      return applyMigrationChain(client);
    });
    this.upgradeNotes.push(...notes);
  }

  async listWorkflows(...args: Parameters<Store["listWorkflows"]>): ReturnType<Store["listWorkflows"]> {
    return workflows.listWorkflows(this.ctx, ...args);
  }
  async getWorkflow(...args: Parameters<Store["getWorkflow"]>): ReturnType<Store["getWorkflow"]> {
    return workflows.getWorkflow(this.ctx, ...args);
  }
  async upsertWorkflow(...args: Parameters<Store["upsertWorkflow"]>): ReturnType<Store["upsertWorkflow"]> {
    return workflows.upsertWorkflow(this.ctx, ...args);
  }
  async deleteWorkflow(...args: Parameters<Store["deleteWorkflow"]>): ReturnType<Store["deleteWorkflow"]> {
    return workflows.deleteWorkflow(this.ctx, ...args);
  }
  async countWorkflows(...args: Parameters<Store["countWorkflows"]>): ReturnType<Store["countWorkflows"]> {
    return workflows.countWorkflows(this.ctx, ...args);
  }
  async listSecrets(...args: Parameters<Store["listSecrets"]>): ReturnType<Store["listSecrets"]> {
    return secrets.listSecrets(this.ctx, ...args);
  }
  async getSecret(...args: Parameters<Store["getSecret"]>): ReturnType<Store["getSecret"]> {
    return secrets.getSecret(this.ctx, ...args);
  }
  async saveSecret(...args: Parameters<Store["saveSecret"]>): ReturnType<Store["saveSecret"]> {
    return secrets.saveSecret(this.ctx, ...args);
  }
  async listProjects(...args: Parameters<Store["listProjects"]>): ReturnType<Store["listProjects"]> {
    return workflows.listProjects(this.ctx, ...args);
  }
  async getProject(...args: Parameters<Store["getProject"]>): ReturnType<Store["getProject"]> {
    return workflows.getProject(this.ctx, ...args);
  }
  async upsertProject(...args: Parameters<Store["upsertProject"]>): ReturnType<Store["upsertProject"]> {
    return workflows.upsertProject(this.ctx, ...args);
  }
  async deleteProject(...args: Parameters<Store["deleteProject"]>): ReturnType<Store["deleteProject"]> {
    return workflows.deleteProject(this.ctx, ...args);
  }
  async listFolders(...args: Parameters<Store["listFolders"]>): ReturnType<Store["listFolders"]> {
    return workflows.listFolders(this.ctx, ...args);
  }
  async getFolder(...args: Parameters<Store["getFolder"]>): ReturnType<Store["getFolder"]> {
    return workflows.getFolder(this.ctx, ...args);
  }
  async upsertFolder(...args: Parameters<Store["upsertFolder"]>): ReturnType<Store["upsertFolder"]> {
    return workflows.upsertFolder(this.ctx, ...args);
  }
  async deleteFolder(...args: Parameters<Store["deleteFolder"]>): ReturnType<Store["deleteFolder"]> {
    return workflows.deleteFolder(this.ctx, ...args);
  }
  async ensureDefaultProject(...args: Parameters<Store["ensureDefaultProject"]>): ReturnType<Store["ensureDefaultProject"]> {
    return workflows.ensureDefaultProject(this.ctx, ...args);
  }
  async countUsers(...args: Parameters<Store["countUsers"]>): ReturnType<Store["countUsers"]> {
    return auth.countUsers(this.ctx, ...args);
  }
  async getUserByEmail(...args: Parameters<Store["getUserByEmail"]>): ReturnType<Store["getUserByEmail"]> {
    return auth.getUserByEmail(this.ctx, ...args);
  }
  async getUserById(...args: Parameters<Store["getUserById"]>): ReturnType<Store["getUserById"]> {
    return auth.getUserById(this.ctx, ...args);
  }
  async saveUser(...args: Parameters<Store["saveUser"]>): ReturnType<Store["saveUser"]> {
    return auth.saveUser(this.ctx, ...args);
  }
  async listUsers(...args: Parameters<Store["listUsers"]>): ReturnType<Store["listUsers"]> {
    return auth.listUsers(this.ctx, ...args);
  }
  async updateUserRole(...args: Parameters<Store["updateUserRole"]>): ReturnType<Store["updateUserRole"]> {
    return auth.updateUserRole(this.ctx, ...args);
  }
  async deleteUser(...args: Parameters<Store["deleteUser"]>): ReturnType<Store["deleteUser"]> {
    return auth.deleteUser(this.ctx, ...args);
  }
  async getSession(...args: Parameters<Store["getSession"]>): ReturnType<Store["getSession"]> {
    return sessions.getSession(this.ctx, ...args);
  }
  async saveSession(...args: Parameters<Store["saveSession"]>): ReturnType<Store["saveSession"]> {
    return sessions.saveSession(this.ctx, ...args);
  }
  async touchSession(...args: Parameters<Store["touchSession"]>): ReturnType<Store["touchSession"]> {
    return sessions.touchSession(this.ctx, ...args);
  }
  async revokeSession(...args: Parameters<Store["revokeSession"]>): ReturnType<Store["revokeSession"]> {
    return sessions.revokeSession(this.ctx, ...args);
  }
  async revokeExpiredSessions(...args: Parameters<Store["revokeExpiredSessions"]>): ReturnType<Store["revokeExpiredSessions"]> {
    return sessions.revokeExpiredSessions(this.ctx, ...args);
  }
  async loadSessionMemory(...args: Parameters<Store["loadSessionMemory"]>): ReturnType<Store["loadSessionMemory"]> {
    return sessions.loadSessionMemory(this.ctx, ...args);
  }
  async loadSessionMemoryLabels(...args: Parameters<Store["loadSessionMemoryLabels"]>): ReturnType<Store["loadSessionMemoryLabels"]> {
    return sessions.loadSessionMemoryLabels(this.ctx, ...args);
  }
  async saveSessionMemory(...args: Parameters<Store["saveSessionMemory"]>): ReturnType<Store["saveSessionMemory"]> {
    return sessions.saveSessionMemory(this.ctx, ...args);
  }
  async saveSessionToolCall(...args: Parameters<Store["saveSessionToolCall"]>): ReturnType<Store["saveSessionToolCall"]> {
    return sessions.saveSessionToolCall(this.ctx, ...args);
  }
  async listSessionToolCalls(...args: Parameters<Store["listSessionToolCalls"]>): ReturnType<Store["listSessionToolCalls"]> {
    return sessions.listSessionToolCalls(this.ctx, ...args);
  }
  async getSessionToolCall(...args: Parameters<Store["getSessionToolCall"]>): ReturnType<Store["getSessionToolCall"]> {
    return sessions.getSessionToolCall(this.ctx, ...args);
  }
  async saveSessionArtifact(...args: Parameters<Store["saveSessionArtifact"]>): ReturnType<Store["saveSessionArtifact"]> {
    return sessions.saveSessionArtifact(this.ctx, ...args);
  }
  async loadSessionArtifact(...args: Parameters<Store["loadSessionArtifact"]>): ReturnType<Store["loadSessionArtifact"]> {
    return sessions.loadSessionArtifact(this.ctx, ...args);
  }
  async clearExpiredWebhookSecurityState(...args: Parameters<Store["clearExpiredWebhookSecurityState"]>): ReturnType<Store["clearExpiredWebhookSecurityState"]> {
    return webhooks.clearExpiredWebhookSecurityState(this.ctx, ...args);
  }
  async hasWebhookReplayKey(...args: Parameters<Store["hasWebhookReplayKey"]>): ReturnType<Store["hasWebhookReplayKey"]> {
    return webhooks.hasWebhookReplayKey(this.ctx, ...args);
  }
  async saveWebhookReplayKey(...args: Parameters<Store["saveWebhookReplayKey"]>): ReturnType<Store["saveWebhookReplayKey"]> {
    return webhooks.saveWebhookReplayKey(this.ctx, ...args);
  }
  async getWebhookIdempotency(...args: Parameters<Store["getWebhookIdempotency"]>): ReturnType<Store["getWebhookIdempotency"]> {
    return webhooks.getWebhookIdempotency(this.ctx, ...args);
  }
  async saveWebhookIdempotencyPending(...args: Parameters<Store["saveWebhookIdempotencyPending"]>): ReturnType<Store["saveWebhookIdempotencyPending"]> {
    return webhooks.saveWebhookIdempotencyPending(this.ctx, ...args);
  }
  async saveWebhookIdempotencyResult(...args: Parameters<Store["saveWebhookIdempotencyResult"]>): ReturnType<Store["saveWebhookIdempotencyResult"]> {
    return webhooks.saveWebhookIdempotencyResult(this.ctx, ...args);
  }
  async saveExecutionHistory(...args: Parameters<Store["saveExecutionHistory"]>): ReturnType<Store["saveExecutionHistory"]> {
    return executions.saveExecutionHistory(this.ctx, ...args);
  }
  async listExecutionHistory(...args: Parameters<Store["listExecutionHistory"]>): ReturnType<Store["listExecutionHistory"]> {
    return executions.listExecutionHistory(this.ctx, ...args);
  }
  async getExecutionHistory(...args: Parameters<Store["getExecutionHistory"]>): ReturnType<Store["getExecutionHistory"]> {
    return executions.getExecutionHistory(this.ctx, ...args);
  }
  async cancelExecution(...args: Parameters<Store["cancelExecution"]>): ReturnType<Store["cancelExecution"]> {
    return executions.cancelExecution(this.ctx, ...args);
  }
  async pruneExecutionHistory(...args: Parameters<Store["pruneExecutionHistory"]>): ReturnType<Store["pruneExecutionHistory"]> {
    return executions.pruneExecutionHistory(this.ctx, ...args);
  }
  async saveWorkflowExecutionState(...args: Parameters<Store["saveWorkflowExecutionState"]>): ReturnType<Store["saveWorkflowExecutionState"]> {
    return executions.saveWorkflowExecutionState(this.ctx, ...args);
  }
  async getWorkflowExecutionState(...args: Parameters<Store["getWorkflowExecutionState"]>): ReturnType<Store["getWorkflowExecutionState"]> {
    return executions.getWorkflowExecutionState(this.ctx, ...args);
  }
  async listPendingApprovals(...args: Parameters<Store["listPendingApprovals"]>): ReturnType<Store["listPendingApprovals"]> {
    return executions.listPendingApprovals(this.ctx, ...args);
  }
  async deleteWorkflowExecution(...args: Parameters<Store["deleteWorkflowExecution"]>): ReturnType<Store["deleteWorkflowExecution"]> {
    return executions.deleteWorkflowExecution(this.ctx, ...args);
  }
  async enqueueExecution(...args: Parameters<Store["enqueueExecution"]>): ReturnType<Store["enqueueExecution"]> {
    return queue.enqueueExecution(this.ctx, ...args);
  }
  async dequeueNext(...args: Parameters<Store["dequeueNext"]>): ReturnType<Store["dequeueNext"]> {
    return queue.dequeueNext(this.ctx, ...args);
  }
  async markQueueItemRunning(...args: Parameters<Store["markQueueItemRunning"]>): ReturnType<Store["markQueueItemRunning"]> {
    return queue.markQueueItemRunning(this.ctx, ...args);
  }
  async markQueueItemCompleted(...args: Parameters<Store["markQueueItemCompleted"]>): ReturnType<Store["markQueueItemCompleted"]> {
    return queue.markQueueItemCompleted(this.ctx, ...args);
  }
  async markQueueItemFailed(...args: Parameters<Store["markQueueItemFailed"]>): ReturnType<Store["markQueueItemFailed"]> {
    return queue.markQueueItemFailed(this.ctx, ...args);
  }
  async requeueStuckItems(...args: Parameters<Store["requeueStuckItems"]>): ReturnType<Store["requeueStuckItems"]> {
    return queue.requeueStuckItems(this.ctx, ...args);
  }
  async reconcileOrphanedExecutions(...args: Parameters<Store["reconcileOrphanedExecutions"]>): ReturnType<Store["reconcileOrphanedExecutions"]> {
    return queue.reconcileOrphanedExecutions(this.ctx, ...args);
  }
  async getQueueDepth(...args: Parameters<Store["getQueueDepth"]>): ReturnType<Store["getQueueDepth"]> {
    return queue.getQueueDepth(this.ctx, ...args);
  }
  async listDlqItems(...args: Parameters<Store["listDlqItems"]>): ReturnType<Store["listDlqItems"]> {
    return queue.listDlqItems(this.ctx, ...args);
  }
  async getTriggerState(...args: Parameters<Store["getTriggerState"]>): ReturnType<Store["getTriggerState"]> {
    return schedules.getTriggerState(this.ctx, ...args);
  }
  async saveTriggerState(...args: Parameters<Store["saveTriggerState"]>): ReturnType<Store["saveTriggerState"]> {
    return schedules.saveTriggerState(this.ctx, ...args);
  }
  async deleteTriggerStatesForWorkflow(...args: Parameters<Store["deleteTriggerStatesForWorkflow"]>): ReturnType<Store["deleteTriggerStatesForWorkflow"]> {
    return schedules.deleteTriggerStatesForWorkflow(this.ctx, ...args);
  }
  async listTemplates(...args: Parameters<Store["listTemplates"]>): ReturnType<Store["listTemplates"]> {
    return workflows.listTemplates(this.ctx, ...args);
  }
  async getTemplate(...args: Parameters<Store["getTemplate"]>): ReturnType<Store["getTemplate"]> {
    return workflows.getTemplate(this.ctx, ...args);
  }
  async upsertTemplate(...args: Parameters<Store["upsertTemplate"]>): ReturnType<Store["upsertTemplate"]> {
    return workflows.upsertTemplate(this.ctx, ...args);
  }
  async deleteTemplate(...args: Parameters<Store["deleteTemplate"]>): ReturnType<Store["deleteTemplate"]> {
    return workflows.deleteTemplate(this.ctx, ...args);
  }
  async countTemplates(...args: Parameters<Store["countTemplates"]>): ReturnType<Store["countTemplates"]> {
    return workflows.countTemplates(this.ctx, ...args);
  }
  async listNotificationConfigs(...args: Parameters<Store["listNotificationConfigs"]>): ReturnType<Store["listNotificationConfigs"]> {
    return misc.listNotificationConfigs(this.ctx, ...args);
  }
  async upsertNotificationConfig(...args: Parameters<Store["upsertNotificationConfig"]>): ReturnType<Store["upsertNotificationConfig"]> {
    return misc.upsertNotificationConfig(this.ctx, ...args);
  }
  async deleteNotificationConfig(...args: Parameters<Store["deleteNotificationConfig"]>): ReturnType<Store["deleteNotificationConfig"]> {
    return misc.deleteNotificationConfig(this.ctx, ...args);
  }
  async storageLocation(...args: Parameters<Store["storageLocation"]>): ReturnType<Store["storageLocation"]> {
    return misc.storageLocation(this.ctx, ...args);
  }
  async getSchemaMarker(...args: Parameters<Store["getSchemaMarker"]>): ReturnType<Store["getSchemaMarker"]> {
    return misc.getSchemaMarker(this.ctx, ...args);
  }
  async getPublishedVersion(...args: Parameters<Store["getPublishedVersion"]>): ReturnType<Store["getPublishedVersion"]> {
    return release.getPublishedVersion(this.ctx, ...args);
  }
  async isWorkflowVersionPinned(...args: Parameters<Store["isWorkflowVersionPinned"]>): ReturnType<Store["isWorkflowVersionPinned"]> {
    return release.isWorkflowVersionPinned(this.ctx, ...args);
  }
  async getReleaseGate(...args: Parameters<Store["getReleaseGate"]>): ReturnType<Store["getReleaseGate"]> {
    return release.getReleaseGate(this.ctx, ...args);
  }
  async upsertReleaseGate(...args: Parameters<Store["upsertReleaseGate"]>): ReturnType<Store["upsertReleaseGate"]> {
    return release.upsertReleaseGate(this.ctx, ...args);
  }
  async listWorkflowReleases(...args: Parameters<Store["listWorkflowReleases"]>): ReturnType<Store["listWorkflowReleases"]> {
    return release.listWorkflowReleases(this.ctx, ...args);
  }
  async hasReleasedVersion(...args: Parameters<Store["hasReleasedVersion"]>): ReturnType<Store["hasReleasedVersion"]> {
    return release.hasReleasedVersion(this.ctx, ...args);
  }
  async listReplayRunIdsForHash(...args: Parameters<Store["listReplayRunIdsForHash"]>): ReturnType<Store["listReplayRunIdsForHash"]> {
    return release.listReplayRunIdsForHash(this.ctx, ...args);
  }
  async setEvalRunSetSnapshot(...args: Parameters<Store["setEvalRunSetSnapshot"]>): ReturnType<Store["setEvalRunSetSnapshot"]> {
    return release.setEvalRunSetSnapshot(this.ctx, ...args);
  }
  async getEvalRunSetSnapshot(...args: Parameters<Store["getEvalRunSetSnapshot"]>): ReturnType<Store["getEvalRunSetSnapshot"]> {
    return release.getEvalRunSetSnapshot(this.ctx, ...args);
  }
  async setExecutionRelease(...args: Parameters<Store["setExecutionRelease"]>): ReturnType<Store["setExecutionRelease"]> {
    return release.setExecutionRelease(this.ctx, ...args);
  }
  async getExecutionRelease(...args: Parameters<Store["getExecutionRelease"]>): ReturnType<Store["getExecutionRelease"]> {
    return release.getExecutionRelease(this.ctx, ...args);
  }
  async listReleasedVersionHashes(...args: Parameters<Store["listReleasedVersionHashes"]>): ReturnType<Store["listReleasedVersionHashes"]> {
    return release.listReleasedVersionHashes(this.ctx, ...args);
  }
  async listEnabledReleaseGateWorkflowIds(...args: Parameters<Store["listEnabledReleaseGateWorkflowIds"]>): ReturnType<Store["listEnabledReleaseGateWorkflowIds"]> {
    return release.listEnabledReleaseGateWorkflowIds(this.ctx, ...args);
  }
  async timeOutExpiredReleaseApprovalRequests(...args: Parameters<Store["timeOutExpiredReleaseApprovalRequests"]>): ReturnType<Store["timeOutExpiredReleaseApprovalRequests"]> {
    return release.timeOutExpiredReleaseApprovalRequests(this.ctx, ...args);
  }
  async listPendingReleaseApprovalRequests(...args: Parameters<Store["listPendingReleaseApprovalRequests"]>): ReturnType<Store["listPendingReleaseApprovalRequests"]> {
    return release.listPendingReleaseApprovalRequests(this.ctx, ...args);
  }
  async insertReleaseApprovalRequest(...args: Parameters<Store["insertReleaseApprovalRequest"]>): ReturnType<Store["insertReleaseApprovalRequest"]> {
    return release.insertReleaseApprovalRequest(this.ctx, ...args);
  }
  async getReleaseApprovalRequest(...args: Parameters<Store["getReleaseApprovalRequest"]>): ReturnType<Store["getReleaseApprovalRequest"]> {
    return release.getReleaseApprovalRequest(this.ctx, ...args);
  }
  async listReleaseApprovalRequests(...args: Parameters<Store["listReleaseApprovalRequests"]>): ReturnType<Store["listReleaseApprovalRequests"]> {
    return release.listReleaseApprovalRequests(this.ctx, ...args);
  }
  async decideReleaseApprovalRequest(...args: Parameters<Store["decideReleaseApprovalRequest"]>): ReturnType<Store["decideReleaseApprovalRequest"]> {
    return release.decideReleaseApprovalRequest(this.ctx, ...args);
  }
  async setReleaseGateAdmission(...args: Parameters<Store["setReleaseGateAdmission"]>): ReturnType<Store["setReleaseGateAdmission"]> {
    return release.setReleaseGateAdmission(this.ctx, ...args);
  }
  async insertGateCaseRequest(...args: Parameters<Store["insertGateCaseRequest"]>): ReturnType<Store["insertGateCaseRequest"]> {
    return release.insertGateCaseRequest(this.ctx, ...args);
  }
  async getGateCaseRequest(...args: Parameters<Store["getGateCaseRequest"]>): ReturnType<Store["getGateCaseRequest"]> {
    return release.getGateCaseRequest(this.ctx, ...args);
  }
  async listPendingGateCaseRequests(...args: Parameters<Store["listPendingGateCaseRequests"]>): ReturnType<Store["listPendingGateCaseRequests"]> {
    return release.listPendingGateCaseRequests(this.ctx, ...args);
  }
  async listGateCaseRequests(...args: Parameters<Store["listGateCaseRequests"]>): ReturnType<Store["listGateCaseRequests"]> {
    return release.listGateCaseRequests(this.ctx, ...args);
  }
  async timeOutExpiredGateCaseRequests(...args: Parameters<Store["timeOutExpiredGateCaseRequests"]>): ReturnType<Store["timeOutExpiredGateCaseRequests"]> {
    return release.timeOutExpiredGateCaseRequests(this.ctx, ...args);
  }
  async decideGateCaseRequest(...args: Parameters<Store["decideGateCaseRequest"]>): ReturnType<Store["decideGateCaseRequest"]> {
    return release.decideGateCaseRequest(this.ctx, ...args);
  }
  async markEvalRunsReleaseIneligible(...args: Parameters<Store["markEvalRunsReleaseIneligible"]>): ReturnType<Store["markEvalRunsReleaseIneligible"]> {
    return release.markEvalRunsReleaseIneligible(this.ctx, ...args);
  }
  async insertGuardSimulation(...args: Parameters<Store["insertGuardSimulation"]>): ReturnType<Store["insertGuardSimulation"]> {
    return guard_simulation.insertGuardSimulation(this.ctx, ...args);
  }
  async updateGuardSimulation(...args: Parameters<Store["updateGuardSimulation"]>): ReturnType<Store["updateGuardSimulation"]> {
    return guard_simulation.updateGuardSimulation(this.ctx, ...args);
  }
  async getGuardSimulation(...args: Parameters<Store["getGuardSimulation"]>): ReturnType<Store["getGuardSimulation"]> {
    return guard_simulation.getGuardSimulation(this.ctx, ...args);
  }
  async listGuardSimulations(...args: Parameters<Store["listGuardSimulations"]>): ReturnType<Store["listGuardSimulations"]> {
    return guard_simulation.listGuardSimulations(this.ctx, ...args);
  }
  async listRunningGuardSimulations(...args: Parameters<Store["listRunningGuardSimulations"]>): ReturnType<Store["listRunningGuardSimulations"]> {
    return guard_simulation.listRunningGuardSimulations(this.ctx, ...args);
  }
  async pruneGuardSimulations(...args: Parameters<Store["pruneGuardSimulations"]>): ReturnType<Store["pruneGuardSimulations"]> {
    return guard_simulation.pruneGuardSimulations(this.ctx, ...args);
  }
  async saveMcpCassette(...args: Parameters<Store["saveMcpCassette"]>): ReturnType<Store["saveMcpCassette"]> {
    return replay.saveMcpCassette(this.ctx, ...args);
  }
  async getMcpCassetteSummary(...args: Parameters<Store["getMcpCassetteSummary"]>): ReturnType<Store["getMcpCassetteSummary"]> {
    return replay.getMcpCassetteSummary(this.ctx, ...args);
  }
  async getMcpCassette(...args: Parameters<Store["getMcpCassette"]>): ReturnType<Store["getMcpCassette"]> {
    return replay.getMcpCassette(this.ctx, ...args);
  }
  async getMcpCassetteForExecution(...args: Parameters<Store["getMcpCassetteForExecution"]>): ReturnType<Store["getMcpCassetteForExecution"]> {
    return replay.getMcpCassetteForExecution(this.ctx, ...args);
  }
  async listMcpCassettesForEvalRun(...args: Parameters<Store["listMcpCassettesForEvalRun"]>): ReturnType<Store["listMcpCassettesForEvalRun"]> {
    return replay.listMcpCassettesForEvalRun(this.ctx, ...args);
  }
  async listMcpCassettes(...args: Parameters<Store["listMcpCassettes"]>): ReturnType<Store["listMcpCassettes"]> {
    return replay.listMcpCassettes(this.ctx, ...args);
  }
  async mcpCassetteBadgesForExecutions(...args: Parameters<Store["mcpCassetteBadgesForExecutions"]>): ReturnType<Store["mcpCassetteBadgesForExecutions"]> {
    return replay.mcpCassetteBadgesForExecutions(this.ctx, ...args);
  }
  async deleteMcpCassette(...args: Parameters<Store["deleteMcpCassette"]>): ReturnType<Store["deleteMcpCassette"]> {
    return replay.deleteMcpCassette(this.ctx, ...args);
  }
  async createMcpServer(...args: Parameters<Store["createMcpServer"]>): ReturnType<Store["createMcpServer"]> {
    return mcp.createMcpServer(this.ctx, ...args);
  }
  async updateMcpServer(...args: Parameters<Store["updateMcpServer"]>): ReturnType<Store["updateMcpServer"]> {
    return mcp.updateMcpServer(this.ctx, ...args);
  }
  async deleteMcpServer(...args: Parameters<Store["deleteMcpServer"]>): ReturnType<Store["deleteMcpServer"]> {
    return mcp.deleteMcpServer(this.ctx, ...args);
  }
  async setMcpServerSandboxStatus(...args: Parameters<Store["setMcpServerSandboxStatus"]>): ReturnType<Store["setMcpServerSandboxStatus"]> {
    return mcp.setMcpServerSandboxStatus(this.ctx, ...args);
  }
  async getMcpServer(...args: Parameters<Store["getMcpServer"]>): ReturnType<Store["getMcpServer"]> {
    return mcp.getMcpServer(this.ctx, ...args);
  }
  async listMcpServers(...args: Parameters<Store["listMcpServers"]>): ReturnType<Store["listMcpServers"]> {
    return mcp.listMcpServers(this.ctx, ...args);
  }
  async recordMcpServerProbe(...args: Parameters<Store["recordMcpServerProbe"]>): ReturnType<Store["recordMcpServerProbe"]> {
    return mcp.recordMcpServerProbe(this.ctx, ...args);
  }
  async listMcpServerProbes(...args: Parameters<Store["listMcpServerProbes"]>): ReturnType<Store["listMcpServerProbes"]> {
    return mcp.listMcpServerProbes(this.ctx, ...args);
  }
  async getMcpToolSnapshot(...args: Parameters<Store["getMcpToolSnapshot"]>): ReturnType<Store["getMcpToolSnapshot"]> {
    return mcp.getMcpToolSnapshot(this.ctx, ...args);
  }
  async listMcpToolSnapshots(...args: Parameters<Store["listMcpToolSnapshots"]>): ReturnType<Store["listMcpToolSnapshots"]> {
    return mcp.listMcpToolSnapshots(this.ctx, ...args);
  }
  async acknowledgeMcpBreakingChange(...args: Parameters<Store["acknowledgeMcpBreakingChange"]>): ReturnType<Store["acknowledgeMcpBreakingChange"]> {
    return mcp.acknowledgeMcpBreakingChange(this.ctx, ...args);
  }
  async replaceMcpToolCallsForExecution(...args: Parameters<Store["replaceMcpToolCallsForExecution"]>): ReturnType<Store["replaceMcpToolCallsForExecution"]> {
    return mcp.replaceMcpToolCallsForExecution(this.ctx, ...args);
  }
  async insertMcpToolCall(...args: Parameters<Store["insertMcpToolCall"]>): ReturnType<Store["insertMcpToolCall"]> {
    return mcp.insertMcpToolCall(this.ctx, ...args);
  }
  async listMcpToolCallsForClient(...args: Parameters<Store["listMcpToolCallsForClient"]>): ReturnType<Store["listMcpToolCallsForClient"]> {
    return mcp.listMcpToolCallsForClient(this.ctx, ...args);
  }
  async summarizeMcpClientUsage(...args: Parameters<Store["summarizeMcpClientUsage"]>): ReturnType<Store["summarizeMcpClientUsage"]> {
    return mcp.summarizeMcpClientUsage(this.ctx, ...args);
  }
  async listMcpToolCalls(...args: Parameters<Store["listMcpToolCalls"]>): ReturnType<Store["listMcpToolCalls"]> {
    return mcp.listMcpToolCalls(this.ctx, ...args);
  }
  async getMcpOAuthConnection(...args: Parameters<Store["getMcpOAuthConnection"]>): ReturnType<Store["getMcpOAuthConnection"]> {
    return mcp.getMcpOAuthConnection(this.ctx, ...args);
  }
  async upsertMcpOAuthConnection(...args: Parameters<Store["upsertMcpOAuthConnection"]>): ReturnType<Store["upsertMcpOAuthConnection"]> {
    return mcp.upsertMcpOAuthConnection(this.ctx, ...args);
  }
  async getMcpUserOAuthConnection(...args: Parameters<Store["getMcpUserOAuthConnection"]>): ReturnType<Store["getMcpUserOAuthConnection"]> {
    return mcp.getMcpUserOAuthConnection(this.ctx, ...args);
  }
  async listMcpUserOAuthConnections(...args: Parameters<Store["listMcpUserOAuthConnections"]>): ReturnType<Store["listMcpUserOAuthConnections"]> {
    return mcp.listMcpUserOAuthConnections(this.ctx, ...args);
  }
  async upsertMcpUserOAuthConnection(...args: Parameters<Store["upsertMcpUserOAuthConnection"]>): ReturnType<Store["upsertMcpUserOAuthConnection"]> {
    return mcp.upsertMcpUserOAuthConnection(this.ctx, ...args);
  }
  async deleteMcpUserOAuthConnection(...args: Parameters<Store["deleteMcpUserOAuthConnection"]>): ReturnType<Store["deleteMcpUserOAuthConnection"]> {
    return mcp.deleteMcpUserOAuthConnection(this.ctx, ...args);
  }
  async deleteMcpOAuthConnection(...args: Parameters<Store["deleteMcpOAuthConnection"]>): ReturnType<Store["deleteMcpOAuthConnection"]> {
    return mcp.deleteMcpOAuthConnection(this.ctx, ...args);
  }
  async getMcpServerCatalog(...args: Parameters<Store["getMcpServerCatalog"]>): ReturnType<Store["getMcpServerCatalog"]> {
    return mcp.getMcpServerCatalog(this.ctx, ...args);
  }
  async upsertMcpServerCatalog(...args: Parameters<Store["upsertMcpServerCatalog"]>): ReturnType<Store["upsertMcpServerCatalog"]> {
    return mcp.upsertMcpServerCatalog(this.ctx, ...args);
  }
  async createMcpElicitation(...args: Parameters<Store["createMcpElicitation"]>): ReturnType<Store["createMcpElicitation"]> {
    return mcp.createMcpElicitation(this.ctx, ...args);
  }
  async getMcpElicitation(...args: Parameters<Store["getMcpElicitation"]>): ReturnType<Store["getMcpElicitation"]> {
    return mcp.getMcpElicitation(this.ctx, ...args);
  }
  async listMcpElicitations(...args: Parameters<Store["listMcpElicitations"]>): ReturnType<Store["listMcpElicitations"]> {
    return mcp.listMcpElicitations(this.ctx, ...args);
  }
  async settleMcpElicitation(...args: Parameters<Store["settleMcpElicitation"]>): ReturnType<Store["settleMcpElicitation"]> {
    return mcp.settleMcpElicitation(this.ctx, ...args);
  }
  async expireMcpElicitationsForExecution(...args: Parameters<Store["expireMcpElicitationsForExecution"]>): ReturnType<Store["expireMcpElicitationsForExecution"]> {
    return mcp.expireMcpElicitationsForExecution(this.ctx, ...args);
  }
  async listExpiredMcpElicitations(...args: Parameters<Store["listExpiredMcpElicitations"]>): ReturnType<Store["listExpiredMcpElicitations"]> {
    return mcp.listExpiredMcpElicitations(this.ctx, ...args);
  }
  async listMcpToolPolicies(...args: Parameters<Store["listMcpToolPolicies"]>): ReturnType<Store["listMcpToolPolicies"]> {
    return mcp.listMcpToolPolicies(this.ctx, ...args);
  }
  async getMcpToolPolicy(...args: Parameters<Store["getMcpToolPolicy"]>): ReturnType<Store["getMcpToolPolicy"]> {
    return mcp.getMcpToolPolicy(this.ctx, ...args);
  }
  async createMcpToolPolicy(...args: Parameters<Store["createMcpToolPolicy"]>): ReturnType<Store["createMcpToolPolicy"]> {
    return mcp.createMcpToolPolicy(this.ctx, ...args);
  }
  async updateMcpToolPolicy(...args: Parameters<Store["updateMcpToolPolicy"]>): ReturnType<Store["updateMcpToolPolicy"]> {
    return mcp.updateMcpToolPolicy(this.ctx, ...args);
  }
  async deleteMcpToolPolicy(...args: Parameters<Store["deleteMcpToolPolicy"]>): ReturnType<Store["deleteMcpToolPolicy"]> {
    return mcp.deleteMcpToolPolicy(this.ctx, ...args);
  }
  async listMcpToolClassifications(...args: Parameters<Store["listMcpToolClassifications"]>): ReturnType<Store["listMcpToolClassifications"]> {
    return mcp.listMcpToolClassifications(this.ctx, ...args);
  }
  async setMcpToolClassification(...args: Parameters<Store["setMcpToolClassification"]>): ReturnType<Store["setMcpToolClassification"]> {
    return mcp.setMcpToolClassification(this.ctx, ...args);
  }
  async listMcpToolsets(...args: Parameters<Store["listMcpToolsets"]>): ReturnType<Store["listMcpToolsets"]> {
    return mcp.listMcpToolsets(this.ctx, ...args);
  }
  async getMcpToolset(...args: Parameters<Store["getMcpToolset"]>): ReturnType<Store["getMcpToolset"]> {
    return mcp.getMcpToolset(this.ctx, ...args);
  }
  async getMcpToolsetBySlug(...args: Parameters<Store["getMcpToolsetBySlug"]>): ReturnType<Store["getMcpToolsetBySlug"]> {
    return mcp.getMcpToolsetBySlug(this.ctx, ...args);
  }
  async createMcpToolset(...args: Parameters<Store["createMcpToolset"]>): ReturnType<Store["createMcpToolset"]> {
    return mcp.createMcpToolset(this.ctx, ...args);
  }
  async updateMcpToolset(...args: Parameters<Store["updateMcpToolset"]>): ReturnType<Store["updateMcpToolset"]> {
    return mcp.updateMcpToolset(this.ctx, ...args);
  }
  async deleteMcpToolset(...args: Parameters<Store["deleteMcpToolset"]>): ReturnType<Store["deleteMcpToolset"]> {
    return mcp.deleteMcpToolset(this.ctx, ...args);
  }
  async createMcpClient(...args: Parameters<Store["createMcpClient"]>): ReturnType<Store["createMcpClient"]> {
    return mcp.createMcpClient(this.ctx, ...args);
  }
  async getMcpClient(...args: Parameters<Store["getMcpClient"]>): ReturnType<Store["getMcpClient"]> {
    return mcp.getMcpClient(this.ctx, ...args);
  }
  async findMcpClientByTokenPrefix(...args: Parameters<Store["findMcpClientByTokenPrefix"]>): ReturnType<Store["findMcpClientByTokenPrefix"]> {
    return mcp.findMcpClientByTokenPrefix(this.ctx, ...args);
  }
  async listMcpClients(...args: Parameters<Store["listMcpClients"]>): ReturnType<Store["listMcpClients"]> {
    return mcp.listMcpClients(this.ctx, ...args);
  }
  async revokeMcpClient(...args: Parameters<Store["revokeMcpClient"]>): ReturnType<Store["revokeMcpClient"]> {
    return mcp.revokeMcpClient(this.ctx, ...args);
  }
  async touchMcpClient(...args: Parameters<Store["touchMcpClient"]>): ReturnType<Store["touchMcpClient"]> {
    return mcp.touchMcpClient(this.ctx, ...args);
  }
  async listMcpToolCallsForExecution(...args: Parameters<Store["listMcpToolCallsForExecution"]>): ReturnType<Store["listMcpToolCallsForExecution"]> {
    return mcp.listMcpToolCallsForExecution(this.ctx, ...args);
  }
  async listGuardProfiles(...args: Parameters<Store["listGuardProfiles"]>): ReturnType<Store["listGuardProfiles"]> {
    return guard.listGuardProfiles(this.ctx, ...args);
  }
  async getGuardProfile(...args: Parameters<Store["getGuardProfile"]>): ReturnType<Store["getGuardProfile"]> {
    return guard.getGuardProfile(this.ctx, ...args);
  }
  async guardProfileRevision(...args: Parameters<Store["guardProfileRevision"]>): ReturnType<Store["guardProfileRevision"]> {
    return guard.guardProfileRevision(this.ctx, ...args);
  }
  async anyGuardProfileUsesLabels(...args: Parameters<Store["anyGuardProfileUsesLabels"]>): ReturnType<Store["anyGuardProfileUsesLabels"]> {
    return guard.anyGuardProfileUsesLabels(this.ctx, ...args);
  }
  async countObservedDestinationBlocks(...args: Parameters<Store["countObservedDestinationBlocks"]>): ReturnType<Store["countObservedDestinationBlocks"]> {
    return guard.countObservedDestinationBlocks(this.ctx, ...args);
  }
  async getGuardProfileVersion(...args: Parameters<Store["getGuardProfileVersion"]>): ReturnType<Store["getGuardProfileVersion"]> {
    return guard.getGuardProfileVersion(this.ctx, ...args);
  }
  async listGuardProfileVersions(...args: Parameters<Store["listGuardProfileVersions"]>): ReturnType<Store["listGuardProfileVersions"]> {
    return guard.listGuardProfileVersions(this.ctx, ...args);
  }
  async insertGuardProfile(...args: Parameters<Store["insertGuardProfile"]>): ReturnType<Store["insertGuardProfile"]> {
    return guard.insertGuardProfile(this.ctx, ...args);
  }
  async addGuardProfileVersion(...args: Parameters<Store["addGuardProfileVersion"]>): ReturnType<Store["addGuardProfileVersion"]> {
    return guard.addGuardProfileVersion(this.ctx, ...args);
  }
  async deleteGuardProfile(...args: Parameters<Store["deleteGuardProfile"]>): ReturnType<Store["deleteGuardProfile"]> {
    return guard.deleteGuardProfile(this.ctx, ...args);
  }
  async getGuardBinding(...args: Parameters<Store["getGuardBinding"]>): ReturnType<Store["getGuardBinding"]> {
    return guard.getGuardBinding(this.ctx, ...args);
  }
  async listGuardBindingsForProfile(...args: Parameters<Store["listGuardBindingsForProfile"]>): ReturnType<Store["listGuardBindingsForProfile"]> {
    return guard.listGuardBindingsForProfile(this.ctx, ...args);
  }
  async setGuardBinding(...args: Parameters<Store["setGuardBinding"]>): ReturnType<Store["setGuardBinding"]> {
    return guard.setGuardBinding(this.ctx, ...args);
  }
  async insertGuardEvents(...args: Parameters<Store["insertGuardEvents"]>): ReturnType<Store["insertGuardEvents"]> {
    return guard.insertGuardEvents(this.ctx, ...args);
  }
  async listGuardEvents(...args: Parameters<Store["listGuardEvents"]>): ReturnType<Store["listGuardEvents"]> {
    return guard.listGuardEvents(this.ctx, ...args);
  }
  async listGuardEventsForExecution(...args: Parameters<Store["listGuardEventsForExecution"]>): ReturnType<Store["listGuardEventsForExecution"]> {
    return guard.listGuardEventsForExecution(this.ctx, ...args);
  }
  async guardEventStats(...args: Parameters<Store["guardEventStats"]>): ReturnType<Store["guardEventStats"]> {
    return guard.guardEventStats(this.ctx, ...args);
  }
  async getGuardVaultByToken(...args: Parameters<Store["getGuardVaultByToken"]>): ReturnType<Store["getGuardVaultByToken"]> {
    return guard.getGuardVaultByToken(this.ctx, ...args);
  }
  async getGuardVaultByHash(...args: Parameters<Store["getGuardVaultByHash"]>): ReturnType<Store["getGuardVaultByHash"]> {
    return guard.getGuardVaultByHash(this.ctx, ...args);
  }
  async putGuardVault(...args: Parameters<Store["putGuardVault"]>): ReturnType<Store["putGuardVault"]> {
    return guard.putGuardVault(this.ctx, ...args);
  }
  async listWorkflowConfigsForDestinations(...args: Parameters<Store["listWorkflowConfigsForDestinations"]>): ReturnType<Store["listWorkflowConfigsForDestinations"]> {
    return data_destinations.listWorkflowConfigsForDestinations(this.ctx, ...args);
  }
  async listDataDestinations(...args: Parameters<Store["listDataDestinations"]>): ReturnType<Store["listDataDestinations"]> {
    return data_destinations.listDataDestinations(this.ctx, ...args);
  }
  async getDataDestination(...args: Parameters<Store["getDataDestination"]>): ReturnType<Store["getDataDestination"]> {
    return data_destinations.getDataDestination(this.ctx, ...args);
  }
  async findDataDestinationByMatch(...args: Parameters<Store["findDataDestinationByMatch"]>): ReturnType<Store["findDataDestinationByMatch"]> {
    return data_destinations.findDataDestinationByMatch(this.ctx, ...args);
  }
  async insertDataDestination(...args: Parameters<Store["insertDataDestination"]>): ReturnType<Store["insertDataDestination"]> {
    return data_destinations.insertDataDestination(this.ctx, ...args);
  }
  async updateDataDestination(...args: Parameters<Store["updateDataDestination"]>): ReturnType<Store["updateDataDestination"]> {
    return data_destinations.updateDataDestination(this.ctx, ...args);
  }
  async deleteDataDestination(...args: Parameters<Store["deleteDataDestination"]>): ReturnType<Store["deleteDataDestination"]> {
    return data_destinations.deleteDataDestination(this.ctx, ...args);
  }
  async createKnowledgeBase(...args: Parameters<Store["createKnowledgeBase"]>): ReturnType<Store["createKnowledgeBase"]> {
    return knowledge.createKnowledgeBase(this.ctx, ...args);
  }
  async updateKnowledgeBase(...args: Parameters<Store["updateKnowledgeBase"]>): ReturnType<Store["updateKnowledgeBase"]> {
    return knowledge.updateKnowledgeBase(this.ctx, ...args);
  }
  async deleteKnowledgeBase(...args: Parameters<Store["deleteKnowledgeBase"]>): ReturnType<Store["deleteKnowledgeBase"]> {
    return knowledge.deleteKnowledgeBase(this.ctx, ...args);
  }
  async getKnowledgeBase(...args: Parameters<Store["getKnowledgeBase"]>): ReturnType<Store["getKnowledgeBase"]> {
    return knowledge.getKnowledgeBase(this.ctx, ...args);
  }
  async listKnowledgeBases(...args: Parameters<Store["listKnowledgeBases"]>): ReturnType<Store["listKnowledgeBases"]> {
    return knowledge.listKnowledgeBases(this.ctx, ...args);
  }
  async addKnowledgeBaseChunks(...args: Parameters<Store["addKnowledgeBaseChunks"]>): ReturnType<Store["addKnowledgeBaseChunks"]> {
    return knowledge.addKnowledgeBaseChunks(this.ctx, ...args);
  }
  async listKnowledgeBaseChunks(...args: Parameters<Store["listKnowledgeBaseChunks"]>): ReturnType<Store["listKnowledgeBaseChunks"]> {
    return knowledge.listKnowledgeBaseChunks(this.ctx, ...args);
  }
  async bm25SearchKnowledgeBase(...args: Parameters<Store["bm25SearchKnowledgeBase"]>): ReturnType<Store["bm25SearchKnowledgeBase"]> {
    return knowledge.bm25SearchKnowledgeBase(this.ctx, ...args);
  }
  async listKnowledgeBaseChunkPreviews(...args: Parameters<Store["listKnowledgeBaseChunkPreviews"]>): ReturnType<Store["listKnowledgeBaseChunkPreviews"]> {
    return knowledge.listKnowledgeBaseChunkPreviews(this.ctx, ...args);
  }
  async deleteKnowledgeBaseChunksBySource(...args: Parameters<Store["deleteKnowledgeBaseChunksBySource"]>): ReturnType<Store["deleteKnowledgeBaseChunksBySource"]> {
    return knowledge.deleteKnowledgeBaseChunksBySource(this.ctx, ...args);
  }
  async listKnowledgeBaseSources(...args: Parameters<Store["listKnowledgeBaseSources"]>): ReturnType<Store["listKnowledgeBaseSources"]> {
    return knowledge.listKnowledgeBaseSources(this.ctx, ...args);
  }
  async createEvalDataset(...args: Parameters<Store["createEvalDataset"]>): ReturnType<Store["createEvalDataset"]> {
    return evals.createEvalDataset(this.ctx, ...args);
  }
  async listEvalDatasets(...args: Parameters<Store["listEvalDatasets"]>): ReturnType<Store["listEvalDatasets"]> {
    return evals.listEvalDatasets(this.ctx, ...args);
  }
  async getEvalDataset(...args: Parameters<Store["getEvalDataset"]>): ReturnType<Store["getEvalDataset"]> {
    return evals.getEvalDataset(this.ctx, ...args);
  }
  async deleteEvalDataset(...args: Parameters<Store["deleteEvalDataset"]>): ReturnType<Store["deleteEvalDataset"]> {
    return evals.deleteEvalDataset(this.ctx, ...args);
  }
  async createEvalFixture(...args: Parameters<Store["createEvalFixture"]>): ReturnType<Store["createEvalFixture"]> {
    return evals.createEvalFixture(this.ctx, ...args);
  }
  async listEvalFixtures(...args: Parameters<Store["listEvalFixtures"]>): ReturnType<Store["listEvalFixtures"]> {
    return evals.listEvalFixtures(this.ctx, ...args);
  }
  async getEvalFixture(...args: Parameters<Store["getEvalFixture"]>): ReturnType<Store["getEvalFixture"]> {
    return evals.getEvalFixture(this.ctx, ...args);
  }
  async findEvalFixtureByRecording(...args: Parameters<Store["findEvalFixtureByRecording"]>): ReturnType<Store["findEvalFixtureByRecording"]> {
    return evals.findEvalFixtureByRecording(this.ctx, ...args);
  }
  async getEvalFixtureDatasetId(...args: Parameters<Store["getEvalFixtureDatasetId"]>): ReturnType<Store["getEvalFixtureDatasetId"]> {
    return evals.getEvalFixtureDatasetId(this.ctx, ...args);
  }
  async deleteEvalFixture(...args: Parameters<Store["deleteEvalFixture"]>): ReturnType<Store["deleteEvalFixture"]> {
    return evals.deleteEvalFixture(this.ctx, ...args);
  }
  async setEvalFixtureRequired(...args: Parameters<Store["setEvalFixtureRequired"]>): ReturnType<Store["setEvalFixtureRequired"]> {
    return evals.setEvalFixtureRequired(this.ctx, ...args);
  }
  async createEvalRun(...args: Parameters<Store["createEvalRun"]>): ReturnType<Store["createEvalRun"]> {
    return evals.createEvalRun(this.ctx, ...args);
  }
  async updateEvalRunProgress(...args: Parameters<Store["updateEvalRunProgress"]>): ReturnType<Store["updateEvalRunProgress"]> {
    return evals.updateEvalRunProgress(this.ctx, ...args);
  }
  async pruneEvalRuns(...args: Parameters<Store["pruneEvalRuns"]>): ReturnType<Store["pruneEvalRuns"]> {
    return evals.pruneEvalRuns(this.ctx, ...args);
  }
  async finalizeEvalRun(...args: Parameters<Store["finalizeEvalRun"]>): ReturnType<Store["finalizeEvalRun"]> {
    return evals.finalizeEvalRun(this.ctx, ...args);
  }
  async updateEvalRunSummary(...args: Parameters<Store["updateEvalRunSummary"]>): ReturnType<Store["updateEvalRunSummary"]> {
    return evals.updateEvalRunSummary(this.ctx, ...args);
  }
  async listEvalRuns(...args: Parameters<Store["listEvalRuns"]>): ReturnType<Store["listEvalRuns"]> {
    return evals.listEvalRuns(this.ctx, ...args);
  }
  async getEvalRun(...args: Parameters<Store["getEvalRun"]>): ReturnType<Store["getEvalRun"]> {
    return evals.getEvalRun(this.ctx, ...args);
  }
  async recordEvalResult(...args: Parameters<Store["recordEvalResult"]>): ReturnType<Store["recordEvalResult"]> {
    return evals.recordEvalResult(this.ctx, ...args);
  }
  async listEvalResults(...args: Parameters<Store["listEvalResults"]>): ReturnType<Store["listEvalResults"]> {
    return evals.listEvalResults(this.ctx, ...args);
  }
  async getEvalResult(...args: Parameters<Store["getEvalResult"]>): ReturnType<Store["getEvalResult"]> {
    return evals.getEvalResult(this.ctx, ...args);
  }
  async evalFixtureIdsForRecording(...args: Parameters<Store["evalFixtureIdsForRecording"]>): ReturnType<Store["evalFixtureIdsForRecording"]> {
    return evals.evalFixtureIdsForRecording(this.ctx, ...args);
  }
  async evalRunIdsForResults(...args: Parameters<Store["evalRunIdsForResults"]>): ReturnType<Store["evalRunIdsForResults"]> {
    return evals.evalRunIdsForResults(this.ctx, ...args);
  }
  async deleteEvalFixturesForRecording(...args: Parameters<Store["deleteEvalFixturesForRecording"]>): ReturnType<Store["deleteEvalFixturesForRecording"]> {
    return evals.deleteEvalFixturesForRecording(this.ctx, ...args);
  }
  async saveReplayRecording(...args: Parameters<Store["saveReplayRecording"]>): ReturnType<Store["saveReplayRecording"]> {
    return replay.saveReplayRecording(this.ctx, ...args);
  }
  async getReplayRecordingSummary(...args: Parameters<Store["getReplayRecordingSummary"]>): ReturnType<Store["getReplayRecordingSummary"]> {
    return replay.getReplayRecordingSummary(this.ctx, ...args);
  }
  async getReplayRecording(...args: Parameters<Store["getReplayRecording"]>): ReturnType<Store["getReplayRecording"]> {
    return replay.getReplayRecording(this.ctx, ...args);
  }
  async listReplayRecordings(...args: Parameters<Store["listReplayRecordings"]>): ReturnType<Store["listReplayRecordings"]> {
    return replay.listReplayRecordings(this.ctx, ...args);
  }
  async sumReplayRecordingBytesForWorkflow(...args: Parameters<Store["sumReplayRecordingBytesForWorkflow"]>): ReturnType<Store["sumReplayRecordingBytesForWorkflow"]> {
    return replay.sumReplayRecordingBytesForWorkflow(this.ctx, ...args);
  }
  async sumReplayRecordingBytes(...args: Parameters<Store["sumReplayRecordingBytes"]>): ReturnType<Store["sumReplayRecordingBytes"]> {
    return replay.sumReplayRecordingBytes(this.ctx, ...args);
  }
  async findReplayRecordingIdForExecution(...args: Parameters<Store["findReplayRecordingIdForExecution"]>): ReturnType<Store["findReplayRecordingIdForExecution"]> {
    return replay.findReplayRecordingIdForExecution(this.ctx, ...args);
  }
  async countReplayRecordingsForWorkflow(...args: Parameters<Store["countReplayRecordingsForWorkflow"]>): ReturnType<Store["countReplayRecordingsForWorkflow"]> {
    return replay.countReplayRecordingsForWorkflow(this.ctx, ...args);
  }
  async listReplayCaptures(...args: Parameters<Store["listReplayCaptures"]>): ReturnType<Store["listReplayCaptures"]> {
    return capture.listReplayCaptures(this.ctx, ...args);
  }
  async countReplayCapturesSince(...args: Parameters<Store["countReplayCapturesSince"]>): ReturnType<Store["countReplayCapturesSince"]> {
    return capture.countReplayCapturesSince(this.ctx, ...args);
  }
  async oldestReplayCaptureIds(...args: Parameters<Store["oldestReplayCaptureIds"]>): ReturnType<Store["oldestReplayCaptureIds"]> {
    return capture.oldestReplayCaptureIds(this.ctx, ...args);
  }
  async pruneReplayCaptures(...args: Parameters<Store["pruneReplayCaptures"]>): ReturnType<Store["pruneReplayCaptures"]> {
    return capture.pruneReplayCaptures(this.ctx, ...args);
  }
  async promoteReplayCapture(...args: Parameters<Store["promoteReplayCapture"]>): ReturnType<Store["promoteReplayCapture"]> {
    return capture.promoteReplayCapture(this.ctx, ...args);
  }
  async getReplayCaptureSettings(...args: Parameters<Store["getReplayCaptureSettings"]>): ReturnType<Store["getReplayCaptureSettings"]> {
    return capture.getReplayCaptureSettings(this.ctx, ...args);
  }
  async saveReplayCaptureSettings(...args: Parameters<Store["saveReplayCaptureSettings"]>): ReturnType<Store["saveReplayCaptureSettings"]> {
    return capture.saveReplayCaptureSettings(this.ctx, ...args);
  }
  async recordReplayCaptureDrop(...args: Parameters<Store["recordReplayCaptureDrop"]>): ReturnType<Store["recordReplayCaptureDrop"]> {
    return capture.recordReplayCaptureDrop(this.ctx, ...args);
  }
  async subjectTextPage(...args: Parameters<Store["subjectTextPage"]>): ReturnType<Store["subjectTextPage"]> {
    return data_labels.subjectTextPage(this.ctx, ...args);
  }
  async subjectTextRow(...args: Parameters<Store["subjectTextRow"]>): ReturnType<Store["subjectTextRow"]> {
    return data_labels.subjectTextRow(this.ctx, ...args);
  }
  async countSubjectRows(...args: Parameters<Store["countSubjectRows"]>): ReturnType<Store["countSubjectRows"]> {
    return data_labels.countSubjectRows(this.ctx, ...args);
  }
  async deleteSubjectRow(...args: Parameters<Store["deleteSubjectRow"]>): ReturnType<Store["deleteSubjectRow"]> {
    return data_labels.deleteSubjectRow(this.ctx, ...args);
  }
  async sumReplayCaptureBytesForWorkflow(...args: Parameters<Store["sumReplayCaptureBytesForWorkflow"]>): ReturnType<Store["sumReplayCaptureBytesForWorkflow"]> {
    return capture.sumReplayCaptureBytesForWorkflow(this.ctx, ...args);
  }
  async oldestReplayCaptures(...args: Parameters<Store["oldestReplayCaptures"]>): ReturnType<Store["oldestReplayCaptures"]> {
    return capture.oldestReplayCaptures(this.ctx, ...args);
  }
  async replayGoldenBadgesForExecutions(...args: Parameters<Store["replayGoldenBadgesForExecutions"]>): ReturnType<Store["replayGoldenBadgesForExecutions"]> {
    return replay.replayGoldenBadgesForExecutions(this.ctx, ...args);
  }
  async deleteReplayRecording(...args: Parameters<Store["deleteReplayRecording"]>): ReturnType<Store["deleteReplayRecording"]> {
    return replay.deleteReplayRecording(this.ctx, ...args);
  }
  async listWorkflowVersions(...args: Parameters<Store["listWorkflowVersions"]>): ReturnType<Store["listWorkflowVersions"]> {
    return workflows.listWorkflowVersions(this.ctx, ...args);
  }
  async getWorkflowVersion(...args: Parameters<Store["getWorkflowVersion"]>): ReturnType<Store["getWorkflowVersion"]> {
    return workflows.getWorkflowVersion(this.ctx, ...args);
  }
  async writeWorkflowVersion(...args: Parameters<Store["writeWorkflowVersion"]>): ReturnType<Store["writeWorkflowVersion"]> {
    return workflows.writeWorkflowVersion(this.ctx, ...args);
  }
  async pruneWorkflowVersions(...args: Parameters<Store["pruneWorkflowVersions"]>): ReturnType<Store["pruneWorkflowVersions"]> {
    return workflows.pruneWorkflowVersions(this.ctx, ...args);
  }
  async maxWorkflowVersionNumber(...args: Parameters<Store["maxWorkflowVersionNumber"]>): ReturnType<Store["maxWorkflowVersionNumber"]> {
    return workflows.maxWorkflowVersionNumber(this.ctx, ...args);
  }
  async appendWorkflowVersion(...args: Parameters<Store["appendWorkflowVersion"]>): ReturnType<Store["appendWorkflowVersion"]> {
    return workflows.appendWorkflowVersion(this.ctx, ...args);
  }
  async publishWorkflowVersion(...args: Parameters<Store["publishWorkflowVersion"]>): ReturnType<Store["publishWorkflowVersion"]> {
    return release.publishWorkflowVersion(this.ctx, ...args);
  }
  async countProjectMemberships(...args: Parameters<Store["countProjectMemberships"]>): ReturnType<Store["countProjectMemberships"]> {
    return auth.countProjectMemberships(this.ctx, ...args);
  }
  async listProjectMembers(...args: Parameters<Store["listProjectMembers"]>): ReturnType<Store["listProjectMembers"]> {
    return auth.listProjectMembers(this.ctx, ...args);
  }
  async listUserProjectRoles(...args: Parameters<Store["listUserProjectRoles"]>): ReturnType<Store["listUserProjectRoles"]> {
    return auth.listUserProjectRoles(this.ctx, ...args);
  }
  async getProjectRole(...args: Parameters<Store["getProjectRole"]>): ReturnType<Store["getProjectRole"]> {
    return auth.getProjectRole(this.ctx, ...args);
  }
  async upsertProjectRole(...args: Parameters<Store["upsertProjectRole"]>): ReturnType<Store["upsertProjectRole"]> {
    return auth.upsertProjectRole(this.ctx, ...args);
  }
  async removeProjectRole(...args: Parameters<Store["removeProjectRole"]>): ReturnType<Store["removeProjectRole"]> {
    return auth.removeProjectRole(this.ctx, ...args);
  }
  async listCustomRoles(...args: Parameters<Store["listCustomRoles"]>): ReturnType<Store["listCustomRoles"]> {
    return auth.listCustomRoles(this.ctx, ...args);
  }
  async getCustomRole(...args: Parameters<Store["getCustomRole"]>): ReturnType<Store["getCustomRole"]> {
    return auth.getCustomRole(this.ctx, ...args);
  }
  async upsertCustomRole(...args: Parameters<Store["upsertCustomRole"]>): ReturnType<Store["upsertCustomRole"]> {
    return auth.upsertCustomRole(this.ctx, ...args);
  }
  async deleteCustomRole(...args: Parameters<Store["deleteCustomRole"]>): ReturnType<Store["deleteCustomRole"]> {
    return auth.deleteCustomRole(this.ctx, ...args);
  }
  async listSsoGroupMappings(...args: Parameters<Store["listSsoGroupMappings"]>): ReturnType<Store["listSsoGroupMappings"]> {
    return auth.listSsoGroupMappings(this.ctx, ...args);
  }
  async upsertSsoGroupMapping(...args: Parameters<Store["upsertSsoGroupMapping"]>): ReturnType<Store["upsertSsoGroupMapping"]> {
    return auth.upsertSsoGroupMapping(this.ctx, ...args);
  }
  async deleteSsoGroupMapping(...args: Parameters<Store["deleteSsoGroupMapping"]>): ReturnType<Store["deleteSsoGroupMapping"]> {
    return auth.deleteSsoGroupMapping(this.ctx, ...args);
  }
  async listWorkflowShares(...args: Parameters<Store["listWorkflowShares"]>): ReturnType<Store["listWorkflowShares"]> {
    return workflows.listWorkflowShares(this.ctx, ...args);
  }
  async listWorkflowsSharedToProject(...args: Parameters<Store["listWorkflowsSharedToProject"]>): ReturnType<Store["listWorkflowsSharedToProject"]> {
    return workflows.listWorkflowsSharedToProject(this.ctx, ...args);
  }
  async upsertWorkflowShare(...args: Parameters<Store["upsertWorkflowShare"]>): ReturnType<Store["upsertWorkflowShare"]> {
    return workflows.upsertWorkflowShare(this.ctx, ...args);
  }
  async removeWorkflowShare(...args: Parameters<Store["removeWorkflowShare"]>): ReturnType<Store["removeWorkflowShare"]> {
    return workflows.removeWorkflowShare(this.ctx, ...args);
  }
  async listSecretShares(...args: Parameters<Store["listSecretShares"]>): ReturnType<Store["listSecretShares"]> {
    return secrets.listSecretShares(this.ctx, ...args);
  }
  async listSecretsSharedToProject(...args: Parameters<Store["listSecretsSharedToProject"]>): ReturnType<Store["listSecretsSharedToProject"]> {
    return secrets.listSecretsSharedToProject(this.ctx, ...args);
  }
  async upsertSecretShare(...args: Parameters<Store["upsertSecretShare"]>): ReturnType<Store["upsertSecretShare"]> {
    return secrets.upsertSecretShare(this.ctx, ...args);
  }
  async removeSecretShare(...args: Parameters<Store["removeSecretShare"]>): ReturnType<Store["removeSecretShare"]> {
    return secrets.removeSecretShare(this.ctx, ...args);
  }
  async getWorkflowCreatedBy(...args: Parameters<Store["getWorkflowCreatedBy"]>): ReturnType<Store["getWorkflowCreatedBy"]> {
    return workflows.getWorkflowCreatedBy(this.ctx, ...args);
  }
  async saveApiKey(...args: Parameters<Store["saveApiKey"]>): ReturnType<Store["saveApiKey"]> {
    return auth.saveApiKey(this.ctx, ...args);
  }
  async listApiKeys(...args: Parameters<Store["listApiKeys"]>): ReturnType<Store["listApiKeys"]> {
    return auth.listApiKeys(this.ctx, ...args);
  }
  async findApiKeyByPrefix(...args: Parameters<Store["findApiKeyByPrefix"]>): ReturnType<Store["findApiKeyByPrefix"]> {
    return auth.findApiKeyByPrefix(this.ctx, ...args);
  }
  async touchApiKey(...args: Parameters<Store["touchApiKey"]>): ReturnType<Store["touchApiKey"]> {
    return auth.touchApiKey(this.ctx, ...args);
  }
  async revokeApiKey(...args: Parameters<Store["revokeApiKey"]>): ReturnType<Store["revokeApiKey"]> {
    return auth.revokeApiKey(this.ctx, ...args);
  }
  async getMfaSecret(...args: Parameters<Store["getMfaSecret"]>): ReturnType<Store["getMfaSecret"]> {
    return auth.getMfaSecret(this.ctx, ...args);
  }
  async upsertMfaSecret(...args: Parameters<Store["upsertMfaSecret"]>): ReturnType<Store["upsertMfaSecret"]> {
    return auth.upsertMfaSecret(this.ctx, ...args);
  }
  async replaceMfaBackupCodes(...args: Parameters<Store["replaceMfaBackupCodes"]>): ReturnType<Store["replaceMfaBackupCodes"]> {
    return auth.replaceMfaBackupCodes(this.ctx, ...args);
  }
  async deleteMfaSecret(...args: Parameters<Store["deleteMfaSecret"]>): ReturnType<Store["deleteMfaSecret"]> {
    return auth.deleteMfaSecret(this.ctx, ...args);
  }
  async findSsoIdentity(...args: Parameters<Store["findSsoIdentity"]>): ReturnType<Store["findSsoIdentity"]> {
    return auth.findSsoIdentity(this.ctx, ...args);
  }
  async upsertSsoIdentity(...args: Parameters<Store["upsertSsoIdentity"]>): ReturnType<Store["upsertSsoIdentity"]> {
    return auth.upsertSsoIdentity(this.ctx, ...args);
  }
  async deleteSecret(...args: Parameters<Store["deleteSecret"]>): ReturnType<Store["deleteSecret"]> {
    return secrets.deleteSecret(this.ctx, ...args);
  }
  async listExternalSecretProviders(...args: Parameters<Store["listExternalSecretProviders"]>): ReturnType<Store["listExternalSecretProviders"]> {
    return secrets.listExternalSecretProviders(this.ctx, ...args);
  }
  async getExternalSecretProvider(...args: Parameters<Store["getExternalSecretProvider"]>): ReturnType<Store["getExternalSecretProvider"]> {
    return secrets.getExternalSecretProvider(this.ctx, ...args);
  }
  async upsertExternalSecretProvider(...args: Parameters<Store["upsertExternalSecretProvider"]>): ReturnType<Store["upsertExternalSecretProvider"]> {
    return secrets.upsertExternalSecretProvider(this.ctx, ...args);
  }
  async deleteExternalSecretProvider(...args: Parameters<Store["deleteExternalSecretProvider"]>): ReturnType<Store["deleteExternalSecretProvider"]> {
    return secrets.deleteExternalSecretProvider(this.ctx, ...args);
  }
  async countSecretsUsingExternalProvider(...args: Parameters<Store["countSecretsUsingExternalProvider"]>): ReturnType<Store["countSecretsUsingExternalProvider"]> {
    return secrets.countSecretsUsingExternalProvider(this.ctx, ...args);
  }
  async getExternalSecretCacheEntry(...args: Parameters<Store["getExternalSecretCacheEntry"]>): ReturnType<Store["getExternalSecretCacheEntry"]> {
    return secrets.getExternalSecretCacheEntry(this.ctx, ...args);
  }
  async upsertExternalSecretCacheEntry(...args: Parameters<Store["upsertExternalSecretCacheEntry"]>): ReturnType<Store["upsertExternalSecretCacheEntry"]> {
    return secrets.upsertExternalSecretCacheEntry(this.ctx, ...args);
  }
  async deleteExternalSecretCacheEntry(...args: Parameters<Store["deleteExternalSecretCacheEntry"]>): ReturnType<Store["deleteExternalSecretCacheEntry"]> {
    return secrets.deleteExternalSecretCacheEntry(this.ctx, ...args);
  }
  async claimWorkflowExecutionForResume(...args: Parameters<Store["claimWorkflowExecutionForResume"]>): ReturnType<Store["claimWorkflowExecutionForResume"]> {
    return executions.claimWorkflowExecutionForResume(this.ctx, ...args);
  }
  async listResumingWorkflowExecutionIds(...args: Parameters<Store["listResumingWorkflowExecutionIds"]>): ReturnType<Store["listResumingWorkflowExecutionIds"]> {
    return executions.listResumingWorkflowExecutionIds(this.ctx, ...args);
  }
  async listResumingWorkflowExecutions(...args: Parameters<Store["listResumingWorkflowExecutions"]>): ReturnType<Store["listResumingWorkflowExecutions"]> {
    return executions.listResumingWorkflowExecutions(this.ctx, ...args);
  }
  async releaseWorkflowExecutionClaim(...args: Parameters<Store["releaseWorkflowExecutionClaim"]>): ReturnType<Store["releaseWorkflowExecutionClaim"]> {
    return executions.releaseWorkflowExecutionClaim(this.ctx, ...args);
  }
  async insertApprovalRequest(...args: Parameters<Store["insertApprovalRequest"]>): ReturnType<Store["insertApprovalRequest"]> {
    return approvals.insertApprovalRequest(this.ctx, ...args);
  }
  async getApprovalRequest(...args: Parameters<Store["getApprovalRequest"]>): ReturnType<Store["getApprovalRequest"]> {
    return approvals.getApprovalRequest(this.ctx, ...args);
  }
  async getPendingApprovalRequestForExecution(...args: Parameters<Store["getPendingApprovalRequestForExecution"]>): ReturnType<Store["getPendingApprovalRequestForExecution"]> {
    return approvals.getPendingApprovalRequestForExecution(this.ctx, ...args);
  }
  async listApprovalRequestsForExecution(...args: Parameters<Store["listApprovalRequestsForExecution"]>): ReturnType<Store["listApprovalRequestsForExecution"]> {
    return approvals.listApprovalRequestsForExecution(this.ctx, ...args);
  }
  async listApprovalRequests(...args: Parameters<Store["listApprovalRequests"]>): ReturnType<Store["listApprovalRequests"]> {
    return approvals.listApprovalRequests(this.ctx, ...args);
  }
  async listExpiredApprovalRequests(...args: Parameters<Store["listExpiredApprovalRequests"]>): ReturnType<Store["listExpiredApprovalRequests"]> {
    return approvals.listExpiredApprovalRequests(this.ctx, ...args);
  }
  async decideApprovalRequest(...args: Parameters<Store["decideApprovalRequest"]>): ReturnType<Store["decideApprovalRequest"]> {
    return approvals.decideApprovalRequest(this.ctx, ...args);
  }
  async reopenApprovalRequest(...args: Parameters<Store["reopenApprovalRequest"]>): ReturnType<Store["reopenApprovalRequest"]> {
    return approvals.reopenApprovalRequest(this.ctx, ...args);
  }
  async cancelPendingApprovalRequests(...args: Parameters<Store["cancelPendingApprovalRequests"]>): ReturnType<Store["cancelPendingApprovalRequests"]> {
    return approvals.cancelPendingApprovalRequests(this.ctx, ...args);
  }
  async hasActiveQueueItem(...args: Parameters<Store["hasActiveQueueItem"]>): ReturnType<Store["hasActiveQueueItem"]> {
    return queue.hasActiveQueueItem(this.ctx, ...args);
  }
  async getGitConfig(...args: Parameters<Store["getGitConfig"]>): ReturnType<Store["getGitConfig"]> {
    return misc.getGitConfig(this.ctx, ...args);
  }
  async upsertGitConfig(...args: Parameters<Store["upsertGitConfig"]>): ReturnType<Store["upsertGitConfig"]> {
    return misc.upsertGitConfig(this.ctx, ...args);
  }
  async deleteGitConfig(...args: Parameters<Store["deleteGitConfig"]>): ReturnType<Store["deleteGitConfig"]> {
    return misc.deleteGitConfig(this.ctx, ...args);
  }
  async recordGitSync(...args: Parameters<Store["recordGitSync"]>): ReturnType<Store["recordGitSync"]> {
    return misc.recordGitSync(this.ctx, ...args);
  }
  async getLease(...args: Parameters<Store["getLease"]>): ReturnType<Store["getLease"]> {
    return misc.getLease(this.ctx, ...args);
  }
  async tryAcquireLease(...args: Parameters<Store["tryAcquireLease"]>): ReturnType<Store["tryAcquireLease"]> {
    return misc.tryAcquireLease(this.ctx, ...args);
  }
  async releaseLease(...args: Parameters<Store["releaseLease"]>): ReturnType<Store["releaseLease"]> {
    return misc.releaseLease(this.ctx, ...args);
  }
  async listLeases(...args: Parameters<Store["listLeases"]>): ReturnType<Store["listLeases"]> {
    return misc.listLeases(this.ctx, ...args);
  }
  async writeAuditLog(...args: Parameters<Store["writeAuditLog"]>): ReturnType<Store["writeAuditLog"]> {
    return audit.writeAuditLog(this.ctx, ...args);
  }
  async verifyAuditChain(...args: Parameters<Store["verifyAuditChain"]>): ReturnType<Store["verifyAuditChain"]> {
    return audit.verifyAuditChain(this.ctx, ...args);
  }
  async listAuditLogs(...args: Parameters<Store["listAuditLogs"]>): ReturnType<Store["listAuditLogs"]> {
    return audit.listAuditLogs(this.ctx, ...args);
  }
  async pruneAuditLogs(...args: Parameters<Store["pruneAuditLogs"]>): ReturnType<Store["pruneAuditLogs"]> {
    return audit.pruneAuditLogs(this.ctx, ...args);
  }
  async listLogStreamDestinations(...args: Parameters<Store["listLogStreamDestinations"]>): ReturnType<Store["listLogStreamDestinations"]> {
    return audit.listLogStreamDestinations(this.ctx, ...args);
  }
  async getLogStreamDestination(...args: Parameters<Store["getLogStreamDestination"]>): ReturnType<Store["getLogStreamDestination"]> {
    return audit.getLogStreamDestination(this.ctx, ...args);
  }
  async upsertLogStreamDestination(...args: Parameters<Store["upsertLogStreamDestination"]>): ReturnType<Store["upsertLogStreamDestination"]> {
    return audit.upsertLogStreamDestination(this.ctx, ...args);
  }
  async deleteLogStreamDestination(...args: Parameters<Store["deleteLogStreamDestination"]>): ReturnType<Store["deleteLogStreamDestination"]> {
    return audit.deleteLogStreamDestination(this.ctx, ...args);
  }
  async recordLogStreamDispatch(...args: Parameters<Store["recordLogStreamDispatch"]>): ReturnType<Store["recordLogStreamDispatch"]> {
    return audit.recordLogStreamDispatch(this.ctx, ...args);
  }
  async writeLogStreamEvent(...args: Parameters<Store["writeLogStreamEvent"]>): ReturnType<Store["writeLogStreamEvent"]> {
    return audit.writeLogStreamEvent(this.ctx, ...args);
  }
  async listLogStreamEvents(...args: Parameters<Store["listLogStreamEvents"]>): ReturnType<Store["listLogStreamEvents"]> {
    return audit.listLogStreamEvents(this.ctx, ...args);
  }
  async pruneLogStreamEvents(...args: Parameters<Store["pruneLogStreamEvents"]>): ReturnType<Store["pruneLogStreamEvents"]> {
    return audit.pruneLogStreamEvents(this.ctx, ...args);
  }
  async createAuditExportDestination(...args: Parameters<Store["createAuditExportDestination"]>): ReturnType<Store["createAuditExportDestination"]> {
    return audit.createAuditExportDestination(this.ctx, ...args);
  }
  async updateAuditExportDestination(...args: Parameters<Store["updateAuditExportDestination"]>): ReturnType<Store["updateAuditExportDestination"]> {
    return audit.updateAuditExportDestination(this.ctx, ...args);
  }
  async deleteAuditExportDestination(...args: Parameters<Store["deleteAuditExportDestination"]>): ReturnType<Store["deleteAuditExportDestination"]> {
    return audit.deleteAuditExportDestination(this.ctx, ...args);
  }
  async listAuditExportDestinations(...args: Parameters<Store["listAuditExportDestinations"]>): ReturnType<Store["listAuditExportDestinations"]> {
    return audit.listAuditExportDestinations(this.ctx, ...args);
  }
  async getAuditExportDestination(...args: Parameters<Store["getAuditExportDestination"]>): ReturnType<Store["getAuditExportDestination"]> {
    return audit.getAuditExportDestination(this.ctx, ...args);
  }
  async listAuditLogsAfter(...args: Parameters<Store["listAuditLogsAfter"]>): ReturnType<Store["listAuditLogsAfter"]> {
    return audit.listAuditLogsAfter(this.ctx, ...args);
  }
  async recordAuditExportRun(...args: Parameters<Store["recordAuditExportRun"]>): ReturnType<Store["recordAuditExportRun"]> {
    return audit.recordAuditExportRun(this.ctx, ...args);
  }
  async listAuditExportRuns(...args: Parameters<Store["listAuditExportRuns"]>): ReturnType<Store["listAuditExportRuns"]> {
    return audit.listAuditExportRuns(this.ctx, ...args);
  }
  async getExecutionManifest(...args: Parameters<Store["getExecutionManifest"]>): ReturnType<Store["getExecutionManifest"]> {
    return audit.getExecutionManifest(this.ctx, ...args);
  }
  async saveExecutionRunContext(...args: Parameters<Store["saveExecutionRunContext"]>): ReturnType<Store["saveExecutionRunContext"]> {
    return audit.saveExecutionRunContext(this.ctx, ...args);
  }
  async saveExecutionManifest(...args: Parameters<Store["saveExecutionManifest"]>): ReturnType<Store["saveExecutionManifest"]> {
    return audit.saveExecutionManifest(this.ctx, ...args);
  }
  async listAuditLogsForExecution(...args: Parameters<Store["listAuditLogsForExecution"]>): ReturnType<Store["listAuditLogsForExecution"]> {
    return audit.listAuditLogsForExecution(this.ctx, ...args);
  }
  async pruneExecutionManifests(...args: Parameters<Store["pruneExecutionManifests"]>): ReturnType<Store["pruneExecutionManifests"]> {
    return audit.pruneExecutionManifests(this.ctx, ...args);
  }
  async listAuditSigningKeys(...args: Parameters<Store["listAuditSigningKeys"]>): ReturnType<Store["listAuditSigningKeys"]> {
    return audit.listAuditSigningKeys(this.ctx, ...args);
  }
  async getAuditSigningKey(...args: Parameters<Store["getAuditSigningKey"]>): ReturnType<Store["getAuditSigningKey"]> {
    return audit.getAuditSigningKey(this.ctx, ...args);
  }
  async getActiveAuditSigningKey(...args: Parameters<Store["getActiveAuditSigningKey"]>): ReturnType<Store["getActiveAuditSigningKey"]> {
    return audit.getActiveAuditSigningKey(this.ctx, ...args);
  }
  async activateAuditSigningKey(...args: Parameters<Store["activateAuditSigningKey"]>): ReturnType<Store["activateAuditSigningKey"]> {
    return audit.activateAuditSigningKey(this.ctx, ...args);
  }
  async listVariables(...args: Parameters<Store["listVariables"]>): ReturnType<Store["listVariables"]> {
    return misc.listVariables(this.ctx, ...args);
  }
  async getVariable(...args: Parameters<Store["getVariable"]>): ReturnType<Store["getVariable"]> {
    return misc.getVariable(this.ctx, ...args);
  }
  async upsertVariable(...args: Parameters<Store["upsertVariable"]>): ReturnType<Store["upsertVariable"]> {
    return misc.upsertVariable(this.ctx, ...args);
  }
  async deleteVariable(...args: Parameters<Store["deleteVariable"]>): ReturnType<Store["deleteVariable"]> {
    return misc.deleteVariable(this.ctx, ...args);
  }
  async findVariableByKey(...args: Parameters<Store["findVariableByKey"]>): ReturnType<Store["findVariableByKey"]> {
    return misc.findVariableByKey(this.ctx, ...args);
  }
  async writeUsageEvent(...args: Parameters<Store["writeUsageEvent"]>): ReturnType<Store["writeUsageEvent"]> {
    return misc.writeUsageEvent(this.ctx, ...args);
  }
  async queryUsageRollup(...args: Parameters<Store["queryUsageRollup"]>): ReturnType<Store["queryUsageRollup"]> {
    return misc.queryUsageRollup(this.ctx, ...args);
  }
  async queryUsageTotals(...args: Parameters<Store["queryUsageTotals"]>): ReturnType<Store["queryUsageTotals"]> {
    return misc.queryUsageTotals(this.ctx, ...args);
  }
  async listUsageEvents(...args: Parameters<Store["listUsageEvents"]>): ReturnType<Store["listUsageEvents"]> {
    return misc.listUsageEvents(this.ctx, ...args);
  }
  async createBudget(...args: Parameters<Store["createBudget"]>): ReturnType<Store["createBudget"]> {
    return misc.createBudget(this.ctx, ...args);
  }
  async updateBudget(...args: Parameters<Store["updateBudget"]>): ReturnType<Store["updateBudget"]> {
    return misc.updateBudget(this.ctx, ...args);
  }
  async deleteBudget(...args: Parameters<Store["deleteBudget"]>): ReturnType<Store["deleteBudget"]> {
    return misc.deleteBudget(this.ctx, ...args);
  }
  async getBudget(...args: Parameters<Store["getBudget"]>): ReturnType<Store["getBudget"]> {
    return misc.getBudget(this.ctx, ...args);
  }
  async listBudgets(...args: Parameters<Store["listBudgets"]>): ReturnType<Store["listBudgets"]> {
    return misc.listBudgets(this.ctx, ...args);
  }
  async recordBudgetAlert(...args: Parameters<Store["recordBudgetAlert"]>): ReturnType<Store["recordBudgetAlert"]> {
    return misc.recordBudgetAlert(this.ctx, ...args);
  }
  async getLatestBudgetAlert(...args: Parameters<Store["getLatestBudgetAlert"]>): ReturnType<Store["getLatestBudgetAlert"]> {
    return misc.getLatestBudgetAlert(this.ctx, ...args);
  }
  async listBudgetAlerts(...args: Parameters<Store["listBudgetAlerts"]>): ReturnType<Store["listBudgetAlerts"]> {
    return misc.listBudgetAlerts(this.ctx, ...args);
  }
  async claimExecutionAndDecideApproval(...args: Parameters<Store["claimExecutionAndDecideApproval"]>): ReturnType<Store["claimExecutionAndDecideApproval"]> {
    return approvals.claimExecutionAndDecideApproval(this.ctx, ...args);
  }
  async releaseExecutionClaimAndReopenApproval(...args: Parameters<Store["releaseExecutionClaimAndReopenApproval"]>): ReturnType<Store["releaseExecutionClaimAndReopenApproval"]> {
    return approvals.releaseExecutionClaimAndReopenApproval(this.ctx, ...args);
  }
  async saveReleaseGate(...args: Parameters<Store["saveReleaseGate"]>): ReturnType<Store["saveReleaseGate"]> {
    return release.saveReleaseGate(this.ctx, ...args);
  }
  async updateReleaseGateCases(...args: Parameters<Store["updateReleaseGateCases"]>): ReturnType<Store["updateReleaseGateCases"]> {
    return release.updateReleaseGateCases(this.ctx, ...args);
  }
  async approveReleaseRequestAndPublish(...args: Parameters<Store["approveReleaseRequestAndPublish"]>): ReturnType<Store["approveReleaseRequestAndPublish"]> {
    return release.approveReleaseRequestAndPublish(this.ctx, ...args);
  }
  async saveReplayRecordingChecked(...args: Parameters<Store["saveReplayRecordingChecked"]>): ReturnType<Store["saveReplayRecordingChecked"]> {
    return replay.saveReplayRecordingChecked(this.ctx, ...args);
  }
  async promoteReplayCaptureToGoldenSet(...args: Parameters<Store["promoteReplayCaptureToGoldenSet"]>): ReturnType<Store["promoteReplayCaptureToGoldenSet"]> {
    return replay.promoteReplayCaptureToGoldenSet(this.ctx, ...args);
  }
  async importGoldenSet(...args: Parameters<Store["importGoldenSet"]>): ReturnType<Store["importGoldenSet"]> {
    return replay.importGoldenSet(this.ctx, ...args);
  }
}
