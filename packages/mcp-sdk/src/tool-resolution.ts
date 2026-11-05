import { createHash } from "node:crypto";
import { BUILT_IN_TOOLS_ADAPTER_ID, WORKFLOW_TOOL_ADAPTER_ID } from "@ai-orchestrator/shared";
import type { McpHiddenTool, McpPolicyKind, McpToolAnnotations, MCPServerConfig, ToolDefinition } from "@ai-orchestrator/shared";
import type { MCPRegistry } from "./registry";
import { McpToolPolicyError } from "./tool-policy";
import { toAgentToolOutput } from "./structured-output";
import { isDelegatedCredentialError } from "./delegated";
import type { MCPExecutionContext, MCPServerAdapter, ResolvedMCPTool } from "./types";

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
   * runs, so policy, the write gate, labels and content rules judge the same tool.
   */
  lookup: (exposedName: string) => ResolvedMCPTool | undefined;
}

/**
 * Phase 6.4 — two tools of one agent would reach the model under the same
 * name in a way renaming cannot settle: names the workflow's author chose
 * (two Workflow Tools with one tool name, two built-in tool nodes of one
 * provider, two workers with one name). The model cannot tell them apart and
 * the checks could judge one while the call runs the other, so the agent
 * fails instead. Two MCP servers serving one tool name are renamed instead
 * (see disambiguatedToolName).
 */
export class DuplicateToolNameError extends Error {
  readonly duplicates: Array<{ name: string; sources: string[] }>;
  constructor(duplicates: Array<{ name: string; sources: string[] }>, advice = "Give each tool a unique name or remove one of them.") {
    super(
      `Two or more tools on this agent have the same name: ${duplicates
        .map((entry) => `'${entry.name}' (${entry.sources.join(", ")})`)
        .join("; ")}. ${advice}`
    );
    this.name = "DuplicateToolNameError";
    this.duplicates = duplicates;
  }
}

/** Phase 6.4 — throws DuplicateToolNameError when any name repeats; `source` says where each tool comes from. */
export function assertUniqueToolNames(tools: ReadonlyArray<{ name: string; source: string }>, advice?: string): void {
  const sources = new Map<string, string[]>();
  for (const tool of tools) sources.set(tool.name, [...(sources.get(tool.name) ?? []), tool.source]);
  const duplicates = [...sources.entries()].filter(([, from]) => from.length > 1).map(([name, from]) => ({ name, sources: from }));
  if (duplicates.length > 0) throw new DuplicateToolNameError(duplicates, advice);
}

function serverConfigSource(config: MCPServerConfig): string {
  return config.label ?? config.registryServerId ?? config.serverId;
}

/** Longest tool name the providers accept. */
export const MAX_EXPOSED_TOOL_NAME_LENGTH = 64;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

/** Phase 6.4 — what makes a server config one server: its registry id, else its secret and connection. */
export function serverIdentityHash(config: Pick<MCPServerConfig, "registryServerId" | "secretRef" | "connection">): string {
  return shortHash(
    config.registryServerId ? `registry:${config.registryServerId}` : `inline:${config.secretRef?.secretId ?? ""}:${JSON.stringify(config.connection ?? {})}`
  );
}

/**
 * Phase 6.4 — the name a tool gets when two or more MCP servers on one agent
 * serve the same name: `<adapter>_<6 hex of the server>__<tool>`. The hash
 * keeps it stable and valid for providers; past 64 characters the tool part
 * is cut and ends in a hash of the full tool name, so cut names stay distinct.
 */
export function disambiguatedToolName(adapterId: string, serverHash: string, toolName: string): string {
  const prefix = `${adapterId}_${serverHash}__`;
  const full = `${prefix}${toolName}`;
  if (full.length <= MAX_EXPOSED_TOOL_NAME_LENGTH) return full;
  const room = Math.max(0, MAX_EXPOSED_TOOL_NAME_LENGTH - prefix.length - 7);
  return `${prefix}${toolName.slice(0, room)}_${shortHash(toolName)}`;
}

/** Phase 6.4 — whether `exposedName` is the name the agent gives `toolName` of an `adapterId` server, plain or disambiguated. */
export function isExposedNameOf(exposedName: string, adapterId: string, toolName: string): boolean {
  if (exposedName === `${adapterId}__${toolName}`) return true;
  const match = exposedName.startsWith(`${adapterId}_`) ? /^([0-9a-f]{6})__/.exec(exposedName.slice(adapterId.length + 1)) : null;
  return Boolean(match && disambiguatedToolName(adapterId, match[1]!, toolName) === exposedName);
}

/** Phase 6.4 — adapters whose tool names the author picks: a clash there is the author's to fix, so it fails. */
const AUTHOR_NAMED_ADAPTERS: Record<string, string> = {
  [WORKFLOW_TOOL_ADAPTER_ID]: "Give each Workflow Tool its own tool name, or remove one of them.",
  [BUILT_IN_TOOLS_ADAPTER_ID]: "Keep one built-in tool node per provider on this agent, or limit one node's tools so only one of them offers the name."
};

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
  type Candidate = {
    serverConfig: MCPServerConfig;
    tool: Awaited<ReturnType<MCPServerAdapter["discoverTools"]>>[number];
    baseName: string;
    verdict: { allowed: true } | { allowed: false; hidden: McpHiddenTool; message: string };
  };
  const candidates: Candidate[] = [];
  /** Phase 6.4 — base exposed name → the distinct servers giving it (visible or hidden). */
  const byName = new Map<string, Map<string, Candidate>>();

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

    const identity = `${serverConfig.serverId}:${serverIdentityHash(serverConfig)}`;
    for (const tool of tools) {
      const baseName = `${serverConfig.serverId}__${tool.name}`;
      const from = byName.get(baseName) ?? new Map<string, Candidate>();
      // One server listing a name twice (or listed twice) keeps its first tool.
      if (from.has(identity)) continue;
      const verdict = options.accessCheck
        ? options.accessCheck({
            adapterId: serverConfig.serverId,
            ...(serverConfig.registryServerId ? { registryServerId: serverConfig.registryServerId } : {}),
            toolName: tool.name,
            ...(serverConfig.label ? { serverLabel: serverConfig.label } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            ...(serverConfig.connection ? { connection: serverConfig.connection } : {})
          })
        : ({ allowed: true } as const);
      const candidate: Candidate = { serverConfig, tool, baseName, verdict };
      from.set(identity, candidate);
      byName.set(baseName, from);
      candidates.push(candidate);
    }
  }

  // Author-named tools (Workflow Tools, built-in tool nodes) fail on any clash, hidden copies included.
  const authorClashes = [...byName.entries()].filter(([, from]) => from.size > 1 && [...from.values()][0]!.serverConfig.serverId in AUTHOR_NAMED_ADAPTERS);
  if (authorClashes.length > 0) {
    const adapterId = [...authorClashes[0]![1].values()][0]!.serverConfig.serverId;
    throw new DuplicateToolNameError(
      authorClashes.map(([name, from]) => ({ name, sources: [...from.values()].map((entry) => serverConfigSource(entry.serverConfig)) })),
      AUTHOR_NAMED_ADAPTERS[adapterId]
    );
  }

  for (const candidate of candidates) {
    const { serverConfig, tool, baseName, verdict } = candidate;
    const group = [...byName.get(baseName)!.values()];
    const visibleCount = group.filter((entry) => entry.verdict.allowed).length;
    // MCP servers sharing a name are each renamed after their server; a copy the checks hid does not force a rename.
    const renamed = verdict.allowed ? visibleCount > 1 : group.length > 1;
    const exposedName = renamed ? disambiguatedToolName(serverConfig.serverId, serverIdentityHash(serverConfig), tool.name) : baseName;
    if (!verdict.allowed) {
      hidden.push(verdict.hidden);
      blocked.set(exposedName, { hidden: verdict.hidden, message: verdict.message });
      // With no visible copy left, the plain name explains the refusal too.
      if (renamed && visibleCount === 0 && !blocked.has(baseName)) blocked.set(baseName, { hidden: verdict.hidden, message: verdict.message });
      continue;
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
        description: renamed ? `[${serverConfig.serverId}: ${serverConfigSource(serverConfig)}] ${tool.description}` : `[${serverConfig.serverId}] ${tool.description}`,
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