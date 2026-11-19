import { describe, expect, it } from "vitest";
import { filterModeOf, filterRejectedView, isMergeMode, isSetValueType, loopCollectsResults, nodeDefinitions, readsFilterRejected } from "./index";

describe("item node settings", () => {
  it("reads absent settings as the behaviour before they existed", () => {
    expect(filterModeOf({})).toBe("gate");
    expect(filterModeOf({ mode: "items" })).toBe("items");
    expect(filterModeOf({ mode: "other" })).toBe("gate");
    expect(loopCollectsResults({})).toBe(false);
    expect(loopCollectsResults({ collectResults: true })).toBe(true);
  });

  it("knows the Set types and Merge modes", () => {
    expect(isSetValueType("auto")).toBe(true);
    expect(isSetValueType("integer")).toBe(false);
    expect(isSetValueType(undefined)).toBe(false);
    expect(isMergeMode("collect_loop_passes")).toBe(true);
    expect(isMergeMode("zip")).toBe(false);
  });

  it("the definitions list the same Merge modes and Set types", () => {
    const merge = nodeDefinitions.find((entry) => entry.type === "merge_node")!;
    const mode = (merge.configSchema as { properties: { mode: { enum: string[] } } }).properties.mode.enum;
    expect(mode.every(isMergeMode)).toBe(true);
    expect(mode).toContain("collect_loop_passes");
    const set = nodeDefinitions.find((entry) => entry.type === "set_node")!;
    const types = (set.configSchema as { properties: { assignments: { items: { properties: { type: { enum: string[] } } } } } }).properties.assignments.items.properties.type.enum;
    expect(types.every(isSetValueType)).toBe(true);
  });
});

describe("a Filter's Rejected output", () => {
  it("passes the rejected items as items", () => {
    const output = { items: [1], count: 1, rejected: [2, 3], rejected_count: 2, total: 3, items_from: "rows" };
    expect(filterRejectedView(output)).toEqual({ items: [2, 3], count: 2, total: 3, items_from: "rows" });
    expect(filterRejectedView({ passed: true })).toEqual({ passed: true });
    expect(filterRejectedView([1])).toEqual([1]);
  });

  it("is what a node reads only when every edge to it leaves an items Filter by Rejected", () => {
    const items = { type: "filter_node", config: { mode: "items" } };
    expect(readsFilterRejected(items, ["filtered"])).toBe(true);
    expect(readsFilterRejected(items, ["filtered", "pass"])).toBe(false);
    expect(readsFilterRejected(items, [null])).toBe(false);
    expect(readsFilterRejected(items, [])).toBe(false);
    expect(readsFilterRejected({ type: "filter_node", config: {} }, ["filtered"])).toBe(false);
    expect(readsFilterRejected({ type: "if_node", config: { mode: "items" } }, ["filtered"])).toBe(false);
  });
});
