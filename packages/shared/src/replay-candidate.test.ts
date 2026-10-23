import { describe, expect, it } from "vitest";
import {
  aggregateReplayAttempts,
  applyCandidate,
  effectiveModelFor,
  liveReadNodeProblems,
  normaliseCandidateOverrides,
  ReplayCandidateError,
  replayCandidateOverridesSchema
} from "./replay";
import { replayJobRequestSchema } from "./evals";
import { mcpCassetteSchema } from "./mcp-testing";
import type { Workflow } from "./types";

function workflow(): Workflow {
  return {
    id: "wf",
    name: "Agents",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "agent_1", type: "agent_orchestrator", name: "Agent 1", position: { x: 0, y: 0 }, config: {} },
      { id: "model_1", type: "openai_chat_model", name: "Model 1", position: { x: 0, y: 0 }, config: { model: "gpt-4o-mini" } },
      { id: "agent_2", type: "agent_orchestrator", name: "Agent 2", position: { x: 0, y: 0 }, config: {} },
      { id: "model_2", type: "llm_call", name: "Model 2", position: { x: 0, y: 0 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini", temperature: 0 } } },
      { id: "summary", type: "llm_call", name: "Summary", position: { x: 0, y: 0 }, config: { provider: { providerId: "anthropic", model: "claude-haiku" } } },
      { id: "sheet", type: "google_sheets_read", name: "Sheet", position: { x: 0, y: 0 }, config: {} },
      { id: "slack", type: "slack_send_message", name: "Slack", position: { x: 0, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "agent_1", sourceHandle: "chat_model", target: "model_1" },
      { id: "e2", source: "agent_2", sourceHandle: "chat_model", target: "model_2" }
    ]
  } as Workflow;
}

describe("applyCandidate", () => {
  it("changes the chat model attached to an agent, and leaves the input untouched", () => {
    const base = workflow();
    const out = applyCandidate(base, { models: [{ nodeId: "agent_1", model: "gpt-5-mini" }] });
    expect(effectiveModelFor(out, "agent_1")).toEqual({ providerId: "openai", model: "gpt-5-mini" });
    expect(effectiveModelFor(out, "agent_2")).toEqual({ providerId: "openai", model: "gpt-4o-mini" });
    expect(effectiveModelFor(base, "agent_1")).toEqual({ providerId: "openai", model: "gpt-4o-mini" });
  });

  it("changes provider and model of an LLM Call node", () => {
    const out = applyCandidate(workflow(), { models: [{ nodeId: "model_2", provider: "anthropic", model: "claude-sonnet" }] });
    expect(out.nodes.find((node) => node.id === "model_2")!.config).toEqual({ provider: { providerId: "anthropic", model: "claude-sonnet", temperature: 0 } });
  });

  it("refuses a provider change on a typed chat model node", () => {
    expect(() => applyCandidate(workflow(), { models: [{ nodeId: "model_1", provider: "anthropic", model: "x" }] })).toThrow(ReplayCandidateError);
  });

  it("changes every node of a provider", () => {
    const out = applyCandidate(workflow(), { models: [{ provider: "openai", model: "gpt-5" }] });
    expect(effectiveModelFor(out, "agent_1")?.model).toBe("gpt-5");
    expect(effectiveModelFor(out, "agent_2")?.model).toBe("gpt-5");
    expect(effectiveModelFor(out, "summary")?.model).toBe("claude-haiku");
  });

  it("refuses overrides that match nothing", () => {
    expect(() => applyCandidate(workflow(), { models: [{ nodeId: "missing", model: "x" }] })).toThrow(/no node missing/);
    expect(() => applyCandidate(workflow(), { models: [{ nodeId: "sheet", model: "x" }] })).toThrow(/no model to change/);
    expect(() => applyCandidate(workflow(), { models: [{ provider: "gemini", model: "x" }] })).toThrow(/provider gemini/);
  });

  it("returns an equal copy without model overrides", () => {
    const base = workflow();
    const out = applyCandidate(base, { guardProfile: { profileId: "strict" } });
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });
});

describe("liveReadNodeProblems", () => {
  it("allows reads and refuses writes, logic and unknown nodes", () => {
    expect(liveReadNodeProblems(workflow(), ["sheet"])).toEqual([]);
    expect(liveReadNodeProblems(workflow(), ["slack"])[0]).toMatch(/never run those live/);
    expect(liveReadNodeProblems(workflow(), ["agent_1"])[0]).toMatch(/not an external read/);
    expect(liveReadNodeProblems(workflow(), ["nope"])[0]).toMatch(/no node nope/);
  });
});

describe("aggregateReplayAttempts", () => {
  it("applies all, majority and any", () => {
    expect(aggregateReplayAttempts(["pass", "pass", "pass"], "all")).toBe("pass");
    expect(aggregateReplayAttempts(["pass", "fail", "pass"], "all")).toBe("fail");
    expect(aggregateReplayAttempts(["pass", "error", "pass"], "all")).toBe("error");
    expect(aggregateReplayAttempts(["pass", "fail", "pass"], "majority")).toBe("pass");
    expect(aggregateReplayAttempts(["pass", "fail", "fail"], "majority")).toBe("fail");
    expect(aggregateReplayAttempts(["pass", "error", "error"], "majority")).toBe("error");
    expect(aggregateReplayAttempts(["fail", "fail", "pass"], "any")).toBe("pass");
    expect(aggregateReplayAttempts(["fail", "error"], "any")).toBe("fail");
    expect(aggregateReplayAttempts(["error"], "any")).toBe("error");
    expect(aggregateReplayAttempts([], "all")).toBe("error");
  });
});

describe("candidate request schema", () => {
  it("accepts the 15.3 fields and keeps the candidate choices exclusive", () => {
    const ok = replayJobRequestSchema.safeParse({
      datasetIds: ["ds"],
      workflow: { id: "wf" },
      overrides: { models: [{ nodeId: "agent_1", model: "x" }], guardProfile: { profileId: "p", version: 2 }, mcpServers: { srv: "live_read_only" }, liveReadNodes: ["sheet"] },
      models: "replay",
      compare: "baseline_rerun",
      repeats: 3,
      aggregate: "majority"
    });
    expect(ok.success).toBe(true);
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds"], workflow: { id: "wf" }, version: 2 }).success).toBe(false);
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds"], repeats: 6 }).success).toBe(false);
    expect(replayJobRequestSchema.safeParse({ datasetIds: ["ds"], mcpServers: {} }).success).toBe(false);
    expect(replayCandidateOverridesSchema.safeParse({ models: [{ model: "x" }] }).success).toBe(false);
    expect(replayCandidateOverridesSchema.safeParse({ mcpServers: { srv: "live" } }).success).toBe(false);
  });

  it("drops empty overrides", () => {
    expect(normaliseCandidateOverrides({ models: [], mcpServers: {}, liveReadNodes: [] })).toBeUndefined();
    expect(normaliseCandidateOverrides({ liveReadNodes: ["a", "a"] })).toEqual({ liveReadNodes: ["a"] });
  });

  it("reads cassettes with and without a model tape", () => {
    const base = { format: "l2m.mcp-cassette", version: 1, recordedAt: "2026-01-01T00:00:00Z", servers: [], entries: [], truncated: false, bytes: 0 };
    expect(mcpCassetteSchema.safeParse({ ...base, llm: "not_recorded" }).success).toBe(true);
    expect(
      mcpCassetteSchema.safeParse({
        ...base,
        llm: "tape",
        models: { format: "l2m.model-tape", version: 1, recordedAt: "2026-01-01T00:00:00Z", entries: [], truncated: false, bytes: 0 },
        memorySeed: { sessions: [], truncated: false }
      }).success
    ).toBe(true);
  });
});
