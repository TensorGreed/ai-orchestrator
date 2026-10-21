import type { McpHiddenTool, McpPolicyKind, McpToolAnnotations, MCPServerConfig, ToolDefinition } from "@ai-orchestrator/shared";
import type { MCPRegistry } from "./registry";
import { McpToolPolicyError } from "./tool-policy";
import { toAgentToolOutput } from "./structured-output";
import type { MCPExecutionContext, ResolvedMCPTool } from "./types";

export interface ResolvedToolSet {
  tools: ToolDefinition[];
  resolved: ResolvedMCPTool[];
  /** Phase 10.2 — tools the access check removed; the model never sees them. */
  hidden: McpHiddenTool[];
  /** Why a tool name is not in the set, when the access check removed it. */
  describeBlocked: (toolName: string) => string | undefined;
  /**
   * Calls the tool and returns what the agent's model should see: the
   * structured result when the tool returned one (with its text content when
   * that says more than the JSON), otherwise the text output.
   */
  invokeByExposedName: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** What the access check sees about one discovered tool. */
export interface McpToolAccessSubjectTool {
  adapterId: string;
  registryServerId?: string;
  /** Tool name; for other kinds the resource URI, prompt name or model name. */
  toolName: string;
  annotations?: McpToolAnnotations;
  /** Phase 10.5 — defaults to `tool`. */
  kind?: McpPolicyKind;
  /** Server name for block messages; falls back to the registry id. */
  serverLabel?: string;
}

export type McpToolAccessCheck = (
  tool: McpToolAccessSubjectTool
) => { allowed: true } | { allowed: false; hidden: McpHiddenTool; message: string };

export interface ResolveMCPToolsOptions {
  /**
   * Phase 10.2 — tool policy. Called for every discovered tool; denied tools
   * are left out of the resolved set, and calling one by name (or calling an
   * allowed tool that has since become denied) fails with McpToolPolicyError.
   */
  accessCheck?: McpToolAccessCheck;
}

export async function resolveMCPTools(
  serverConfigs: MCPServerConfig[],
  registry: MCPRegistry,
  context: MCPExecutionContext,
  options: ResolveMCPToolsOptions = {}
): Promise<ResolvedToolSet> {
  const resolved: ResolvedMCPTool[] = [];
  const hidden: McpHiddenTool[] = [];
  const blocked = new Map<string, { hidden: McpHiddenTool; message: string }>();
  const route = new Map<
    string,
    {
      serverConfig: MCPServerConfig;
      originalName: string;
      annotations?: McpToolAnnotations;
    }
  >();


  for (const serverConfig of serverConfigs) {
    const adapter = registry.get(serverConfig.serverId);
    let tools: Awaited<ReturnType<typeof adapter.discoverTools>>;
    try {
      tools = await adapter.discoverTools(serverConfig, context);
    } catch (discoveryError) {
      // Log and continue — don't let one server failure kill the entire workflow
      console.warn(
        `[MCP] Tool discovery failed for server '${serverConfig.serverId}': ${
          discoveryError instanceof Error ? discoveryError.message : String(discoveryError)
        }. Skipping this server.`
      );
      continue;
    }

    if (!tools.length && serverConfig.manualTools?.length) {
      tools = serverConfig.manualTools;
    }

    if (serverConfig.allowedTools?.length) {
      const allowed = new Set(serverConfig.allowedTools);
      tools = tools.filter((tool) => allowed.has(tool.name));
    }

    for (const tool of tools) {
      const exposedName = `${serverConfig.serverId}__${tool.name}`;
      if (options.accessCheck) {
        const verdict = options.accessCheck({
          adapterId: serverConfig.serverId,
          ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
          toolName: tool.name,
          ...(serverConfig.label ? { serverLabel: serverConfig.label } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {})
        });
        if (!verdict.allowed) {
          if (!blocked.has(exposedName)) {
            hidden.push(verdict.hidden);
            blocked.set(exposedName, { hidden: verdict.hidden, message: verdict.message });
          }
          continue;
        }
      }
      resolved.push({
        exposedName,
        originalName: tool.name,
        serverId: serverConfig.serverId,
        ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        definition: {
          name: exposedName,
          description: `[${serverConfig.serverId}] ${tool.description}`,
          inputSchema: tool.inputSchema
        }
      });

      route.set(exposedName, {
        serverConfig,
        originalName: tool.name,
        ...(tool.annotations ? { annotations: tool.annotations } : {})
      });
    }
  }

  return {
    tools: resolved.map((entry) => entry.definition),
    resolved,
    hidden,
    describeBlocked(toolName: string) {
      return blocked.get(toolName)?.message;
    },
    async invokeByExposedName(toolName: string, args: Record<string, unknown>) {
      const refused = blocked.get(toolName);
      if (refused) {
        throw new McpToolPolicyError(refused.message, refused.hidden);
      }
      const target = route.get(toolName);
      if (!target) {
        throw new Error(`Unknown resolved MCP tool '${toolName}'`);
      }
      if (options.accessCheck) {
        // Re-check at call time, so no call path can skip the policy.
        const verdict = options.accessCheck({
          adapterId: target.serverConfig.serverId,
          ...(target.serverConfig.registryServerId ? { registryServerId: target.serverConfig.registryServerId } : {}),
          toolName: target.originalName,
          ...(target.serverConfig.label ? { serverLabel: target.serverConfig.label } : {}),
          ...(target.annotations ? { annotations: target.annotations } : {})
        });
        if (!verdict.allowed) {
          throw new McpToolPolicyError(verdict.message, verdict.hidden);
        }
      }
      const adapter = registry.get(target.serverConfig.serverId);
      const result = await adapter.invokeTool(target.originalName, args, target.serverConfig, context);
      if (!result.ok) {
        throw new Error(result.error ?? `Tool ${toolName} failed`);
      }
      return toAgentToolOutput(result);
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