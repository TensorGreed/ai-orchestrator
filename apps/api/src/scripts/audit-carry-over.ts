/**
 * Phase 13.1 — the audit-chain rule for moving a database (db:copy SQLite → Postgres, db:export → db:import), and the
 * verdict a backup records.
 *
 * A move may lose what the target cannot store: Postgres (and better-sqlite3 on Node 24) keep U+FFFD where the source
 * held a lone surrogate, and Postgres also where it held U+0000. The verifier tries every candidate for one U+FFFD in a
 * row, not for two, so such a row can go from verified to "cannot be verified". That is the only change a move may
 * make to the verdict, and only for a row whose own source text explains it (auditCarryOver). Anything else (a row
 * turning broken, a broken chain turning clean, an unverifiable row turning verified) means the copy is not faithful.
 */
import type { PoolClient } from "pg";
import {
  AuditChainWalker,
  LEGACY_TEXT_FIELDS,
  wellFormedAuditText,
  type AuditCanonicalInput,
  type AuditChainResult
} from "../db/audit-chain.js";

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * A Postgres chain's verdict, read through a cursor (seq order; `client` must be inside a transaction) and walked row
 * by row, so the chain is never held in memory. Reads and maps the rows exactly as postgres/audit.ts verifyAuditChain
 * does (same query, required fields as text, optional ones NULL → null, the sub-millisecond flag); the db:copy tests
 * compare the two verdicts.
 */
export async function verifyPostgresAuditChainByCursor(client: PoolClient): Promise<AuditChainResult> {
  const walker = new AuditChainWalker();
  await client.query(
    `DECLARE db_copy_audit NO SCROLL CURSOR FOR
       SELECT id, event_type, category, action, outcome, actor_user_id, actor_email, actor_type,
              resource_type, resource_id, project_id, ip_address, user_agent, metadata_json, message,
              created_at, prev_hash, entry_hash,
              date_trunc('milliseconds', created_at) <> created_at AS created_at_sub_ms
         FROM audit_logs WHERE entry_hash IS NOT NULL
        ORDER BY seq ASC`
  );
  try {
    const text = (value: unknown) => (typeof value === "string" ? value : String(value ?? ""));
    for (;;) {
      const batch = await client.query<Record<string, unknown>>(`FETCH 2000 FROM db_copy_audit`);
      for (const row of batch.rows) {
        const more = walker.push({
          fields: {
            id: text(row.id),
            createdAt: text(row.created_at),
            eventType: text(row.event_type),
            category: text(row.category),
            action: text(row.action),
            outcome: text(row.outcome),
            actorUserId: optionalText(row.actor_user_id),
            actorEmail: optionalText(row.actor_email),
            actorType: text(row.actor_type),
            resourceType: optionalText(row.resource_type),
            resourceId: optionalText(row.resource_id),
            projectId: optionalText(row.project_id),
            ipAddress: optionalText(row.ip_address),
            userAgent: optionalText(row.user_agent),
            metadataJson: optionalText(row.metadata_json),
            message: optionalText(row.message)
          },
          prevHash: text(row.prev_hash ?? ""),
          entryHash: text(row.entry_hash ?? ""),
          createdAtHasSubMillisecond: row.created_at_sub_ms === true
        });
        if (!more) return walker.result();
      }
      if (batch.rows.length < 2000) return walker.result();
    }
  } finally {
    await client.query(`CLOSE db_copy_audit`);
  }
}

/** 1-based walk position of the row where `result` found the chain broken. */
export function brokenPosition(result: AuditChainResult): number | undefined {
  return result.firstBrokenAt ? result.rowsChecked + (result.unverifiable?.length ?? 0) + 1 : undefined;
}

const UNSTORABLE_ON_POSTGRES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/g;

/**
 * Whether a source row's own text explains it being unverifiable on Postgres: its free-text fields hold at least one
 * character Postgres cannot store (U+0000, a lone surrogate), and two or more U+FFFD once those become U+FFFD (the
 * verifier tries one U+FFFD's candidates, not two). Computed from the source row, never from the target.
 */
export function unverifiableOnPostgresBySource(fields: AuditCanonicalInput): boolean {
  let unstorable = 0;
  let replacements = 0;
  for (const field of LEGACY_TEXT_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string") continue;
    unstorable += value.match(UNSTORABLE_ON_POSTGRES)?.length ?? 0;
    replacements += wellFormedAuditText(value).split("\ufffd").length - 1;
  }
  return unstorable > 0 && replacements >= 2;
}

/**
 * The audit rule for a move (db:copy, db:import): `target` (predicted or actual) against `source`, row by row up to the
 * source's break (all rows when the source is not broken). Every row the source verified must verify on the target,
 * or may be unverifiable there only when `explainedBySource` holds it (unverifiableOnPostgresBySource of the source
 * row); rows unverifiable on the source must stay so; the target must not break before the source does. Returns what
 * breaks the rule, and the rows that became unverifiable as the rule allows.
 */
export function auditCarryOver(
  source: AuditChainResult,
  target: AuditChainResult,
  explainedBySource: ReadonlySet<string>,
  names: { source: string; target: string } = { source: "the source", target: "the target" }
): { problems: string[]; becameUnverifiable: string[] } {
  const limit = brokenPosition(source) ?? Number.POSITIVE_INFINITY;
  const problems: string[] = [];
  const targetBreak = brokenPosition(target);
  if (target.firstBrokenAt && targetBreak! < limit) {
    problems.push(`row ${target.firstBrokenAt.id} (position ${targetBreak}) would be broken on ${names.target}, where ${names.source} verified the chain up to it`);
  }
  const before = (row: { position: number }) => row.position < limit && (targetBreak === undefined || row.position < targetBreak);
  const sourceUnverifiable = new Set((source.unverifiable ?? []).filter(before).map((row) => row.id));
  const targetUnverifiable = new Set((target.unverifiable ?? []).filter(before).map((row) => row.id));
  for (const id of sourceUnverifiable) {
    if (!targetUnverifiable.has(id)) problems.push(`row ${id} cannot be verified on ${names.source} but would count as verified on ${names.target}`);
  }
  const becameUnverifiable: string[] = [];
  for (const row of (target.unverifiable ?? []).filter(before)) {
    if (sourceUnverifiable.has(row.id)) continue;
    if (explainedBySource.has(row.id)) becameUnverifiable.push(row.id);
    else {
      problems.push(
        `row ${row.id} (position ${row.position}), verified on ${names.source}, would not be verifiable on ${names.target}, and its text on ${names.source} does not ` +
          `explain it (it needs a character the target cannot store and two or more U+FFFD once those become U+FFFD)`
      );
    }
  }
  return { problems, becameUnverifiable };
}

/** The audit verdict a backup records (db:export), compared after a restore (db:import). */
export interface AuditVerdictRecord {
  ok: boolean;
  rowsChecked: number;
  /** Where the chain was broken (1-based walk position), if it was. */
  firstBrokenAt?: { id: string; position: number };
  /** Rows that could not be verified, by walk position. */
  unverifiable: Array<{ id: string; position: number }>;
}

export function auditVerdictRecord(result: AuditChainResult): AuditVerdictRecord {
  return {
    ok: result.ok,
    rowsChecked: result.rowsChecked,
    ...(result.firstBrokenAt ? { firstBrokenAt: { id: result.firstBrokenAt.id, position: brokenPosition(result)! } } : {}),
    unverifiable: (result.unverifiable ?? []).map((row) => ({ id: row.id, position: row.position }))
  };
}

/** A recorded verdict as an AuditChainResult (enough of it for auditCarryOver and verdictText). */
export function auditVerdictFromRecord(record: AuditVerdictRecord): AuditChainResult {
  return {
    ok: record.ok,
    rowsChecked: record.rowsChecked,
    ...(record.firstBrokenAt ? { firstBrokenAt: { id: record.firstBrokenAt.id, createdAt: "", expected: "", stored: "" } } : {}),
    ...(record.unverifiable.length > 0
      ? { unverifiable: record.unverifiable.map((row) => ({ ...row, createdAt: "", prevHash: "", entryHash: "", reason: "" })) }
      : {})
  };
}

/** One line for a verdict. */
export function verdictText(result: AuditChainResult): string {
  if (result.firstBrokenAt) return `broken at row ${result.firstBrokenAt.id} (${result.rowsChecked} rows verified before it)`;
  const unverifiable = result.unverifiable ?? [];
  if (unverifiable.length === 0) return `intact (${result.rowsChecked} rows verified)`;
  const ids = unverifiable.map((row) => row.id);
  return `${result.rowsChecked} rows verified, ${ids.length} cannot be verified (${ids.length <= 8 ? ids.join(", ") : `${ids.slice(0, 8).join(", ")} and ${ids.length - 8} more`})`;
}

/**
 * A restored chain against the verdict its backup recorded: the same, except rows the rule allows to become
 * unverifiable (auditCarryOver). A broken backup must restore broken at the same row.
 */
export function restoredAuditProblems(
  recorded: AuditChainResult,
  restored: AuditChainResult,
  explainedBySource: ReadonlySet<string>
): { problems: string[]; becameUnverifiable: string[] } {
  const carried = auditCarryOver(recorded, restored, explainedBySource, { source: "the backup", target: "the restored database" });
  if (recorded.firstBrokenAt && restored.firstBrokenAt?.id !== recorded.firstBrokenAt.id) {
    carried.problems.unshift(
      `the backup's chain was broken at row ${recorded.firstBrokenAt.id}, the restored one is ${verdictText(restored)}`
    );
  }
  return carried;
}
