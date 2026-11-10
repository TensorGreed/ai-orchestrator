import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEgressGuardDetector, GuardRegistry, type GuardDetector } from "@ai-orchestrator/guard-sdk";
import type { Workflow } from "@ai-orchestrator/shared";
import {
  builtInGuardProfile,
  runGuardCheck,
  runVerdictMemoOf,
  type GuardEvalScope,
  type GuardRuntimeDependencies,
  type GuardVerdictEvent
} from "./guard-runtime";
import { exportWorkflowToJson, importWorkflowFromJson } from "./serialization";

/**
 * Phase 12 coverage, schema lane — the per-run verdict memo on a check's
 * scope, and proof that workflows written before the change import and
 * export exactly as before.
 */

const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "samples", "workflows");

describe("workflows written before the coverage fields", () => {
  it("import, export and import again unchanged (every sample)", () => {
    const files = readdirSync(SAMPLES_DIR).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const first = importWorkflowFromJson(readFileSync(join(SAMPLES_DIR, file), "utf8"));
      const again = importWorkflowFromJson(exportWorkflowToJson(first));
      expect(again, file).toEqual(first);
    }
  });

  it("keep a Content Rules node and a protection provider exactly as written", () => {
    const workflow = {
      id: "wf-rules",
      name: "Rules",
      schemaVersion: "1.0.0",
      workflowVersion: 3,
      nodes: [
        { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
        {
          id: "rules",
          type: "guard",
          name: "Content Rules",
          position: { x: 200, y: 0 },
          config: { profileId: "strict", channel: "final_output", inputField: "text", labels: ["model_generated"], timeoutMinutes: 30 }
        },
        {
          id: "vault",
          type: "guard_protection",
          name: "Vault",
          position: { x: 200, y: 200 },
          config: { providerId: "token_vault", dataClasses: ["card_number"], protectMatches: true }
        }
      ],
      edges: [
        { id: "e1", source: "in", target: "rules" },
        { id: "e2", source: "vault", target: "rules", targetHandle: "protection" }
      ]
    };
    const imported = importWorkflowFromJson(JSON.stringify(workflow)) as Workflow;
    const rules = imported.nodes.find((node) => node.id === "rules");
    expect(rules?.config).toEqual(workflow.nodes[1]!.config);
    expect(importWorkflowFromJson(exportWorkflowToJson(imported))).toEqual(imported);
  });
});

function countingRegistry(counter: { calls: number }, flag: string): GuardRegistry {
  const detector: GuardDetector = {
    id: "test.flag",
    tier: "rule",
    description: "flags a marker word",
    channels: ["prompt", "final_output", "response", "tool_result"],
    categories: ["custom"],
    detect: (_input, context) => {
      counter.calls += 1;
      const at = context.text.indexOf(flag);
      return at < 0 ? [] : [{ detectorId: "test.flag", category: "custom", score: 0.9, spans: [{ start: at, end: at + flag.length }], evidence: "…", message: "marker" }];
    }
  };
  return new GuardRegistry().register(detector);
}

function setup(options: { memo: boolean; action?: "block" | "allow" | "redact" }) {
  const counter = { calls: 0 };
  const events: GuardVerdictEvent[] = [];
  const builtIn = builtInGuardProfile();
  const profile = {
    ...builtIn,
    profile: {
      ...builtIn.profile,
      channels: {
        final_output: {
          detectors: [{ id: "test.flag", threshold: 0.5, options: {} }],
          actions: { custom: { action: options.action ?? "block" } },
          defaultAction: { action: "block" as const }
        }
      }
    }
  };
  const guard: GuardRuntimeDependencies = {
    registry: countingRegistry(counter, "MARKER"),
    resolveRun: () => ({ source: "none", stack: [], chain: [] }),
    loadProfile: () => undefined,
    onVerdict: (event) => {
      events.push(event);
    }
  };
  const scope: GuardEvalScope = {
    guard,
    resolveSecret: async () => undefined,
    executionId: "exec-1",
    workflowId: "wf-1",
    nodeId: "n1",
    placement: "response",
    ...(options.memo ? { memo: runVerdictMemoOf(guard) } : {})
  };
  return { counter, events, scope, profiles: [profile], guard };
}

describe("per-run verdict memo", () => {
  it("without a memo, every check runs and records as before", async () => {
    const { counter, events, scope, profiles } = setup({ memo: false });
    const first = await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good" });
    const second = await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good" });
    expect(counter.calls).toBe(2);
    expect(events).toHaveLength(2);
    expect(first.memoHit).toBeUndefined();
    expect(second.memoHit).toBeUndefined();
  });

  it("a repeated clean check is answered from the memo and records nothing", async () => {
    const { counter, events, scope, profiles } = setup({ memo: true });
    const first = await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good" });
    const second = await runGuardCheck({ ...scope, nodeId: "n2" }, profiles, { channel: "final_output", content: "all good" });
    expect(counter.calls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.placement).toBe("response");
    expect(first.memoHit).toBeUndefined();
    expect(second).toMatchObject({ action: "allow", content: "all good", transformed: false, memoHit: true });
    expect(second.verdicts).toEqual(first.verdicts);
  });

  it("misses on other content, channel or labels", async () => {
    const { counter, scope, profiles } = setup({ memo: true });
    await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good" });
    await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good!" });
    await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good", labels: ["untrusted_external"] });
    expect(counter.calls).toBe(3);
  });

  it("never memoises a finding, a block or a rewrite", async () => {
    for (const action of ["block", "allow", "redact"] as const) {
      const { counter, events, scope, profiles } = setup({ memo: true, action });
      const first = await runGuardCheck(scope, profiles, { channel: "final_output", content: "has MARKER inside" });
      const second = await runGuardCheck(scope, profiles, { channel: "final_output", content: "has MARKER inside" });
      expect(counter.calls, action).toBe(2);
      expect(events, action).toHaveLength(2);
      expect(first.memoHit).toBeUndefined();
      expect(second.memoHit).toBeUndefined();
    }
  });

  it("is one memo per run, never shared across runs", async () => {
    const a = setup({ memo: true });
    const b = setup({ memo: true });
    expect(runVerdictMemoOf(a.guard)).toBe(runVerdictMemoOf(a.guard));
    expect(runVerdictMemoOf(a.guard)).not.toBe(runVerdictMemoOf(b.guard));
  });

  it("a standalone run keys its memo on its own run object, so two runs never share one", () => {
    const { guard } = setup({ memo: false });
    const runA = new Map<string, unknown>();
    const runB = new Map<string, unknown>();
    expect(runVerdictMemoOf(guard, runA)).toBe(runVerdictMemoOf(guard, runA));
    expect(runVerdictMemoOf(guard, runA)).not.toBe(runVerdictMemoOf(guard, runB));
    expect(runVerdictMemoOf(guard, runA)).not.toBe(runVerdictMemoOf(guard));
  });

  it("stores nothing when the first check did not record (no recorder or no execution id)", async () => {
    const { counter, scope, profiles } = setup({ memo: true });
    const silent = { ...scope, executionId: "" };
    await runGuardCheck(silent, profiles, { channel: "final_output", content: "all good" });
    const second = await runGuardCheck(scope, profiles, { channel: "final_output", content: "all good" });
    expect(second.memoHit).toBeUndefined();
    expect(counter.calls).toBe(2);
  });

  it("never answers a tool-arguments check from the memo: a DNS change between two checks still blocks", async () => {
    let address = "93.184.216.34";
    const registry = new GuardRegistry().register(createEgressGuardDetector({ resolver: async () => [address] }));
    const builtIn = builtInGuardProfile();
    const profile = {
      ...builtIn,
      profile: {
        ...builtIn.profile,
        channels: { tool_arguments: { detectors: [{ id: "tool.egress", threshold: 0.5, options: {} }], actions: { egress: { action: "block" as const } }, defaultAction: { action: "block" as const } } }
      }
    };
    const events: GuardVerdictEvent[] = [];
    const guard: GuardRuntimeDependencies = { registry, resolveRun: () => ({ source: "none", stack: [], chain: [] }), loadProfile: () => undefined, onVerdict: (event) => void events.push(event) };
    const scope: GuardEvalScope = { guard, resolveSecret: async () => undefined, executionId: "exec-dns", workflowId: "wf", nodeId: "agent", placement: "agent", memo: runVerdictMemoOf(guard) };
    const input = { channel: "tool_arguments" as const, content: { url: "http://rebind.example.com/x" }, tool: { toolName: "fetch" } };
    const first = await runGuardCheck(scope, [profile], input);
    expect(first.action).toBe("allow");
    address = "127.0.0.1";
    const second = await runGuardCheck(scope, [profile], input);
    expect(second.memoHit).toBeUndefined();
    expect(second.action).toBe("block");
    expect(events).toHaveLength(2);
  });

  it("never answers from the memo when the egress detector sits on a content channel", async () => {
    let address = "93.184.216.34";
    const registry = new GuardRegistry().register({ ...createEgressGuardDetector({ resolver: async () => [address] }), channels: ["tool_result"] });
    const builtIn = builtInGuardProfile();
    const profile = {
      ...builtIn,
      profile: {
        ...builtIn.profile,
        channels: { tool_result: { detectors: [{ id: "tool.egress", threshold: 0.5, options: {} }], actions: { egress: { action: "block" as const } }, defaultAction: { action: "block" as const } } }
      }
    };
    const guard: GuardRuntimeDependencies = { registry, resolveRun: () => ({ source: "none", stack: [], chain: [] }), loadProfile: () => undefined, onVerdict: () => undefined };
    const scope: GuardEvalScope = { guard, resolveSecret: async () => undefined, executionId: "exec-dns2", workflowId: "wf", nodeId: "n", placement: "node", memo: runVerdictMemoOf(guard) };
    const input = { channel: "tool_result" as const, content: "see http://rebind.example.com/x" };
    expect((await runGuardCheck(scope, [profile], input)).action).toBe("allow");
    address = "127.0.0.1";
    const second = await runGuardCheck(scope, [profile], input);
    expect(second.memoHit).toBeUndefined();
  });
});
