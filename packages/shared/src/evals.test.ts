import { describe, expect, it } from "vitest";
import { evalScorerSpecSchema, goldenSetAddRecordingSchema, replayJobExitCode, replayJobRequestSchema } from "./evals";

describe("eval scorer specs", () => {
  it("accepts every scorer type and rejects unknown ones", () => {
    for (const spec of [
      { type: "exact_match" },
      { type: "json_equal", ignorePaths: ["**.id"], numberTolerance: 0.1, ignoreArrayOrder: true },
      { type: "json_schema", schema: { type: "object" } },
      { type: "text_similarity", threshold: 0.6 },
      { type: "tool_sequence", mode: "subsequence", args: "keys", forbiddenTools: ["delete"] },
      { type: "status" },
      { type: "no_new_guard_blocks", failOnRemoved: true },
      { type: "budget", maxCostUsd: 0.5 },
      { type: "llm_judge", rubric: "Polite", mode: "pairwise", votes: 3, secretRef: { secretId: "s1" } }
    ]) {
      expect(evalScorerSpecSchema.safeParse(spec).success, JSON.stringify(spec)).toBe(true);
    }
    expect(evalScorerSpecSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(evalScorerSpecSchema.safeParse({ type: "llm_judge", rubric: "" }).success).toBe(false);
    expect(evalScorerSpecSchema.safeParse({ type: "llm_judge", rubric: "r", votes: 6 }).success).toBe(false);
    // A raw key is never accepted in place of a secret reference.
    expect(evalScorerSpecSchema.safeParse({ type: "llm_judge", rubric: "r", secretRef: { secretId: "s", value: "sk-x" } }).success).toBe(false);
    expect(evalScorerSpecSchema.safeParse({ type: "json_schema", schema: { big: "x".repeat(70_000) } }).success).toBe(false);
  });
});

describe("replay job requests", () => {
  it("needs a set, refuses draft and version together and unknown keys", () => {
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds_1"] }).success).toBe(true);
    expect(replayJobRequestSchema.safeParse({ datasetIds: [] }).success).toBe(false);
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds_1"], draft: true, version: 2 }).success).toBe(false);
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds_1"], live: true }).success).toBe(false);
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds_1"], maxCostUsd: 0 }).success).toBe(false);
    expect(goldenSetAddRecordingSchema.safeParse({ recordingId: "rec_1", scorers: [{ type: "status" }] }).success).toBe(true);
  });
});

describe("replayJobExitCode", () => {
  const summary = (pass: number, fail: number, error: number) => ({ total: pass + fail + error, pass, fail, error, passRate: 0, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 0, avgDurationMs: 0 });
  it("maps a finished job to 0, 1 or 4", () => {
    expect(replayJobExitCode({ status: "completed", summary: summary(3, 0, 0) })).toBe(0);
    expect(replayJobExitCode({ status: "completed", summary: summary(2, 1, 1) })).toBe(1);
    expect(replayJobExitCode({ status: "completed", summary: summary(2, 0, 1) })).toBe(4);
    expect(replayJobExitCode({ status: "completed", summary: summary(0, 0, 0) })).toBe(4);
    for (const status of ["failed", "canceled", "interrupted", "running"]) expect(replayJobExitCode({ status, summary: summary(3, 0, 0) })).toBe(4);
  });
});
