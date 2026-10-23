import { describe, expect, it } from "vitest";
import {
  GOLDEN_SET_SIGNATURE_PURPOSE,
  goldenSetFileSchema,
  goldenSetFileSizeProblem,
  goldenSetSignedBytes,
  jsonDepthExceeds,
  stripSecretReferences,
  type GoldenSetFile
} from "./golden-set-file";

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
        recording: { name: "Case", sourceStatus: "success", workflowHash: "h", recordedAt: "2026-10-20T00:00:00.000Z", workflow: { nodes: [] }, input: { q: 1 }, nodes: {}, facts, cassette: null }
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
    const more = stripSecretReferences({
      credentialId: "c1",
      oauthCredentialId: "c2",
      credentialRef: { id: "c3" },
      credentials_secret_id: "c4",
      signingSecretRef: { secretId: "c5" },
      credentialsSecretId: "c6",
      secret: "kept for the shape scrub",
      secretRefs: "not a reference key",
      credentials: "kept for the shape scrub"
    });
    expect(JSON.parse(JSON.stringify(more))).toEqual({ secret: "kept for the shape scrub", secretRefs: "not a reference key", credentials: "kept for the shape scrub" });
  });

  it("requires recordedAt and knows the origins", () => {
    const base = file();
    const { recordedAt: _recordedAt, ...withoutTime } = base.cases[0]!.recording;
    expect(goldenSetFileSchema.safeParse({ ...base, cases: [{ ...base.cases[0], recording: withoutTime }] }).success).toBe(false);
    expect(goldenSetFileSchema.safeParse({ ...base, cases: [{ ...base.cases[0], recording: { ...base.cases[0]!.recording, recordedAt: "yesterday" } }] }).success).toBe(false);
    expect(goldenSetFileSchema.safeParse({ ...base, cases: [{ ...base.cases[0], recording: { ...base.cases[0]!.recording, origin: "imported", sourceWorkflowId: "wf-a" } }] }).success).toBe(true);
    expect(goldenSetFileSchema.safeParse({ ...base, cases: [{ ...base.cases[0], recording: { ...base.cases[0]!.recording, origin: "somewhere" } }] }).success).toBe(false);
  });

  it("measures JSON depth without recursion", () => {
    expect(jsonDepthExceeds({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(jsonDepthExceeds({ a: [{ b: {} }] }, 3)).toBe(true);
    let deep: unknown = 1;
    for (let level = 0; level < 200_000; level += 1) deep = [deep];
    expect(jsonDepthExceeds(deep)).toBe(true);
    expect(jsonDepthExceeds("text")).toBe(false);
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
    // The purpose tag is inside the signed bytes (domain separation).
    expect(GOLDEN_SET_SIGNATURE_PURPOSE).toBe("l2m.golden-set/1");
    expect(JSON.parse(Buffer.from(one).toString("utf8"))).toMatchObject({ purpose: "l2m.golden-set/1", keyId: "k", signedAt: "t" });
  });
});
