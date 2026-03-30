import type { MCPServerConfig, ToolDefinition } from "@ai-orchestrator/shared";
import type { MCPRegistry } from "./registry";
import type { MCPExecutionContext, ResolvedMCPTool } from "./types";

export interface ResolvedToolSet {
  tools: ToolDefinition[];
  resolved: ResolvedMCPTool[];
  invokeByExposedName: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

export async function resolveMCPTools(
  serverConfigs: MCPServerConfig[],
  registry: MCPRegistry,
  context: MCPExecutionContext
): Promise<ResolvedToolSet> {
  const resolved: ResolvedMCPTool[] = [];
  const route = new Map<
    string,
    {
      serverConfig: MCPServerConfig;
      originalName: string;
    }
  >();

  for (const serverConfig of serverConfigs) {
    const adapter = registry.get(serverConfig.serverId);
    let tools = await adapter.discoverTools(serverConfig, context);

    if (!tools.length && serverConfig.manualTools?.length) {
      tools = serverConfig.manualTools;
    }

    if (serverConfig.allowedTools?.length) {
      const allowed = new Set(serverConfig.allowedTools);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }

    for (const tool of tools) {
      const exposedName = `${serverConfig.serverId}__${tool.name}`;
      resolved.push({
        exposedName,
        originalName: tool.name,
        serverId: serverConfig.serverId,
        definition: {
          name: exposedName,
          description: `[${serverConfig.serverId}] ${tool.description}`,
          inputSchema: tool.inputSchema
        }
      });

      route.set(exposedName, {
        serverConfig,
        originalName: tool.name
      });
    }
  }

  return {
    tools: resolved.map((entry) => entry.definition),
    resolved,
    async invokeByExposedName(toolName: string, args: Record<string, unknown>) {
      const target = route.get(toolName);
      if (!target) {
        throw new Error(`Unknown resolved MCP tool '${toolName}'`);
      }
      const adapter = registry.get(target.serverConfig.serverId);
      const result = await adapter.invokeTool(target.originalName, args, target.serverConfig, context);
      if (!result.ok) {
        throw new Error(result.error ?? `Tool ${toolName} failed`);
      }
      return result.output;
    }
  };
}

export async function invokeDirectMCPTool(
  serverConfig: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  registry: MCPRegistry,
  context: MCPExecutionContext
) {
  const adapter = registry.get(serverConfig.serverId);
  return adapter.invokeTool(toolName, args, serverConfig, context);
}