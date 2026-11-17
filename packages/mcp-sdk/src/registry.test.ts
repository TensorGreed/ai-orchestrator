import { describe, expect, it } from "vitest";
import { MCPRegistry } from "./registry";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

function makeAdapter(id: string, closeSessions?: MCPServerAdapter["closeSessions"]): MCPServerAdapter {
  return {
    definition: { id, label: id, description: id, configSchema: {}, authSchema: {} },
    discoverTools: async () => [],
    invokeTool: async () => ({ ok: true, output: null }),
    ...(closeSessions ? { closeSessions } : {})
  };
}

describe("MCPRegistry.closeSessions", () => {
  it("closes the context on every adapter that supports it and collects failures", async () => {
    const closed: string[] = [];
    const registry = new MCPRegistry();
    registry.register(makeAdapter("plain"));
    registry.register(
      makeAdapter("failing", () => {
        throw new Error("boom");
      })
    );
    registry.register(
      makeAdapter("closing", async (context) => {
        closed.push(String(context.runtimeState?.get("marker")));
      })
    );
    const context: MCPExecutionContext = {
      resolveSecret: async () => undefined,
      runtimeState: new Map<string, unknown>([["marker", "ctx-1"]])
    };

    const errors = await registry.closeSessions(context);

    expect(closed).toEqual(["ctx-1"]);
    expect(errors.map((error) => error.message)).toEqual(["boom"]);
  });
});

describe("MCPRegistry.get", () => {
  it("names the adapter it does not know, and points a registered server's id at registryServerId", () => {
    const registry = new MCPRegistry();
    registry.register(makeAdapter("http_mcp"));
    expect(registry.get("http_mcp").definition.id).toBe("http_mcp");
    expect(() => registry.get("nope")).toThrow(/^Unknown MCP server adapter: nope$/);
    expect(() => registry.get("mcp_4b0e2a8e-0f4c-4a52-9a43-0d6f3c1f2b11")).toThrow(
      "Unknown MCP server adapter: mcp_4b0e2a8e-0f4c-4a52-9a43-0d6f3c1f2b11. If this is the id of a registered MCP server, set it as registryServerId"
    );
  });
});
