/**
 * Phase 13.1 — verifyAuditRows on its own (no store): what an unverifiable row reports, the single-U+FFFD search's
 * candidates (the 2048 lone surrogates and U+0000) and its cost on a large legacy row; storedSqliteAuditText, which
 * reads SQLite text bytes the same on every Node version.
 */
import { describe, expect, it } from "vitest";
import {
  auditEntryHash,
  GENESIS_HASH,
  storedSqliteAuditText,
  verifyAuditRows,
  wellFormedAuditText,
  type AuditCanonicalInput,
  type AuditChainRow
} from "./audit-chain.js";

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

  it("a row whose stored text kept its lone surrogates verifies exactly; edited, it is broken, never searched or unverifiable", () => {
    let prev = GENESIS_HASH;
    const rows: AuditChainRow[] = [fields("a", "first"), fields("kept", "\ud800 x \udc00 \udbff"), fields("b", "after")].map((f) => {
      const entryHash = auditEntryHash(prev, f);
      const row = { fields: { ...f }, prevHash: prev, entryHash };
      prev = entryHash;
      return row;
    });
    expect(verifyAuditRows(rows)).toEqual({ ok: true, rowsChecked: 3 });
    for (const edit of [{ action: "delete" }, { message: "\ud800 x \udc00 \udbfe" }, { message: "\ud800 x \udc00 \uFFFD" }]) {
      const edited = rows.map((row) => (row.fields.id === "kept" ? { ...row, fields: { ...row.fields, ...edit } } : row));
      const result = verifyAuditRows(edited);
      expect(result).toMatchObject({ ok: false, rowsChecked: 1, firstBrokenAt: { id: "kept" } });
      expect(result.unverifiable).toBeUndefined();
    }
  });
});

describe("storedSqliteAuditText", () => {
  const bytes = (hex: string) => Buffer.from(hex.replace(/ /g, ""), "hex");

  it("decodes valid UTF-8 as is, and NULL as null", () => {
    expect(storedSqliteAuditText(bytes(""))).toBe("");
    expect(storedSqliteAuditText(null)).toBeNull();
    expect(storedSqliteAuditText(Buffer.from("ok 😀 � é \u0000 x", "utf8"))).toBe("ok 😀 � é \u0000 x");
  });

  it("decodes generalized UTF-8 to the lone surrogates it encodes, beside pairs and other text", () => {
    expect(storedSqliteAuditText(bytes("61 ed a0 80 62"))).toBe("a\ud800b");
    expect(storedSqliteAuditText(bytes("ed bf bf ed a0 80"))).toBe("\udfff\ud800");
    expect(storedSqliteAuditText(bytes("ed af bf f0 9f 98 80 ed b0 80"))).toBe("\udbff😀\udc00");
    expect(storedSqliteAuditText(bytes("f4 8f bf bf ed a0 80"))).toBe("\u{10ffff}\ud800");
  });

  it("reads any other invalid bytes with U+FFFD, a CESU-8 pair and overlong forms included", () => {
    expect(storedSqliteAuditText(bytes("ed a0 80 ed b0 80"))).toBe(new TextDecoder().decode(bytes("ed a0 80 ed b0 80")));
    expect(storedSqliteAuditText(bytes("ed a0 80 ed b0 80"))).not.toMatch(/[\ud800-\udfff]/);
    for (const hex of ["ed a0", "c0 80 ed a0 80", "e0 80 80 ed a0 80", "f0 80 80 80", "f4 90 80 80", "ff ed a0 80", "80"]) {
      const decoded = storedSqliteAuditText(bytes(hex));
      expect(decoded).toBe(new TextDecoder().decode(bytes(hex)));
      expect(decoded).toContain("\uFFFD");
    }
  });
});
