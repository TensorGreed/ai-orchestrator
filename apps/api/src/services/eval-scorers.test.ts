/**
 * Phase 15.2 — the scorer library: every scorer returns pass, a score and a
 * readable reason; the comparing ones use the golden run's facts.
 */
import { describe, expect, it } from "vitest";
import { evalScorerSpecSchema, type EvalScorerSpec, type RunFactGuardVerdict, type RunFactToolCall, type RunFacts } from "@ai-orchestrator/shared";
import { applyScorer, type EvalLlmJudge, type ScorerContext } from "./eval-scorers.js";

function call(tool: string, args: Record<string, unknown> = {}, server = "srv"): RunFactToolCall {
  return { nodeId: "agent", iteration: 0, server, tool, args, argsHash: JSON.stringify(args), outcome: "ok", durationMs: 1 };
}

function block(detectorId: string, action = "block", shadow = false): RunFactGuardVerdict {
  return { nodeId: "agent", placement: "input", channel: "prompt", detectorId, effectiveAction: action, shadow };
}

function facts(overrides: Omit<Partial<RunFacts>, "totals"> & { totals?: Partial<RunFacts["totals"]> } = {}): RunFacts {
  const { totals, ...rest } = overrides;
  return {
    status: "success",
    error: null,
    output: { answer: "The capital of France is Paris." },
    nodes: [],
    toolCalls: [],
    modelCalls: [],
    guard: [],
    ...rest,
    totals: { inputTokens: 80, outputTokens: 20, totalTokens: 100, costUsd: 0.01, durationMs: 1000, modelCalls: 1, toolCalls: 0, ...totals }
  };
}

function ctx(overrides: Partial<ScorerContext> = {}): ScorerContext {
  const baseline = facts();
  return { output: baseline.output, expected: undefined, fixtureInput: { q: "capital of France?" }, baseline, candidate: facts(), ...overrides };
}

const run = (spec: EvalScorerSpec, context: ScorerContext) => applyScorer(evalScorerSpecSchema.parse(spec), context);

describe("json_equal", () => {
  it("passes on equal output and lists the paths that differ", async () => {
    expect(await run({ type: "json_equal" }, ctx())).toMatchObject({ pass: true, score: 1, reason: "matches the golden run" });
    const changed = await run({ type: "json_equal" }, ctx({ output: { answer: "Lyon", extra: 1 } }));
    expect(changed.pass).toBe(false);
    expect(changed.score).toBe(0);
    expect(changed.reason).toContain("2 paths");
    expect(changed.reason).toContain("answer changed");
    expect(changed.reason).toContain("extra added");
  });

  it("honours ignore paths, a number tolerance, array order and the expected value", async () => {
    const baseline = facts({ output: { id: "a1", total: 10, tags: ["x", "y"] } });
    const output = { id: "b2", total: 10.004, tags: ["y", "x"] };
    expect((await run({ type: "json_equal" }, ctx({ baseline, output }))).pass).toBe(false);
    const relaxed = await run({ type: "json_equal", ignorePaths: ["id"], numberTolerance: 0.01, ignoreArrayOrder: true }, ctx({ baseline, output }));
    expect(relaxed).toMatchObject({ pass: true, score: 1 });
    expect(relaxed.reason).toContain("1 ignored difference");
    // The expected value wins over the golden run unless `against: baseline`.
    expect((await run({ type: "json_equal", path: "id" }, ctx({ baseline, output, expected: { id: "b2" } }))).pass).toBe(true);
    expect((await run({ type: "json_equal", path: "id", against: "baseline" }, ctx({ baseline, output, expected: { id: "b2" } }))).pass).toBe(false);
  });

  it("fails clearly with nothing to compare with", async () => {
    expect(await run({ type: "json_equal" }, ctx({ baseline: null }))).toMatchObject({ pass: false, score: 0, reason: expect.stringContaining("no `expected`") });
  });
});

describe("json_schema", () => {
  const schema = { type: "object", required: ["answer"], properties: { answer: { type: "string", minLength: 3 } } };
  it("validates the output at a path", async () => {
    expect(await run({ type: "json_schema", schema }, ctx())).toMatchObject({ pass: true, score: 1 });
    const bad = await run({ type: "json_schema", schema }, ctx({ output: { answer: 4 } }));
    expect(bad.pass).toBe(false);
    expect(bad.reason).toContain("/answer");
    expect((await run({ type: "json_schema", path: "missing", schema }, ctx())).reason).toContain("no output at 'missing'");
  });

  it("reports a schema that cannot compile", async () => {
    expect((await run({ type: "json_schema", schema: { type: "nope" } }, ctx())).reason).toContain("could not be compiled");
  });
});

describe("text_similarity", () => {
  it("scores word overlap against the golden run", async () => {
    const same = await run({ type: "text_similarity", path: "answer" }, ctx());
    expect(same).toMatchObject({ pass: true, score: 1 });
    const close = await run({ type: "text_similarity", path: "answer", threshold: 0.5 }, ctx({ output: { answer: "The capital of France is Paris!" } }));
    expect(close.pass).toBe(true);
    const far = await run({ type: "text_similarity", path: "answer" }, ctx({ output: { answer: "I do not know." } }));
    expect(far.pass).toBe(false);
    expect(far.score).toBeLessThan(0.3);
    expect(far.reason).toContain("threshold 0.8");
  });
});

describe("tool_sequence", () => {
  const baseline = facts({ toolCalls: [call("search", { q: "a" }), call("fetch", { id: 1 }), call("summarise")] });

  it("exact: same calls in the same order", async () => {
    expect(await run({ type: "tool_sequence" }, ctx({ baseline, candidate: facts({ toolCalls: baseline.toolCalls }) }))).toMatchObject({ pass: true, score: 1 });
    const reordered = await run({ type: "tool_sequence" }, ctx({ baseline, candidate: facts({ toolCalls: [call("fetch", { id: 1 }), call("search", { q: "a" }), call("summarise")] }) }));
    expect(reordered.pass).toBe(false);
    expect(reordered.reason).toContain("(exact)");
    const extra = await run({ type: "tool_sequence" }, ctx({ baseline, candidate: facts({ toolCalls: [...baseline.toolCalls, call("search")] }) }));
    expect(extra.pass).toBe(false);
    expect(extra.score).toBe(0.75);
  });

  it("subsequence allows extra calls; args modes check arguments", async () => {
    const candidate = facts({ toolCalls: [call("search", { q: "b" }), call("log"), call("fetch", { id: 1 }), call("summarise")] });
    expect((await run({ type: "tool_sequence", mode: "subsequence" }, ctx({ baseline, candidate }))).pass).toBe(true);
    expect((await run({ type: "tool_sequence", mode: "subsequence", args: "keys" }, ctx({ baseline, candidate }))).pass).toBe(true);
    const exactArgs = await run({ type: "tool_sequence", mode: "subsequence", args: "exact" }, ctx({ baseline, candidate }));
    expect(exactArgs.pass).toBe(false);
    expect(exactArgs.reason).toContain("missing srv/search with matching args");
  });

  it("set and superset_allowed compare which tools were called", async () => {
    const candidate = facts({ toolCalls: [call("summarise"), call("fetch"), call("search"), call("search")] });
    expect((await run({ type: "tool_sequence", mode: "set" }, ctx({ baseline, candidate }))).pass).toBe(true);
    const more = facts({ toolCalls: [...candidate.toolCalls, call("delete")] });
    const set = await run({ type: "tool_sequence", mode: "set" }, ctx({ baseline, candidate: more }));
    expect(set.pass).toBe(false);
    expect(set.reason).toContain("new srv/delete");
    expect((await run({ type: "tool_sequence", mode: "superset_allowed" }, ctx({ baseline, candidate: more }))).pass).toBe(true);
  });

  it("uses a listed sequence and forbidden tools", async () => {
    const candidate = facts({ toolCalls: [call("search", { q: "a" }, "other"), call("fetch")] });
    expect((await run({ type: "tool_sequence", expected: [{ tool: "search" }, { tool: "fetch" }] }, ctx({ baseline: null, candidate }))).pass).toBe(true);
    expect((await run({ type: "tool_sequence", expected: [{ tool: "search", server: "srv" }, { tool: "fetch" }] }, ctx({ baseline: null, candidate }))).pass).toBe(false);
    const forbidden = await run({ type: "tool_sequence", mode: "superset_allowed", forbiddenTools: ["fetch"] }, ctx({ baseline, candidate }));
    expect(forbidden).toMatchObject({ pass: false, score: 0, reason: "called a forbidden tool: srv/fetch" });
    expect((await run({ type: "tool_sequence" }, ctx({ baseline: null, candidate }))).reason).toContain("no golden run");
  });
});

describe("status", () => {
  it("checks the run status", async () => {
    expect(await run({ type: "status" }, ctx())).toMatchObject({ pass: true, reason: "finished with success" });
    const failed = await run({ type: "status" }, ctx({ candidate: facts({ status: "error", error: "boom" }) }));
    expect(failed).toMatchObject({ pass: false, score: 0 });
    expect(failed.reason).toBe("finished with error, expected success: boom");
    expect((await run({ type: "status", expect: "error" }, ctx({ candidate: facts({ status: "error" }) }))).pass).toBe(true);
    expect((await run({ type: "status" }, ctx({ candidate: null }))).pass).toBe(false);
  });
});

describe("no_new_guard_blocks", () => {
  it("fails on a block the golden run did not have, ignoring shadow verdicts", async () => {
    const baseline = facts({ guard: [block("pii")] });
    expect((await run({ type: "no_new_guard_blocks" }, ctx({ baseline, candidate: facts({ guard: [block("pii"), block("x", "block", true), block("y", "allow")] }) }))).pass).toBe(true);
    const added = await run({ type: "no_new_guard_blocks" }, ctx({ baseline, candidate: facts({ guard: [block("pii"), block("injection", "review")] }) }));
    expect(added).toMatchObject({ pass: false, score: 0 });
    expect(added.reason).toBe("1 new guard block: review by injection on prompt at agent");
  });

  it("optionally fails when a block went away", async () => {
    const baseline = facts({ guard: [block("pii")] });
    expect((await run({ type: "no_new_guard_blocks" }, ctx({ baseline, candidate: facts() }))).reason).toContain("1 fewer");
    expect((await run({ type: "no_new_guard_blocks", failOnRemoved: true }, ctx({ baseline, candidate: facts() }))).pass).toBe(false);
  });
});

describe("budget", () => {
  it("checks absolute limits", async () => {
    expect(await run({ type: "budget", maxCostUsd: 0.02, maxTokens: 100, maxLatencyMs: 2000 }, ctx())).toMatchObject({ pass: true, score: 1 });
    const over = await run({ type: "budget", maxCostUsd: 0.005, maxTokens: 100 }, ctx());
    expect(over.pass).toBe(false);
    expect(over.score).toBe(0.5);
    expect(over.reason).toContain("cost $0.0100 > $0.005");
  });

  it("checks increases against the golden run, and fails on unknown cost", async () => {
    const candidate = facts({ totals: { costUsd: 0.013, totalTokens: 110, durationMs: 3000 } });
    const result = await run({ type: "budget", maxCostIncreasePct: 50, maxTokensIncreasePct: 5, maxLatencyIncreasePct: 100 }, ctx({ candidate }));
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("tokens +10.0%");
    expect(result.reason).toContain("latency +200.0%");
    expect(result.reason).not.toContain("cost +30");
    expect((await run({ type: "budget", maxCostUsd: 1 }, ctx({ candidate: facts({ totals: { costUsd: null } }) }))).reason).toContain("cost unknown");
    expect((await run({ type: "budget", maxCostIncreasePct: 10 }, ctx({ baseline: null }))).reason).toContain("no golden run");
  });

  it("rejects a budget without a limit at the schema", () => {
    expect(evalScorerSpecSchema.safeParse({ type: "budget" }).success).toBe(false);
  });
});

describe("llm_judge", () => {
  const judgeReturning = (...responses: Array<string | { content: string; costUsd?: number }>) => {
    const prompts: string[] = [];
    const calls: Array<Parameters<EvalLlmJudge>[0]> = [];
    const judge: EvalLlmJudge = async (input) => {
      prompts.push(input.prompt);
      calls.push(input);
      const next = responses[Math.min(prompts.length - 1, responses.length - 1)]!;
      return next;
    };
    return { judge, prompts, calls };
  };

  it("absolute: averages votes, counts cost, passes the secret reference and temperature 0", async () => {
    const { judge, calls } = judgeReturning({ content: '{"score": 0.9, "reason": "good"}', costUsd: 0.001 }, { content: '```json\n{"score": 0.7}\n```', costUsd: 0.001 });
    const result = await run({ type: "llm_judge", rubric: "Names the capital", votes: 2, providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: "sec-1" } }, ctx({ llmJudge: judge }));
    expect(result).toMatchObject({ pass: true, score: 0.8, costUsd: 0.002 });
    expect(result.reason).toContain("rubric score 0.800");
    expect(result.reason).toContain("2/2 votes");
    expect(result.reason).toContain("good");
    expect(calls[0]).toMatchObject({ providerId: "openai", model: "gpt-4o-mini", secretRef: { secretId: "sec-1" }, temperature: 0 });
    expect(calls[0]!.prompt).toContain("Names the capital");
    expect(calls[0]!.prompt).toContain("REFERENCE OUTPUT");
  });

  it("fails clearly when the judge answers garbage, and counts partial garbage", async () => {
    const garbage = await run({ type: "llm_judge", rubric: "r" }, ctx({ llmJudge: judgeReturning("I think it is fine").judge }));
    expect(garbage).toMatchObject({ pass: false, score: 0, reason: "the judge's response was not parseable JSON" });
    const partial = await run({ type: "llm_judge", rubric: "r", votes: 3 }, ctx({ llmJudge: judgeReturning('{"score":1}', "nope", '{"score":1}').judge }));
    expect(partial).toMatchObject({ pass: true, score: 1 });
    expect(partial.reason).toContain("2/3 votes, 1 unparseable");
    const thrown = await run({ type: "llm_judge", rubric: "r" }, ctx({ llmJudge: async () => { throw new Error("401 from provider"); } }));
    expect(thrown.reason).toBe("judge call failed: 401 from provider");
    expect((await run({ type: "llm_judge", rubric: "r" }, ctx())).reason).toContain("no LLM judge wired");
  });

  it("pairwise: runs both orders so position bias cancels out", async () => {
    // A judge that always prefers whatever is shown as A.
    const biased = judgeReturning('{"winner":"A"}');
    const result = await run({ type: "llm_judge", rubric: "Better answer", mode: "pairwise" }, ctx({ llmJudge: biased.judge, output: { answer: "Paris" }, random: () => 0.9 }));
    expect(biased.prompts).toHaveLength(2);
    expect(result.score).toBe(0.5);
    expect(result.pass).toBe(true);
    expect(result.reason).toContain("same position in both orders 1 time");
    // Order: random >= 0.5 shows the golden run as A first; the candidate is A in the second prompt.
    expect(biased.prompts[0]).toMatch(/OUTPUT A:\n\{\n {2}"answer": "The capital of France is Paris\."/);
    expect(biased.prompts[1]).toMatch(/OUTPUT A:\n\{\n {2}"answer": "Paris"/);
    const swapped = judgeReturning('{"winner":"A"}');
    await run({ type: "llm_judge", rubric: "Better answer", mode: "pairwise" }, ctx({ llmJudge: swapped.judge, output: { answer: "Paris" }, random: () => 0.1 }));
    expect(swapped.prompts[0]).toMatch(/OUTPUT A:\n\{\n {2}"answer": "Paris"/);
  });

  it("pairwise: a judge that consistently prefers the candidate scores 1, the baseline 0", async () => {
    // Prefers the output containing "Paris." (the golden run).
    const prefersBaseline: EvalLlmJudge = async ({ prompt }) => {
      const a = prompt.split("OUTPUT A:")[1]!.split("OUTPUT B:")[0]!;
      return a.includes("France is Paris.") ? '{"winner":"A"}' : '{"winner":"B"}';
    };
    const lost = await run({ type: "llm_judge", rubric: "r", mode: "pairwise", votes: 2 }, ctx({ llmJudge: prefersBaseline, output: { answer: "dunno" } }));
    expect(lost).toMatchObject({ pass: false, score: 0 });
    const tie = await run({ type: "llm_judge", rubric: "r", mode: "pairwise" }, ctx({ llmJudge: judgeReturning('{"winner":"tie"}').judge }));
    expect(tie).toMatchObject({ pass: true, score: 0.5 });
    expect((await run({ type: "llm_judge", rubric: "r", mode: "pairwise" }, ctx({ baseline: null, llmJudge: prefersBaseline }))).reason).toContain("needs a golden run");
  });
});

describe("legacy scorers through the same entry point", () => {
  it("still run, without a score for the programmatic ones", async () => {
    const result = await run({ type: "contains", path: "answer", needle: "Paris" }, ctx());
    expect(result).toEqual({ type: "contains", path: "answer", pass: true, reason: "contains 'Paris'" });
  });
});
