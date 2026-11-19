/**
 * Phase 10.4 — the tools a toolset exposes to one policy role.
 *
 * Workflow members contribute one tool per `mcp_server_trigger` node, named
 * by the trigger's `toolName`. Server members contribute the tools of the
 * registry server's current schema snapshot (no live tools/list per client
 * request), filtered by the member's tool glob and named
 * `<server-slug>__<tool>`. Tools the policy denies for the role are left out
 * of `tools` and kept in `hidden`, so a call to one can be refused with the
 * rule's message. Names are made unique in member order.
 */

import { assignServerSlugs, dedupeToolNames, gatewayToolName, matchesToolPattern, policyReadsOpenWorld } from "@ai-orchestrator/mcp-sdk";
import {
  CONTENT_RULES_TOOL_DESCRIPTIONS,
  CONTENT_RULES_TOOL_INPUT_SCHEMAS,
  CONTENT_RULES_TOOL_LIST,
  CONTENT_RULES_TOOLS_ADAPTER_ID,
  CONTENT_RULES_TOOLS_SERVER_LABEL,
  SCAN_DOCUMENT_TOOL_NAME,
  isLiveEntryOff,
  scanDocumentDescription,
  scanDocumentInputSchema,
  type ContentRulesDocumentsOptions,
  type ContentRulesGatewayToolName
} from "@ai-orchestrator/shared";
import type {
  McpGatewayHiddenToolView,
  McpGatewayToolView,
  McpPolicyRole,
  McpToolAnnotations,
  McpToolClassificationOverride,
  McpToolOpenWorldOverride,
  DataDestinationRow,
  McpToolPolicyRule,
  McpToolset,
  Workflow
} from "@ai-orchestrator/shared";
import type { McpServerRecord, McpToolSnapshotRecord } from "../db/database.js";
import { evaluateToolForContext } from "./mcp-tool-policy.js";
import { loadMcpOpenWorldContext, type McpOpenWorldContext } from "./mcp-open-world.js";

export interface GatewayWorkflowTool {
  kind: "workflow";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  workflowId: string;
  workflowName: string;
  /** 12.6 — the workflow's project (its project budgets apply to the call). */
  projectId: string | null;
  nodeId: string;
}

export interface GatewayServerTool {
  kind: "server";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  serverId: string;
  serverName: string;
  adapterId: string;
  toolName: string;
  readOnly: boolean;
}

/** A built-in content rules tool (a toolset member of kind `content_rules`). */
export interface GatewayContentRulesTool {
  kind: "content_rules";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  tool: ContentRulesGatewayToolName;
  /** The member's rule set; null: the built-in detector defaults. */
  ruleSetId: string | null;
  /** The member's document options (`scan_document`); absent: off. */
  documents?: ContentRulesDocumentsOptions;
  readOnly: boolean;
}

export type GatewayTool = GatewayWorkflowTool | GatewayServerTool | GatewayContentRulesTool;

export interface GatewayHiddenTool extends McpGatewayHiddenToolView {
  adapterId: string;
}

export interface GatewayCatalog {
  tools: GatewayTool[];
  hidden: GatewayHiddenTool[];
  /** Members that contribute nothing, and why (shown in the toolset preview). */
  warnings: string[];
}

export interface GatewayCatalogStore {
  getWorkflow(id: string): Promise<Workflow | null>;
  listMcpServers(): Promise<McpServerRecord[]>;
  getMcpToolSnapshot(id: string): Promise<McpToolSnapshotRecord | null>;
  listMcpToolPolicies(): Promise<McpToolPolicyRule[]>;
  listMcpToolClassifications(registryServerId?: string): Promise<McpToolClassificationOverride[]>;
  listMcpToolOpenWorldOverrides(registryServerId?: string): Promise<McpToolOpenWorldOverride[]>;
  listDataDestinations(): Promise<DataDestinationRow[]>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** MCP requires an object schema; a trigger without one accepts any object. */
export function normalizeInputSchema(value: unknown): Record<string, unknown> {
  const schema = asRecord(value);
  if (Object.keys(schema).length === 0) return { type: "object" };
  return schema.type === "object" ? schema : { ...schema, type: "object" };
}

/** Server slugs over the whole registry, so a tool keeps its name in every toolset. */
export function registryServerSlugs(servers: readonly McpServerRecord[]): Map<string, string> {
  return assignServerSlugs(servers.map((server) => ({ id: server.id, name: server.name, createdAt: server.createdAt })));
}

type Candidate =
  | (Omit<GatewayWorkflowTool, "name"> & { rawName: string })
  | (Omit<GatewayServerTool, "name"> & { rawName: string })
  | (Omit<GatewayContentRulesTool, "name"> & { rawName: string })
  | { kind: "hidden"; rawName: string; hidden: Omit<GatewayHiddenTool, "name"> };

export async function buildGatewayCatalog(input: {
  toolset: McpToolset;
  role: McpPolicyRole;
  store: GatewayCatalogStore;
  /** Phase 12.4 — the client asking, for rules scoped to clients; absent for the admin preview. */
  clientId?: string | null;
}): Promise<GatewayCatalog> {
  const { toolset, role, store } = input;
  const servers = await store.listMcpServers();
  const serverById = new Map(servers.map((server) => [server.id, server]));
  const slugs = registryServerSlugs(servers);
  const rules = await store.listMcpToolPolicies();
  let openWorldLoaded: McpOpenWorldContext | undefined;
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  let contentRulesAdded = false;

  for (const member of toolset.members) {
    if (member.kind === "workflow") {
      const workflow = await store.getWorkflow(member.workflowId);
      if (!workflow) {
        warnings.push(`Workflow '${member.workflowId}' no longer exists.`);
        continue;
      }
      const triggers = workflow.nodes.filter((node) => node.type === "mcp_server_trigger");
      if (triggers.length === 0) {
        warnings.push(`Workflow '${workflow.name}' has no "Expose as MCP Tool" trigger, so it adds no tool.`);
        continue;
      }
      for (const node of triggers) {
        const config = asRecord(node.config);
        const toolName = typeof config.toolName === "string" && config.toolName.trim() ? config.toolName.trim() : node.id;
        // Switched off in the editor: the tool is left out until it is turned on.
        if (isLiveEntryOff(node)) {
          warnings.push(`Workflow '${workflow.name}': the "Expose as MCP Tool" trigger '${toolName}' is turned off, so it adds no tool.`);
          continue;
        }
        const description =
          typeof config.toolDescription === "string" && config.toolDescription.trim()
            ? config.toolDescription.trim()
            : `Runs the workflow '${workflow.name}'.`;
        candidates.push({
          kind: "workflow",
          rawName: toolName,
          description,
          inputSchema: normalizeInputSchema(config.inputSchema),
          workflowId: workflow.id,
          workflowName: workflow.name,
          projectId: workflow.projectId ?? null,
          nodeId: node.id
        });
      }
      continue;
    }

    if (member.kind === "content_rules") {
      // One content rules member per toolset (the admin API keeps only the first); the tools follow the tool policy
      // like a server's, under their own adapter id and server label.
      if (contentRulesAdded) continue;
      contentRulesAdded = true;
      // scan_document only when the member turns documents on; it reaches the open web only when URLs are allowed.
      const documents = member.documents?.enabled ? member.documents : undefined;
      const names: ContentRulesGatewayToolName[] = [...CONTENT_RULES_TOOL_LIST, ...(documents ? [SCAN_DOCUMENT_TOOL_NAME] : [])];
      for (const name of names) {
        // Detect and scan_document are read-only: redact keeps a sealed map (and vault tokens), restore gives values back.
        const readOnly = name === "detect_sensitive_data" || name === SCAN_DOCUMENT_TOOL_NAME;
        const openWorld = name === SCAN_DOCUMENT_TOOL_NAME && Boolean(documents?.allowUrls);
        const annotations: McpToolAnnotations = { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: openWorld };
        const decision = evaluateToolForContext(
          {
            rules,
            classifications: [],
            role,
            projectId: toolset.projectId,
            adapterId: CONTENT_RULES_TOOLS_ADAPTER_ID,
            serverLabel: CONTENT_RULES_TOOLS_SERVER_LABEL,
            clientId: input.clientId ?? null,
            toolsetId: toolset.id
          },
          { name, annotations }
        );
        if (!decision.allowed) {
          candidates.push({
            kind: "hidden",
            rawName: name,
            hidden: {
              serverId: CONTENT_RULES_TOOLS_ADAPTER_ID,
              serverName: CONTENT_RULES_TOOLS_SERVER_LABEL,
              adapterId: CONTENT_RULES_TOOLS_ADAPTER_ID,
              toolName: name,
              ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
              ...(decision.ruleName ? { ruleName: decision.ruleName } : {}),
              message: decision.message ?? `MCP tool '${name}' is blocked by policy for role ${role}.`
            }
          });
          continue;
        }
        candidates.push({
          kind: "content_rules",
          rawName: name,
          description: name === SCAN_DOCUMENT_TOOL_NAME ? scanDocumentDescription(openWorld) : CONTENT_RULES_TOOL_DESCRIPTIONS[name],
          inputSchema: name === SCAN_DOCUMENT_TOOL_NAME ? scanDocumentInputSchema(openWorld) : CONTENT_RULES_TOOL_INPUT_SCHEMAS[name],
          annotations,
          tool: name,
          ruleSetId: member.ruleSetId,
          ...(name === SCAN_DOCUMENT_TOOL_NAME && documents ? { documents } : {}),
          readOnly
        });
      }
      continue;
    }

    const server = serverById.get(member.serverId);
    if (!server) {
      warnings.push(`MCP server '${member.serverId}' is no longer registered.`);
      continue;
    }
    const snapshot = server.currentSnapshotId ? await store.getMcpToolSnapshot(server.currentSnapshotId) : null;
    if (!snapshot) {
      warnings.push(`MCP server '${server.name}' has no tool snapshot yet; probe it to publish its tools.`);
      continue;
    }
    if (server.blockOnBreakingChange && server.pendingBreakingSnapshotId) {
      warnings.push(`MCP server '${server.name}' has an unaccepted breaking change; calls to its tools fail until it is accepted.`);
    }
    const classifications = await store.listMcpToolClassifications(server.id);
    // Phase 12.2 — open-world resolution, only when a rule reads the open-world hint (read once per catalog).
    if (policyReadsOpenWorld(rules) && !openWorldLoaded) openWorldLoaded = await loadMcpOpenWorldContext(store);
    const openWorld = openWorldLoaded ? { ...openWorldLoaded, connection: server.connection } : undefined;
    const slug = slugs.get(server.id) ?? "server";
    const tools = snapshot.tools.filter((tool) => matchesToolPattern(member.toolGlob ?? "*", tool.name));
    if (tools.length === 0) {
      warnings.push(`No tool of MCP server '${server.name}' matches '${member.toolGlob ?? "*"}'.`);
    }
    for (const tool of tools) {
      const decision = evaluateToolForContext(
        {
          rules,
          classifications,
          role,
          projectId: toolset.projectId,
          adapterId: server.adapterId,
          registryServerId: server.id,
          serverLabel: server.name,
          clientId: input.clientId ?? null,
          // 12.6 — server tools are called through this toolset, for rules scoped to toolsets.
          toolsetId: toolset.id,
          ...(openWorld ? { openWorld } : {})
        },
        { name: tool.name, ...(tool.annotations ? { annotations: tool.annotations } : {}) }
      );
      const rawName = gatewayToolName(slug, tool.name);
      if (!decision.allowed) {
        candidates.push({
          kind: "hidden",
          rawName,
          hidden: {
            serverId: server.id,
            serverName: server.name,
            adapterId: server.adapterId,
            toolName: tool.name,
            ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
            ...(decision.ruleName ? { ruleName: decision.ruleName } : {}),
            message: decision.message ?? `MCP tool '${tool.name}' is blocked by policy for role ${role}.`
          }
        });
        continue;
      }
      candidates.push({
        kind: "server",
        rawName,
        description: tool.description?.trim() || `Tool '${tool.name}' on MCP server '${server.name}'.`,
        inputSchema: normalizeInputSchema(tool.inputSchema),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        serverId: server.id,
        serverName: server.name,
        adapterId: server.adapterId,
        toolName: tool.name,
        readOnly: decision.classification.readOnly
      });
    }
  }

  const names = dedupeToolNames(candidates.map((candidate) => candidate.rawName));
  const tools: GatewayTool[] = [];
  const hidden: GatewayHiddenTool[] = [];
  candidates.forEach((candidate, index) => {
    const name = names[index]!;
    if (name !== candidate.rawName) {
      warnings.push(`Two tools are named '${candidate.rawName}'; the later one is published as '${name}'.`);
    }
    if (candidate.kind === "hidden") {
      hidden.push({ ...candidate.hidden, name });
      return;
    }
    const { rawName: _raw, ...rest } = candidate;
    tools.push({ ...rest, name } as GatewayTool);
  });
  return { tools, hidden, warnings };
}

/** The shape an MCP client gets from tools/list. */
export function toMcpToolDescriptor(tool: GatewayTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.kind !== "workflow" && tool.annotations ? { annotations: tool.annotations } : {})
  };
}

/** The shape the admin API returns for previews. */
export function toToolView(tool: GatewayTool): McpGatewayToolView {
  if (tool.kind === "workflow") {
    return {
      name: tool.name,
      kind: "workflow",
      description: tool.description,
      inputSchema: tool.inputSchema,
      workflowId: tool.workflowId,
      workflowName: tool.workflowName,
      readOnly: false
    };
  }
  if (tool.kind === "content_rules") {
    return {
      name: tool.name,
      kind: "content_rules",
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      serverId: CONTENT_RULES_TOOLS_ADAPTER_ID,
      serverName: CONTENT_RULES_TOOLS_SERVER_LABEL,
      toolName: tool.tool,
      readOnly: tool.readOnly
    };
  }
  return {
    name: tool.name,
    kind: "server",
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    serverId: tool.serverId,
    serverName: tool.serverName,
    toolName: tool.toolName,
    readOnly: tool.readOnly
  };
}
