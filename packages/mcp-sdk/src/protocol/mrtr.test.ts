import { describe, expect, it, vi } from "vitest";
import type { McpElicitationRequest, McpSamplingRequest } from "@ai-orchestrator/shared";
import { McpServerRequestError } from "../client-features";
import { McpTimeoutError, classifyMcpError } from "../errors";
import { McpCassetteRecorder, recordingAdapter } from "../cassette";
import type { MCPServerAdapter } from "../types";
import {
  McpInputRequestError,
  McpMrtrCanceledError,
  McpMrtrRoundLimitError,
  answerInputRequest,
  requestStateFingerprint,
  runMrtrRequest,
  type McpMrtrOptions,
  type McpMrtrRoundInfo
} from "./mrtr";
import { McpInvalidResultError } from "./result";

const origin = { serverId: "srv", toolName: "book" };
const elicitParams = {
  mode: "form",
  message: "Which date?",
  requestedSchema: { type: "object", properties: { date: { type: "string", format: "date" } }, required: ["date"] }
};
const sampleParams = { messages: [{ role: "user", content: { type: "text", text: "Capital of France?" } }], maxTokens: 50 };
const sampled = { role: "assistant" as const, content: { type: "text" as const, text: "Paris" }, model: "m-1", stopReason: "endTurn" };

function options(context: McpMrtrOptions["context"], extra?: Partial<McpMrtrOptions>): McpMrtrOptions {
  return { context, origin, ...extra };
}

/** A fake modern server: each call returns the next scripted result and records the params it got. */
function scripted(results: unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (params: Record<string, unknown>, _round: number) => {
    calls.push(structuredClone(params));
    const next = results.shift();
    if (next === undefined) throw new Error("no more scripted results");
    return next;
  });
  return { send, calls };
}

describe("runMrtrRequest", () => {
  it("returns a complete result from the first round, and treats a missing resultType (legacy) as complete", async () => {
    const modern = scripted([{ resultType: "complete", content: [] }]);
    await expect(runMrtrRequest("tools/call", { name: "t" }, modern.send, options({}))).resolves.toEqual({ resultType: "complete", content: [] });
    const legacy = scripted([{ content: [{ type: "text", text: "ok" }] }]);
    await expect(runMrtrRequest("tools/call", { name: "t" }, legacy.send, options({}))).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(legacy.send).toHaveBeenCalledTimes(1);
  });

  it("answers an elicitation through the handler and retries with inputResponses and the exact requestState", async () => {
    const onElicitation = vi.fn(async (request: McpElicitationRequest) => {
      expect(request.message).toBe("Which date?");
      return { action: "accept" as const, content: { date: "2026-12-01" } };
    });
    const state = "  AEAD+blob/with=odd chars\n ";
    const server = scripted([
      { resultType: "input_required", inputRequests: { when: { method: "elicitation/create", params: elicitParams } }, requestState: state },
      { resultType: "complete", content: [{ type: "text", text: "booked" }] }
    ]);
    const original = { name: "book", arguments: { room: 4 }, _meta: { progressToken: "p" } };
    const result = await runMrtrRequest("tools/call", original, server.send, options({ onElicitation }));
    expect(result).toEqual({ resultType: "complete", content: [{ type: "text", text: "booked" }] });
    expect(server.calls[0]).toEqual(original);
    expect(server.calls[1]).toEqual({ ...original, inputResponses: { when: { action: "accept", content: { date: "2026-12-01" } } }, requestState: state });
    expect(server.send.mock.calls.map((call) => call[1])).toEqual([0, 1]);
    expect(onElicitation).toHaveBeenCalledWith(expect.anything(), origin);
  });

  it("passes decline and cancel through, and declines without a handler", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const server = scripted([
        { resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: elicitParams } } },
        { resultType: "complete" }
      ]);
      await runMrtrRequest("prompts/get", { name: "p" }, server.send, options({ onElicitation: async () => ({ action }) }));
      expect(server.calls[1]).toEqual({ name: "p", inputResponses: { a: { action } } });
    }
    const server = scripted([{ resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: elicitParams } } }, { resultType: "complete" }]);
    await runMrtrRequest("resources/read", { uri: "file:///x" }, server.send, options({}));
    expect(server.calls[1]).toEqual({ uri: "file:///x", inputResponses: { a: { action: "decline" } } });
  });

  it("answers sampling through the handler when it was declared", async () => {
    const onSampling = vi.fn(async (request: McpSamplingRequest) => {
      expect(request.maxTokens).toBe(50);
      return sampled;
    });
    const server = scripted([
      {
        resultType: "input_required",
        inputRequests: { q: { method: "sampling/createMessage", params: sampleParams }, who: { method: "elicitation/create", params: elicitParams } }
      },
      { resultType: "complete", ok: true }
    ]);
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: { date: "2026-01-01" } }));
    await runMrtrRequest("tools/call", { name: "t" }, server.send, options({ onSampling, onElicitation }));
    expect(server.calls[1]).toEqual({
      name: "t",
      inputResponses: {
        q: { role: "assistant", content: { type: "text", text: "Paris" }, model: "m-1", stopReason: "endTurn" },
        who: { action: "accept", content: { date: "2026-01-01" } }
      }
    });
    // Answered in the order the server listed them.
    expect(onSampling.mock.invocationCallOrder[0]).toBeLessThan(onElicitation.mock.invocationCallOrder[0]);
  });

  it("omits requestState when the server sent none and drops stale values from the caller's params", async () => {
    const server = scripted([
      { resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: elicitParams } }, requestState: "s1" },
      { resultType: "input_required", inputRequests: { b: { method: "elicitation/create", params: elicitParams } } },
      { resultType: "complete" }
    ]);
    await runMrtrRequest("tools/call", { name: "t", inputResponses: { old: {} }, requestState: "stale" }, server.send, options({}));
    expect(server.calls[0]).toEqual({ name: "t" });
    expect(server.calls[1]).toEqual({ name: "t", inputResponses: { a: { action: "decline" } }, requestState: "s1" });
    expect(server.calls[2]).toEqual({ name: "t", inputResponses: { b: { action: "decline" } } });
  });

  it("retries at once with only the state when the server sent no input requests (load shedding)", async () => {
    const server = scripted([{ resultType: "input_required", requestState: "later" }, { resultType: "complete" }]);
    await runMrtrRequest("tools/call", { name: "t" }, server.send, options({}));
    expect(server.calls[1]).toEqual({ name: "t", requestState: "later" });
  });

  it("stops after the round limit, counting repeated identical requests", async () => {
    const ask = { resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: elicitParams } }, requestState: "same" };
    const server = scripted([ask, ask, ask, ask]);
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: { date: "2026-01-01" } }));
    const run = runMrtrRequest("tools/call", { name: "t" }, server.send, options({ onElicitation }, { maxRounds: 2 }));
    await expect(run).rejects.toBeInstanceOf(McpMrtrRoundLimitError);
    expect(server.send).toHaveBeenCalledTimes(3);
    expect(onElicitation).toHaveBeenCalledTimes(2);
    const defaults = scripted(Array.from({ length: 10 }, () => ask));
    await expect(runMrtrRequest("tools/call", { name: "t" }, defaults.send, options({}))).rejects.toThrow(/stopped after 5 rounds/);
    expect(defaults.send).toHaveBeenCalledTimes(6);
  });

  it("stops at the deadline and when the run is aborted", async () => {
    const ask = { resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: elicitParams } } };
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const server = scripted([ask, ask]);
      const onElicitation = async () => {
        now = 5_000;
        return { action: "decline" as const };
      };
      await expect(runMrtrRequest("tools/call", { name: "t" }, server.send, options({ onElicitation }, { deadlineAt: 2_000 }))).rejects.toBeInstanceOf(
        McpTimeoutError
      );
      expect(server.send).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }

    const controller = new AbortController();
    const server = scripted([ask, ask]);
    const onElicitation = async () => {
      controller.abort(new Error("Run stopped"));
      return { action: "decline" as const };
    };
    const run = runMrtrRequest("tools/call", { name: "t" }, server.send, options({ onElicitation, signal: controller.signal }));
    await expect(run).rejects.toThrow(/canceled: Run stopped/);
    await expect(run).rejects.toBeInstanceOf(McpMrtrCanceledError);
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(classifyMcpError(await run.catch((error) => error))).toBe("canceled");
  });

  it("reports each round without the requestState value", async () => {
    const rounds: McpMrtrRoundInfo[] = [];
    const server = scripted([
      { resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: elicitParams } }, requestState: "secret-state" },
      { resultType: "complete" }
    ]);
    await runMrtrRequest("tools/call", { name: "t" }, server.send, options({}, { onRound: (info) => rounds.push(info) }));
    expect(rounds).toEqual([
      { round: 1, method: "tools/call", inputRequests: [{ key: "a", method: "elicitation/create" }], requestState: requestStateFingerprint("secret-state") }
    ]);
    expect(JSON.stringify(rounds)).not.toContain("secret-state");
    expect(requestStateFingerprint("secret-state")).toEqual({ length: 12, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("rejects invalid results and propagates send errors", async () => {
    const bad = scripted([{ resultType: "task" }]);
    await expect(runMrtrRequest("tools/call", { name: "t" }, bad.send, options({}))).rejects.toBeInstanceOf(McpInvalidResultError);
    const failing = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(runMrtrRequest("tools/call", { name: "t" }, failing, options({}))).rejects.toThrow("socket hang up");
  });

  it("feeds MRTR exchanges into a cassette recording like legacy server requests", async () => {
    const recorder = new McpCassetteRecorder();
    const fakeModernAdapter: MCPServerAdapter = {
      definition: { id: "fake-modern", label: "Fake modern", description: "", configSchema: {}, authSchema: {} },
      discoverTools: async () => [],
      invokeTool: async (toolName, args, _config, context) => {
        const server = scripted([
          {
            resultType: "input_required",
            inputRequests: { q: { method: "sampling/createMessage", params: sampleParams }, w: { method: "elicitation/create", params: elicitParams } }
          },
          { resultType: "complete", content: [{ type: "text", text: "done" }] }
        ]);
        const result = await runMrtrRequest("tools/call", { name: toolName, arguments: args }, server.send, options(context));
        return { ok: true, output: result };
      }
    };
    const adapter = recordingAdapter(fakeModernAdapter, recorder);
    await adapter.invokeTool(
      "book",
      {},
      { serverId: "fake-modern" },
      { resolveSecret: async () => undefined, onSampling: async () => sampled, onElicitation: async () => ({ action: "accept", content: { date: "2026-01-01" } }) }
    );
    const [entry] = recorder.toCassette().entries;
    expect(entry?.exchanges?.map((exchange) => exchange.kind)).toEqual(["sampling", "elicitation"]);
  });
});

describe("answerInputRequest refusals", () => {
  it("refuses roots/list and unknown methods: L2M declares no roots", async () => {
    const error = await answerInputRequest("r", { method: "roots/list" }, options({})).catch((caught) => caught);
    expect(error).toBeInstanceOf(McpInputRequestError);
    expect(error).toMatchObject({ reason: "undeclared", inputKey: "r", inputMethod: "roots/list", code: -32601 });
    expect(classifyMcpError(error)).toBe("protocol");
  });

  it("refuses sampling when it was not declared, even if a handler exists", async () => {
    await expect(answerInputRequest("q", { method: "sampling/createMessage", params: sampleParams }, options({}))).rejects.toMatchObject({
      reason: "undeclared"
    });
    const onSampling = vi.fn(async () => sampled);
    await expect(
      answerInputRequest("q", { method: "sampling/createMessage", params: sampleParams }, options({ onSampling }, { clientCapabilities: { elicitation: {} } }))
    ).rejects.toMatchObject({ reason: "undeclared" });
    expect(onSampling).not.toHaveBeenCalled();
  });

  it("refuses URL-mode elicitation (L2M declares form only) and elicitation that was not declared", async () => {
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: {} }));
    await expect(
      answerInputRequest("u", { method: "elicitation/create", params: { mode: "url", message: "Open", url: "https://x" } }, options({ onElicitation }))
    ).rejects.toMatchObject({ reason: "undeclared" });
    await expect(answerInputRequest("e", { method: "elicitation/create", params: elicitParams }, options({ onElicitation }, { clientCapabilities: {} }))).rejects.toMatchObject({
      reason: "undeclared"
    });
    await expect(
      answerInputRequest("e", { method: "elicitation/create", params: elicitParams }, options({ onElicitation }, { clientCapabilities: { elicitation: { form: {} } } }))
    ).resolves.toEqual({ action: "accept", content: {} });
    expect(onElicitation).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed requests and credential-looking elicitation fields with the legacy validation", async () => {
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: {} }));
    const credential = { message: "Log in", requestedSchema: { type: "object", properties: { password: { type: "string" } } } };
    await expect(answerInputRequest("c", { method: "elicitation/create", params: credential }, options({ onElicitation }))).rejects.toMatchObject({
      reason: "invalid",
      code: -32602,
      message: expect.stringMatching(/look like credentials/)
    });
    expect(onElicitation).not.toHaveBeenCalled();
    await expect(
      answerInputRequest("s", { method: "sampling/createMessage", params: { messages: [] } }, options({ onSampling: async () => sampled }))
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("ends the call when the sampling handler refuses, keeping the refusal's code", async () => {
    const onSampling = async () => {
      throw new McpServerRequestError("Sampling budget used up.", -32001);
    };
    const error = await answerInputRequest("q", { method: "sampling/createMessage", params: sampleParams }, options({ onSampling })).catch((caught) => caught);
    expect(error).toMatchObject({ name: "McpInputRequestError", reason: "refused", code: -32001, message: "Sampling budget used up." });
    expect(classifyMcpError(error)).toBe("tool");
    const crash = async () => {
      throw new Error("provider down");
    };
    await expect(answerInputRequest("q", { method: "sampling/createMessage", params: sampleParams }, options({ onSampling: crash }))).rejects.toThrow("provider down");
  });
});
