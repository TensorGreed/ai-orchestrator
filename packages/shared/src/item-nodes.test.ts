import { describe, expect, it } from "vitest";
import { filterModeOf, isMergeMode, isSetValueType, loopCollectsResults, nodeDefinitions } from "./index";

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
