import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "./db/database.js";
import { EvalService, __test__, type EvalLlmJudge, type ScorerSpec } from "./services/eval-service.js";

const { scoreContextPrecision, scoreContextRecall, parseJudgeJson, extractDocuments } = __test__;

describe("Phase 9.5 — RAG-specific eval scorers", () => {
  describe("scoreContextPrecision (programmatic)", () => {
    it("returns 1 when every chunk overlaps the expected answer", () => {
      const docs = [
        { text: "Reset password by clicking recovery link sent via email" },
        { text: "Password recovery email arrives within five minutes" }
      ];
      const score = scoreContextPrecision(docs, "reset password recovery email", 0.3);
      expect(score).toBeCloseTo(1, 6);
    });

    it("drops to 0.5 when half the chunks are off-topic", () => {
      const docs = [
        { text: "Reset password recovery via email link" },
        { text: "We accept Visa Mastercard ACH payments" }
      ];
      const score = scoreContextPrecision(docs, "reset password recovery", 0.3);
      expect(score).toBeCloseTo(0.5, 6);
    });

    it("returns 0 when no chunks are relevant", () => {
      const docs = [
        { text: "We accept Visa Mastercard ACH payments" },
        { text: "Office hours weekdays nine to five Pacific" }
      ];
      const score = scoreContextPrecision(docs, "reset password", 0.3);
      expect(score).toBe(0);
    });

    it("ignores stopwords so 'is the' doesn't trick precision", () => {
      const docs = [
        { text: "the office is open from nine to five on weekdays" }
      ];
      // Expected has only stopwords + already-filtered short tokens — no
      // meaningful overlap; chunk should not count as relevant.
      const score = scoreContextPrecision(docs, "the is on", 0.3);
      expect(score).toBe(0);
    });
  });

  describe("scoreContextRecall (programmatic)", () => {
    it("returns 1 when every expected token appears somewhere in context", () => {
      const docs = [
        { text: "Password recovery uses email verification" },
        { text: "Reset link arrives within five minutes" }
      ];
      // Expected: "reset password recovery email" — every meaningful token
      // appears in some chunk.
      const score = scoreContextRecall(docs, "reset password recovery email");
      expect(score).toBeCloseTo(1, 6);
    });

    it("drops when context misses some expected tokens", () => {
      const docs = [
        { text: "Reset password by clicking the link" }
      ];
      // "verification" not present
      const score = scoreContextRecall(docs, "reset password verification");
      expect(score).toBeCloseTo(2 / 3, 6);
    });

    it("returns 1 for empty expected (vacuous recall)", () => {
      const score = scoreContextRecall([{ text: "anything" }], "");
      expect(score).toBe(1);
    });
  });

  describe("extractDocuments", () => {
    it("handles the rag_retrieve output shape", () => {
      const out = { documents: [{ text: "alpha", metadata: { sourceId: "s1" } }] };
      expect(extractDocuments(out, "documents")).toHaveLength(1);
    });

    it("handles a string at the path (joined context)", () => {
      const out = { context: "joined context blob" };
      const docs = extractDocuments(out, "context");
      expect(docs).toHaveLength(1);
      expect(docs[0]!.text).toBe("joined context blob");
    });

    it("falls back to output.context when the requested path is empty", () => {
      const out = { context: "fallback" };
      // Default path "documents" doesn't exist; should fall back to .context
      const docs = extractDocuments(out, "documents");
      expect(docs).toHaveLength(1);
    });

    it("returns [] for shapes it can't make sense of", () => {
      expect(extractDocuments({}, "documents")).toEqual([]);
      expect(extractDocuments({ documents: 42 }, "documents")).toEqual([]);
    });
  });

  describe("parseJudgeJson", () => {
    it("parses a clean JSON object", () => {
      const result = parseJudgeJson<{ score: number }>('{"score": 0.85}');
      expect(result).toEqual({ score: 0.85 });
    });

    it("strips ```json fences before parsing", () => {
      const wrapped = '```json\n{"score": 0.7}\n```';
      const result = parseJudgeJson<{ score: number }>(wrapped);
      expect(result).toEqual({ score: 0.7 });
    });

    it("extracts the {...} block when there's surrounding prose", () => {
      const noisy = 'Here is my analysis: {"score": 0.42, "reasoning": "ok"} I hope this helps!';
      const result = parseJudgeJson<{ score: number }>(noisy);
      expect(result?.score).toBe(0.42);
    });

    it("recovers from trailing commas (light cleanup)", () => {
      const raw = '{"score": 0.9, "reasoning": "great",}';
      const result = parseJudgeJson<{ score: number }>(raw);
      expect(result?.score).toBe(0.9);
    });

    it("returns null on garbage input", () => {
      expect(parseJudgeJson("not even close")).toBeNull();
      expect(parseJudgeJson("")).toBeNull();
      expect(parseJudgeJson("{ broken syntax")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: EvalService.startRun with the new scorers
  // ---------------------------------------------------------------------------

  let tempDir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase9-5-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    store.ensureDefaultProject();
  });

  afterEach(() => {
    try { store.close(); } catch { /* may already be closed */ }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs context_precision + context_recall against a stubbed RAG output", async () => {
    // Build a fake workflow output that looks like rag_retrieve + llm_call.
    const fakeExecutor = async () => ({
      output: {
        documents: [
          { text: "Reset your password using the recovery email link", metadata: {} },
          { text: "Password reset emails arrive within five minutes", metadata: {} }
        ],
        answer: "To reset your password, follow the recovery link in the email."
      },
      durationMs: 12
    });
    const svc = new EvalService(store, fakeExecutor);

    // Workflow + dataset + fixture wiring
    store.upsertWorkflow({
      id: "wf",
      name: "wf",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [],
      edges: []
    });
    const dataset = svc.createDataset({ name: "ds" })!;
    svc.addFixture({
      datasetId: dataset.id,
      name: "fix1",
      input: { user_prompt: "how do I reset my password" },
      expected: "Reset your password by clicking the recovery email link"
    });

    const result = await svc.startRun({
      datasetId: dataset.id,
      workflowId: "wf",
      scorers: [
        { type: "context_precision", threshold: 0.5 } as ScorerSpec,
        { type: "context_recall", threshold: 0.5 } as ScorerSpec
      ]
    });

    expect(result.summary.total).toBe(1);
    const run = svc.getRun(result.runId)!;
    const fixtureResult = run.results[0]!;
    const score = fixtureResult.score as { details: Array<{ type: string; pass: boolean; score: number }> };
    expect(score.details).toHaveLength(2);
    const precision = score.details.find((d) => d.type === "context_precision")!;
    const recall = score.details.find((d) => d.type === "context_recall")!;
    expect(precision.pass).toBe(true);
    expect(precision.score).toBeGreaterThan(0);
    expect(recall.pass).toBe(true);
    expect(recall.score).toBeGreaterThan(0);
  });

  it("faithfulness/answer_relevance fail loudly when no judge is wired", async () => {
    const fakeExecutor = async () => ({
      output: { documents: [{ text: "x" }], answer: "y" },
      durationMs: 1
    });
    const svc = new EvalService(store, fakeExecutor); // no judge passed

    store.upsertWorkflow({ id: "wf", name: "wf", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    const dataset = svc.createDataset({ name: "ds2" })!;
    svc.addFixture({ datasetId: dataset.id, name: "f", input: "q", expected: "a" });

    const result = await svc.startRun({
      datasetId: dataset.id,
      workflowId: "wf",
      scorers: [
        { type: "faithfulness" } as ScorerSpec,
        { type: "answer_relevance" } as ScorerSpec
      ]
    });

    const run = svc.getRun(result.runId)!;
    const fixtureResult = run.results[0]!;
    const score = fixtureResult.score as { details: Array<{ type: string; pass: boolean; reason: string }> };
    for (const d of score.details) {
      expect(d.pass).toBe(false);
      expect(d.reason.toLowerCase()).toContain("no llm judge wired");
    }
  });

  it("faithfulness invokes the judge and parses supported/unsupported", async () => {
    let lastPrompt = "";
    const judge: EvalLlmJudge = async ({ prompt }) => {
      lastPrompt = prompt;
      return '{"supported": 3, "unsupported": 1}';
    };
    const fakeExecutor = async () => ({
      output: {
        documents: [{ text: "Password reset uses an email link" }],
        answer: "To reset your password, click the email link. The link expires in 1 hour."
      },
      durationMs: 1
    });
    const svc = new EvalService(store, fakeExecutor, judge);

    store.upsertWorkflow({ id: "wf3", name: "w", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    const dataset = svc.createDataset({ name: "ds3" })!;
    svc.addFixture({ datasetId: dataset.id, name: "f", input: "how to reset", expected: "click email link" });

    const result = await svc.startRun({
      datasetId: dataset.id,
      workflowId: "wf3",
      scorers: [{ type: "faithfulness", threshold: 0.6 } as ScorerSpec]
    });

    const run = svc.getRun(result.runId)!;
    const fixtureResult = run.results[0]!;
    const score = fixtureResult.score as { details: Array<{ type: string; pass: boolean; score: number }> };
    expect(score.details[0]!.pass).toBe(true);
    expect(score.details[0]!.score).toBeCloseTo(0.75, 6); // 3 / (3+1)
    // Prompt should mention both context and answer
    expect(lastPrompt).toContain("Password reset uses an email link");
    expect(lastPrompt).toContain("click the email link");
  });

  it("answer_relevance defaults questionPath to the fixture input", async () => {
    let observedPrompt = "";
    const judge: EvalLlmJudge = async ({ prompt }) => {
      observedPrompt = prompt;
      return '{"score": 0.92, "reasoning": "directly addresses the question"}';
    };
    const fakeExecutor = async () => ({
      output: { answer: "The office is open weekdays from 9am to 5pm Pacific." },
      durationMs: 1
    });
    const svc = new EvalService(store, fakeExecutor, judge);

    store.upsertWorkflow({ id: "wf4", name: "w", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    const dataset = svc.createDataset({ name: "ds4" })!;
    svc.addFixture({
      datasetId: dataset.id,
      name: "f",
      input: "What are your office hours?",
      expected: ""
    });

    const result = await svc.startRun({
      datasetId: dataset.id,
      workflowId: "wf4",
      scorers: [{ type: "answer_relevance", threshold: 0.6 } as ScorerSpec]
    });
    const run = svc.getRun(result.runId)!;
    const score = run.results[0]!.score as { details: Array<{ pass: boolean; score: number; reason: string }> };
    expect(score.details[0]!.pass).toBe(true);
    expect(score.details[0]!.score).toBeCloseTo(0.92, 6);
    expect(observedPrompt).toContain("What are your office hours?");
    expect(observedPrompt).toContain("9am to 5pm");
  });

  it("clamps answer_relevance scores into [0,1] even if the judge misbehaves", async () => {
    const judge: EvalLlmJudge = async () => '{"score": 1.7, "reasoning": "off-spec"}';
    const fakeExecutor = async () => ({ output: { answer: "z" }, durationMs: 1 });
    const svc = new EvalService(store, fakeExecutor, judge);
    store.upsertWorkflow({ id: "wf5", name: "w", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    const dataset = svc.createDataset({ name: "ds5" })!;
    svc.addFixture({ datasetId: dataset.id, name: "f", input: "q", expected: "" });
    const result = await svc.startRun({
      datasetId: dataset.id,
      workflowId: "wf5",
      scorers: [{ type: "answer_relevance" } as ScorerSpec]
    });
    const run = svc.getRun(result.runId)!;
    const score = run.results[0]!.score as { details: Array<{ score: number }> };
    expect(score.details[0]!.score).toBeLessThanOrEqual(1);
    expect(score.details[0]!.score).toBeGreaterThanOrEqual(0);
  });
});
