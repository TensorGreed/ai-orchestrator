/**
 * Phase 13.1 — how PostgresStore reads TIMESTAMPTZ text: through pg's own parser, then as an ISO-8601 string (the
 * shape the SQLite store returns). Values with no ISO form (infinity) come back as Postgres wrote them.
 */
import { describe, expect, it } from "vitest";
import { parseTimestamptz } from "./postgres-store.js";

describe("parseTimestamptz", () => {
  it("turns ordinary values into UTC ISO strings, keeping milliseconds", () => {
    expect(parseTimestamptz("2026-10-26 07:00:00+00")).toBe("2026-10-26T07:00:00.000Z");
    expect(parseTimestamptz("2026-10-26 09:30:00.123456+02:30")).toBe("2026-10-26T07:00:00.123Z");
  });

  it("reads an offset with seconds (local mean time, as Postgres prints old dates in a non-UTC session)", () => {
    // 1800-01-01T00:00:00Z shown in Asia/Kolkata (LMT +05:53:28).
    expect(parseTimestamptz("1800-01-01 05:53:28+05:53:28")).toBe("1800-01-01T00:00:00.000Z");
  });

  it("reads BC dates", () => {
    expect(parseTimestamptz("0044-03-15 00:00:00+00 BC")).toBe("-000043-03-15T00:00:00.000Z");
  });

  it("returns infinity / -infinity as written (there is no ISO form)", () => {
    expect(parseTimestamptz("infinity")).toBe("infinity");
    expect(parseTimestamptz("-infinity")).toBe("-infinity");
  });
});
