/**
 * Phase 6.4 — one exposed name stands for one tool. Two server configs that would give the model the same name fail
 * the resolution instead of letting the checks judge one tool while the call runs the other.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOLS_ADAPTER_ID, WORKFLOW_TOOL_ADAPTER_ID, type MCPServerConfig } from "@ai-orchestrator/shared";
import { createDefaultMCPRegistry, isL2mOwnToolAdapter, withRuntimeLimits, McpRuntimeGuard } from "./index";
import { createRecordingRegistry, McpCassetteRecorder } from "./cassette";
import { MCPRegistry } from "./registry";
import { DuplicateToolNameError, assertUniqueToolNames, resolveMCPTools } from "./tool-resolution";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

const ctx: MCPExecutionContext = { resolveSecret: async () => undefined };

function workflowTool(workflowId: string, toolName: string, readOnly = false): MCPServerConfig {
  return {
    serverId: WORKFLOW_TOOL_ADAPTER_ID,
    registryServerId: `workflow:${workflowId}`,
    label: `Workflow ${workflowId}`,
    connection: { workflowId, toolName, description: "d", inputSchema: {}, readOnly }
  };
}

describe("tool resolution: one exposed name, one tool", () => {
  it("fails on two workflow tools with one name instead of judging A and running B", async () => {
    const registry = createDefaultMCPRegistry();
    const run = resolveMCPTools([workflowTool("A", "lookup", true), workflowTool("B", "lookup")], registry, ctx);
    await expect(run).rejects.toBeInstanceOf(DuplicateToolNameError);
    await expect(run).rejects.toThrow(/'l2m-workflow__lookup' \(Workflow A, Workflow B\)/);
  });

  it("fails on two built-in tool nodes of one provider with different endpoints", async () => {
    const wiki = (endpoint?: string): MCPServerConfig => ({ serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: { provider: "wikipedia", ...(endpoint ? { endpoint } : {}) } });
    await expect(resolveMCPTools([wiki(), wiki("https://attacker.example")], createDefaultMCPRegistry(), ctx)).rejects.toThrow(/l2m-tools__wikipedia_search/);
  });

  it("counts a name the policy hid as taken", async () => {
    const registry = createDefaultMCPRegistry();
    const run = resolveMCPTools([workflowTool("A", "lookup"), workflowTool("B", "lookup")], registry, ctx, {
      accessCheck: (tool) =>
        tool.registryServerId === "workflow:A"
          ? { allowed: false, hidden: { tool: tool.toolName, server: tool.adapterId, reason: "policy" }, message: "no" }
          : { allowed: true }
    });
    await expect(run).rejects.toBeInstanceOf(DuplicateToolNameError);
  });

  it("looks up the entry the call runs, and keeps one server's repeated listing to its first tool", async () => {
    const twice: MCPServerAdapter = {
      definition: { id: "twice", label: "Twice", description: "", configSchema: {}, authSchema: {} },
      async discoverTools() {
        return [
          { serverId: "twice", serverLabel: "Twice", name: "t", description: "first", inputSchema: { type: "object" } },
          { serverId: "twice", serverLabel: "Twice", name: "t", description: "second", inputSchema: { type: "object" } }
        ];
      },
      async invokeTool() {
        return { ok: true, output: "ran" };
      }
    } as MCPServerAdapter;
    const registry = new MCPRegistry();
    registry.register(twice);
    const set = await resolveMCPTools([{ serverId: "twice" }, workflowTool("A", "x")], (() => {
      registry.register(createDefaultMCPRegistry().get(WORKFLOW_TOOL_ADAPTER_ID));
      return registry;
    })(), ctx);
    expect(set.resolved.map((entry) => entry.exposedName)).toEqual(["twice__t", "l2m-workflow__x"]);
    expect(set.lookup("twice__t")?.definition.description).toBe("[twice] first");
    expect(set.lookup("l2m-workflow__x")?.registryServerId).toBe("workflow:A");
    expect(set.lookup("nope")).toBeUndefined();
  });

  it("asserts unique names across any tool sources", () => {
    expect(() => assertUniqueToolNames([{ name: "a", source: "x" }, { name: "b", source: "y" }])).not.toThrow();
    expect(() => assertUniqueToolNames([{ name: "delegate_to_w", source: "worker 1" }, { name: "delegate_to_w", source: "worker 2" }])).toThrow(
      /'delegate_to_w' \(worker 1, worker 2\)/
    );
  });
});

describe("L2M's own tool adapters", () => {
  it("are recognised through the runtime-limits and recording wrappers, and an impostor under the same id is not", () => {
    const registry = createDefaultMCPRegistry({ runtimeGuard: new McpRuntimeGuard() });
    expect(isL2mOwnToolAdapter(registry.get(BUILT_IN_TOOLS_ADAPTER_ID))).toBe(true);
    expect(isL2mOwnToolAdapter(registry.get(WORKFLOW_TOOL_ADAPTER_ID))).toBe(true);
    const recording = createRecordingRegistry(registry, new McpCassetteRecorder());
    expect(isL2mOwnToolAdapter(recording.get(BUILT_IN_TOOLS_ADAPTER_ID))).toBe(true);
    expect(isL2mOwnToolAdapter(withRuntimeLimits(registry.get(WORKFLOW_TOOL_ADAPTER_ID), new McpRuntimeGuard()))).toBe(true);
    const impostor = { ...registry.get(BUILT_IN_TOOLS_ADAPTER_ID), definition: { ...registry.get(BUILT_IN_TOOLS_ADAPTER_ID).definition } } as MCPServerAdapter;
    expect(isL2mOwnToolAdapter(impostor)).toBe(false);
    expect(isL2mOwnToolAdapter(registry.get("mock-mcp"))).toBe(false);
    expect(isL2mOwnToolAdapter(undefined)).toBe(false);
  });
});
