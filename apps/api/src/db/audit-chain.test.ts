/**
 * Phase 13.1 — verifyAuditRows on its own (no store): the single-U+FFFD search's candidates (the 2048 lone surrogates
 * and U+0000) and its cost on a large legacy row.
 */
import { describe, expect, it } from "vitest";
import { auditEntryHash, GENESIS_HASH, verifyAuditRows, wellFormedAuditText, type AuditCanonicalInput, type AuditChainRow } from "./audit-chain.js";

function fields(id: string, message: string | null, overrides: Partial<AuditCanonicalInput> = {}): AuditCanonicalInput {
  return {
    id, createdAt: "2026-01-01T00:00:00.000Z", eventType: "tag.create", category: "workflow", action: "create",
    outcome: "success", actorUserId: null, actorEmail: null, actorType: "user", resourceType: "tag", resourceId: null,
    projectId: null, ipAddress: null, userAgent: null, metadataJson: null, message, ...overrides
  };
}

/**
 * A chain of rows hashed over `written` (the text the writer saw) and stored as a driver stores it: lone surrogates
 * and U+0000 as U+FFFD.
 */
function chain(written: AuditCanonicalInput[]): AuditChainRow[] {
  let prev = GENESIS_HASH;
  return written.map((f) => {
    const entryHash = auditEntryHash(prev, f);
    const stored: AuditCanonicalInput = { ...f };
    for (const key of Object.keys(stored) as Array<keyof AuditCanonicalInput>) {
      const value = stored[key];
      if (typeof value === "string") (stored as unknown as Record<string, string>)[key] = wellFormedAuditText(value);
    }
    const row = { fields: stored, prevHash: prev, entryHash };
    prev = entryHash;
    return row;
  });
}

describe("verifyAuditRows", () => {
  it("a row hashed with U+0000 and stored as U+FFFD (a SQLite → Postgres copy) is verified by the single-U+FFFD search", () => {
    const rows = chain([fields("a", "before"), fields("nul", "x\u0000y"), fields("b", "after")]);
    expect(rows[1]!.fields.message).toBe("x�y");
    expect(verifyAuditRows(rows)).toEqual({ ok: true, rowsChecked: 3 });
  });

  it("the single-U+FFFD search still verifies the first and last surrogates, a high surrogate before a pair, and a NUL in another field", () => {
    for (const written of [
      fields("s", "a\ud800b"),
      fields("s", "a\udfffb"),
      fields("s", "\udbff😀 pair after"),
      fields("s", "pair before 😀\udc00"),
      fields("s", null, { resourceId: "\u0000" })
    ]) {
      expect(verifyAuditRows(chain([written, fields("t", "next")]))).toEqual({ ok: true, rowsChecked: 2 });
    }
  });

  it("an edit beside the single U+FFFD is broken, whichever candidate was written", () => {
    for (const text of ["a\ud800b", "a\u0000b"]) {
      const rows = chain([fields("s", text)]);
      rows[0]!.fields.action = "delete";
      expect(verifyAuditRows(rows)).toMatchObject({ ok: false, rowsChecked: 0, firstBrokenAt: { id: "s" } });
    }
  });

  it("the search over a 100 KB legacy row stays fast (every candidate tried, no match)", () => {
    const big = "x".repeat(100_000);
    const rows = chain([fields("big", `${big}\udfff`)]);
    rows[0]!.fields.action = "delete"; // no candidate can match: the worst case, all 2049 are tried
    verifyAuditRows(rows); // warm up
    const started = performance.now();
    const result = verifyAuditRows(rows);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: false, firstBrokenAt: { id: "big" } });
    expect(elapsed).toBeLessThan(200);
  });
});
