import { describe, expect, it } from "vitest";
import { canUseIntegrationCatalog, catalogPresets, INTEGRATION_CATALOG_CATEGORY } from "./integration-catalog";

describe("catalogPresets", () => {
  it("turns catalog entries into palette presets of the MCP Tool and HTTP Request nodes", () => {
    const presets = catalogPresets([
      {
        key: "mcp:mcp_1:calculator",
        kind: "mcp_tool",
        label: "Demo · calculator",
        description: "",
        sourceName: "Demo",
        sourceId: "mcp_1",
        itemId: "calculator",
        nodeType: "mcp_tool",
        nodeConfig: { registryServerId: "mcp_1", toolName: "calculator" }
      },
      {
        key: "openapi:oas_1:listTickets",
        kind: "openapi_operation",
        label: "Desk · List tickets",
        description: "GET /tickets",
        sourceName: "Desk",
        sourceId: "oas_1",
        itemId: "listTickets",
        nodeType: "http_request",
        nodeConfig: { method: "GET" }
      }
    ]);
    expect(presets).toEqual([
      {
        presetId: "catalog:mcp:mcp_1:calculator",
        type: "mcp_tool",
        label: "Demo · calculator",
        category: INTEGRATION_CATALOG_CATEGORY,
        description: "Tool of Demo",
        sampleConfig: { registryServerId: "mcp_1", toolName: "calculator" }
      },
      {
        presetId: "catalog:openapi:oas_1:listTickets",
        type: "http_request",
        label: "Desk · List tickets",
        category: INTEGRATION_CATALOG_CATEGORY,
        description: "GET /tickets",
        sampleConfig: { method: "GET" }
      }
    ]);
  });

  it("is for builders and admins", () => {
    expect(["admin", "builder", "operator", "viewer", null].map(canUseIntegrationCatalog)).toEqual([true, true, false, false, false]);
  });
});
