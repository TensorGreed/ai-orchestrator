import { workflowSchema, type Workflow, type WorkflowValidationIssue, type WorkflowValidationResult } from "@ai-orchestrator/shared";

interface GraphMetadata {
  inDegree: Map<string, number>;
  outgoing: Map<string, string[]>;
}

function buildGraph(workflow: Workflow): GraphMetadata {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    const sourceOut = outgoing.get(edge.source);
    if (sourceOut) {
      sourceOut.push(edge.target);
    }

    const currentDegree = inDegree.get(edge.target);
    if (currentDegree !== undefined) {
      inDegree.set(edge.target, currentDegree + 1);
    }
  }

  return { inDegree, outgoing };
}

function topoSort(workflow: Workflow): { order: string[]; cyclic: boolean } {
  const { inDegree, outgoing } = buildGraph(workflow);
  const queue: string[] = [];

  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const order: string[] = [];
  while (queue.length) {
    const nodeId = queue.shift()!;
    order.push(nodeId);

    for (const target of outgoing.get(nodeId) ?? []) {
      const degree = inDegree.get(target);
      if (degree === undefined) {
        continue;
      }

      const nextDegree = degree - 1;
      inDegree.set(target, nextDegree);
      if (nextDegree === 0) {
        queue.push(target);
      }
    }
  }

  return {
    order,
    cyclic: order.length !== workflow.nodes.length
  };
}

function validateNodeConfig(workflow: Workflow): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];

  for (const node of workflow.nodes) {
    const config = (node.config ?? {}) as Record<string, unknown>;

    if (node.type === "prompt_template" && typeof config.template !== "string") {
      issues.push({
        code: "missing_template",
        message: "Prompt Template node requires a string template config.",
        nodeId: node.id
      });
    }

    if (node.type === "llm_call") {
      const provider = config.provider as Record<string, unknown> | undefined;
      if (!provider || typeof provider.providerId !== "string" || typeof provider.model !== "string") {
        issues.push({
          code: "missing_llm_provider",
          message: "LLM Call node requires provider.providerId and provider.model.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "agent_orchestrator") {
      const provider = config.provider as Record<string, unknown> | undefined;
      if (!provider || typeof provider.providerId !== "string" || typeof provider.model !== "string") {
        issues.push({
          code: "missing_agent_provider",
          message: "Agent Orchestrator node requires provider.providerId and provider.model.",
          nodeId: node.id
        });
      }
      if (typeof config.maxIterations !== "number" || config.maxIterations < 1) {
        issues.push({
          code: "invalid_max_iterations",
          message: "Agent Orchestrator node requires maxIterations >= 1.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "mcp_tool") {
      if (typeof config.serverId !== "string" || typeof config.toolName !== "string") {
        issues.push({
          code: "missing_mcp_tool_config",
          message: "MCP Tool node requires serverId and toolName.",
          nodeId: node.id
        });
      }
    }

    if (node.type === "connector_source" && typeof config.connectorId !== "string") {
      issues.push({
        code: "missing_connector_id",
        message: "Connector Source node requires connectorId.",
        nodeId: node.id
      });
    }
  }

  return issues;
}

export function validateWorkflowGraph(rawWorkflow: unknown): WorkflowValidationResult {
  const parsed = workflowSchema.safeParse(rawWorkflow);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: `${issue.path.join(".")}: ${issue.message}`
      }))
    };
  }

  const workflow = parsed.data;
  const issues: WorkflowValidationIssue[] = [];
  const nodeIds = new Set<string>();

  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        message: `Duplicate node id '${node.id}'`,
        nodeId: node.id
      });
    }
    nodeIds.add(node.id);
  }

  for (const edge of workflow.edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push({
        code: "missing_edge_source",
        message: `Edge source '${edge.source}' does not exist`,
        edgeId: edge.id
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        code: "missing_edge_target",
        message: `Edge target '${edge.target}' does not exist`,
        edgeId: edge.id
      });
    }
    if (edge.source === edge.target) {
      issues.push({
        code: "self_edge",
        message: `Self-referencing edge '${edge.id}' is not allowed`,
        edgeId: edge.id
      });
    }
  }

  const outputNodes = workflow.nodes.filter((node) => node.type === "output");
  if (!outputNodes.length) {
    issues.push({
      code: "missing_output_node",
      message: "Workflow must include at least one Output node."
    });
  }

  issues.push(...validateNodeConfig(workflow));

  const topology = topoSort(workflow);
  if (topology.cyclic) {
    issues.push({
      code: "cycle_detected",
      message: "Workflow graph contains a cycle. V1 supports DAG execution only."
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    orderedNodeIds: topology.order
  };
}

export function sortWorkflowNodes(workflow: Workflow): string[] {
  const topology = topoSort(workflow);
  if (topology.cyclic) {
    throw new Error("Workflow graph contains a cycle");
  }
  return topology.order;
}