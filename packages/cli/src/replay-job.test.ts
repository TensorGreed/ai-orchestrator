import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { EvalCaseResult, EvalRunView } from "@ai-orchestrator/shared";
import { EXIT_FAILED, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE, main, type CliIo } from "./main";

type Reply = { status: number; body: unknown };

/** A CLI wired to a fake API that answers each request with the next reply in the list (the last one repeats). */
function io(replies: Reply[], sleep: (ms: number) => Promise<void> = async () => undefined) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const requests: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const cli: CliIo = { stdin: new PassThrough(), stdout, stderr, env: { L2M_API_URL: "http://l2m.test", L2M_API_KEY: "key-1" }, fetch: fetchImpl, sleep };
  return { cli, requests, out: () => out, err: () => err };
}

function job(status: string, counts: { pass?: number; fail?: number; error?: number } = {}, results: Partial<EvalCaseResult>[] = []): EvalRunView & { results: Partial<EvalCaseResult>[] } {
  const pass = counts.pass ?? 0;
  const fail = counts.fail ?? 0;
  const error = counts.error ?? 0;
  const finished = !["queued", "running"].includes(status);
  return {
    id: "run_1",
    kind: "replay",
    datasetId: "ds_1",
    datasetIds: ["ds_1"],
    workflowId: "wf",
    workflowName: "WF",
    status,
    startedAt: "2026-10-23T00:00:00Z",
    completedAt: finished ? "2026-10-23T00:01:00Z" : null,
    triggeredBy: "ci@example.com",
    summary: finished ? { total: pass + fail + error, pass, fail, error, passRate: 0, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 0, avgDurationMs: 0, costUsd: 0.0123 } : null,
    progress: null,
    candidate: { kind: "version", version: 4, workflowHash: "b".repeat(64) },
    options: { mcpMode: "strict", maxCostUsd: 5 },
    error: status === "failed" ? "Stopped after 1 of 3 cases: the job spent $5.0000 of its $5 budget." : null,
    results
  };
}

describe("l2m replay run --set", () => {
  it("starts a job over the sets, polls until it finishes and exits 0 when every case passed", async () => {
    const fake = io([{ status: 202, body: { run: job("queued") } }, { status: 200, body: { run: job("running") } }, { status: 200, body: { run: job("completed", { pass: 3 }) } }]);
    const code = await main(["replay", "run", "--set", "ds_1", "--set", "ds_2", "--version", "4", "--mcp", "lenient", "--ignore-path", "**.id", "--max-cost", "2.5"], fake.cli);
    expect(code, fake.err()).toBe(EXIT_OK);
    expect(fake.requests[0]).toEqual({
      method: "POST",
      url: "http://l2m.test/api/replay/runs",
      body: { datasetIds: ["ds_1", "ds_2"], version: 4, mcpMode: "lenient", ignorePaths: ["**.id"], maxCostUsd: 2.5 },
      auth: "Bearer key-1"
    });
    expect(fake.requests.slice(1).map((request) => `${request.method} ${request.url}`)).toEqual(["GET http://l2m.test/api/replay/runs/run_1", "GET http://l2m.test/api/replay/runs/run_1"]);
    expect(fake.out()).toContain("Replay job run_1 against the version 4 (bbbbbbbbbbbb): PASS (completed)");
    expect(fake.out()).toContain("3 passed, 0 failed, 0 inconclusive of 3; spent $0.0123");
  });

  it("exits 1 on a failed case and lists the failing scorers", async () => {
    const results = [{ id: "r1", fixtureName: "Golden 2", status: "fail", score: { pass: false, details: [{ type: "json_equal", pass: false, reason: "differs from the golden run at 1 path: answer changed" }] }, error: null }];
    const fake = io([{ status: 202, body: { run: job("completed", { pass: 2, fail: 1 }, results) } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], fake.cli)).toBe(EXIT_FAILED);
    expect(fake.requests[0]!.body).toEqual({ datasetIds: ["ds_1"], draft: true });
    expect(fake.out()).toContain("FAIL");
    expect(fake.out()).toContain("fail Golden 2");
    expect(fake.out()).toContain("- json_equal: differs from the golden run at 1 path: answer changed");
  });

  it("exits 4 when a case is inconclusive, the job did not complete, or it outlives --timeout", async () => {
    expect(await main(["replay", "run", "--set", "ds_1"], io([{ status: 202, body: { run: job("completed", { pass: 2, error: 1 }) } }]).cli)).toBe(EXIT_INCOMPLETE);
    const overBudget = io([{ status: 202, body: { run: job("failed", { pass: 1 }) } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], overBudget.cli)).toBe(EXIT_INCOMPLETE);
    expect(overBudget.out()).toContain("budget");
    expect(await main(["replay", "run", "--set", "ds_1"], io([{ status: 202, body: { run: job("canceled") } }]).cli)).toBe(EXIT_INCOMPLETE);
    const slow = io([{ status: 202, body: { run: job("running") } }], () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(await main(["replay", "run", "--set", "ds_1", "--timeout", "0.05"], slow.cli)).toBe(EXIT_INCOMPLETE);
    expect(slow.err()).toContain("still running after 0.05 s");
    const unreachable = io([{ status: 503, body: { error: "down" } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], unreachable.cli)).toBe(EXIT_INCOMPLETE);
    expect(await main(["replay", "run", "--set", "ds_1"], io([{ status: 202, body: { nope: true } }]).cli)).toBe(EXIT_INCOMPLETE);
  });

  it("treats bad flags and API refusals as usage errors", async () => {
    expect(await main(["replay", "run", "--set", "ds_1", "--recording", "rec_1"], io([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["replay", "run", "--set", "ds_1", "--max-cost", "0"], io([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["replay", "run", "--set", "ds_1", "--timeout", "soon"], io([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["replay", "run", "--set", "ds_1", "--draft", "--version", "2"], io([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["replay", "run", "--set", "ds_1"], io([{ status: 400, body: { error: "These golden sets hold no golden runs to replay." } }]).cli)).toBe(EXIT_USAGE);
  });

  it("exits 4 when a poll cannot reach the API or is refused with 403, never 2", async () => {
    let calls = 0;
    const flaky = io([{ status: 202, body: { run: job("queued") } }]);
    const base = flaky.cli.fetch!;
    flaky.cli.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) throw new Error("connect ECONNREFUSED");
      return base(input, init);
    }) as typeof fetch;
    expect(await main(["replay", "run", "--set", "ds_1"], flaky.cli)).toBe(EXIT_INCOMPLETE);
    expect(flaky.err()).toContain("Cannot reach http://l2m.test");
    const refused = io([{ status: 202, body: { run: job("queued") } }, { status: 403, body: { error: "Insufficient permissions" } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], refused.cli)).toBe(EXIT_INCOMPLETE);
    expect(refused.err()).toContain("403");
  });

  it("drops control characters from server text and says when the spend is a lower bound", async () => {
    const results = [{ id: "r1", fixtureName: "Golden\u001b[31m 2", status: "fail", score: { pass: false, details: [{ type: "llm_judge", pass: false, reason: "bad\r\u001b[2Kfaked PASS" }] }, error: null }];
    const run = job("completed", { pass: 1, fail: 1 }, results);
    run.summary = { ...run.summary!, costUnknown: true, warnings: ["Some calls have no price\u0007"] };
    const fake = io([{ status: 202, body: { run } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], fake.cli)).toBe(EXIT_FAILED);
    expect(fake.out()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(fake.out()).toContain("fail Golden[31m 2");
    expect(fake.out()).toContain("- llm_judge: bad[2Kfaked PASS");
    expect(fake.out()).toContain("or more (some calls are unpriced)");
    expect(fake.out()).toContain("warning: Some calls have no price");
  });

  it("prints the job as JSON with the exit code", async () => {
    const fake = io([{ status: 202, body: { run: job("completed", { pass: 1 }) } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--json"], fake.cli)).toBe(EXIT_OK);
    expect(JSON.parse(fake.out())).toMatchObject({ id: "run_1", status: "completed", exitCode: 0 });
  });
});

describe("an enforced release gate in the job output", () => {
  const results: Partial<EvalCaseResult>[] = [
    { id: "r1", fixtureId: "f1", fixtureName: "Refund", status: "fail", score: { pass: false, details: [{ type: "status", pass: false, reason: "different" }] } },
    { id: "r2", fixtureId: "f2", fixtureName: "Lookup", status: "pass" },
    { id: "r3", fixtureId: "f3", fixtureName: "Easy", status: "error", error: "cassette miss" }
  ];
  const gated = () => ({
    ...job("completed", { pass: 1, fail: 1, error: 1 }, results),
    releaseGate: { enforced: true, admittedFixtureIds: ["f1", "f2"], pendingFixtureIds: ["f3"], requiredFixtureIds: ["f1"], errorsCountAsFailures: true }
  });

  it("prints admitted, pending and required counts and the failing required case; the exit code stays the job's", async () => {
    const fake = io([{ status: 200, body: { run: gated() } }]);
    const code = await main(["replay", "status", "run_1"], fake.cli);
    expect(code).toBe(EXIT_FAILED);
    expect(fake.out()).toContain("enforced release gate: 2 admitted, 1 pending admission (they run but do not count yet), 1 required");
    expect(fake.out()).toContain('required case "Refund" failed: it blocks a publish whatever the pass rate');
    expect(fake.out()).toContain("fail Refund (required)");
    expect(fake.out()).toContain("error Easy (pending admission, not counted): cassette miss");
  });

  it("follows the gate's verdict on the case results when the server judged them: a failing pending case does not fail the run", async () => {
    const passing = { ...gated(), releaseGate: { ...gated().releaseGate, requiredFixtureIds: [], verdict: "passed", reasons: [] } };
    const fake = io([{ status: 200, body: { run: passing } }]);
    expect(await main(["replay", "status", "run_1"], fake.cli)).toBe(EXIT_OK);
    expect(fake.out()).toContain("the release gate accepts these results");
  });

  it("exits 1 when the gate blocks although every case the job ran passed, and lists why", async () => {
    const allPass = results.slice(1, 2);
    const blocked = {
      ...job("completed", { pass: 1 }, allPass),
      releaseGate: {
        enforced: true,
        admittedFixtureIds: ["f1", "f2"],
        pendingFixtureIds: [],
        requiredFixtureIds: ["f1"],
        requiredCaseNames: { f1: "Refund" },
        errorsCountAsFailures: false,
        verdict: "blocked",
        reasons: ['Required case "Refund" did not run: a required case must pass whatever the pass rate.']
      }
    };
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-junit-"));
    try {
      const file = path.join(dir, "out.xml");
      const fake = io([{ status: 200, body: { run: blocked } }]);
      expect(await main(["replay", "status", "run_1", "--junit", file], fake.cli)).toBe(EXIT_FAILED);
      expect(fake.out()).toContain('required case "Refund" did not run');
      expect(fake.out()).toContain("the release gate blocks these results:");
      const xml = fs.readFileSync(file, "utf8");
      // The required case has no result at all: it still shows as a failing test case.
      expect(xml).toContain('<testcase classname="l2m.replay.wf" name="Refund" time="0.000">');
      expect(xml).toContain('type="required_case">required case did not run</failure>');
      expect(xml).toContain('<property name="gateVerdict" value="blocked"/>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an inconclusive required case fails whatever errorsCountAsFailures says", async () => {
    const erroring = {
      ...job("completed", { pass: 1, error: 1 }, [{ id: "r1", fixtureId: "f1", fixtureName: "Refund", status: "error", error: "model tape miss" }, results[1]!]),
      releaseGate: { enforced: true, admittedFixtureIds: ["f1", "f2"], pendingFixtureIds: [], requiredFixtureIds: ["f1"], errorsCountAsFailures: false }
    };
    const fake = io([{ status: 200, body: { run: erroring } }]);
    await main(["replay", "status", "run_1"], fake.cli);
    expect(fake.out()).toContain('required case "Refund" was inconclusive: it blocks a publish whatever the pass rate');
  });

  it("for a job over the gate's sets and another set, a failing or inconclusive case outside the gate still fails or is inconclusive", async () => {
    const outsideFail: Partial<EvalCaseResult> = { id: "r9", fixtureId: "x1", fixtureName: "Other set", status: "fail" };
    const outsideError: Partial<EvalCaseResult> = { id: "r10", fixtureId: "x2", fixtureName: "Other set too", status: "error", error: "tape miss" };
    const gate = { enforced: true, admittedFixtureIds: ["f2"], pendingFixtureIds: [], requiredFixtureIds: [], errorsCountAsFailures: true, verdict: "passed", reasons: [] };
    const run = (extra: Partial<EvalCaseResult>[], counts: { pass?: number; fail?: number; error?: number }) => ({
      ...job("completed", counts, [results[1]!, ...extra]),
      datasetIds: ["ds_1", "ds_2"],
      releaseGate: gate
    });
    const failing = io([{ status: 200, body: { run: run([outsideFail], { pass: 1, fail: 1 }) } }]);
    expect(await main(["replay", "status", "run_1"], failing.cli)).toBe(EXIT_FAILED);
    const inconclusive = io([{ status: 200, body: { run: run([outsideError], { pass: 1, error: 1 }) } }]);
    expect(await main(["replay", "status", "run_1"], inconclusive.cli)).toBe(EXIT_INCOMPLETE);
    const clean = io([{ status: 200, body: { run: run([{ id: "r11", fixtureId: "x3", fixtureName: "Other ok", status: "pass" }], { pass: 2 }) } }]);
    expect(await main(["replay", "status", "run_1"], clean.cli)).toBe(EXIT_OK);
    // A blocking gate fails the step whatever the other sets did.
    const blocked = io([{ status: 200, body: { run: { ...run([outsideError], { pass: 1, error: 1 }), releaseGate: { ...gate, verdict: "blocked", reasons: ["Pass rate 0% is below the required 90%."] } } } }]);
    expect(await main(["replay", "status", "run_1"], blocked.cli)).toBe(EXIT_FAILED);
  });

  it("says publishing may still refuse the job when the gate's sets changed after it was queued", async () => {
    const passing = { ...gated(), releaseGate: { ...gated().releaseGate, requiredFixtureIds: [], verdict: "passed", reasons: [], setsChanged: true } };
    const fake = io([{ status: 200, body: { run: passing } }]);
    expect(await main(["replay", "status", "run_1"], fake.cli)).toBe(EXIT_OK);
    expect(fake.out()).toContain("the release gate accepts these results");
    expect(fake.out()).toContain("publishing may still refuse it (`l2m release publish` decides)");
  });

  it("says nothing about a gate when the job ran over no enforced gate's sets", async () => {
    const fake = io([{ status: 200, body: { run: job("completed", { pass: 1, fail: 1 }, results.slice(0, 2)) } }]);
    await main(["replay", "status", "run_1"], fake.cli);
    expect(fake.out()).not.toContain("release gate");
    expect(fake.out()).not.toContain("required");
  });

  it("marks the failing required case in JUnit and carries the counts", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-junit-"));
    try {
      const file = path.join(dir, "out.xml");
      const fake = io([{ status: 200, body: { run: gated() } }]);
      await main(["replay", "status", "run_1", "--junit", file], fake.cli);
      const xml = fs.readFileSync(file, "utf8");
      expect(xml).toContain('<failure message="required case: blocks a publish whatever the pass rate: status: different" type="required_case">');
      expect(xml).toContain('message="pending admission, not counted by the release gate: cassette miss"');
      expect(xml).toContain('<property name="gateAdmittedCases" value="2"/>');
      expect(xml).toContain('<property name="gateRequiredFailing" value="1"/>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
