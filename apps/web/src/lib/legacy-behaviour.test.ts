import { getNodeDefinition } from "@ai-orchestrator/shared";
import { describe, expect, it } from "vitest";
import { behavioursOffDefault, legacyBehaviours, legacySummary, restoreOldBehaviour, upgradeNotes, upgradeToNewBehaviour } from "./legacy-behaviour";

const sample = (type: string) => ({ ...(getNodeDefinition(type as never)?.sampleConfig as Record<string, unknown>) });

describe("legacy behaviours", () => {
  it("finds none on new nodes", () => {
    for (const type of ["loop_node", "http_request", "filter_node", "set_node", "if_node", "webhook_input"]) {
      expect(legacyBehaviours(type, sample(type)), type).toEqual([]);
    }
  });

  it("finds the older behaviours of saved nodes", () => {
    expect(legacyBehaviours("loop_node", { inputKey: "items" })).toEqual(["loop_collect", "loop_route"]);
    expect(legacyBehaviours("loop_node", { collectResults: true })).toEqual(["loop_route"]);
    expect(legacyBehaviours("http_request", { method: "GET" })).toEqual(["http_fail"]);
    expect(behavioursOffDefault("http_request", { failOnHttpError: false })).toEqual(["http_fail"]);
    // A saved node that retries fails only on its retried statuses: still the older behaviour.
    expect(legacyBehaviours("http_request", { retryCount: 2 })).toEqual(["http_fail"]);
    expect(legacyBehaviours("http_request", {}, { retryOnFail: true })).toEqual(["http_fail"]);
    expect(legacyBehaviours("filter_node", { conditions: [] })).toEqual(["filter_gate"]);
    expect(behavioursOffDefault("filter_node", { mode: "gate" })).toEqual(["filter_gate"]);
    expect(legacyBehaviours("set_node", { assignments: [{ key: "a", valueTemplate: "1", type: "auto" }, { key: "b", valueTemplate: "2" }] })).toEqual(["set_text"]);
    expect(legacyBehaviours("set_node", { assignments: [{ key: "a", valueTemplate: "1", type: "number" }] })).toEqual([]);
  });

  it("does not call an older behaviour chosen on purpose (as an import sets it) an earlier one", () => {
    expect(legacyBehaviours("http_request", { failOnHttpError: false })).toEqual([]);
    expect(legacyBehaviours("filter_node", { mode: "gate" })).toEqual([]);
    expect(legacyBehaviours("loop_node", { collectResults: false })).toEqual(["loop_route"]);
    expect(behavioursOffDefault("loop_node", { collectResults: false })).toEqual(["loop_collect", "loop_route"]);
    // The upgrade leaves a chosen behaviour alone.
    expect(upgradeToNewBehaviour("loop_node", { collectResults: false }, ["loop_route"])).toEqual({ collectResults: false, routeBranches: true });
  });

  it("upgrades to the newer behaviour and keeps the other settings", () => {
    expect(upgradeToNewBehaviour("loop_node", { inputKey: "rows" })).toEqual({ inputKey: "rows", collectResults: true, routeBranches: true });
    expect(upgradeToNewBehaviour("http_request", { method: "GET", retryCount: 2 })).toEqual({ method: "GET", retryCount: 2, failOnHttpError: true });
    expect(upgradeToNewBehaviour("filter_node", { conditions: [] })).toEqual({ conditions: [], mode: "items" });
    expect(
      upgradeToNewBehaviour("set_node", { assignments: [{ key: "a", valueTemplate: "1", type: "number" }, { key: "b", valueTemplate: "2" }] })
    ).toEqual({ assignments: [{ key: "a", valueTemplate: "1", type: "number" }, { key: "b", valueTemplate: "2", type: "auto" }] });
    for (const type of ["loop_node", "http_request", "filter_node"]) {
      expect(legacyBehaviours(type, upgradeToNewBehaviour(type, {})), type).toEqual([]);
    }
  });

  it("undoes an upgrade and keeps the other edits", () => {
    const saved = { inputKey: "rows", collectResults: false };
    const upgraded = { ...upgradeToNewBehaviour("loop_node", saved), inputKey: "lines" };
    expect(restoreOldBehaviour("loop_node", upgraded, saved)).toEqual({ inputKey: "lines", collectResults: false });
    expect(restoreOldBehaviour("http_request", { failOnHttpError: true, urlTemplate: "x" }, {})).toEqual({ urlTemplate: "x" });
    const savedSet = { assignments: [{ key: "a", valueTemplate: "1" }, { key: "b", valueTemplate: "2", type: "number" }] };
    const upgradedSet = upgradeToNewBehaviour("set_node", savedSet);
    expect(restoreOldBehaviour("set_node", { assignments: [...(upgradedSet.assignments as unknown[]), { key: "c", valueTemplate: "3", type: "auto" }] }, savedSet)).toEqual({
      assignments: [{ key: "a", valueTemplate: "1" }, { key: "b", valueTemplate: "2", type: "number" }, { key: "c", valueTemplate: "3", type: "auto" }]
    });
  });

  it("says in one line what the node keeps and what an upgrade changes", () => {
    expect(legacySummary(["http_fail"])).toBe("Saved with an earlier behaviour: an HTTP error status does not always fail it.");
    expect(legacySummary(["loop_collect", "loop_route"])).toBe(
      "Saved with an earlier behaviour: it does not collect each pass's results and IF, Switch and Filter in its body do not route on each pass."
    );
    expect(upgradeNotes(["filter_gate"])).toBe("Its conditions then read each item's fields.");
  });
});
