/**
 * v76 — content redaction maps: what a reversible redaction replaced, sealed with the master key by the caller
 * (ContentRulesToolsService and GuardService seal and open; the store only keeps the sealed text). Both stores run the
 * same SQL through a small executor (`?` placeholders; Postgres numbers them): SQLite in content-redaction-sqlite.ts,
 * Postgres in postgres/content-redaction.ts.
 *
 * - scope `gateway`: a redact tool call's map, bound to the client, toolset and project scope that made it;
 * - scope `run`: a workflow run's placeholder book (id `run:<executionId>`), one per run and project.
 * Rows end at `expires_at`: reads never return an expired row, and every write sweeps a batch of expired rows.
 */

import { randomInt } from "node:crypto";

/**
 * The first version of a new row: random in [1, 2^30], so it fits the Postgres INTEGER column after many updates and a
 * stale writer's version matches a replacement row only by a one-in-a-billion chance.
 */
export function newContentRedactionVersion(): number {
  return randomInt(1, 2 ** 30 + 1);
}

export const CONTENT_REDACTION_SCOPES = ["gateway", "run"] as const;
export type ContentRedactionScope = (typeof CONTENT_REDACTION_SCOPES)[number];

export interface ContentRedactionRecord {
  id: string;
  scope: ContentRedactionScope;
  clientId: string | null;
  toolsetId: string | null;
  /** The toolset's project, `gateway:<toolsetId>` for a toolset without one, or a run's project. */
  projectId: string | null;
  executionId: string | null;
  /** SecretService.sealValue output; never logged or returned by an API. */
  entriesSealed: string;
  entryCount: number;
  /** Data classes in the map (names only). */
  classes: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Write count of the row (conditional writes); 0 when first written. */
  version?: number;
}

export interface ContentRedactionStore {
  /** Insert or replace a map (same id: entries, counts, classes, updated and expiry change; scope and owner stay). */
  putContentRedaction(record: ContentRedactionRecord): Promise<void>;
  /** The map, or null when there is none or it expired at `now`. */
  getContentRedaction(id: string, now: string): Promise<ContentRedactionRecord | null>;
  /** Removes maps that expired before `now` (at most `limit`); resolves with how many went. */
  deleteExpiredContentRedactions(now: string, limit?: number): Promise<number>;
  /**
   * A conditional write: with `expectedVersion` null, inserts the map only when no unexpired row has its id; otherwise
   * replaces its contents only while the row is still at that version. Resolves with the row's new version, or null
   * when another writer got there first (the caller reloads and merges).
   */
  writeContentRedactionIfVersion(record: ContentRedactionRecord, expectedVersion: number | null): Promise<number | null>;
  /** Unexpired maps after `afterId` in id order, at most `limit` (a data-subject deletion pages through them). */
  listContentRedactions(input: { afterId: string | null; limit: number; now: string }): Promise<ContentRedactionRecord[]>;
  /** Removes one map; resolves with whether it was there. */
  deleteContentRedaction(id: string): Promise<boolean>;
}

type Row = Record<string, unknown>;

export interface ContentRedactionSqlExecutor {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Resolves with the rows changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
}

const str = (value: unknown): string => (typeof value === "string" ? value : value instanceof Date ? value.toISOString() : String(value ?? ""));
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : str(value));

function classesOf(value: unknown): string[] {
  try {
    const parsed = JSON.parse(str(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(row: Row): ContentRedactionRecord {
  const scope = str(row.scope);
  return {
    id: str(row.id),
    scope: scope === "run" ? "run" : "gateway",
    clientId: strOrNull(row.client_id),
    toolsetId: strOrNull(row.toolset_id),
    projectId: strOrNull(row.project_id),
    executionId: strOrNull(row.execution_id),
    entriesSealed: str(row.entries_sealed),
    entryCount: Number(row.entry_count ?? 0),
    classes: classesOf(row.classes_json),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    expiresAt: str(row.expires_at),
    version: Number(row.version ?? 0)
  };
}

/** Expired rows a write sweeps at most. */
export const CONTENT_REDACTION_SWEEP_BATCH = 500;

export function createContentRedactionSqlStore(exec: ContentRedactionSqlExecutor): ContentRedactionStore {
  const deleteExpired = async (now: string, limit = CONTENT_REDACTION_SWEEP_BATCH): Promise<number> =>
    await exec.run(
      `DELETE FROM content_redactions WHERE id IN (SELECT id FROM content_redactions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`,
      [now, Math.max(1, Math.floor(limit))]
    );
  return {
    async putContentRedaction(record) {
      await deleteExpired(record.updatedAt);
      await exec.run(
        `INSERT INTO content_redactions (id, scope, client_id, toolset_id, project_id, execution_id, entries_sealed, entry_count, classes_json, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET entries_sealed = excluded.entries_sealed, entry_count = excluded.entry_count,
           classes_json = excluded.classes_json, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        [
          record.id,
          record.scope,
          record.clientId,
          record.toolsetId,
          record.projectId,
          record.executionId,
          record.entriesSealed,
          record.entryCount,
          JSON.stringify([...new Set(record.classes)].sort()),
          record.createdAt,
          record.updatedAt,
          record.expiresAt
        ]
      );
    },
    async getContentRedaction(id, now) {
      const rows = await exec.all(`SELECT * FROM content_redactions WHERE id = ? AND expires_at > ?`, [id, now]);
      return rows[0] ? mapRow(rows[0]) : null;
    },
    deleteExpiredContentRedactions: deleteExpired,
    async writeContentRedactionIfVersion(record, expectedVersion) {
      await deleteExpired(record.updatedAt);
      if (expectedVersion === null) {
        // A new row starts at a random version, not 1: a writer still holding the version of a row that was deleted (a
        // data-subject deletion, expiry) must never match the row that replaced it and write the old mappings back.
        const version = newContentRedactionVersion();
        // An expired row of the same id is gone first, so it never blocks a new book.
        await exec.run(`DELETE FROM content_redactions WHERE id = ? AND expires_at <= ?`, [record.id, record.updatedAt]);
        const inserted = await exec.run(
          `INSERT INTO content_redactions (id, scope, client_id, toolset_id, project_id, execution_id, entries_sealed, entry_count, classes_json, created_at, updated_at, expires_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          [
            record.id, record.scope, record.clientId, record.toolsetId, record.projectId, record.executionId, record.entriesSealed, record.entryCount,
            JSON.stringify([...new Set(record.classes)].sort()), record.createdAt, record.updatedAt, record.expiresAt, version
          ]
        );
        return inserted > 0 ? version : null;
      }
      const updated = await exec.run(
        `UPDATE content_redactions SET entries_sealed = ?, entry_count = ?, classes_json = ?, updated_at = ?, expires_at = ?, version = version + 1
         WHERE id = ? AND version = ? AND expires_at > ?`,
        [record.entriesSealed, record.entryCount, JSON.stringify([...new Set(record.classes)].sort()), record.updatedAt, record.expiresAt, record.id, expectedVersion, record.updatedAt]
      );
      return updated > 0 ? expectedVersion + 1 : null;
    },
    async listContentRedactions({ afterId, limit, now }) {
      const rows = await exec.all(
        `SELECT * FROM content_redactions WHERE expires_at > ? AND id > ? ORDER BY id LIMIT ?`,
        [now, afterId ?? "", Math.max(1, Math.min(1000, Math.floor(limit)))]
      );
      return rows.map(mapRow);
    },
    async deleteContentRedaction(id) {
      return (await exec.run(`DELETE FROM content_redactions WHERE id = ?`, [id])) > 0;
    }
  };
}

export const SQLITE_CONTENT_REDACTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS content_redactions (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    client_id TEXT,
    toolset_id TEXT,
    project_id TEXT,
    execution_id TEXT,
    entries_sealed TEXT NOT NULL,
    entry_count INTEGER NOT NULL DEFAULT 0,
    classes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_content_redactions_expires ON content_redactions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_content_redactions_project ON content_redactions(project_id);
`;
