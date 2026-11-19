import { describe, expect, it } from "vitest";
import { getNodeDefinition } from "@ai-orchestrator/shared";
import { isDirectLoopBodyNode, newNodeConfig } from "./new-node-config";

const sample = (type: string) => structuredClone(getNodeDefinition(type as never)!.sampleConfig as Record<string, unknown>);

describe("a node added in the editor starts with placeholders, not example values", () => {
  it("HTTP Request starts with an empty URL", () => {
    const config = newNodeConfig("http_request", sample("http_request"));
    expect(config.urlTemplate).toBe("");
    expect(config.method).toBe("GET");
    expect(config.failOnHttpError).toBe(true);
  });

  it("Set starts with one empty row", () => {
    expect(newNodeConfig("set_node", sample("set_node")).assignments).toEqual([{ key: "", valueTemplate: "", type: "auto" }]);
  });

  it("Filter starts with one empty condition (which keeps every item until it is filled in)", () => {
    const config = newNodeConfig("filter_node", sample("filter_node"));
    expect(config.conditions).toEqual([{ field: "", operator: "eq", value: "" }]);
    expect(config.mode).toBe("items");
  });

  it("Loop starts with an empty input key and keeps the newer behaviours", () => {
    const config = newNodeConfig("loop_node", sample("loop_node"));
    expect(config.inputKey).toBe("");
    expect(config).toMatchObject({ itemVariable: "item", collectResults: true, routeBranches: true });
  });

  it("Merge appends, without a combine key, and collects a loop's passes after a Loop body node", () => {
    expect(newNodeConfig("merge_node", sample("merge_node"))).toEqual({ mode: "append" });
    expect(newNodeConfig("merge_node", sample("merge_node"), { afterLoopBodyNode: true })).toEqual({ mode: "collect_loop_passes" });
  });

  it("Schedule Trigger starts off, in the browser's time zone", () => {
    expect(newNodeConfig("schedule_trigger", sample("schedule_trigger"), { timeZone: "Europe/Lisbon" })).toEqual({
      cronExpression: "0 9 * * *",
      timezone: "Europe/Lisbon",
      active: false
    });
    // Without a zone from the browser the sample's stays.
    expect(newNodeConfig("schedule_trigger", { cronExpression: "0 9 * * *", timezone: "UTC", active: true }, { timeZone: undefined }).active).toBe(false);
  });

  it("Expose as MCP Tool asks for a bearer token and gets its own path", () => {
    expect(newNodeConfig("mcp_server_trigger", sample("mcp_server_trigger"), { suffix: () => "abc" })).toMatchObject({ authMode: "bearer", path: "helper-abc" });
  });

  it("never changes the catalog's sample", () => {
    const before = sample("set_node");
    const input = structuredClone(before);
    const config = newNodeConfig("set_node", input);
    (config.assignments as unknown[]).push({ key: "x" });
    expect(input).toEqual(before);
  });
});

describe("a Loop body node", () => {
  const nodes = [
    { id: "loop", data: { nodeType: "loop_node" } },
    { id: "each", data: { nodeType: "set_node" } },
    { id: "after", data: { nodeType: "set_node" } }
  ];
  it("is one a Loop connects straight to (not through its Error output)", () => {
    const edges = [
      { source: "loop", target: "each" },
      { source: "loop", target: "after", sourceHandle: "error" }
    ];
    expect(isDirectLoopBodyNode("each", nodes, edges)).toBe(true);
    expect(isDirectLoopBodyNode("after", nodes, edges)).toBe(false);
    expect(isDirectLoopBodyNode("loop", nodes, edges)).toBe(false);
  });
});
