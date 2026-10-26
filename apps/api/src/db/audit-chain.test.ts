/**
 * Phase 13.1 — verifyAuditRows on its own (no store): what an unverifiable row reports, the single-U+FFFD search's
 * candidates (the 2048 lone surrogates and U+0000) and its cost on a large legacy row.
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
  it("an unverifiable row is reported by its chain position and hashes, with a reason that does not assume it is legacy", () => {
    const rows = chain([fields("a", "first"), fields("b", "second"), fields("old", "\ud800 and \udc00"), fields("c", "after")]);
    const result = verifyAuditRows(rows);
    expect(result).toMatchObject({ ok: false, rowsChecked: 3 });
    expect(result.firstBrokenAt).toBeUndefined();
    expect(result.unverifiable).toEqual([
      {
        id: "old",
        createdAt: "2026-01-01T00:00:00.000Z",
        position: 3,
        prevHash: rows[1]!.entryHash,
        entryHash: rows[2]!.entryHash,
        reason: expect.stringContaining(
          "Content cannot be verified: either a row written before audit text was normalised, or an edit. Compare it with a backup or export."
        )
      }
    ]);
    // The next row's prev_hash pins the reported entry hash.
    expect(rows[3]!.prevHash).toBe(result.unverifiable![0]!.entryHash);
    expect(result.unverifiable![0]!.reason).toMatch(/2 U\+FFFD/);
  });

  it("the position counts every row walked, unverifiable ones included", () => {
    const rows = chain([fields("u1", "\ud800\ud800"), fields("v", "ok"), fields("u2", "\udfff x \udbff")]);
    expect(verifyAuditRows(rows).unverifiable?.map((row) => [row.id, row.position])).toEqual([["u1", 1], ["u2", 3]]);
  });

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
