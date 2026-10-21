import type { McpCatalogTool } from "./api";
import {
  EMPTY_TOOL_FILTERS,
  changeLinkLabel,
  changeLinkTarget,
  countActiveToolFilters,
  formatCost,
  formatCount,
  formatPercent,
  policyStateOf,
  sortCatalogTools
} from "./mcp-control-plane";

function tool(name: string, calls: number | null, cost: number | null = null): McpCatalogTool {
  return {
    serverId: "s",
    serverName: "Server",
    serverStatus: "healthy",
    adapterId: "mock-mcp",
    name,
    inputSchema: {},
    classification: { readOnly: true, source: "annotation" },
    manualReadOnly: null,
    access: { allowed: true },
    telemetry:
      calls === null
        ? null
        : {
            toolName: name,
            calls,
            errors: 0,
            errorRate: 0,
            p50Ms: null,
            p95Ms: calls ? calls * 10 : null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: cost,
            samplingRequests: 0,
            samplingInputTokens: 0,
            samplingOutputTokens: 0,
            lastCalledAt: null
          }
  };
}

describe("mcp-control-plane helpers", () => {
  it("sorts by telemetry with missing values last in both directions", () => {
    const tools = [tool("b", 5, 0.5), tool("a", null), tool("c", 9, null)];
    expect(sortCatalogTools(tools, "calls", "desc").map((entry) => entry.name)).toEqual(["c", "b", "a"]);
    expect(sortCatalogTools(tools, "p95", "asc").map((entry) => entry.name)).toEqual(["b", "c", "a"]);
    expect(sortCatalogTools(tools, "cost", "desc").map((entry) => entry.name)).toEqual(["b", "a", "c"]);
    expect(sortCatalogTools(tools, "name", "asc").map((entry) => entry.name)).toEqual(["a", "b", "c"]);
  });

  it("derives the policy state worst-first", () => {
    expect(policyStateOf(tool("x", 1))).toBe("read_only");
    expect(policyStateOf({ ...tool("x", 1), classification: { readOnly: false, source: "unknown" } })).toBe("write");
    expect(policyStateOf({ ...tool("x", 1), classification: { readOnly: false, source: "annotation" }, annotations: { destructiveHint: true } })).toBe(
      "destructive"
    );
    expect(policyStateOf({ ...tool("x", 1), access: { allowed: false } })).toBe("blocked");
  });

  it("maps change links to navigation targets", () => {
    expect(changeLinkTarget(null)).toBeNull();
    expect(changeLinkTarget({ page: "policies", policyId: "r1" })).toEqual({ page: "policies", policyId: "r1" });
    expect(changeLinkLabel({ page: "policies" })).toBe("Open policies");
    expect(changeLinkLabel({ page: "tools", serverId: "s", toolName: "t" })).toBe("Open tool");
  });

  it("counts filters and formats numbers", () => {
    expect(countActiveToolFilters(EMPTY_TOOL_FILTERS)).toBe(0);
    expect(countActiveToolFilters({ ...EMPTY_TOOL_FILTERS, search: "x", blocked: true, kind: "write" })).toBe(3);
    expect(formatCount(1500)).toBe("1.5k");
    expect(formatPercent(0.004)).toBe("<1%");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0.004)).toBe("<$0.01");
  });
});
