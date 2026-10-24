import { describe, expect, it } from "vitest";
import { canonicalJson, type McpCassette, type ModelMemorySeed, type ModelTape, type RunFacts } from "@ai-orchestrator/shared";
import { surrogateFor } from "@ai-orchestrator/guard-sdk";
import { canonicalJson as cassetteCanonical, hashCassetteArgs } from "@ai-orchestrator/mcp-sdk";
import { canonicalTapeJson, hashModelRequest } from "@ai-orchestrator/provider-sdk";
import { sha256Hex } from "./audit-bundle-service.js";
import { inputProvenance, maskCapturedRun, maskCapturedRunAsync, provenanceFor, withNodeLabels, type CapturedRunParts } from "./capture-masking.js";

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
    // An API-key run of the execute routes keeps its `manual` trigger; the server passes its origin.
    expect(inputProvenance("manual", "user")).toBe("user");
    expect(inputProvenance("webhook", undefined)).toBe("untrusted_external");
    expect(provenanceFor("webhook_input", "trusted")).toEqual(["trusted"]);
    expect(provenanceFor("http_request", "user")).toEqual(["untrusted_external"]);
    expect(provenanceFor("output", "untrusted_external")).toEqual([]);
  });

  it("masks the same way in chunks as in one go", async () => {
    const options = { key, dictionaries: [] };
    expect(JSON.stringify(await maskCapturedRunAsync(run(), options))).toBe(JSON.stringify(maskCapturedRun(run(), options)));
  });

  // Re-review N1: a resource URI (the cassette entry's `name`) held the raw email.
  it("masks a cassette entry's name (resource URI), server key and every other string, and a replay of the masked input asks for the masked URI", () => {
    const base: CapturedRunParts = run();
    const uri = `crm://customers/${EMAIL}/profile`;
    base.cassette = {
      ...base.cassette!,
      servers: [{ key: `inline:http-mcp:${EMAIL}`, adapterId: "http-mcp", label: `CRM for ${EMAIL}` }],
      entries: [
        {
          seq: 1,
          server: `inline:http-mcp:${EMAIL}`,
          method: "resources/read",
          name: uri,
          argsHash: "stale",
          result: { contents: [{ uri, text: "profile" }] },
          at: 0,
          durationMs: 1
        }
      ]
    } as McpCassette;
    const masked = maskCapturedRun(base, { key, dictionaries: [] });
    const surrogate = surrogateFor(EMAIL, "email", key);
    expect(JSON.stringify(masked)).not.toContain(EMAIL);
    const entry = masked.cassette!.entries[0]!;
    // The workflow resolves the URI from the (masked) input, so a replay asks for exactly this name.
    expect(entry.name).toBe(`crm://customers/${surrogate}/profile`);
    expect(entry.server).toBe(masked.cassette!.servers[0]!.key);
    expect(masked.cassette!.servers[0]).toMatchObject({ adapterId: "http-mcp", label: `CRM for ${surrogate}` });
    expect(entry).toMatchObject({ seq: 1, method: "resources/read", at: 0, durationMs: 1 });
  });

  it("finds the value only in a resource URI and masks it there and everywhere else", () => {
    const base: CapturedRunParts = run();
    base.input = { user_prompt: "show the profile" };
    base.nodes = {};
    base.facts = { ...base.facts, output: null, toolCalls: [] };
    base.modelTape = null;
    base.memorySeed = null;
    base.cassette = {
      ...base.cassette!,
      entries: [{ seq: 1, server: "crm", method: "resources/read", name: "crm://customers/jane.doe@example.com/profile", argsHash: "stale", at: 0, durationMs: 1 }]
    } as McpCassette;
    const masked = maskCapturedRun(base, { key, dictionaries: [] });
    expect(masked.cassette!.entries[0]!.name).toBe(`crm://customers/${surrogateFor(EMAIL, "email", key)}/profile`);
    expect(masked.report.values).toEqual({ email: 1 });
  });

  it("property: no detected value survives in any field of any cassette entry", () => {
    const values = [EMAIL, "+44 20 7946 0958", "4111 1111 1111 1111", "GB82 WEST 1234 5698 7654 32", "536-90-4399"];
    const fields = ["server", "name", "args", "result", "error", "exchanges", "futureField"] as const;
    for (const value of values) {
      for (const field of fields) {
        const base: CapturedRunParts = run();
        const entry: Record<string, unknown> = { seq: 1, server: "crm", method: "tools/call", name: "find", argsHash: "stale", at: 0, durationMs: 1 };
        entry[field] =
          field === "args" || field === "result"
            ? { nested: [{ text: `see ${value}` }] }
            : field === "exchanges"
              ? [{ kind: "sampling", at: 0, request: { text: value }, response: { text: `ok ${value}` } }]
              : `x ${value} y`;
        base.input = { user_prompt: "nothing here" };
        base.cassette = { ...base.cassette!, servers: [{ key: "crm", adapterId: "mock-mcp", label: field === "server" ? `crm ${value}` : "crm" }], entries: [entry] } as unknown as McpCassette;
        const masked = maskCapturedRun(base, { key, dictionaries: [] });
        const stored = JSON.stringify(masked.cassette);
        expect(stored, `${field}: ${value}`).not.toContain(value);
        expect(stored.replace(/\D/g, ""), `${field}: ${value}`).not.toContain(value.replace(/\D/g, "").length >= 9 ? value.replace(/\D/g, "").slice(-8) : "@@");
      }
    }
  });
});
