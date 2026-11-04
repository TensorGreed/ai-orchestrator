import {
  BUILT_IN_TOOLS_ADAPTER_ID,
  BUILT_IN_TOOL_PROVIDER_INFO,
  WORKFLOW_TOOL_ADAPTER_ID,
  builtInToolProviderOf,
  toWorkflowToolName,
  type Workflow,
  type WorkflowValidationIssue
} from "@ai-orchestrator/shared";

/**
 * Phase 6.4 — tool names an agent would give its model twice, found from the
 * workflow alone. The run fails closed on any duplicate (the MCP layer and
 * the executor check every name); this catches the ones a workflow shows
 * before it runs: two Workflow Tools with one tool name or one workflow, two
 * built-in tool nodes of one provider, two inline MCP Tool nodes of one
 * adapter naming the same tool, and two workers with one name.
 */

const ALL_TOOLS = "__all__";
const AGENT_NODE_TYPES = new Set(["agent_orchestrator", "supervisor_node"]);

/** The name of the synthetic tool a Supervisor gets for an attached worker node. */
export function workerDelegateToolName(workerName: string): string {
  return `delegate_to_${workerName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The tools an inline MCP Tool node names, or null when only its server knows them. */
function namedTools(config: Record<string, unknown>, serverId: string): string[] | null {
  const named = new Set<string>();
  if (Array.isArray(config.allowedTools)) for (const tool of config.allowedTools) if (text(tool)) named.add(text(tool));
  const toolName = text(config.toolName);
  if (toolName && toolName !== ALL_TOOLS) named.add(toolName);
  if (serverId === BUILT_IN_TOOLS_ADAPTER_ID) {
    const provider = builtInToolProviderOf(config.connection);
    if (!provider) return null;
    const all = BUILT_IN_TOOL_PROVIDER_INFO[provider].toolNames;
    return named.size > 0 ? all.filter((tool) => named.has(tool)) : [...all];
  }
  return named.size > 0 ? [...named] : null;
}

export function duplicateAgentToolNameIssues(workflow: Pick<Workflow, "nodes" | "edges">): WorkflowValidationIssue[] {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const issues: WorkflowValidationIssue[] = [];
  for (const agent of workflow.nodes) {
    if (!AGENT_NODE_TYPES.has(agent.type) || agent.disabled === true) continue;
    /** Exposed name → the tool sources that give it (node id or merged server → shown name). */
    const names = new Map<string, Map<string, string>>();
    const add = (name: string, sourceId: string, shownName: string) => names.set(name, (names.get(name) ?? new Map()).set(sourceId, shownName));
    // Inline MCP Tool nodes with the same server and connection are merged into one server, like the run does.
    const merged = new Map<string, { serverId: string; tools: Set<string>; nodeNames: string[] }>();
    for (const edge of workflow.edges) {
      if (edge.source !== agent.id || (edge.sourceHandle !== "tool" && edge.sourceHandle !== "worker")) continue;
      const target = nodes.get(edge.target);
      if (!target || target.disabled === true) continue;
      const config = record(target.config);
      const label = target.name || target.id;
      if (edge.sourceHandle === "worker") {
        if (target.type === "agent_orchestrator" || target.type === "supervisor_node") add(workerDelegateToolName(target.name), target.id, label);
        continue;
      }
      if (target.type === "workflow_tool") {
        const override = text(config.toolName);
        const workflowId = text(config.workflowId);
        if (override) add(`${WORKFLOW_TOOL_ADAPTER_ID}__${toWorkflowToolName(override)}`, target.id, label);
        // Without its own name a Workflow Tool is named after its workflow: two on one workflow collide.
        else if (workflowId) add(`${WORKFLOW_TOOL_ADAPTER_ID}__\u0000${workflowId}`, target.id, label);
        continue;
      }
      if (target.type !== "mcp_tool") continue;
      const serverId = text(config.serverId);
      // A registered server's adapter and tools are known only at run time.
      if (!serverId || text(config.registryServerId)) continue;
      const tools = namedTools(config, serverId);
      if (!tools) continue;
      const key = `${serverId}::${text(record(config.secretRef).secretId)}::${JSON.stringify(record(config.connection))}`;
      const group = merged.get(key) ?? { serverId, tools: new Set<string>(), nodeNames: [] };
      for (const tool of tools) group.tools.add(tool);
      group.nodeNames.push(label);
      merged.set(key, group);
    }
    for (const [key, group] of merged) {
      for (const tool of group.tools) add(`${group.serverId}__${tool}`, key, group.nodeNames.join(" + "));
    }
    for (const [name, from] of names) {
      if (from.size < 2) continue;
      const shown = name.includes("\u0000") ? `the tool of workflow '${name.split("\u0000")[1]}'` : `'${name}'`;
      issues.push({
        code: "duplicate_agent_tool_name",
        message: `Agent '${agent.name || agent.id}' would give its model two tools named ${shown} (${[...from.values()].join(", ")}). Give each tool a unique name or remove one; the run fails while names repeat.`,
        nodeId: agent.id
      });
    }
  }
  return issues;
}
