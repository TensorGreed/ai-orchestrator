import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { RunDiff, ReplayRunResponse } from "@ai-orchestrator/shared";
import { EXIT_FAILED, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE, main, type CliIo } from "./main";

function io(fetchImpl?: typeof fetch): CliIo & { out: () => string; err: () => string; requests: Array<{ url: string; body: unknown; auth: string | null }> } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const requests: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get("authorization") });
    return fetchImpl!(input, init);
  }) as typeof fetch;
  return { stdin: new PassThrough(), stdout, stderr, env: { L2M_API_URL: "http://l2m.test/", L2M_API_KEY: "key-1" }, ...(fetchImpl ? { fetch: recordingFetch } : {}), out: () => out, err: () => err, requests };
}

const zero = { baseline: 0, candidate: 0, delta: 0, ratio: null };

function diff(overrides: Partial<RunDiff> = {}): RunDiff {
  return {
    status: { baseline: "success", candidate: "success", changed: false, regression: false },
    output: { equal: true, changes: [], ignored: 0, ignorePaths: [] },
    toolCalls: { baselineCount: 0, candidateCount: 0, changed: false, steps: [], countDelta: [] },
    path: { added: [], removed: [], statusChanges: [] },
    models: { changes: [], callDelta: zero },
    totals: { tokens: zero, costUsd: zero, durationMs: zero },
    guard: { added: [], removed: [], changed: [] },
    health: [],
    ...overrides
  } as RunDiff;
}

function response(d: RunDiff, verdict: ReplayRunResponse["verdict"] = "pass"): ReplayRunResponse {
  return {
    recordingId: "rec_1",
    executionId: "exe_9",
    candidate: { kind: "draft", version: null, workflowHash: "a".repeat(64) },
    status: d.status.candidate,
    diff: d,
    verdict,
    reasons: [],
    facts: {} as ReplayRunResponse["facts"]
  };
}

const replyWith = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("l2m replay run", () => {
  it("exits 0 on pass and posts the candidate, MCP mode and ignore paths with the API key", async () => {
    const cli = io(replyWith(200, response(diff())));
    const code = await main(["replay", "run", "--recording", "rec_1", "--version", "3", "--mcp", "lenient", "--ignore-path", "**.id", "--ignore-path", "meta.at", "--number-tolerance", "0.5"], cli);
    expect(code).toBe(EXIT_OK);
    expect(cli.requests).toEqual([
      { url: "http://l2m.test/api/replay/recordings/rec_1/replay", body: { version: 3, mcpMode: "lenient", ignorePaths: ["**.id", "meta.at"], numberTolerance: 0.5 }, auth: "Bearer key-1" }
    ]);
    expect(cli.out()).toContain("PASS");
  });

  it("exits 1 when the candidate's output differs, and re-judges instead of trusting the verdict field", async () => {
    const changed = diff({ output: { equal: false, changes: [{ path: "answer", kind: "changed", baseline: "v1", candidate: "v2" }], ignored: 0, ignorePaths: [] } });
    const cli = io(replyWith(200, response(changed, "pass")));
    expect(await main(["replay", "run", "--recording", "rec_1", "--draft"], cli)).toBe(EXIT_FAILED);
    expect(cli.requests[0]!.body).toEqual({ draft: true });
    expect(cli.out()).toContain("FAIL");
    expect(cli.out()).toContain("output changed answer");
  });

  it("exits 4 when the recording could not answer the candidate", async () => {
    const blocked = diff({ health: [{ kind: "mcp_unmatched", nodeId: null, message: "1 MCP call had no recorded answer", blocking: true }] });
    const cli = io(replyWith(200, response(blocked, "error")));
    expect(await main(["replay", "run", "--recording", "rec_1", "--json"], cli)).toBe(EXIT_INCOMPLETE);
    expect(JSON.parse(cli.out())).toMatchObject({ verdict: "error" });
  });

  it("exits 4 when the request fails or the API is unreachable", async () => {
    const notFound = io(replyWith(404, { error: "Golden run not found" }));
    expect(await main(["replay", "run", "--recording", "nope"], notFound)).toBe(EXIT_INCOMPLETE);
    expect(notFound.err()).toContain("Golden run not found");
    const down = io((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(await main(["replay", "run", "--recording", "rec_1"], down)).toBe(EXIT_INCOMPLETE);
    expect(down.err()).toContain("could not complete");
  });

  it("exits 2 on usage errors", async () => {
    for (const argv of [
      ["replay", "run"],
      ["replay", "run", "--recording", "r", "--draft", "--version", "2"],
      ["replay", "run", "--recording", "r", "--version", "0"],
      ["replay", "run", "--recording", "r", "--mcp", "live"],
      ["replay", "run", "--recording", "r", "--number-tolerance", "-1"]
    ]) {
      expect(await main(argv, io(replyWith(200, response(diff()))))).toBe(EXIT_USAGE);
    }
    const noUrl = io(replyWith(200, response(diff())));
    noUrl.env = {};
    expect(await main(["replay", "run", "--recording", "r"], noUrl)).toBe(EXIT_USAGE);
  });
});
