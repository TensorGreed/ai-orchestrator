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
