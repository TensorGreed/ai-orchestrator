import { describe, expect, it } from "vitest";
import { buildReplayJobRequest, candidateLabel, caseStatusLabel, emptyReplayJobForm, formatUsd, jobCounts, parseIgnorePaths, shortHash, statusTone, type ReplayJobForm } from "./replay-jobs";

function form(patch: (draft: ReplayJobForm) => void = () => undefined): ReplayJobForm {
  const value = emptyReplayJobForm();
  patch(value);
  return value;
}

describe("buildReplayJobRequest", () => {
  it("defaults to the draft, strict MCP and the server's scorers", () => {
    expect(buildReplayJobRequest(["set_1"], form())).toEqual({ ok: true, request: { datasetIds: ["set_1"], draft: true, mcpMode: "strict" } });
  });

  it("targets a saved version with the job options", () => {
    const result = buildReplayJobRequest(
      ["set_1"],
      form((draft) => {
        draft.candidate = 3;
        draft.mcpMode = "lenient";
        draft.ignorePaths = " answer.generatedAt \n\n items.*.id ";
        draft.numberTolerance = "0.01";
        draft.maxCostUsd = "2.5";
      })
    );
    expect(result).toEqual({
      ok: true,
      request: { datasetIds: ["set_1"], version: 3, mcpMode: "lenient", ignorePaths: ["answer.generatedAt", "items.*.id"], numberTolerance: 0.01, maxCostUsd: 2.5 }
    });
  });

  it("builds every picked scorer, the judge with a secret reference only", () => {
    const result = buildReplayJobRequest(
      ["set_1"],
      form((draft) => {
        draft.ignorePaths = "meta.at";
        draft.scorers.status = true;
        draft.scorers.jsonEqual = true;
        draft.scorers.textSimilarity = { enabled: true, threshold: "0.7" };
        draft.scorers.toolSequence = { enabled: true, mode: "subsequence" };
        draft.scorers.noNewGuardBlocks = true;
        draft.scorers.budget = { enabled: true, maxCostUsd: "0.05", maxTokens: "", maxLatencyMs: "4000" };
        draft.scorers.llmJudge = { enabled: true, rubric: " Be polite ", mode: "pairwise", votes: "3", threshold: "", providerId: "openai", model: "gpt-4o-mini", secretId: "sec_1" };
      })
    );
    expect(result.ok && result.request.scorers).toEqual([
      { type: "status" },
      { type: "json_equal", against: "baseline", ignorePaths: ["meta.at"] },
      { type: "text_similarity", against: "baseline", threshold: 0.7 },
      { type: "tool_sequence", mode: "subsequence" },
      { type: "no_new_guard_blocks" },
      { type: "budget", maxCostUsd: 0.05, maxLatencyMs: 4000 },
      { type: "llm_judge", rubric: "Be polite", mode: "pairwise", votes: 3, providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: "sec_1" } }
    ]);
  });

  it("rejects bad input with a readable message", () => {
    expect(buildReplayJobRequest([], form())).toEqual({ ok: false, error: "Pick a golden set." });
    expect(buildReplayJobRequest(["s"], form((draft) => void (draft.maxCostUsd = "0")))).toEqual({ ok: false, error: "Max cost must be more than 0." });
    expect(buildReplayJobRequest(["s"], form((draft) => void (draft.numberTolerance = "abc")))).toEqual({ ok: false, error: "Number tolerance must be a number." });
    expect(buildReplayJobRequest(["s"], form((draft) => void (draft.scorers.budget.enabled = true)))).toEqual({ ok: false, error: "The budget scorer needs at least one limit." });
    expect(buildReplayJobRequest(["s"], form((draft) => void (draft.scorers.llmJudge.enabled = true)))).toEqual({ ok: false, error: "The LLM judge needs a rubric." });
    expect(
      buildReplayJobRequest(
        ["s"],
        form((draft) => {
          draft.scorers.llmJudge = { ...draft.scorers.llmJudge, enabled: true, rubric: "x", votes: "9" };
        })
      )
    ).toEqual({ ok: false, error: "Judge votes must be at most 5." });
    expect(buildReplayJobRequest(["s"], form((draft) => void (draft.ignorePaths = Array.from({ length: 33 }, (_, i) => `p${i}`).join("\n"))))).toEqual({
      ok: false,
      error: "At most 32 ignore paths."
    });
  });
});

describe("labels", () => {
  it("formats candidates and hashes", () => {
    expect(candidateLabel({ kind: "draft", version: null, workflowHash: "abc" })).toBe("draft");
    expect(candidateLabel({ kind: "version", version: 3, workflowHash: "abc" })).toBe("v3");
    expect(candidateLabel(null)).toBe("—");
    expect(shortHash("sha256:0123456789abcdef")).toBe("01234567");
    expect(shortHash(null)).toBe("");
  });

  it("maps statuses to chip tones", () => {
    expect(statusTone("pass")).toBe("success");
    expect(statusTone("completed")).toBe("success");
    expect(statusTone("fail")).toBe("error");
    expect(statusTone("error")).toBe("partial");
    expect(statusTone("running")).toBe("running");
    expect(statusTone("canceled")).toBe("skipped");
    expect(caseStatusLabel("error")).toBe("inconclusive");
    expect(caseStatusLabel("pass")).toBe("pass");
  });

  it("formats money and parses ignore paths", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(parseIgnorePaths("a\r\n b \n")).toEqual(["a", "b"]);
  });

  it("counts from the summary once finished, else from progress", () => {
    const progress = { total: 4, done: 2, running: 1, pass: 1, fail: 1, error: 0, skipped: 0, spentUsd: 0.2, updatedAt: "" };
    expect(jobCounts({ summary: null, progress })).toMatchObject({ total: 4, done: 2, running: 1, pass: 1, fail: 1, spentUsd: 0.2 });
    const summary = { total: 4, pass: 3, fail: 1, error: 0, skipped: 0, passRate: 0.75, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 0, avgDurationMs: 0, costUsd: 0.3 };
    expect(jobCounts({ summary, progress })).toMatchObject({ total: 4, done: 4, running: 0, pass: 3, spentUsd: 0.3 });
  });
});
