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

  it("prints the job as JSON with the exit code", async () => {
    const fake = io([{ status: 202, body: { run: job("completed", { pass: 1 }) } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--json"], fake.cli)).toBe(EXIT_OK);
    expect(JSON.parse(fake.out())).toMatchObject({ id: "run_1", status: "completed", exitCode: 0 });
  });
});
