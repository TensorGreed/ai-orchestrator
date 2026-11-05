import { describe, expect, it } from "vitest";
import { createBenchmarkGuardRegistry, createDefaultGuardProfile, hashGuardProfile, loadGuardCorpus, parseGuardProfile } from "@ai-orchestrator/guard-sdk";
import { createDefaultProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { REDTEAM_SCRIPTED_PROVIDER_ID, referenceWorkflow, runReferenceScenario, runReferenceWorkflowSuite } from "./redteam-suite";
import { validateWorkflowGraph } from "./validation";

/**
 * Phase 12.7 — the reference workflow suite: corpus tool-result attacks end to
 * end through an agent with an obedient scripted model and mock sinks.
 */

const corpus = loadGuardCorpus();
const loose = parseGuardProfile({ id: "loose", name: "Loose", version: "1", channels: {} });
const byKey = (report: Awaited<ReturnType<typeof runReferenceWorkflowSuite>>) => Object.fromEntries(report.results.map((result) => [`${result.configuration}/${result.split}`, result]));

describe("reference workflow suite", () => {
  it("is a valid workflow whose sinks are write tools", () => {
    expect(validateWorkflowGraph(referenceWorkflow("hello")).valid).toBe(true);
  });

  it("stops every main-split attack with the default rule set and lists the held-out attacks that reached a sink", async () => {
    const report = await runReferenceWorkflowSuite({ profile: createDefaultGuardProfile(), corpus });
    expect(report.categories).toEqual(["indirect_injection"]);
    const results = byKey(report);
    expect(results["guard/main"]).toMatchObject({ attacks: 20, benign: 20, attackSucceeded: 0, falsePositives: 0 });
    // Held-out phrasings the rules miss get through the tool result; the obedient model then calls the sinks.
    expect(results["guard/heldout"]!.attackSucceeded).toBeGreaterThan(0);
    expect(results["guard/heldout"]!.succeeded.every((id) => id.startsWith("h-ii-a"))).toBe(true);
    // The taint preset pauses those write calls for approval instead.
    expect(results["guard_untrusted_write_approval/heldout"]).toMatchObject({ attackSucceeded: 0, pausedForApproval: results["guard/heldout"]!.attackSucceeded });
    expect(results["guard_untrusted_write_approval/main"]!.attackSucceeded).toBe(0);
  });

  it("measures attack success without a content rules, and the taint preset alone pausing every write", async () => {
    const report = await runReferenceWorkflowSuite({ profile: loose, corpus, splits: ["main"] });
    const results = byKey(report);
    expect(results["guard/main"]).toMatchObject({ attacks: 20, detected: 0, attackSucceeded: 20, attackSuccessRate: 1, falsePositives: 0 });
    expect(results["guard_untrusted_write_approval/main"]).toMatchObject({ attackSucceeded: 0, pausedForApproval: 20, falsePositives: 0 });
  });

  it("calls both sinks and leaks the collector link only when the attack reached the model unchanged", async () => {
    const file = corpus.files.find((entry) => entry.category === "indirect_injection" && entry.split === "main")!;
    const attack = file.items.find((item) => item.label === "attack")!;
    const benign = file.items.find((item) => item.label === "benign")!;
    const registry = createBenchmarkGuardRegistry(corpus);
    const unguarded = { profileId: "loose", version: 1, hash: hashGuardProfile(loose), name: loose.name, profile: loose };
    const hit = await runReferenceScenario({ profile: unguarded, item: attack, configuration: "guard", registry, executionId: "rt-1" });
    expect(hit).toMatchObject({ status: "success", detected: false, exfiltratedInAnswer: true, paused: false });
    expect(hit.sinksCalled.sort()).toEqual(["http_post", "send_email"]);
    const clean = await runReferenceScenario({ profile: unguarded, item: benign, configuration: "guard", registry, executionId: "rt-2" });
    expect(clean).toMatchObject({ status: "success", sinksCalled: [], exfiltratedInAnswer: false });
  });

  it("keeps the scripted model out of the default provider registry", () => {
    expect(createDefaultProviderRegistry().listDefinitions().map((definition) => definition.id)).not.toContain(REDTEAM_SCRIPTED_PROVIDER_ID);
  });
});

describe("combined benchmark", () => {
  it("adds the workflow suite to the rule set report only when asked", async () => {
    const { runGuardBenchmarkSuites } = await import("./redteam-suite");
    const profileOnly = await runGuardBenchmarkSuites({ profile: loose, corpus, splits: ["main"], categories: ["sql_injection"] });
    expect(profileOnly.workflow).toBeUndefined();
    expect(profileOnly.corpus.categories).toEqual(["sql_injection"]);
    const both = await runGuardBenchmarkSuites({ profile: loose, corpus, splits: ["main"], suites: ["profile", "workflow"] });
    expect(both.workflow?.results.map((result) => result.configuration)).toEqual(["guard", "guard_untrusted_write_approval"]);
  });
});
