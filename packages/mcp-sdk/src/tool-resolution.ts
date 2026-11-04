import type { McpHiddenTool, McpPolicyKind, McpToolAnnotations, MCPServerConfig, ToolDefinition } from "@ai-orchestrator/shared";
import type { MCPRegistry } from "./registry";
import { McpToolPolicyError } from "./tool-policy";
import { toAgentToolOutput } from "./structured-output";
import { isDelegatedCredentialError } from "./delegated";
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
  invokeByExposedName: (toolName: string, args: Record<string, unknown>, call?: McpToolAccessCallContext) => Promise<unknown>;
  /**
   * Phase 6.4 — the one entry an exposed name stands for: the entry the call
   * runs, so policy, the write gate, labels and Guard judge the same tool.
   */
  lookup: (exposedName: string) => ResolvedMCPTool | undefined;
}

/**
 * Phase 6.4 — two tools of one agent would reach the model under the same
 * name (two servers on one adapter id serving the same tool, two Workflow
 * Tools with one tool name). The model cannot tell them apart and the checks
 * could judge one while the call runs the other, so the agent fails instead.
 */
export class DuplicateToolNameError extends Error {
  readonly duplicates: Array<{ name: string; sources: string[] }>;
  constructor(duplicates: Array<{ name: string; sources: string[] }>) {
    super(
      `Two or more tools on this agent have the same name: ${duplicates
        .map((entry) => `'${entry.name}' (${entry.sources.join(", ")})`)
        .join("; ")}. Give each tool a unique name (a Workflow Tool's tool name) or remove one of them.`
    );
    this.name = "DuplicateToolNameError";
    this.duplicates = duplicates;
  }
}

/** Phase 6.4 — throws DuplicateToolNameError when any name repeats; `source` says where each tool comes from. */
export function assertUniqueToolNames(tools: ReadonlyArray<{ name: string; source: string }>): void {
  const sources = new Map<string, string[]>();
  for (const tool of tools) sources.set(tool.name, [...(sources.get(tool.name) ?? []), tool.source]);
  const duplicates = [...sources.entries()].filter(([, from]) => from.length > 1).map(([name, from]) => ({ name, sources: from }));
  if (duplicates.length > 0) throw new DuplicateToolNameError(duplicates);
}

function serverConfigSource(config: MCPServerConfig): string {
  return config.label ?? config.registryServerId ?? config.serverId;
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
  /**
   * Phase 12.2 — the server's connection settings, read only for the host of its endpoint (its destination tier
   * decides whether the tool is open world). Never recorded.
   */
  connection?: unknown;
}

/** Phase 12.4 — what the call-time check knows about the call beyond the tool. */
export interface McpToolAccessCallContext {
  /** The run's data labels at the call; absent when the run does not track labels. */
  dataLabels?: { provenance: readonly string[]; dataClasses: readonly string[] } | null;
  /** The agent's id for this tool call. */
  toolCallId?: string;
}

/** Phase 12.4 — the call being checked: its arguments plus the call context. Absent at discovery. */
export interface McpToolAccessCall extends McpToolAccessCallContext {
  arguments: Record<string, unknown>;
}

/**
 * Refuses denied tools. Called without `call` at discovery (rules with
 * conditions cannot decide yet, so they never hide a tool) and with the
 * call's arguments before each call. A require_approval outcome is not a
 * refusal: the caller hands the call off for approval before invoking it.
 */
export type McpToolAccessCheck = (
  tool: McpToolAccessSubjectTool,
  call?: McpToolAccessCall
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
      entry: ResolvedMCPTool;
    }
  >();
  // Phase 6.4 — every exposed name, allowed or hidden, and the server configs it came from.
  const seen = new Map<string, MCPServerConfig[]>();


  for (const serverConfig of serverConfigs) {
    const adapter = registry.get(serverConfig.serverId);
    let tools: Awaited<ReturnType<typeof adapter.discoverTools>>;
    try {
      tools = await adapter.discoverTools(serverConfig, context);
    } catch (discoveryError) {
      // Phase 10.7 — a delegated server the user has not connected fails the node with a link to connect, rather than vanishing.
      if (isDelegatedCredentialError(discoveryError)) throw discoveryError;
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
      const from = seen.get(exposedName) ?? [];
      // One server listing a name twice keeps its first tool; another server reusing it is a duplicate.
      if (from.includes(serverConfig)) continue;
      seen.set(exposedName, [...from, serverConfig]);
      if (from.length > 0) continue;
      if (options.accessCheck) {
        const verdict = options.accessCheck({
          adapterId: serverConfig.serverId,
          ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
          toolName: tool.name,
          ...(serverConfig.label ? { serverLabel: serverConfig.label } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(serverConfig.connection ? { connection: serverConfig.connection } : {})
        });
        if (!verdict.allowed) {
          if (!blocked.has(exposedName)) {
            hidden.push(verdict.hidden);
            blocked.set(exposedName, { hidden: verdict.hidden, message: verdict.message });
          }
          continue;
        }
      }
      const entry: ResolvedMCPTool = {
        exposedName,
        originalName: tool.name,
        serverId: serverConfig.serverId,
        ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(serverConfig.connection ? { connection: serverConfig.connection } : {}),
        definition: {
          name: exposedName,
          description: `[${serverConfig.serverId}] ${tool.description}`,
          inputSchema: tool.inputSchema
        }
      };
      resolved.push(entry);

      route.set(exposedName, {
        serverConfig,
        originalName: tool.name,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        entry
      });
    }
  }

  const duplicates = [...seen.entries()].filter(([, from]) => from.length > 1);
  if (duplicates.length > 0) {
    throw new DuplicateToolNameError(duplicates.map(([name, from]) => ({ name, sources: from.map(serverConfigSource) })));
  }

  return {
    tools: resolved.map((entry) => entry.definition),
    resolved,
    hidden,
    lookup(exposedName: string) {
      return route.get(exposedName)?.entry;
    },
    describeBlocked(toolName: string) {
      return blocked.get(toolName)?.message;
    },
    async invokeByExposedName(toolName: string, args: Record<string, unknown>, call?: McpToolAccessCallContext) {
      const refused = blocked.get(toolName);
      if (refused) {
        throw new McpToolPolicyError(refused.message, refused.hidden);
      }
      const target = route.get(toolName);
      if (!target) {
        throw new Error(`Unknown resolved MCP tool '${toolName}'`);
      }
      if (options.accessCheck) {
        // Re-check at call time with the arguments, so no call path can skip the policy.
        const verdict = options.accessCheck(
          {
            adapterId: target.serverConfig.serverId,
            ...(target.serverConfig.registryServerId ? { registryServerId: target.serverConfig.registryServerId } : {}),
            toolName: target.originalName,
            ...(target.serverConfig.label ? { serverLabel: target.serverConfig.label } : {}),
            ...(target.annotations ? { annotations: target.annotations } : {}),
            ...(target.serverConfig.connection ? { connection: target.serverConfig.connection } : {})
          },
          { ...call, arguments: args }
        );
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