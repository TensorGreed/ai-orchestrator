import { describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import {
  buildReplayJobRequest,
  candidateLabel,
  caseStatusLabel,
  comparisonLabel,
  emptyReplayJobForm,
  formatSpend,
  formatUsd,
  jobCounts,
  jobWarnings,
  modelNodesOf,
  overrideLines,
  parseCandidateFile,
  parseIgnorePaths,
  readNodesOf,
  releaseProofLine,
  shortHash,
  statusTone,
  type ReplayJobForm
} from "./replay-jobs";

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
    expect(jobCounts({ summary, progress })).toMatchObject({ total: 4, done: 4, running: 0, pass: 3, spentUsd: 0.3, costUnknown: false });
  });

  it("marks a spend with unpriced calls as a lower bound and surfaces the warning", () => {
    const progress = { total: 2, done: 1, running: 1, pass: 1, fail: 0, error: 0, skipped: 0, spentUsd: 0.2, costUnknown: true, updatedAt: "" };
    const live = jobCounts({ summary: null, progress });
    expect(live.costUnknown).toBe(true);
    expect(formatSpend(live)).toBe(`${formatUsd(0.2)}+`);
    expect(jobWarnings({ summary: null, progress })[0]).toContain("no price");
    const summary = { total: 2, pass: 2, fail: 0, error: 0, passRate: 1, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 0, avgDurationMs: 0, costUsd: 0.3, costUnknown: true, warnings: ["W"] };
    expect(jobWarnings({ summary, progress })).toEqual(["W"]);
    expect(formatSpend(jobCounts({ summary, progress: null }))).toBe(`${formatUsd(0.3)}+`);
    expect(jobWarnings({ summary: { ...summary, warnings: undefined }, progress: null })).toEqual([]);
  });
});

describe("replay candidates (Phase 15.3)", () => {
  const workflow = {
    id: "wf",
    name: "W",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "agent_1", type: "agent_orchestrator", name: "Agent", position: { x: 0, y: 0 }, config: {} },
      { id: "model", type: "llm_call", name: "Model", position: { x: 0, y: 0 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini" } } },
      { id: "summary", type: "llm_call", name: "Summary", position: { x: 0, y: 0 }, config: { provider: { providerId: "anthropic", model: "claude-haiku" } } },
      { id: "sheet", type: "google_sheets_read", name: "Sheet", position: { x: 0, y: 0 }, config: {} },
      { id: "slack", type: "slack_send_message", name: "Slack", position: { x: 0, y: 0 }, config: {} }
    ],
    edges: [{ id: "e", source: "agent_1", sourceHandle: "chat_model", target: "model" }]
  } as Workflow;

  it("lists the nodes a candidate can change: models through their agent, reads only for live reads", () => {
    expect(modelNodesOf(workflow)).toEqual([
      { id: "agent_1", name: "Agent", providerId: "openai", model: "gpt-4o-mini" },
      { id: "summary", name: "Summary", providerId: "anthropic", model: "claude-haiku" }
    ]);
    expect(readNodesOf(workflow)).toEqual([{ id: "sheet", name: "Sheet" }]);
  });

  it("builds overrides, the comparison and repeats; leaves defaults out", () => {
    const result = buildReplayJobRequest(
      ["set_1"],
      form((draft) => {
        draft.modelOverrides = [
          { nodeId: "agent_1", provider: "", model: " gpt-5-mini " },
          { nodeId: "", provider: "anthropic", model: "claude-sonnet" },
          { nodeId: "", provider: "", model: "" }
        ];
        draft.guardProfileId = "strict";
        draft.mcpServers = { srv: "live_read_only" };
        draft.liveReadNodes = ["sheet", "sheet"];
        draft.models = "replay";
        draft.compare = "baseline_rerun";
        draft.repeats = "3";
        draft.aggregate = "any";
      })
    );
    expect(result).toEqual({
      ok: true,
      request: {
        datasetIds: ["set_1"],
        draft: true,
        overrides: {
          models: [
            { nodeId: "agent_1", model: "gpt-5-mini" },
            { provider: "anthropic", model: "claude-sonnet" }
          ],
          guardProfile: { profileId: "strict" },
          mcpServers: { srv: "live_read_only" },
          liveReadNodes: ["sheet"]
        },
        models: "replay",
        compare: "baseline_rerun",
        repeats: 3,
        aggregate: "any",
        mcpMode: "strict"
      }
    });
    // One repeat sends no aggregate.
    expect(buildReplayJobRequest(["set_1"], form((draft) => void (draft.aggregate = "any")))).toEqual({ ok: true, request: { datasetIds: ["set_1"], draft: true, mcpMode: "strict" } });
  });

  it("rejects incomplete overrides, bad repeats and a missing file", () => {
    const error = (patch: (draft: ReplayJobForm) => void) => {
      const result = buildReplayJobRequest(["set_1"], form(patch));
      return result.ok ? null : result.error;
    };
    expect(error((draft) => void (draft.modelOverrides = [{ nodeId: "agent_1", provider: "", model: "" }]))).toMatch(/needs a model/);
    expect(error((draft) => void (draft.modelOverrides = [{ nodeId: "", provider: "", model: "x" }]))).toMatch(/node or a provider/);
    expect(error((draft) => void (draft.repeats = "6"))).toMatch(/at most 5/);
    expect(error((draft) => void (draft.repeats = "1.5"))).toMatch(/whole number/);
    expect(error((draft) => void (draft.guardProfileVersion = "2"))).toMatch(/Pick a guard profile/);
    expect(error((draft) => void (draft.candidate = "file"))).toMatch(/Choose a workflow file/);
  });

  it("reads a workflow file or an export holding one, for this workflow only", () => {
    const text = JSON.stringify(workflow);
    expect(parseCandidateFile("w.json", text, "wf")).toMatchObject({ ok: true, file: { name: "w.json", workflow: { id: "wf" } } });
    expect(parseCandidateFile("e.json", JSON.stringify({ workflow }), "wf")).toMatchObject({ ok: true, file: { workflow: { id: "wf" } } });
    expect(parseCandidateFile("w.json", text, "other")).toMatchObject({ ok: false, error: expect.stringContaining("is for workflow wf") });
    expect(parseCandidateFile("x.json", "{", "wf")).toMatchObject({ ok: false, error: "x.json is not JSON." });
    expect(parseCandidateFile("x.json", "{}", "wf")).toMatchObject({ ok: false, error: "x.json is not a workflow file." });
    const built = buildReplayJobRequest(["s"], form((draft) => {
      draft.candidate = "file";
      draft.candidateFile = { name: "w.json", workflow: workflow as unknown as Record<string, unknown> };
    }));
    expect(built.ok && built.request.workflow).toEqual(workflow);
    expect(built.ok && "draft" in built.request).toBe(false);
  });

  it("labels inline candidates, overrides and the comparison", () => {
    expect(candidateLabel({ kind: "inline", version: null, workflowHash: "h", name: "v2.json" })).toBe("file: v2.json");
    expect(
      overrideLines({
        kind: "draft",
        version: null,
        workflowHash: "h",
        overrides: { models: [{ provider: "openai", model: "gpt-5" }, { nodeId: "n", provider: "anthropic", model: "c" }], guardProfile: { profileId: "p" }, mcpServers: { s: "live_read_only" }, liveReadNodes: ["a", "b"] }
      })
    ).toEqual(["Model for every openai node: gpt-5", "Model on n: anthropic/c", "Guard profile p (latest)", "MCP s: live reads only", "Live reads: a, b"]);
    expect(overrideLines({ kind: "draft", version: null, workflowHash: "h" })).toEqual([]);
    expect(comparisonLabel({ mcpMode: "strict", maxCostUsd: 5 })).toBe("live models · vs recording");
  });

  it("offers only allow-listed reads for live reads: never triggers, browsers or non-GET requests", () => {
    const reads = {
      ...workflow,
      nodes: [
        ...workflow.nodes,
        { id: "redis", type: "redis_trigger", name: "Queue", position: { x: 0, y: 0 }, config: {} },
        { id: "pg", type: "postgres_trigger", name: "Poll", position: { x: 0, y: 0 }, config: {} },
        { id: "browse", type: "web_browse", name: "Browse", position: { x: 0, y: 0 }, config: {} },
        { id: "pdf", type: "pdf_output", name: "PDF", position: { x: 0, y: 0 }, config: { renderMode: "html" } },
        { id: "post", type: "http_request", name: "Post", position: { x: 0, y: 0 }, config: { method: "POST" } },
        { id: "get", type: "http_request", name: "Get", position: { x: 0, y: 0 }, config: { method: "GET" } }
      ]
    } as Workflow;
    expect(readNodesOf(reads)).toEqual([
      { id: "sheet", name: "Sheet" },
      { id: "get", name: "Get" }
    ]);
  });

  it("sends a model override's secret by reference", () => {
    const result = buildReplayJobRequest(
      ["set_1"],
      form((draft) => {
        draft.modelOverrides = [{ nodeId: "model", provider: "anthropic", model: "claude-sonnet", secretId: "sec_1" }];
      })
    );
    expect(result.ok && result.request.overrides?.models).toEqual([{ nodeId: "model", provider: "anthropic", model: "claude-sonnet", secretRef: { secretId: "sec_1" } }]);
  });

  it("says whether a job is release proof, and why not", () => {
    expect(releaseProofLine(null)).toBeNull();
    expect(releaseProofLine({ kind: "draft", version: null, workflowHash: "h", releaseEligible: true, releaseIneligibleReasons: [] })).toEqual({ eligible: true, text: "Counts as release proof for this hash.", reasons: [] });
    expect(releaseProofLine({ kind: "draft", version: null, workflowHash: "h", releaseEligible: false, releaseIneligibleReasons: ["Lenient"] })).toMatchObject({ eligible: false, reasons: ["Lenient"] });
    // Jobs from before the field: not proof.
    expect(releaseProofLine({ kind: "draft", version: null, workflowHash: "h" })!.eligible).toBe(false);
  });
});
