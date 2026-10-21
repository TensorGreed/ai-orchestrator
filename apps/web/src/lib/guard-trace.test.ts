import { describe, expect, it } from "vitest";
import type { GuardEventView } from "@ai-orchestrator/shared";
import { dailySeries, extractGuardTrace, guardMarkerFor, mostSevere, traceFromEvents } from "./guard-trace";

const summary = (overrides: Record<string, unknown> = {}) => ({
  action: "allow",
  blocked: false,
  channel: "prompt",
  transformed: false,
  findings: [],
  actions: [],
  shadowAction: "allow",
  protectedCount: 0,
  timings: { totalMs: 1.5, detectors: [{ detectorId: "guard.injection.direct", durationMs: 1.2, status: "ran" }] },
  budget: { limitMs: 2000, exceeded: false, policy: "fail_closed", skippedDetectors: [] },
  profile: { id: "default", version: "1", hash: "abc" },
  ...overrides
});

const emailFinding = { detectorId: "guard.dlp", category: "sensitive_data", dataClass: "email", score: 0.9, evidence: "j***@e***.com", message: "Email address" };

describe("guard trace", () => {
  it("orders actions by severity", () => {
    expect(mostSevere(["allow", "mask", "review"])).toBe("review");
    expect(mostSevere(["redact", "block", "require_approval"])).toBe("block");
    expect(mostSevere([])).toBe("allow");
  });

  it("reads guard node verdicts with masked evidence, shadow and timings", () => {
    const nodes = extractGuardTrace([
      {
        nodeId: "g1",
        status: "success",
        output: {
          guard: {
            action: "mask",
            route: "pass",
            channel: "prompt",
            source: "workflow",
            profiles: [{ profileId: "strict", version: 3, hash: "h3" }],
            verdicts: [
              {
                profile: { profileId: "strict", version: 3, hash: "h3" },
                summary: summary({
                  action: "mask",
                  shadowAction: "block",
                  findings: [emailFinding],
                  actions: [{ detectorId: "guard.dlp", requested: "mask", effective: "mask", shadow: false }]
                })
              }
            ]
          }
        }
      }
    ]);
    expect(nodes).toHaveLength(1);
    const [node] = nodes;
    expect(node!.placement).toBe("node");
    expect(node!.source).toBe("workflow");
    expect(node!.verdicts[0]!.action).toBe("mask");
    expect(node!.verdicts[0]!.shadowAction).toBe("block");
    expect(node!.verdicts[0]!.findings[0]).toMatchObject({ evidence: "j***@e***.com", effective: "mask", dataClass: "email" });
    expect(node!.verdicts[0]!.timings[0]!.detectorId).toBe("guard.injection.direct");
  });

  it("reads agent verdicts per step and channel", () => {
    const [node] = extractGuardTrace([
      {
        nodeId: "agent",
        output: {
          answer: "ok",
          _guard: {
            source: "enforced",
            profiles: [{ profileId: "org", version: 2, name: "Org baseline" }],
            chain: [{ level: "project", mode: "enforced", profileId: "org", version: 2 }],
            spotlighting: "datamark",
            canary: true,
            verdicts: [
              { iteration: 0, channel: "prompt", action: "allow", verdicts: [{ profile: { profileId: "org", version: 2 }, summary: summary() }] },
              {
                iteration: 1,
                channel: "tool_result",
                toolName: "search",
                action: "block",
                verdicts: [{ profile: { profileId: "org", version: 2 }, summary: summary({ action: "block", findings: [{ ...emailFinding, detectorId: "guard.injection.indirect", category: "indirect_injection" }] }) }]
              }
            ]
          }
        }
      }
    ]);
    expect(node!.placement).toBe("agent");
    expect(node!.canary).toBe(true);
    expect(node!.spotlighting).toBe("datamark");
    expect(node!.profiles[0]!.name).toBe("Org baseline");
    expect(node!.verdicts.map((verdict) => [verdict.iteration, verdict.channel, verdict.action])).toEqual([
      [0, "prompt", "allow"],
      [1, "tool_result", "block"]
    ]);
    expect(node!.verdicts[1]!.toolName).toBe("search");
  });

  it("rebuilds nodes without an output trace from guard events", () => {
    const base: GuardEventView = {
      id: "e1",
      verdictId: "v1",
      executionId: "x",
      workflowId: "wf",
      projectId: "default",
      nodeId: "failed-agent",
      placement: "agent",
      iteration: 2,
      channel: "final_output",
      detectorId: "guard.canary",
      category: "canary_leak",
      score: 1,
      requestedAction: "block",
      effectiveAction: "block",
      verdictAction: "block",
      shadow: false,
      evidence: [{ evidence: "L2M-****", message: "Canary token" }],
      profileId: "default",
      profileVersion: 1,
      profileHash: "h",
      latencyMs: 3,
      budgetExceeded: false,
      skippedDetectors: [],
      createdAt: new Date().toISOString()
    } as GuardEventView;
    const nodes = traceFromEvents([base, { ...base, id: "e2", nodeId: "known" }], new Set(["known"]));
    expect(nodes.map((node) => node.nodeId)).toEqual(["failed-agent"]);
    expect(nodes[0]!.verdicts[0]).toMatchObject({ channel: "final_output", action: "block", iteration: 2 });
    expect(nodes[0]!.verdicts[0]!.findings[0]!.evidence).toBe("L2M-****");
  });

  it("marks run tape lanes by the most severe outcome", () => {
    expect(guardMarkerFor({ error: "Guard blocked the final answer", status: "error" })?.kind).toBe("blocked");
    const review = { guard: { action: "review", route: "review", channel: "prompt", verdicts: [{ profile: { profileId: "p", version: 1 }, summary: summary({ action: "review" }) }] } };
    expect(guardMarkerFor({ output: review, status: "success" })?.kind).toBe("review");
    expect(guardMarkerFor({ output: review, status: "waiting_approval" })?.kind).toBe("approval");
    const masked = { guard: { action: "mask", route: "pass", channel: "prompt", verdicts: [{ profile: { profileId: "p", version: 1 }, summary: summary({ action: "mask" }) }] } };
    expect(guardMarkerFor({ output: masked, status: "success" })?.kind).toBe("rewritten");
    const clean = { guard: { action: "allow", route: "pass", channel: "prompt", verdicts: [{ profile: { profileId: "p", version: 1 }, summary: summary() }] } };
    expect(guardMarkerFor({ output: clean, status: "success" })).toBeNull();
    expect(guardMarkerFor({ output: { answer: "x" } })).toBeNull();
  });

  it("fills a zero for every day of the chart", () => {
    const now = new Date(Date.UTC(2026, 9, 21));
    const series = dailySeries(
      [
        { day: "2026-10-21", action: "block", count: 2 },
        { day: "2026-10-20", action: "mask", count: 1 },
        { day: "2026-10-20", action: "require_approval", count: 4 },
        { day: "2026-01-01", action: "block", count: 9 }
      ],
      3,
      now
    );
    expect(series.map((entry) => entry.day)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(series[1]).toMatchObject({ rewritten: 1, review: 4 });
    expect(series[2]!.blocked).toBe(2);
  });
});
