/** Phase 15.5 - the CI commands against a fake API: replay run flags, status, JUnit, release publish and golden-set files. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goldenSetSignedBytes, type EvalCaseResult, type EvalRunView, type GoldenSetFile } from "@ai-orchestrator/shared";
import { EXIT_FAILED, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE, main, type CliIo } from "./main";
import { buildJunit } from "./junit";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function harness(replies: Reply[]) {
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
    if (reply.status === 0) throw new Error("connect ECONNREFUSED");
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
  }) as typeof fetch;
  const cli: CliIo = { stdin: new PassThrough(), stdout, stderr, env: { L2M_API_URL: "http://l2m.test", L2M_API_KEY: "key-1" }, fetch: fetchImpl, sleep: async () => undefined };
  return { cli, requests, out: () => out, err: () => err };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-ci-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
    workflowId: "wf-1",
    workflowName: "Support bot",
    status,
    startedAt: "2026-10-24T08:00:00.000Z",
    completedAt: finished ? "2026-10-24T08:01:00.000Z" : null,
    triggeredBy: "ci@example.com",
    summary: finished ? { total: pass + fail + error, pass, fail, error, passRate: 0, totalTokenInput: 0, totalTokenOutput: 0, totalTokenTotal: 0, totalDurationMs: 0, avgDurationMs: 0, costUsd: 0.5 } : null,
    progress: finished ? null : { total: 3, done: 1, running: 1, pass: 1, fail: 0, error: 0, skipped: 0 },
    candidate: { kind: "inline", workflowHash: "c".repeat(64) } as unknown as EvalRunView["candidate"],
    options: null,
    error: status === "failed" ? "Stopped: over budget." : null,
    results
  } as never;
}

const failingResult = { id: "r2", fixtureId: "fx2", fixtureName: "Refund <case> & \"quote\"", status: "fail", durationMs: 1500, score: { pass: false, details: [{ type: "json_equal", pass: false, reason: "answer changed" }] }, error: null };
const results = [
  { id: "r1", fixtureId: "fx1", fixtureName: "Greeting", status: "pass", durationMs: 250, score: { pass: true, details: [] }, error: null },
  failingResult,
  { id: "r3", fixtureId: "fx3", fixtureName: "Tool outage", status: "error", durationMs: 10, score: null, error: "the golden run for this case was deleted" }
];

describe("l2m replay run --set: the candidate file and overrides", () => {
  it("sends the contract shapes as JSON and gates on the exit code", async () => {
    const workflowFile = path.join(dir, "workflow.json");
    fs.writeFileSync(workflowFile, JSON.stringify({ id: "wf-1", name: "Support bot", nodes: [{ id: "a" }], edges: [] }));
    const fake = harness([{ status: 202, body: { run: job("completed", { pass: 3 }) } }]);
    const code = await main(
      [
        "replay", "run", "--set", "ds_1", "--set", "ds_2", "--file", workflowFile,
        "--model", "agent=gpt-4.1-mini", "--model", "writer=claude-sonnet", "--provider-model", "openai=gpt-4.1",
        "--guard-profile", "strict@3", "--mcp-server", "crm=live_read_only", "--mcp-server", "docs=strict", "--live-read", "lookup,search",
        "--models", "replay", "--compare", "baseline_rerun", "--repeats", "3", "--aggregate", "majority", "--max-cost", "2"
      ],
      fake.cli
    );
    expect(code, fake.err()).toBe(EXIT_OK);
    expect(fake.requests[0]).toEqual({
      method: "POST",
      url: "http://l2m.test/api/replay/runs",
      auth: "Bearer key-1",
      body: {
        datasetIds: ["ds_1", "ds_2"],
        workflow: { id: "wf-1", name: "Support bot", nodes: [{ id: "a" }], edges: [] },
        overrides: {
          models: [{ nodeId: "agent", model: "gpt-4.1-mini" }, { nodeId: "writer", model: "claude-sonnet" }, { provider: "openai", model: "gpt-4.1" }],
          guardProfile: { profileId: "strict", version: 3 },
          mcpServers: { crm: "live_read_only", docs: "strict" },
          liveReadNodes: ["lookup", "search"]
        },
        models: "replay",
        compare: "baseline_rerun",
        repeats: 3,
        aggregate: "majority",
        maxCostUsd: 2
      }
    });
    expect(fake.out()).toContain("against the workflow file (cccccccccccc): PASS");
  });

  it("exits 1 on a regression, 4 when inconclusive, and polls a running job", async () => {
    const regression = harness([{ status: 202, body: { run: job("queued") } }, { status: 200, body: { run: job("running") } }, { status: 200, body: { run: job("completed", { pass: 1, fail: 1 }, [failingResult]) } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], regression.cli)).toBe(EXIT_FAILED);
    expect(regression.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(regression.out()).toContain("- json_equal: answer changed");

    expect(await main(["replay", "run", "--set", "ds_1"], harness([{ status: 202, body: { run: job("completed", { pass: 1, error: 1 }) } }]).cli)).toBe(EXIT_INCOMPLETE);
    const unreachable = harness([{ status: 0 }]);
    expect(await main(["replay", "run", "--set", "ds_1"], unreachable.cli)).toBe(EXIT_INCOMPLETE);
    expect(unreachable.err()).toContain("inconclusive");
    const serverError = harness([{ status: 500, body: { error: "boom" } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], serverError.cli)).toBe(EXIT_INCOMPLETE);
    const notAJob = harness([{ status: 202, body: { nope: true } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], notAJob.cli)).toBe(EXIT_INCOMPLETE);
  });

  it("starts a job and returns with --no-wait", async () => {
    const fake = harness([{ status: 202, body: { run: job("queued") } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--no-wait"], fake.cli)).toBe(EXIT_OK);
    expect(fake.requests).toHaveLength(1);
    expect(fake.out()).toContain("l2m replay status run_1 --wait");
  });

  it("reports a flag the server does not support as a usage error naming it", async () => {
    const fake = harness([
      { status: 400, body: { error: "Invalid replay job", details: [{ code: "unrecognized_keys", keys: ["workflow", "overrides"], path: [], message: "Unrecognized keys" }] } }
    ]);
    const workflowFile = path.join(dir, "w.json");
    fs.writeFileSync(workflowFile, JSON.stringify({ nodes: [] }));
    expect(await main(["replay", "run", "--set", "ds_1", "--file", workflowFile, "--model", "a=b"], fake.cli)).toBe(EXIT_USAGE);
    expect(fake.err()).toContain("does not support: workflow, overrides");
    expect(fake.err()).toContain("Phase 15.3");
    // A plain 400 keeps the API's own text.
    const plain = harness([{ status: 400, body: { error: "Invalid replay job" } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], plain.cli)).toBe(EXIT_USAGE);
    expect(plain.err()).toContain("Invalid replay job");
  });

  it("rejects bad flags before anything is sent", async () => {
    const workflowFile = path.join(dir, "w.json");
    fs.writeFileSync(workflowFile, JSON.stringify({ nodes: [] }));
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    fs.writeFileSync(path.join(dir, "list.json"), "[]");
    const bad: string[][] = [
      ["--model", "no-equals"],
      ["--model", "=gpt"],
      ["--provider-model", "openai="],
      ["--guard-profile", "strict@zero"],
      ["--guard-profile", "@3"],
      ["--mcp-server", "crm=writable"],
      ["--models", "mock"],
      ["--compare", "latest"],
      ["--repeats", "6"],
      ["--repeats", "0"],
      ["--aggregate", "most"],
      ["--max-cost", "free"],
      ["--timeout", "0"],
      ["--file", path.join(dir, "missing.json")],
      ["--file", path.join(dir, "bad.json")],
      ["--file", path.join(dir, "list.json")],
      ["--file", workflowFile, "--version", "2"],
      ["--file", workflowFile, "--draft"],
      ["--junit"]
    ];
    for (const flags of bad) {
      const fake = harness([{ status: 202, body: { run: job("completed", { pass: 1 }) } }]);
      expect(await main(["replay", "run", "--set", "ds_1", ...flags], fake.cli), flags.join(" ")).toBe(EXIT_USAGE);
      expect(fake.requests, flags.join(" ")).toHaveLength(0);
    }
    // Job-only flags make no sense with a single recording.
    const single = harness([{ status: 200, body: {} }]);
    expect(await main(["replay", "run", "--recording", "rec_1", "--repeats", "2"], single.cli)).toBe(EXIT_USAGE);
    expect(await main(["replay", "run", "--recording", "rec_1", "--estimate"], single.cli)).toBe(EXIT_USAGE);
    expect(single.requests).toHaveLength(0);
    // No API key.
    const keyless = harness([]);
    keyless.cli.env = { L2M_API_URL: "http://l2m.test" };
    expect(await main(["replay", "run", "--set", "ds_1"], keyless.cli)).toBe(EXIT_USAGE);
  });
});

describe("l2m replay run --estimate", () => {
  it("calls the estimate route with the same body and does not start a job", async () => {
    const fake = harness([{ status: 200, body: { cases: 12, runsPerCase: 2, modelCallsEstimate: 48, estimatedCostUsd: 0.84, costUnknown: false, warnings: ["2 cases have no model tape"], extra: 1 } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--estimate", "--repeats", "2", "--models", "live"], fake.cli)).toBe(EXIT_OK);
    expect(fake.requests).toEqual([{ method: "POST", url: "http://l2m.test/api/replay/estimate", auth: "Bearer key-1", body: { datasetIds: ["ds_1"], draft: true, models: "live", repeats: 2 } }]);
    expect(fake.out()).toContain("Estimate: 12 cases, 2 runs each, about 48 model calls, about $0.8400");
    expect(fake.out()).toContain("warning: 2 cases have no model tape");
    const json = harness([{ status: 200, body: { cases: 1 } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--estimate", "--json"], json.cli)).toBe(EXIT_OK);
    expect(JSON.parse(json.out())).toEqual({ cases: 1 });
  });

  it("exits 2 on a server without the route, 4 on an unreadable answer or a failed request", async () => {
    const old = harness([{ status: 404, body: { error: "Route POST:/api/replay/estimate not found" } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--estimate"], old.cli)).toBe(EXIT_USAGE);
    expect(old.err()).toContain("Phase 15.3");
    expect(await main(["replay", "run", "--set", "ds_1", "--estimate"], harness([{ status: 200, body: { hello: 1 } }]).cli)).toBe(EXIT_INCOMPLETE);
    expect(await main(["replay", "run", "--set", "ds_1", "--estimate"], harness([{ status: 500, body: { error: "x" } }]).cli)).toBe(EXIT_INCOMPLETE);
    expect(await main(["replay", "run", "--set", "ds_1", "--estimate"], harness([{ status: 400, body: { error: "Invalid" } }]).cli)).toBe(EXIT_USAGE);
  });
});

describe("JUnit output", () => {
  it("writes one test case per golden case", async () => {
    const file = path.join(dir, "report.xml");
    const fake = harness([{ status: 202, body: { run: job("completed", { pass: 1, fail: 1, error: 1 }, results) } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--junit", file], fake.cli)).toBe(EXIT_FAILED);
    expect(fs.readFileSync(file, "utf8")).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <testsuites>
        <testsuite name="l2m replay Support bot" tests="3" failures="1" errors="1" skipped="0" time="1.760" timestamp="2026-10-24T08:00:00.000Z">
          <properties>
            <property name="run" value="run_1"/>
            <property name="status" value="completed"/>
            <property name="candidate" value="inline"/>
            <property name="workflowHash" value="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"/>
          </properties>
          <testcase classname="l2m.replay.wf-1" name="Greeting" time="0.250"/>
          <testcase classname="l2m.replay.wf-1" name="Refund &lt;case&gt; &amp; &quot;quote&quot;" time="1.500">
            <failure message="json_equal: answer changed" type="regression">json_equal: answer changed</failure>
          </testcase>
          <testcase classname="l2m.replay.wf-1" name="Tool outage" time="0.010">
            <error message="the golden run for this case was deleted" type="inconclusive">the golden run for this case was deleted</error>
          </testcase>
        </testsuite>
      </testsuites>
      "
    `);
  });

  it("writes a red report when the job times out, the request fails or the job never completes", async () => {
    const file = path.join(dir, "late.xml");
    const stuck = harness([{ status: 202, body: { run: job("queued") } }, { status: 200, body: { run: job("running") } }]);
    expect(await main(["replay", "run", "--set", "ds_1", "--junit", file, "--timeout", "0.001"], stuck.cli)).toBe(EXIT_INCOMPLETE);
    expect(fs.readFileSync(file, "utf8")).toMatch(/<error message="replay job run_1 is still (queued|running) after 0.001 s/);

    const failed = path.join(dir, "failed.xml");
    expect(await main(["replay", "run", "--set", "ds_1", "--junit", failed], harness([{ status: 202, body: { run: job("failed", { pass: 1 }) } }]).cli)).toBe(EXIT_INCOMPLETE);
    expect(fs.readFileSync(failed, "utf8")).toContain('errors="1"');
    expect(fs.readFileSync(failed, "utf8")).toContain("Stopped: over budget.");

    const down = path.join(dir, "down.xml");
    expect(await main(["replay", "run", "--set", "ds_1", "--junit", down], harness([{ status: 0 }]).cli)).toBe(EXIT_INCOMPLETE);
    expect(fs.readFileSync(down, "utf8")).toContain("Cannot reach http://l2m.test");
  });

  it("escapes markup and control characters in server text", () => {
    const xml = buildJunit({ run: job("completed", { fail: 1 }, [{ ...failingResult, fixtureName: "a\u001b[31m<b>\u0007", score: { pass: false, details: [{ type: "x", pass: false, reason: "]]> & <tag>" }] } }]) as never });
    expect(xml).not.toContain("\u001b");
    expect(xml).not.toContain("<b>");
    expect(xml).toContain("]]&gt; &amp; &lt;tag&gt;");
  });
});

describe("l2m replay status", () => {
  it("reports each outcome as an exit code", async () => {
    const pass = harness([{ status: 200, body: { run: job("completed", { pass: 2 }) } }]);
    expect(await main(["replay", "status", "run_1"], pass.cli)).toBe(EXIT_OK);
    expect(pass.requests[0]).toMatchObject({ method: "GET", url: "http://l2m.test/api/replay/runs/run_1" });
    expect(await main(["replay", "status", "run_1"], harness([{ status: 200, body: { run: job("completed", { pass: 1, fail: 1 }, [failingResult]) } }]).cli)).toBe(EXIT_FAILED);
    expect(await main(["replay", "status", "run_1"], harness([{ status: 200, body: { run: job("canceled", { pass: 1 }) } }]).cli)).toBe(EXIT_INCOMPLETE);
    const running = harness([{ status: 200, body: { run: job("running") } }]);
    expect(await main(["replay", "status", "run_1"], running.cli)).toBe(EXIT_INCOMPLETE);
    expect(running.out()).toContain("is running (1 of 3 cases done)");
    expect(await main(["replay", "status", "run_x"], harness([{ status: 404, body: { error: "Replay job not found" } }]).cli)).toBe(EXIT_INCOMPLETE);
  });

  it("waits for a running job and writes JUnit", async () => {
    const file = path.join(dir, "status.xml");
    const fake = harness([{ status: 200, body: { run: job("running") } }, { status: 200, body: { run: job("running") } }, { status: 200, body: { run: job("completed", { pass: 1 }, [results[0]!]) } }]);
    expect(await main(["replay", "status", "run_1", "--wait", "--junit", file], fake.cli)).toBe(EXIT_OK);
    expect(fake.requests).toHaveLength(3);
    expect(fs.readFileSync(file, "utf8")).toContain('tests="1" failures="0" errors="0"');
    const slow = harness([{ status: 200, body: { run: job("running") } }]);
    expect(await main(["replay", "status", "run_1", "--wait", "--timeout", "0.001"], slow.cli)).toBe(EXIT_INCOMPLETE);
  });

  it("needs exactly one job id", async () => {
    expect(await main(["replay", "status"], harness([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["replay", "status", "a", "b"], harness([]).cli)).toBe(EXIT_USAGE);
  });
});

describe("l2m release publish", () => {
  it("publishes (200 -> 0)", async () => {
    const fake = harness([{ status: 200, body: { release: { version: 4, verdict: "passed" } } }]);
    expect(await main(["release", "publish", "wf-1", "--version", "4", "--hash", "abc", "--run", "run_9"], fake.cli)).toBe(EXIT_OK);
    expect(fake.requests[0]).toEqual({ method: "POST", url: "http://l2m.test/api/workflows/wf-1/publish", auth: "Bearer key-1", body: { version: 4, workflowHash: "abc", replayRunId: "run_9" } });
    expect(fake.out()).toContain("Published version 4 of workflow wf-1 (passed)");
  });

  it("exits 4 with the request id when the publish needs approval", async () => {
    const fake = harness([{ status: 202, body: { verdict: "needs_approval", approvalRequestId: "apr_7" } }]);
    expect(await main(["release", "publish", "wf-1", "--version", "4", "--request-approval", "ship it"], fake.cli)).toBe(EXIT_INCOMPLETE);
    expect(fake.requests[0]!.body).toEqual({ version: 4, requestApproval: { reason: "ship it" } });
    expect(fake.out()).toContain("request apr_7");
  });

  it("exits 1 with the reasons when the gate blocks, and for any other failure", async () => {
    const blocked = harness([{ status: 409, body: { verdict: "blocked", reasons: ["no passing replay for this hash", "2 cases failed"], canRequestApproval: true } }]);
    expect(await main(["release", "publish", "wf-1", "--version", "4", "--override-reason", "hotfix"], blocked.cli)).toBe(EXIT_FAILED);
    expect(blocked.requests[0]!.body).toEqual({ version: 4, override: { reason: "hotfix" } });
    expect(blocked.out()).toContain("- no passing replay for this hash");
    expect(blocked.out()).toContain("--request-approval");
    const forbidden = harness([{ status: 403, body: { error: "Only admins can override" } }]);
    expect(await main(["release", "publish", "wf-1", "--version", "4"], forbidden.cli)).toBe(EXIT_FAILED);
    expect(forbidden.err()).toContain("Only admins can override");
    const old = harness([{ status: 404, body: { error: "not found" } }]);
    expect(await main(["release", "publish", "wf-1", "--version", "4"], old.cli)).toBe(EXIT_FAILED);
    expect(old.err()).toContain("Phase 15.4");
    expect(await main(["release", "publish", "wf-1", "--version", "4"], harness([{ status: 0 }]).cli)).toBe(EXIT_FAILED);
  });

  it("checks its flags", async () => {
    for (const argv of [
      ["release", "publish"],
      ["release", "publish", "wf-1"],
      ["release", "publish", "wf-1", "--version", "0"],
      ["release", "publish", "wf-1", "--version", "x"],
      ["release", "publish", "wf-1", "--version", "2", "--override-reason", "a", "--request-approval", "b"],
      ["release", "publish", "wf-1", "--version", "2", "--override-reason", " "]
    ]) {
      const fake = harness([{ status: 200, body: {} }]);
      expect(await main(argv, fake.cli), argv.join(" ")).toBe(EXIT_USAGE);
      expect(fake.requests).toHaveLength(0);
    }
  });
});

// --- golden-set files -----------------------------------------------------------

const facts = { status: "success", error: null, output: { ok: true }, nodes: [], toolCalls: [], modelCalls: [], guard: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null, durationMs: 1, modelCalls: 0, toolCalls: 0 } };

function goldenFile(): GoldenSetFile {
  return {
    format: "l2m.golden-set",
    version: 1,
    workflow: { id: "wf-1", name: "Support bot" },
    name: "Regression suite",
    exportedAt: "2026-10-24T08:00:00.000Z",
    exportedBy: "ci@example.com",
    cases: [{ name: "Case", recording: { name: "Case", sourceStatus: "success", workflowHash: "h", recordedAt: "2026-10-20T08:00:00.000Z", workflow: { nodes: [] }, input: { q: 1 }, nodes: {}, facts, cassette: null } }]
  } as GoldenSetFile;
}

function sign(file: GoldenSetFile): { signed: GoldenSetFile; publicKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const signedAt = "2026-10-24T08:00:00.000Z";
  const signature = crypto.sign(null, Buffer.from(goldenSetSignedBytes(file as never, keyId, signedAt)), privateKey).toString("base64");
  return { signed: { ...file, signature: { algorithm: "Ed25519", keyId, publicKey: raw.toString("base64"), signedAt, signature } }, publicKey: raw.toString("base64") };
}

describe("l2m golden export", () => {
  it("writes the file the API returns, with a signature when asked", async () => {
    const { signed } = sign(goldenFile());
    const out = path.join(dir, "suite.json");
    const fake = harness([{ status: 200, body: signed, headers: { "x-l2m-skipped-cases": "2" } }]);
    expect(await main(["golden", "export", "ds_1", "-o", out, "--sign"], fake.cli)).toBe(EXIT_OK);
    expect(fake.requests[0]).toMatchObject({ method: "GET", url: "http://l2m.test/api/eval/datasets/ds_1/export?sign=true" });
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(signed);
    expect(fake.err()).toContain("signed, key");
    expect(fake.err()).toContain("2 cases without a golden run were left out");
  });

  it("prints to stdout without -o, and exits 1 on failures and on a wrong answer", async () => {
    const plain = harness([{ status: 200, body: goldenFile() }]);
    expect(await main(["golden", "export", "ds_1"], plain.cli)).toBe(EXIT_OK);
    expect(plain.requests[0]!.url).toBe("http://l2m.test/api/eval/datasets/ds_1/export");
    expect(JSON.parse(plain.out()).format).toBe("l2m.golden-set");
    expect(await main(["golden", "export", "ds_1"], harness([{ status: 404, body: { error: "Golden set not found" } }]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "export", "ds_1"], harness([{ status: 200, body: { hello: 1 } }]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "export", "ds_1", "--sign"], harness([{ status: 200, body: goldenFile() }]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "export", "ds_1"], harness([{ status: 0 }]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "export"], harness([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["golden", "export", "ds_1", "-o"], harness([]).cli)).toBe(EXIT_USAGE);
  });
});

describe("l2m golden import", () => {
  const writeFile = (file: unknown) => {
    const target = path.join(dir, "in.json");
    fs.writeFileSync(target, JSON.stringify(file));
    return target;
  };

  it("sends the file as it is and prints the warnings", async () => {
    const { signed } = sign(goldenFile());
    const file = writeFile(signed);
    const fake = harness([{ status: 201, body: { dataset: { id: "ds_9", name: "From git" }, imported: 1, skipped: 0, warnings: ["1 judge scorer lost the credential reference"] } }]);
    expect(await main(["golden", "import", file, "--workflow", "wf-2", "--project", "p1", "--name", "From git"], fake.cli)).toBe(EXIT_OK);
    expect(fake.requests[0]).toEqual({ method: "POST", url: "http://l2m.test/api/eval/datasets/import", auth: "Bearer key-1", body: { file: signed, workflowId: "wf-2", projectId: "p1", name: "From git" } });
    expect(fake.out()).toContain("Imported 1 case as golden set ds_9 (From git)");
    expect(fake.out()).toContain("warning: 1 judge scorer lost the credential reference");
  });

  it("maps refusals to exit codes", async () => {
    const file = writeFile(goldenFile());
    expect(await main(["golden", "import", file, "--workflow", "wf-1"], harness([{ status: 400, body: { error: "Not a valid file" } }]).cli)).toBe(EXIT_USAGE);
    for (const status of [403, 404, 413, 500]) {
      expect(await main(["golden", "import", file, "--workflow", "wf-1"], harness([{ status, body: { error: "no" } }]).cli), String(status)).toBe(EXIT_FAILED);
    }
    expect(await main(["golden", "import", file, "--workflow", "wf-1"], harness([{ status: 0 }]).cli)).toBe(EXIT_FAILED);
  });

  it("checks the file and flags locally", async () => {
    const good = writeFile(goldenFile());
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ format: "other" }));
    for (const argv of [
      ["golden", "import"],
      ["golden", "import", good],
      ["golden", "import", bad, "--workflow", "wf-1"],
      ["golden", "import", path.join(dir, "missing.json"), "--workflow", "wf-1"]
    ]) {
      const fake = harness([{ status: 201, body: {} }]);
      expect(await main(argv, fake.cli), argv.join(" ")).toBe(EXIT_USAGE);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("with --public-key refuses a file that does not verify before sending it", async () => {
    const { signed, publicKey } = sign(goldenFile());
    const ok = harness([{ status: 201, body: { dataset: { id: "d", name: "n" }, imported: 1, warnings: [] } }]);
    expect(await main(["golden", "import", writeFile(signed), "--workflow", "wf-1", "--public-key", publicKey], ok.cli)).toBe(EXIT_OK);
    const tampered = JSON.parse(JSON.stringify(signed)) as GoldenSetFile;
    tampered.cases[0]!.name = "edited";
    const refused = harness([{ status: 201, body: {} }]);
    expect(await main(["golden", "import", writeFile(tampered), "--workflow", "wf-1", "--public-key", publicKey], refused.cli)).toBe(EXIT_FAILED);
    expect(refused.requests).toHaveLength(0);
    const other = sign(goldenFile()).publicKey;
    expect(await main(["golden", "import", writeFile(signed), "--workflow", "wf-1", "--public-key", other], harness([{ status: 201, body: {} }]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "import", writeFile(goldenFile()), "--workflow", "wf-1", "--public-key", publicKey], harness([{ status: 201, body: {} }]).cli)).toBe(EXIT_FAILED);
  });
});

describe("l2m golden verify", () => {
  const writeFile = (file: unknown) => {
    const target = path.join(dir, "v.json");
    fs.writeFileSync(target, JSON.stringify(file));
    return target;
  };

  it("passes with the trusted key, is unverified (3) without one, and fails when tampered or unsigned", async () => {
    const { signed, publicKey } = sign(goldenFile());
    const file = writeFile(signed);
    const pass = harness([]);
    expect(await main(["golden", "verify", file, "--public-key", publicKey], pass.cli)).toBe(EXIT_OK);
    expect(pass.out()).toContain("PASS");
    const unverified = harness([]);
    expect(await main(["golden", "verify", file], unverified.cli)).toBe(3);
    expect(unverified.out()).toContain("SIGNER NOT VERIFIED");
    expect(await main(["golden", "verify", file, "--trust-embedded-key"], harness([]).cli)).toBe(EXIT_OK);
    const json = harness([]);
    expect(await main(["golden", "verify", file, "--public-key", publicKey, "--json"], json.cli)).toBe(EXIT_OK);
    expect(JSON.parse(json.out())).toMatchObject({ ok: true, status: "pass", cases: 1 });

    const tampered = JSON.parse(JSON.stringify(signed)) as GoldenSetFile;
    tampered.name = "Edited";
    const failed = harness([]);
    expect(await main(["golden", "verify", writeFile(tampered), "--public-key", publicKey], failed.cli)).toBe(EXIT_FAILED);
    expect(failed.out()).toContain("changed after signing");
    expect(await main(["golden", "verify", writeFile(tampered)], harness([]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "verify", writeFile(goldenFile())], harness([]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "verify", writeFile({ nope: 1 })], harness([]).cli)).toBe(EXIT_FAILED);
    // The right file, the wrong deployment's key.
    expect(await main(["golden", "verify", file, "--public-key", sign(goldenFile()).publicKey], harness([]).cli)).toBe(EXIT_FAILED);
    expect(await main(["golden", "verify", file, "--public-key", publicKey, "--trust-embedded-key"], harness([]).cli)).toBe(EXIT_USAGE);
    expect(await main(["golden", "verify"], harness([]).cli)).toBe(EXIT_USAGE);
  });
});

// --- review fixes: flag checking, timeouts and retries, private files --------------------------

describe("flag checking", () => {
  it("refuses unknown flags and flags of another command with exit 2, sending nothing", async () => {
    for (const argv of [
      ["release", "publish", "wf-1", "--version", "2", "--override-reson", "hotfix"],
      ["replay", "run", "--set", "ds_1", "--live-reads", "fetch"],
      ["replay", "run", "--set", "ds_1", "--repeat", "3"],
      ["replay", "run", "--set", "ds_1", "--no-wiat"],
      ["replay", "status", "run_1", "--set", "ds_1"],
      ["golden", "export", "ds_1", "--workflow", "wf-1"],
      ["golden", "import", "x.json", "--workflow", "wf-1", "--allow-other"],
      ["golden", "verify", "x.json", "--api-url", "http://l2m.test"],
      ["audit", "verify", "b.zip", "--sign"]
    ]) {
      const fake = harness([{ status: 200, body: {} }]);
      expect(await main(argv, fake.cli), argv.join(" ")).toBe(EXIT_USAGE);
      expect(fake.requests, argv.join(" ")).toHaveLength(0);
      expect(fake.err(), argv.join(" ")).toMatch(/Unknown flag/);
    }
  });

  it("refuses =value on a switch, so --sign=false cannot read as true", async () => {
    for (const argv of [
      ["golden", "export", "ds_1", "--sign=false"],
      ["replay", "status", "run_1", "--wait=true"],
      ["replay", "run", "--set", "ds_1", "--estimate=no"]
    ]) {
      const fake = harness([{ status: 200, body: {} }]);
      expect(await main(argv, fake.cli), argv.join(" ")).toBe(EXIT_USAGE);
      expect(fake.requests).toHaveLength(0);
      expect(fake.err()).toContain("takes no value");
    }
    // A value flag still takes --name=value.
    const fake = harness([{ status: 200, body: { run: job("completed", { pass: 1 }) } }]);
    expect(await main(["replay", "status", "run_1", "--timeout=5"], fake.cli)).toBe(EXIT_OK);
  });

  it("warns on stderr when the key is given with --api-key, never printing it", async () => {
    const fake = harness([{ status: 200, body: { run: job("completed", { pass: 1 }) } }]);
    expect(await main(["replay", "status", "run_1", "--api-key", "secret-key-value"], fake.cli)).toBe(EXIT_OK);
    expect(fake.err()).toContain("set L2M_API_KEY");
    expect(fake.err()).not.toContain("secret-key-value");
    expect(fake.out()).not.toContain("secret-key-value");
    const quiet = harness([{ status: 200, body: { run: job("completed", { pass: 1 }) } }]);
    expect(await main(["replay", "status", "run_1"], quiet.cli)).toBe(EXIT_OK);
    expect(quiet.err()).not.toContain("L2M_API_KEY");
  });
});

describe("status polls: retries, timeouts and exit codes", () => {
  it("retries a poll after a 5xx and a network error, then judges the job", async () => {
    const fake = harness([
      { status: 202, body: { run: job("running") } },
      { status: 503, body: { error: "restarting" } },
      { status: 0 },
      { status: 200, body: { run: job("completed", { pass: 2 }) } }
    ]);
    const sleeps: number[] = [];
    fake.cli.sleep = async (ms) => void sleeps.push(ms);
    expect(await main(["replay", "run", "--set", "ds_1"], fake.cli), fake.err()).toBe(EXIT_OK);
    expect(fake.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET", "GET"]);
    expect(sleeps).toEqual([2_000, 1_000, 3_000]);
  });

  it("gives up after two retries with exit 4, and a 400 from a poll exits 1, not 2", async () => {
    const down = harness([{ status: 202, body: { run: job("running") } }, { status: 502, body: { error: "bad gateway" } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], down.cli)).toBe(EXIT_INCOMPLETE);
    expect(down.requests).toHaveLength(4);
    const bad = harness([{ status: 202, body: { run: job("running") } }, { status: 400, body: { error: "bad id" } }]);
    expect(await main(["replay", "run", "--set", "ds_1"], bad.cli)).toBe(EXIT_FAILED);
    expect(bad.requests).toHaveLength(2);
    expect(await main(["replay", "status", "run_1"], harness([{ status: 400, body: { error: "bad id" } }]).cli)).toBe(EXIT_FAILED);
    // 4xx other than 400 are final at once and keep exit 4 (Phase 15.2 behaviour).
    const missing = harness([{ status: 404, body: { error: "Replay job not found" } }]);
    expect(await main(["replay", "status", "run_1"], missing.cli)).toBe(EXIT_INCOMPLETE);
    expect(missing.requests).toHaveLength(1);
    // A 400 when the job is started is still the flags: exit 2.
    expect(await main(["replay", "run", "--set", "ds_1"], harness([{ status: 400, body: { error: "Invalid" } }]).cli)).toBe(EXIT_USAGE);
  });

  it("gives up on a server that accepts the connection and never answers, within --timeout", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const cli: CliIo = { stdin: new PassThrough(), stdout, stderr, env: { L2M_API_URL: "http://l2m.test", L2M_API_KEY: "k" }, fetch: hanging, sleep: async () => undefined };
    const started = Date.now();
    expect(await main(["replay", "status", "run_1", "--timeout", "1"], cli)).toBe(EXIT_INCOMPLETE);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(err).toContain("no answer");
  }, 30_000);
});

describe("private output files", () => {
  it("writes golden-set files and JUnit reports with mode 0600", async () => {
    const out = path.join(dir, "suite.json");
    fs.writeFileSync(out, "old", { mode: 0o644 });
    expect(await main(["golden", "export", "ds_1", "-o", out], harness([{ status: 200, body: goldenFile() }]).cli)).toBe(EXIT_OK);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).format).toBe("l2m.golden-set");
    const junit = path.join(dir, "junit.xml");
    expect(await main(["replay", "status", "run_1", "--junit", junit], harness([{ status: 200, body: { run: job("completed", { pass: 1 }) } }]).cli)).toBe(EXIT_OK);
    expect(fs.statSync(junit).mode & 0o777).toBe(0o600);
  });

  it("refuses to write through a symlink", async () => {
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "keep me");
    const link = path.join(dir, "link.json");
    fs.symlinkSync(victim, link);
    const fake = harness([{ status: 200, body: goldenFile() }]);
    expect(await main(["golden", "export", "ds_1", "-o", link], fake.cli)).toBe(EXIT_FAILED);
    expect(fake.err()).toContain("symbolic link");
    const junit = harness([{ status: 200, body: { run: job("completed", { pass: 1 }) } }]);
    expect(await main(["replay", "status", "run_1", "--junit", link], junit.cli)).toBe(EXIT_OK);
    expect(junit.err()).toContain("symbolic link");
    expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
  });
});

describe("l2m golden import --allow-other-workflow", () => {
  it("asks the server to accept another workflow's file, and a refusal (409) exits 1", async () => {
    const file = path.join(dir, "other.json");
    fs.writeFileSync(file, JSON.stringify(goldenFile()));
    const allowed = harness([{ status: 201, body: { dataset: { id: "d", name: "n" }, imported: 1, warnings: [] } }]);
    expect(await main(["golden", "import", file, "--workflow", "wf-2", "--allow-other-workflow"], allowed.cli)).toBe(EXIT_OK);
    expect(allowed.requests[0]!.body).toMatchObject({ workflowId: "wf-2", allowWorkflowMismatch: true });
    const refused = harness([{ status: 409, body: { error: "The file was exported from workflow wf-1", code: "workflow_mismatch" } }]);
    expect(await main(["golden", "import", file, "--workflow", "wf-2"], refused.cli)).toBe(EXIT_FAILED);
    expect(refused.requests[0]!.body).not.toHaveProperty("allowWorkflowMismatch");
    expect(refused.err()).toContain("exported from workflow wf-1");
  });
});
