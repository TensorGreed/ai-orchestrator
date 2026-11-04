import {
  DEFAULT_WORKFLOW_TOOL_SCHEMA,
  WORKFLOW_TOOL_ADAPTER_ID,
  toWorkflowToolName,
  workflowIdOfToolServerKey,
  workflowToolServerKey,
  type McpToolAnnotations,
  type MCPServerConfig,
  type MCPToolDefinition,
  type MCPToolResult
} from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "../types";

/**
 * Phase 6.4 — the `l2m-workflow` adapter: a workflow an agent calls as a tool.
 *
 * The engine builds one server config per Workflow Tool node, filed under
 * the registry id `workflow:<workflowId>`, with the tool it derived from the
 * child workflow in `connection`. Calls go to `context.runWorkflowTool`,
 * which runs the child in-process. Going through the MCP layer is what gives
 * a workflow tool tool policy (rules name `workflow:<id>` as their server),
 * the write gate, Guard checkpoints, telemetry and cassette record/replay:
 * a replay answers the call from the recording and never runs the child.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export interface WorkflowToolConnection {
  workflowId: string;
  nodeId?: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

/** The connection of a workflow tool server config, or null when it names no workflow. */
export function readWorkflowToolConnection(config: Pick<MCPServerConfig, "connection" | "registryServerId">): WorkflowToolConnection | null {
  const connection = asRecord(config.connection);
  const workflowId =
    (typeof connection.workflowId === "string" && connection.workflowId.trim()) || workflowIdOfToolServerKey(config.registryServerId) || "";
  if (!workflowId) return null;
  const schema = asRecord(connection.inputSchema);
  return {
    workflowId,
    ...(typeof connection.nodeId === "string" && connection.nodeId ? { nodeId: connection.nodeId } : {}),
    toolName: toWorkflowToolName(typeof connection.toolName === "string" ? connection.toolName : "", "run_workflow"),
    description: typeof connection.description === "string" && connection.description.trim() ? connection.description.trim() : `Runs the workflow ${workflowId}.`,
    inputSchema: Object.keys(schema).length > 0 ? { ...schema, type: "object" } : { ...DEFAULT_WORKFLOW_TOOL_SCHEMA },
    readOnly: connection.readOnly === true
  };
}

/** A workflow is not read-only unless its tool node says so; nothing is known about where it sends data. */
function annotationsFor(tool: WorkflowToolConnection): McpToolAnnotations {
  return tool.readOnly ? { title: tool.toolName, readOnlyHint: true } : { title: tool.toolName, readOnlyHint: false };
}

export class WorkflowToolMCPServerAdapter implements MCPServerAdapter {
  readonly definition = {
    id: WORKFLOW_TOOL_ADAPTER_ID,
    label: "Workflow tools",
    description: "Another workflow, called by an agent as a tool.",
    configSchema: {
      type: "object",
      properties: { workflowId: { type: "string" }, toolName: { type: "string" }, description: { type: "string" }, inputSchema: { type: "object" }, readOnly: { type: "boolean" } },
      required: ["workflowId"]
    },
    authSchema: { type: "object", properties: {} }
  };

  async discoverTools(config: MCPServerConfig): Promise<MCPToolDefinition[]> {
    const tool = readWorkflowToolConnection(config);
    if (!tool) throw new Error("A workflow tool needs the workflow it runs.");
    return [
      {
        serverId: WORKFLOW_TOOL_ADAPTER_ID,
        serverLabel: config.label ?? "Workflow tools",
        name: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotationsFor(tool)
      }
    ];
  }

  async invokeTool(toolName: string, args: Record<string, unknown>, config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolResult> {
    const tool = readWorkflowToolConnection(config);
    if (!tool) return { ok: false, output: null, error: "A workflow tool needs the workflow it runs.", errorKind: "tool" };
    // Only the engine's own config (filed under workflow:<id>) runs a workflow: an MCP Tool node naming this adapter cannot.
    if (config.registryServerId !== workflowToolServerKey(tool.workflowId)) {
      return { ok: false, output: null, error: "Add a Workflow Tool node to call a workflow as a tool.", errorKind: "tool" };
    }
    if (toolName !== tool.toolName) return { ok: false, output: null, error: `This workflow tool is '${tool.toolName}', not '${toolName}'.`, errorKind: "invalid_arguments" };
    if (!context.runWorkflowTool) {
      return { ok: false, output: null, error: "Workflow tools run only inside an agent of a workflow run.", errorKind: "tool" };
    }
    return context.runWorkflowTool({ workflowId: tool.workflowId, ...(tool.nodeId ? { nodeId: tool.nodeId } : {}), toolName, args: args ?? {} });
  }
}
