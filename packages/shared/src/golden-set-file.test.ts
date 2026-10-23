import { describe, expect, it } from "vitest";
import { goldenSetFileSchema, goldenSetFileSizeProblem, goldenSetSignedBytes, stripSecretReferences, type GoldenSetFile } from "./golden-set-file";

const facts = {
  status: "success",
  error: null,
  output: { ok: true },
  nodes: [],
  toolCalls: [],
  modelCalls: [],
  guard: [],
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null, durationMs: 1, modelCalls: 0, toolCalls: 0 }
};

function file(overrides: Partial<GoldenSetFile> = {}): GoldenSetFile {
  return {
    format: "l2m.golden-set",
    version: 1,
    workflow: { id: "wf", name: "WF" },
    name: "Suite",
    exportedAt: "2026-10-24T00:00:00.000Z",
    cases: [
      {
        name: "Case",
        recording: { name: "Case", sourceStatus: "success", workflowHash: "h", workflow: { nodes: [] }, input: { q: 1 }, nodes: {}, facts, cassette: null }
      }
    ],
    ...overrides
  };
}

describe("golden-set file", () => {
  it("accepts a minimal file and rejects the wrong format, version and shape", () => {
    expect(goldenSetFileSchema.safeParse(file()).success).toBe(true);
    expect(goldenSetFileSchema.safeParse({ ...file(), format: "other" }).success).toBe(false);
    expect(goldenSetFileSchema.safeParse({ ...file(), version: 2 }).success).toBe(false);
    expect(goldenSetFileSchema.safeParse({ ...file(), cases: [{ name: "x" }] }).success).toBe(false);
  });

  it("removes secret references at any depth and leaves other keys alone", () => {
    const clean = stripSecretReferences({ a: { secretRef: { secretId: "s1" }, keep: 1, list: [{ apiSecretId: "s2", x: "y" }] }, secretId: "s3" });
    expect(JSON.parse(JSON.stringify(clean))).toEqual({ a: { keep: 1, list: [{ x: "y" }] } });
  });

  it("reports too many cases, an oversized case and an oversized file", () => {
    const base = file();
    expect(goldenSetFileSizeProblem(base, { maxBytes: 1_000_000, maxCaseBytes: 1_000_000 })).toBeNull();
    expect(goldenSetFileSizeProblem(base, { maxBytes: 1_000_000, maxCaseBytes: 10 })).toContain("Case 1");
    expect(goldenSetFileSizeProblem(base, { maxBytes: 10, maxCaseBytes: 1_000_000 })).toContain("over 10 bytes");
    expect(goldenSetFileSizeProblem({ ...base, cases: [...base.cases, ...base.cases] }, { maxBytes: 1_000_000, maxCaseBytes: 1_000_000, maxCases: 1 })).toContain("at most 1");
  });

  it("signs the same bytes whatever the key order and ignores the signature block", () => {
    const one = goldenSetSignedBytes({ a: 1, b: 2, signature: { x: 1 } }, "k", "t");
    const two = goldenSetSignedBytes({ b: 2, a: 1 }, "k", "t");
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
    expect(Buffer.from(goldenSetSignedBytes({ a: 1 }, "k2", "t")).equals(Buffer.from(two))).toBe(false);
  });
});
