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

  it("lists an enforced profile and its tightened copy once, with each finding and detector once", () => {
    const timings = (direct: number, dlp: number) => ({
      totalMs: direct + dlp,
      detectors: [
        { detectorId: "injection.direct", durationMs: direct, status: "ran" },
        { detectorId: "dlp.patterns", durationMs: dlp, status: "ran" }
      ]
    });
    const [node] = extractGuardTrace([
      {
        nodeId: "guard",
        output: {
          guard: {
            action: "protect",
            channel: "prompt",
            source: "enforced",
            profiles: [
              { profileId: "support-baseline", version: 2, hash: "original", name: "Support baseline" },
              { profileId: "support-baseline", version: 2, hash: "tightened", name: "Support baseline" }
            ],
            verdicts: [
              {
                profile: { profileId: "support-baseline", version: 2, hash: "original" },
                summary: summary({ action: "mask", findings: [emailFinding], actions: [{ requested: "mask", effective: "mask", shadow: false }], timings: timings(0.1, 0.4) })
              },
              {
                profile: { profileId: "support-baseline", version: 2, hash: "tightened" },
                summary: summary({ action: "protect", findings: [{ ...emailFinding, score: 0.95 }], actions: [{ requested: "protect", effective: "protect", shadow: false }], timings: timings(5.3, 0.8) })
              }
            ]
          }
        }
      }
    ]);
    expect(node!.profiles).toEqual([{ profileId: "support-baseline", version: 2, hash: "original", name: "Support baseline", tightened: true }]);
    const [verdict] = node!.verdicts;
    expect(verdict!.profiles).toHaveLength(1);
    expect(verdict!.findings).toHaveLength(1);
    expect(verdict!.findings[0]).toMatchObject({ dataClass: "email", effective: "protect", requested: "protect", score: 0.95 });
    expect(verdict!.timings).toEqual([
      { detectorId: "injection.direct", durationMs: 5.4, status: "ran" },
      { detectorId: "dlp.patterns", durationMs: 1.2, status: "ran" }
    ]);
  });

  it("keeps distinct findings of one detector apart", () => {
    const [node] = extractGuardTrace([
      {
        nodeId: "g",
        output: {
          guard: {
            channel: "prompt",
            verdicts: [
              {
                profile: { profileId: "p", version: 1, hash: "h" },
                summary: summary({ action: "block", findings: [{ ...emailFinding, evidence: "a" }, { ...emailFinding, evidence: "b" }] })
              }
            ]
          }
        }
      }
    ]);
    expect(node!.verdicts[0]!.findings.map((finding) => finding.evidence)).toEqual(["a", "b"]);
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

describe("verdictReasonLine (Phase 16)", () => {
  const base = { shadow: false, category: "pii", dataClass: "card_number", channel: "egress" as const, evidence: [] };
  it("a destination rule gives its own reason; shadow says would have", async () => {
    const { verdictReasonLine } = await import("./guard-trace");
    const message = 'Rule "Keep sensitive data in-house": Data of class card_number may go no further than private network; this destination is api.example.com (public)';
    const event = { ...base, effectiveAction: "block" as const, detectorId: "<destinations>", evidence: [{ detectorId: "<destinations>", category: "destination", score: 1, evidence: "", spans: [], message }] };
    expect(verdictReasonLine(event)).toBe(`Blocked: ${message}.`);
    expect(verdictReasonLine({ ...event, shadow: true })).toBe(`Would have been blocked: ${message}.`);
  });
  it("other findings say what was found where; allowed and rewritten verdicts have none", async () => {
    const { verdictReasonLine } = await import("./guard-trace");
    expect(verdictReasonLine({ ...base, effectiveAction: "require_approval", detectorId: "dlp.patterns" })).toBe("Held for approval: card number found in the outbound (egress).");
    expect(verdictReasonLine({ ...base, effectiveAction: "redact", detectorId: "dlp.patterns" })).toBeNull();
    expect(verdictReasonLine({ ...base, effectiveAction: "block", detectorId: null })).toBeNull();
  });
});
