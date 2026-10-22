import { describe, expect, it } from "vitest";
import { nodeDefinitions } from "./definitions";
import {
  judgeReplayDiff,
  REPLAY_ALWAYS_STUBBED_CLASSES,
  REPLAY_NODE_CLASSES,
  replayNodeClass,
  replayRunRequestSchema,
  type RunDiff
} from "./replay";

function emptyDelta() {
  return { baseline: 0, candidate: 0, delta: 0, pct: 0 };
}

function cleanDiff(overrides: Partial<RunDiff> = {}): RunDiff {
  return {
    status: { baseline: "success", candidate: "success", changed: false, regression: false },
    output: { equal: true, changes: [], ignored: 0, ignorePaths: [] },
    toolCalls: { baselineCount: 0, candidateCount: 0, changed: false, steps: [], countDelta: [] },
    path: { added: [], removed: [], statusChanges: [] },
    models: { changes: [], callDelta: emptyDelta() },
    totals: { tokens: emptyDelta(), costUsd: emptyDelta(), latencyMs: emptyDelta(), toolCalls: emptyDelta() },
    guard: { added: [], removed: [], changed: [] },
    health: [],
    ...overrides
  };
}

describe("replay node classes", () => {
  it("classifies every node definition", () => {
    const missing = nodeDefinitions.filter((definition) => !Object.prototype.hasOwnProperty.call(REPLAY_NODE_CLASSES, definition.type));
    expect(missing.map((definition) => definition.type)).toEqual([]);
  });

  it("never lets a connector node run live", () => {
    const live = nodeDefinitions
      .filter((definition) => definition.category === "Connector")
      .filter((definition) => !REPLAY_ALWAYS_STUBBED_CLASSES.has(replayNodeClass({ type: definition.type })));
    expect(live.map((definition) => definition.type)).toEqual([]);
  });

  it("stubs every send, create, update, put, query and charge node", () => {
    const sideEffectNames = /(send|create|update|append|put_object|query|command|operation|charge|action|http|execute_workflow|storage|cosmos|vector_store)/;
    const offenders = nodeDefinitions
      .filter((definition) => sideEffectNames.test(definition.type))
      .filter((definition) => !REPLAY_ALWAYS_STUBBED_CLASSES.has(replayNodeClass({ type: definition.type })));
    expect(offenders.map((definition) => definition.type)).toEqual([]);
  });

  it("treats unknown types and prototype keys as writes", () => {
    for (const type of ["community_send_fax", "constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      expect(replayNodeClass({ type })).toBe("write");
    }
  });

  it("answers every code node from the recording, Python and JavaScript alike", () => {
    // The JavaScript sandbox is not an isolate: host intrinsics reach `process`, so user code is never run in a replay.
    for (const config of [{ language: "python", code: "import urllib" }, { language: "javascript" }, undefined]) {
      const nodeClass = replayNodeClass({ type: "code_node", config });
      expect(nodeClass).toBe("code");
      expect(REPLAY_ALWAYS_STUBBED_CLASSES.has(nodeClass)).toBe(true);
    }
  });

  it("answers an HTML-rendered PDF from the recording, since Chromium loads whatever the page asks for", () => {
    expect(replayNodeClass({ type: "pdf_output", config: { renderMode: "html", htmlTemplate: "<img src='https://x.test/a.png'>" } })).toBe("read");
    expect(replayNodeClass({ type: "pdf_output", config: { renderMode: "text" } })).toBe("logic");
    expect(replayNodeClass({ type: "pdf_output" })).toBe("logic");
  });

  it("classes the output parser as a model node, since it can ask the model to repair its output", () => {
    expect(replayNodeClass({ type: "output_parser" })).toBe("model");
  });

  it("keeps models, guard and MCP live-or-cassette and session state sandboxed", () => {
    expect(replayNodeClass({ type: "agent_orchestrator" })).toBe("model");
    expect(replayNodeClass({ type: "guard" })).toBe("guard");
    expect(replayNodeClass({ type: "mcp_tool" })).toBe("mcp");
    expect(replayNodeClass({ type: "local_memory" })).toBe("sandboxed");
    expect(replayNodeClass({ type: "human_approval" })).toBe("approval");
    expect(replayNodeClass({ type: "wait_node" })).toBe("wait");
  });
});

describe("replay request", () => {
  it("accepts the draft or a version, not both, and refuses unknown fields", () => {
    expect(replayRunRequestSchema.safeParse({}).success).toBe(true);
    expect(replayRunRequestSchema.safeParse({ draft: true, mcpMode: "lenient" }).success).toBe(true);
    expect(replayRunRequestSchema.safeParse({ version: 3 }).success).toBe(true);
    expect(replayRunRequestSchema.safeParse({ draft: true, version: 3 }).success).toBe(false);
    expect(replayRunRequestSchema.safeParse({ mcpMode: "live" }).success).toBe(false);
    expect(replayRunRequestSchema.safeParse({ live: true }).success).toBe(false);
    expect(replayRunRequestSchema.safeParse({ version: 0 }).success).toBe(false);
  });
});

describe("judgeReplayDiff", () => {
  it("passes a clean diff", () => {
    expect(judgeReplayDiff(cleanDiff())).toEqual({ verdict: "pass", reasons: [] });
  });

  it("fails on a status regression or an output change", () => {
    const regressed = judgeReplayDiff(cleanDiff({ status: { baseline: "success", candidate: "error", changed: true, regression: true } }));
    expect(regressed.verdict).toBe("fail");
    expect(regressed.reasons[0]).toContain("success → error");
    const changed = judgeReplayDiff(
      cleanDiff({ output: { equal: false, changes: [{ path: "answer", kind: "changed", baseline: "a", candidate: "b" }], ignored: 0, ignorePaths: [] } })
    );
    expect(changed).toEqual({ verdict: "fail", reasons: ["Output changed at 1 path (answer)"] });
  });

  it("reports tool and cost changes without failing", () => {
    const diff = cleanDiff({ toolCalls: { baselineCount: 1, candidateCount: 2, changed: true, steps: [], countDelta: [] } });
    expect(judgeReplayDiff(diff).verdict).toBe("pass");
  });

  it("is inconclusive when the replay could not be trusted", () => {
    const diff = cleanDiff({
      status: { baseline: "success", candidate: "error", changed: true, regression: true },
      health: [{ kind: "mcp_unmatched", nodeId: "tool", message: "1 MCP call had no recorded answer", blocking: true }]
    });
    expect(judgeReplayDiff(diff)).toEqual({ verdict: "error", reasons: ["1 MCP call had no recorded answer"] });
    const advisory = cleanDiff({ health: [{ kind: "unrecorded_stub", nodeId: "slack", message: "stubbed", blocking: false }] });
    expect(judgeReplayDiff(advisory).verdict).toBe("pass");
  });
});
