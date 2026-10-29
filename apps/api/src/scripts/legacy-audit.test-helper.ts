/**
 * Test helper: audit rows the way builds before the audit-text fix wrote them to SQLite. The hash covers the text the
 * writer saw (lone surrogates, U+0000 as is); the stored bytes are what better-sqlite3 on Node 20 (the former runtime image)
 * kept: a lone surrogate as its 3-byte generalized UTF-8 form (ED A0 80 for U+D800), U+0000 as a 0 byte. The bytes
 * are written with `CAST(? AS TEXT)`, so the row is the same whichever Node runs the test.
 */
import type Database from "better-sqlite3";
import { auditEntryHash, GENESIS_HASH, type AuditCanonicalInput } from "../db/audit-chain.js";

/** `value` in generalized UTF-8 (WTF-8): every code point, a lone surrogate included, as its own UTF-8 sequence. */
export function wtf8(value: string): Buffer {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Buffer.from(bytes);
}

const COLUMNS: Record<keyof AuditCanonicalInput, string> = {
  id: "id", createdAt: "created_at", eventType: "event_type", category: "category", action: "action", outcome: "outcome",
  actorUserId: "actor_user_id", actorEmail: "actor_email", actorType: "actor_type", resourceType: "resource_type",
  resourceId: "resource_id", projectId: "project_id", ipAddress: "ip_address", userAgent: "user_agent",
  metadataJson: "metadata_json", message: "message"
};

/** Appends one legacy row to the chain in `db` (an open better-sqlite3 handle on a store's file); returns its fields. */
export function appendLegacySqliteAuditRow(
  db: Database.Database,
  id: string,
  text: Partial<Omit<AuditCanonicalInput, "id" | "createdAt">>,
  createdAt = new Date().toISOString()
): AuditCanonicalInput {
  const last = db.prepare(`SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get() as
    | { entry_hash: string }
    | undefined;
  const prev = last?.entry_hash ?? GENESIS_HASH;
  const fields: AuditCanonicalInput = {
    id, createdAt, eventType: "tag.create", category: "workflow", action: "create", outcome: "success",
    actorUserId: null, actorEmail: null, actorType: "user", resourceType: "tag", resourceId: null,
    projectId: null, ipAddress: null, userAgent: null, metadataJson: null, message: null, ...text
  };
  const keys = Object.keys(COLUMNS) as Array<keyof AuditCanonicalInput>;
  const placeholders = keys.map((key) => (fields[key] === null ? "?" : "CAST(? AS TEXT)"));
  db.prepare(
    `INSERT INTO audit_logs (${keys.map((key) => COLUMNS[key]).join(", ")}, prev_hash, entry_hash) VALUES (${placeholders.join(", ")}, ?, ?)`
  ).run(...keys.map((key) => (fields[key] === null ? null : wtf8(fields[key] as string))), prev, auditEntryHash(prev, fields));
  return fields;
}

/**
 * A writeAuditLog input whose every free-text field (id included) starts with U+FEFF, the character a decoder without
 * `ignoreBOM` drops. `message` may add a U+FFFD (or a lone surrogate, stored as U+FFFD), so the row is one the exact
 * reader takes from its stored bytes.
 */
export function bomAuditEntry(id: string, message = "﻿plain") {
  return {
    id: `﻿${id}`, eventType: "﻿tag.create", category: "﻿workflow", action: "﻿create", outcome: "success" as const,
    actorUserId: "﻿u-1", actorEmail: "﻿a@example.com", resourceType: "﻿tag", resourceId: "﻿wf-1",
    projectId: "﻿default", ipAddress: "﻿127.0.0.1", userAgent: "﻿agent", metadata: "﻿note", message
  };
}

/** The stored bytes of every audit_logs text column, by id, in rowid order (hex), to compare a copy byte for byte. */
export function sqliteAuditBytes(db: Database.Database): Array<Record<string, string | null>> {
  const columns = Object.values(COLUMNS);
  return db.prepare(`SELECT ${columns.map((c) => `CASE WHEN ${c} IS NULL THEN NULL ELSE hex(CAST(${c} AS BLOB)) END AS ${c}`).join(", ")} FROM audit_logs ORDER BY rowid`).all() as Array<
    Record<string, string | null>
  >;
}
