import { describe, expect, it } from "vitest";
import { canonicalJson, type McpCassette, type ModelMemorySeed, type ModelTape, type RunFacts } from "@ai-orchestrator/shared";
import { surrogateFor } from "@ai-orchestrator/guard-sdk";
import { canonicalJson as cassetteCanonical, hashCassetteArgs } from "@ai-orchestrator/mcp-sdk";
import { canonicalTapeJson, hashModelRequest } from "@ai-orchestrator/provider-sdk";
import { sha256Hex } from "./audit-bundle-service.js";
import { inputProvenance, maskCapturedRun, maskCapturedRunAsync, provenanceFor, withNodeLabels } from "./capture-masking.js";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
const EMAIL = "jane.doe@example.com";

function run() {
  const facts: RunFacts = {
    status: "success",
    error: null,
    output: { answer: `Mailed ${EMAIL}` },
    nodes: [
      { nodeId: "hook", nodeType: "webhook_input", status: "success", durationMs: 1, errorCategory: null },
      { nodeId: "lookup", nodeType: "mcp_tool", status: "success", durationMs: 2, errorCategory: null },
      { nodeId: "out", nodeType: "output", status: "success", durationMs: 1, errorCategory: null }
    ],
    toolCalls: [{ nodeId: "lookup", iteration: 1, server: "crm", tool: "find", args: { email: EMAIL }, argsHash: "stale" } as RunFacts["toolCalls"][number]],
    modelCalls: [],
    guard: [],
    totals: {} as RunFacts["totals"]
  };
  const cassette = {
    format: "l2m.mcp-cassette",
    version: 1,
    recordedAt: "2026-10-24T00:00:00.000Z",
    servers: [],
    entries: [{ seq: 1, server: "crm", method: "tools/call", name: "find", args: { email: EMAIL }, argsHash: "stale", result: { owner: EMAIL }, at: 0 }]
  } as unknown as McpCassette;
  const request: ModelTape["entries"][number]["request"] = { messages: [{ role: "user", content: `Who is ${EMAIL}?` }], tools: null, params: { model: "m" } };
  const modelTape = {
    format: "l2m.model-tape",
    version: 1,
    recordedAt: "2026-10-24T00:00:00.000Z",
    entries: [{ seq: 1, nodeId: "lookup", iteration: 0, providerId: "openai", model: "m", requestHash: "stale", request, response: { content: `It is ${EMAIL}` }, at: 0 }]
  } as unknown as ModelTape;
  const memorySeed: ModelMemorySeed = { sessions: [{ namespace: "ns", sessionId: EMAIL, messages: [{ role: "user", content: EMAIL }] }], truncated: false };
  return {
    input: { user_prompt: `I am ${EMAIL}`, from: "Support <support@acme.test>" },
    nodes: {
      hook: { nodeId: "hook", nodeType: "webhook_input", status: "success", output: { email: EMAIL } },
      lookup: { nodeId: "lookup", nodeType: "mcp_tool", status: "success", output: { owner: EMAIL } },
      out: { nodeId: "out", nodeType: "output", status: "success", output: { answer: "done" } }
    },
    facts,
    cassette,
    modelTape,
    memorySeed
  };
}

describe("maskCapturedRun", () => {
  it("replaces the value with one surrogate in every part and takes the match keys again over the masked content", () => {
    const masked = maskCapturedRun(run(), { key, dictionaries: [], keepLiteralsFrom: { nodes: [{ config: { note: "Mail support@acme.test" } }] } });
    const surrogate = surrogateFor(EMAIL, "email", key);
    const text = JSON.stringify(masked);
    expect(text).not.toContain(EMAIL);
    expect(text).toContain(surrogate);
    // A value the workflow itself holds stays.
    expect(text).toContain("support@acme.test");
    expect(masked.memorySeed!.sessions[0]!.sessionId).toBe(surrogate);

    const tool = masked.facts.toolCalls[0]!;
    expect(tool.args).toEqual({ email: surrogate });
    expect(tool.argsHash).toBe(sha256Hex(canonicalJson({ email: surrogate })));
    const entry = masked.cassette!.entries[0]!;
    expect(entry.argsHash).toBe(hashCassetteArgs(cassetteCanonical({ email: surrogate })));
    expect(entry.result).toEqual({ owner: surrogate });
    const tape = masked.modelTape!.entries[0]!;
    expect(tape.requestHash).toBe(hashModelRequest(canonicalTapeJson({ messages: [{ role: "user", content: `Who is ${surrogate}?` }], tools: null, params: { model: "m" } }) as ModelTape["entries"][number]["request"]));
    expect(masked.report.values).toEqual({ email: 1 });
    expect(masked.report.keptFromWorkflow).toBe(1);
  });

  it("labels each node with the classes found in it and where its content came from", () => {
    const masked = maskCapturedRun(run(), { key, dictionaries: [] });
    const facts = withNodeLabels(masked.facts, masked.report, "untrusted_external");
    const byId = Object.fromEntries(facts.nodes.map((node) => [node.nodeId, node.labels]));
    // Provenance is origin only: finding a data class adds nothing to it.
    expect(byId.hook).toEqual({ provenance: ["untrusted_external"], dataClasses: ["email"], source: "scan" });
    expect(byId.lookup).toMatchObject({ provenance: ["untrusted_external"], dataClasses: ["email"] });
    expect(byId.out).toEqual({ provenance: [], dataClasses: [], source: "scan" });
    // Unscanned (masking off): unchanged.
    expect(withNodeLabels(masked.facts, null, "untrusted_external")).toBe(masked.facts);
  });

  it("derives provenance from where the run started, never from a caller-chosen trigger name", () => {
    expect(inputProvenance("cron", "scheduler")).toBe("trusted");
    // A caller naming its queued run "cron" is a user, not the scheduler.
    expect(inputProvenance("cron", "user")).toBe("user");
    expect(inputProvenance("cron", undefined)).toBe("untrusted_external");
    expect(inputProvenance("schedule", undefined)).toBe("untrusted_external");
    expect(inputProvenance("chat", undefined)).toBe("user");
    expect(inputProvenance("api_execute", undefined)).toBe("user");
    expect(inputProvenance("webhook", undefined)).toBe("untrusted_external");
    expect(provenanceFor("webhook_input", "trusted")).toEqual(["trusted"]);
    expect(provenanceFor("http_request", "user")).toEqual(["untrusted_external"]);
    expect(provenanceFor("output", "untrusted_external")).toEqual([]);
  });

  it("masks the same way in chunks as in one go", async () => {
    const options = { key, dictionaries: [] };
    expect(JSON.stringify(await maskCapturedRunAsync(run(), options))).toBe(JSON.stringify(maskCapturedRun(run(), options)));
  });
});
