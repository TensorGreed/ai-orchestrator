/**
 * Phase 6.4 — one exposed name stands for one tool. Two MCP servers serving one tool name are each renamed after their
 * server; names the author chose (Workflow Tools, built-in tool nodes) fail the resolution instead of letting the
 * checks judge one tool while the call runs the other.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_TOOLS_ADAPTER_ID, WORKFLOW_TOOL_ADAPTER_ID, type MCPServerConfig } from "@ai-orchestrator/shared";
import { createDefaultMCPRegistry, isL2mOwnToolAdapter, withRuntimeLimits, McpRuntimeGuard } from "./index";
import { createRecordingRegistry, McpCassetteRecorder } from "./cassette";
import { MCPRegistry } from "./registry";
import {
  DuplicateToolNameError,
  MAX_EXPOSED_TOOL_NAME_LENGTH,
  assertUniqueToolNames,
  disambiguatedToolName,
  isExposedNameOf,
  resolveMCPTools,
  serverIdentityHash,
  type McpToolAccessCheck
} from "./tool-resolution";
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
    await expect(run).rejects.toThrow(/'l2m-workflow__lookup' \(Workflow A, Workflow B\)\. Give each Workflow Tool its own tool name/);
  });

  it("fails on two built-in tool nodes of one provider with different endpoints", async () => {
    const wiki = (endpoint?: string): MCPServerConfig => ({ serverId: BUILT_IN_TOOLS_ADAPTER_ID, connection: { provider: "wikipedia", ...(endpoint ? { endpoint } : {}) } });
    await expect(resolveMCPTools([wiki(), wiki("https://attacker.example")], createDefaultMCPRegistry(), ctx)).rejects.toThrow(
      /l2m-tools__wikipedia_search.*Keep one built-in tool node per provider/
    );
  });

  it("counts a Workflow Tool name the policy hid as taken", async () => {
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

/** An MCP server adapter whose every server serves the same tools; calls report which server ran. */
function sharedNamesRegistry(toolNames: string[] = ["search"]) {
  const calls: string[] = [];
  const adapter: MCPServerAdapter = {
    definition: { id: "http_mcp", label: "HTTP", description: "", configSchema: {}, authSchema: {} },
    async discoverTools(config) {
      return toolNames.map((name) => ({ serverId: "http_mcp", serverLabel: "HTTP", name, description: `${name} on ${String(config.registryServerId ?? (config.connection as { endpoint?: string }).endpoint)}`, inputSchema: { type: "object" } }));
    },
    async invokeTool(name, _args, config) {
      const server = String(config.registryServerId ?? (config.connection as { endpoint?: string }).endpoint);
      calls.push(`${server}:${name}`);
      return { ok: true, output: server };
    }
  } as MCPServerAdapter;
  const registry = new MCPRegistry();
  registry.register(adapter);
  return { registry, calls };
}

const registered = (id: string, label = id): MCPServerConfig => ({ serverId: "http_mcp", registryServerId: id, label, connection: { endpoint: `https://${id}.example/mcp` } });
const inline = (endpoint: string, label: string): MCPServerConfig => ({ serverId: "http_mcp", label, connection: { endpoint } });

describe("tool resolution: two MCP servers serving one tool name", () => {
  it("renames both after their server, routes each call to its own server, and judges each by its own policy", async () => {
    const { registry, calls } = sharedNamesRegistry();
    const seen: string[] = [];
    // A require_approval-style rule keyed on server B's `search`: the check sees the server and the original name.
    const accessCheck: McpToolAccessCheck = (tool, call) => {
      if (call) seen.push(`${tool.registryServerId}:${tool.toolName}`);
      return call && tool.registryServerId === "srv_b" && tool.toolName === "search"
        ? { allowed: false, hidden: { tool: tool.toolName, server: tool.adapterId, registryServerId: "srv_b", reason: "policy" }, message: "B's search needs approval" }
        : { allowed: true };
    };
    const set = await resolveMCPTools([registered("srv_a", "Server A"), registered("srv_b", "Server B")], registry, ctx, { accessCheck });
    const nameA = disambiguatedToolName("http_mcp", serverIdentityHash({ registryServerId: "srv_a" }), "search");
    const nameB = disambiguatedToolName("http_mcp", serverIdentityHash({ registryServerId: "srv_b" }), "search");
    expect(nameA).toMatch(/^http_mcp_[0-9a-f]{6}__search$/);
    expect(set.resolved.map((entry) => entry.exposedName)).toEqual([nameA, nameB]);
    expect(set.lookup(nameA)?.registryServerId).toBe("srv_a");
    expect(set.lookup(nameB)?.registryServerId).toBe("srv_b");
    expect(set.lookup(nameB)?.originalName).toBe("search");
    expect(set.lookup(nameA)?.definition.description).toBe("[http_mcp: Server A] search on srv_a");
    expect(set.lookup("http_mcp__search")).toBeUndefined();
    await expect(set.invokeByExposedName(nameA, {})).resolves.toBe("srv_a");
    await expect(set.invokeByExposedName(nameB, {})).rejects.toThrow("B's search needs approval");
    expect(calls).toEqual(["srv_a:search"]);
    expect(seen).toEqual(["srv_a:search", "srv_b:search"]);
    expect(isExposedNameOf(nameB, "http_mcp", "search")).toBe(true);
    expect(isExposedNameOf("http_mcp__search", "http_mcp", "search")).toBe(true);
    expect(isExposedNameOf(nameB, "http_mcp", "fetch")).toBe(false);
  });

  it("renames two inline servers of one adapter in all-tools mode, and keeps a name only one of them serves", async () => {
    const { registry, calls } = sharedNamesRegistry(["search", "fetch"]);
    const one = inline("https://one.example/mcp", "Docs");
    const two: MCPServerConfig = { ...inline("https://two.example/mcp", "Wiki"), allowedTools: ["search"] };
    const set = await resolveMCPTools([one, two], registry, ctx);
    const names = set.resolved.map((entry) => entry.exposedName);
    expect(names).toEqual([disambiguatedToolName("http_mcp", serverIdentityHash(one), "search"), "http_mcp__fetch", disambiguatedToolName("http_mcp", serverIdentityHash(two), "search")]);
    await set.invokeByExposedName(names[2]!, {});
    await set.invokeByExposedName("http_mcp__fetch", {});
    expect(calls).toEqual(["https://two.example/mcp:search", "https://one.example/mcp:fetch"]);
  });

  it("renames the existing two once when a third server joins, with the same name for each server as before", async () => {
    const { registry } = sharedNamesRegistry();
    const before = await resolveMCPTools([registered("srv_a"), registered("srv_b")], registry, ctx);
    const after = await resolveMCPTools([registered("srv_a"), registered("srv_b"), registered("srv_c")], registry, ctx);
    expect(after.resolved.slice(0, 2).map((entry) => entry.exposedName)).toEqual(before.resolved.map((entry) => entry.exposedName));
    expect(new Set(after.resolved.map((entry) => entry.exposedName)).size).toBe(3);
    const alone = await resolveMCPTools([registered("srv_a")], registry, ctx);
    expect(alone.resolved.map((entry) => entry.exposedName)).toEqual(["http_mcp__search"]);
  });

  it("does not count a copy the checks hid: the visible copy keeps its plain name and the hidden one is still refused", async () => {
    const { registry, calls } = sharedNamesRegistry(["create_issue"]);
    const accessCheck: McpToolAccessCheck = (tool) =>
      tool.registryServerId === "srv_a"
        ? { allowed: false, hidden: { tool: tool.toolName, server: tool.adapterId, registryServerId: "srv_a", reason: "no_write_tools" }, message: "hidden on A" }
        : { allowed: true };
    const set = await resolveMCPTools([registered("srv_a"), registered("srv_b")], registry, ctx, { accessCheck });
    expect(set.resolved.map((entry) => entry.exposedName)).toEqual(["http_mcp__create_issue"]);
    expect(set.hidden).toHaveLength(1);
    await expect(set.invokeByExposedName("http_mcp__create_issue", {})).resolves.toBe("srv_b");
    const hiddenName = disambiguatedToolName("http_mcp", serverIdentityHash({ registryServerId: "srv_a" }), "create_issue");
    expect(set.describeBlocked(hiddenName)).toBe("hidden on A");
    await expect(set.invokeByExposedName(hiddenName, {})).rejects.toThrow("hidden on A");
    expect(calls).toEqual(["srv_b:create_issue"]);
    // Both hidden: neither fails the agent, both are refused.
    const none = await resolveMCPTools([registered("srv_a"), registered("srv_b")], registry, ctx, {
      accessCheck: (tool) => ({ allowed: false, hidden: { tool: tool.toolName, server: tool.adapterId, reason: "no_write_tools" }, message: "hidden" })
    });
    expect(none.resolved).toEqual([]);
    expect(none.describeBlocked("http_mcp__create_issue")).toBe("hidden");
  });

  it("keeps renamed names within 64 characters, distinct for long tools that share a prefix", () => {
    const long = "x".repeat(80);
    const a = disambiguatedToolName("http_mcp", "abcdef", `${long}_one`);
    const b = disambiguatedToolName("http_mcp", "abcdef", `${long}_two`);
    expect(a.length).toBeLessThanOrEqual(MAX_EXPOSED_TOOL_NAME_LENGTH);
    expect(a).toMatch(/^http_mcp_abcdef__x+_[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(isExposedNameOf(a, "http_mcp", `${long}_one`)).toBe(true);
    expect(isExposedNameOf(a, "http_mcp", `${long}_two`)).toBe(false);
  });
});
