/**
 * MCP 2026-07-28 (v71) — the label mark of a stateless gateway caller, shared by every instance.
 *
 * A 2026-07-28 caller has no session, so its 12.2 high-water mark is keyed by who it is: the client credential, the
 * toolset and the user its token acts for (`scope_key`, '' for a plain credential). Nothing in a request names or
 * replaces the key, so a caller cannot reset its mark; it ends `idleMs` after the caller's last call (as a session
 * would), when the client is revoked, or when the toolset is deleted. Any instance may answer the caller's next call,
 * so the mark lives in `mcp_gateway_label_marks` and every raise is a monotonic merge done under a row lock (Postgres)
 * or inside one transaction (SQLite).
 *
 * Both stores share the merge and the row mapping below; each runs it in its own dialect.
 */
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { MCP_TOOL_CALL_LABELS_MAX_CLASSES, PROVENANCE_LABELS, dataClassNameSchema, type ProvenanceLabel } from "@ai-orchestrator/shared";

/** Whose mark: the client credential, the toolset and the user its token acts for ('' for none). */
export interface McpGatewayLabelMarkKey {
  clientId: string;
  toolsetId: string;
  scopeKey: string;
}

export interface McpGatewayLabelMark extends McpGatewayLabelMarkKey {
  provenance: ProvenanceLabel[];
  dataClasses: string[];
  /** A result went back while the toolset did not track: what it carried is unknown (counts as outside content once it tracks). */
  unobserved: boolean;
  /** When the mark first held outside content or sensitive data. */
  raisedAt: string | null;
  /** The first raise has been audited (once per mark). */
  raiseAudited: boolean;
  lastSeenAt: string;
  expiresAt: string;
}

/** What a call adds to a mark. `now` and `expiresAt` come from the instance (expiresAt = now + idle expiry). */
export interface McpGatewayLabelMarkRaise extends McpGatewayLabelMarkKey {
  provenance: readonly string[];
  dataClasses: readonly string[];
  /** A result went back while the toolset did not track. */
  unobserved?: boolean;
  /** The toolset tracks now: results noted as unobserved count as outside content, and the note is cleared. */
  convertUnobserved?: boolean;
  now: string;
  expiresAt: string;
}

/** Labels a mark never collects: only the server's own scheduler is ever `trusted`. */
const UNCOLLECTED: ReadonlySet<string> = new Set(["trusted"]);

/** The mark counts as raised once it holds outside content or sensitive data (or classes). */
export function labelMarkRaised(mark: Pick<McpGatewayLabelMark, "provenance" | "dataClasses">): boolean {
  return mark.provenance.includes("untrusted_external") || mark.provenance.includes("sensitive") || mark.dataClasses.length > 0;
}

function emptyMark(input: McpGatewayLabelMarkRaise): McpGatewayLabelMark {
  return {
    clientId: input.clientId,
    toolsetId: input.toolsetId,
    scopeKey: input.scopeKey,
    provenance: [],
    dataClasses: [],
    unobserved: false,
    raisedAt: null,
    raiseAudited: false,
    lastSeenAt: input.now,
    expiresAt: input.expiresAt
  };
}

/** A stored row is live until its expiry; an expired one counts as no mark (the caller starts clean). */
export function labelMarkLive(mark: Pick<McpGatewayLabelMark, "expiresAt">, now: string): boolean {
  return Date.parse(mark.expiresAt) > Date.parse(now);
}

/**
 * The merge every raise runs: labels only ever join the mark (never leave it), unknown labels and invalid class names
 * are dropped, classes stop at the per-call cap. `existing`: the live row, or null (none, or expired). `firstRaise` is
 * true exactly once per mark: the call that first raised it (or that raises a mark whose raise was never audited).
 */
export function mergeLabelMark(existing: McpGatewayLabelMark | null, input: McpGatewayLabelMarkRaise): { next: McpGatewayLabelMark; firstRaise: boolean } {
  const base = existing ?? emptyMark(input);
  const provenance = new Set<ProvenanceLabel>(base.provenance);
  const dataClasses = new Set<string>(base.dataClasses);
  const add = (label: string) => {
    if ((PROVENANCE_LABELS as readonly string[]).includes(label) && !UNCOLLECTED.has(label)) provenance.add(label as ProvenanceLabel);
  };
  for (const label of input.provenance) add(label);
  for (const name of input.dataClasses) {
    if (dataClasses.size >= MCP_TOOL_CALL_LABELS_MAX_CLASSES) break;
    if (dataClassNameSchema.safeParse(name).success) dataClasses.add(name);
  }
  let unobserved = base.unobserved || input.unobserved === true;
  if (input.convertUnobserved && unobserved) {
    add("untrusted_external");
    unobserved = false;
  }
  const merged = {
    provenance: PROVENANCE_LABELS.filter((label) => provenance.has(label)),
    dataClasses: [...dataClasses].sort()
  };
  const raised = labelMarkRaised(merged);
  const firstRaise = raised && !base.raiseAudited;
  const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
  return {
    next: {
      ...base,
      ...merged,
      unobserved,
      raisedAt: base.raisedAt ?? (raised ? input.now : null),
      raiseAudited: base.raiseAudited || firstRaise,
      lastSeenAt: later(input.now, base.lastSeenAt),
      expiresAt: later(input.expiresAt, base.expiresAt)
    },
    firstRaise
  };
}

function jsonList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A row of either store as a mark (Postgres reads timestamps as ISO strings; SQLite stores them so). */
export function mapLabelMarkRow(row: Record<string, unknown>): McpGatewayLabelMark {
  const provenance = jsonList(row.provenance_json);
  return {
    clientId: String(row.client_id),
    toolsetId: String(row.toolset_id),
    scopeKey: String(row.scope_key ?? ""),
    provenance: PROVENANCE_LABELS.filter((label) => provenance.includes(label)),
    dataClasses: jsonList(row.data_classes_json),
    unobserved: Number(row.unobserved) === 1 || row.unobserved === true,
    raisedAt: row.raised_at === null || row.raised_at === undefined ? null : isoOf(row.raised_at),
    raiseAudited: Number(row.raise_audited) === 1 || row.raise_audited === true,
    lastSeenAt: isoOf(row.last_seen_at),
    expiresAt: isoOf(row.expires_at)
  };
}

/** The values of LABEL_MARK_WRITE_SQL: the key, then every mutable column. */
export function labelMarkUpdateParams(mark: McpGatewayLabelMark): unknown[] {
  return [
    mark.clientId,
    mark.toolsetId,
    mark.scopeKey,
    JSON.stringify(mark.provenance),
    JSON.stringify(mark.dataClasses),
    mark.unobserved ? 1 : 0,
    mark.raisedAt,
    mark.raiseAudited ? 1 : 0,
    mark.lastSeenAt,
    mark.expiresAt
  ];
}

/** `?` placeholders (SQLite); Postgres converts them with toPgPlaceholders. */
export const LABEL_MARK_INSERT_EMPTY_SQL = `INSERT INTO mcp_gateway_label_marks
  (client_id, toolset_id, scope_key, provenance_json, data_classes_json, unobserved, raised_at, raise_audited, last_seen_at, expires_at)
  VALUES (?, ?, ?, '[]', '[]', 0, NULL, 0, ?, ?)
  ON CONFLICT (client_id, toolset_id, scope_key) DO NOTHING`;

/**
 * The merged mark, written as an upsert: if the row vanished between the insert and the locked read (another
 * instance's sweep deleted it as expired), the write re-creates it instead of updating no row and losing the raise.
 */
export const LABEL_MARK_WRITE_SQL = `INSERT INTO mcp_gateway_label_marks
  (client_id, toolset_id, scope_key, provenance_json, data_classes_json, unobserved, raised_at, raise_audited, last_seen_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (client_id, toolset_id, scope_key) DO UPDATE SET
    provenance_json = excluded.provenance_json,
    data_classes_json = excluded.data_classes_json,
    unobserved = excluded.unobserved,
    raised_at = excluded.raised_at,
    raise_audited = excluded.raise_audited,
    last_seen_at = excluded.last_seen_at,
    expires_at = excluded.expires_at`;

/**
 * Reads a live mark and moves its expiry on (a call keeps its caller's mark alive, as a request keeps a session). The
 * expiry never moves back: an instance whose clock lags cannot shorten a mark another instance set.
 */
export const LABEL_MARK_TOUCH_SQL = `UPDATE mcp_gateway_label_marks
  SET last_seen_at = ?, expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE ? END
  WHERE client_id = ? AND toolset_id = ? AND scope_key = ? AND expires_at > ?
  RETURNING *`;

/** The touch's parameters, in LABEL_MARK_TOUCH_SQL's order. */
export function labelMarkTouchParams(key: McpGatewayLabelMarkKey, at: { now: string; expiresAt: string }): unknown[] {
  return [at.now, at.expiresAt, at.expiresAt, key.clientId, key.toolsetId, key.scopeKey, at.now];
}

/** The v71 table, as the Postgres chain creates it (TEXT timestamps on SQLite). */
export function ensureLabelMarkSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_gateway_label_marks (
      client_id TEXT NOT NULL,
      toolset_id TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      provenance_json TEXT NOT NULL,
      data_classes_json TEXT NOT NULL,
      unobserved INTEGER NOT NULL DEFAULT 0,
      raised_at TEXT,
      raise_audited INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (client_id, toolset_id, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_gateway_label_marks_expires ON mcp_gateway_label_marks(expires_at);
  `);
}
