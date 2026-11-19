/**
 * A summary of what replacing one workflow with another changes: nodes and edges added, removed and changed, plus
 * the workflow-level fields that differ. The import confirm step shows it before a "Replace existing" import, and the
 * import API returns it on a dry run. Positions are compared on their own (`moved`): moving a node is not a change of
 * what it does.
 */

export interface WorkflowDiffNodeRef {
  id: string;
  name: string;
  type: string;
}

export interface WorkflowDiffChangedNode extends WorkflowDiffNodeRef {
  /** Top-level fields that differ (`config.<key>` for a config key, `name`, `type`, `disabled`, `errorConfig`, ...). */
  fields: string[];
}

export interface WorkflowDiffEdgeRef {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface WorkflowDiff {
  nodes: { added: WorkflowDiffNodeRef[]; removed: WorkflowDiffNodeRef[]; changed: WorkflowDiffChangedNode[]; moved: number };
  edges: { added: WorkflowDiffEdgeRef[]; removed: WorkflowDiffEdgeRef[]; changed: WorkflowDiffEdgeRef[] };
  /** Workflow-level fields that differ, other than nodes, edges and timestamps (`name`, `settings`, `variables`, ...). */
  fields: string[];
  /** True when nothing differs but positions and timestamps. */
  identical: boolean;
}

interface DiffableNode {
  id: string;
  type: string;
  name?: string;
  position?: unknown;
  config?: unknown;
  [key: string]: unknown;
}

interface DiffableEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface DiffableWorkflow {
  nodes?: DiffableNode[];
  edges?: DiffableEdge[];
  [key: string]: unknown;
}

/** Fields that say nothing about what a workflow does, or that the store sets. */
const IGNORED_WORKFLOW_FIELDS = new Set(["nodes", "edges", "createdAt", "updatedAt", "workflowVersion", "schemaVersion"]);

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

/** Absent, null, "" and an empty list or object all mean "not set". */
function blank(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

function same(a: unknown, b: unknown): boolean {
  if (blank(a) && blank(b)) return true;
  return stable(a) === stable(b);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nodeRef(node: DiffableNode): WorkflowDiffNodeRef {
  return { id: node.id, name: typeof node.name === "string" && node.name ? node.name : node.id, type: node.type };
}

function edgeRef(edge: DiffableEdge): WorkflowDiffEdgeRef {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
  };
}

function changedNodeFields(before: DiffableNode, after: DiffableNode): string[] {
  const fields: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (key === "id" || key === "position") continue;
    if (key === "config") {
      const a = asRecord(before.config);
      const b = asRecord(after.config);
      for (const configKey of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!same(a[configKey], b[configKey])) fields.push(`config.${configKey}`);
      }
      continue;
    }
    if (!same(before[key], after[key])) fields.push(key);
  }
  return fields;
}

/** What replacing `before` (the stored workflow) with `after` (the import) changes. */
export function diffWorkflows(before: DiffableWorkflow, after: DiffableWorkflow, options: { defaultProjectId?: string } = {}): WorkflowDiff {
  const beforeNodes = new Map((before.nodes ?? []).map((node) => [node.id, node]));
  const afterNodes = new Map((after.nodes ?? []).map((node) => [node.id, node]));
  const nodes: WorkflowDiff["nodes"] = { added: [], removed: [], changed: [], moved: 0 };
  for (const [id, node] of afterNodes) {
    const previous = beforeNodes.get(id);
    if (!previous) {
      nodes.added.push(nodeRef(node));
      continue;
    }
    const fields = changedNodeFields(previous, node);
    if (fields.length > 0) nodes.changed.push({ ...nodeRef(node), fields });
    else if (!same(previous.position, node.position)) nodes.moved += 1;
  }
  for (const [id, node] of beforeNodes) if (!afterNodes.has(id)) nodes.removed.push(nodeRef(node));

  // Edges are matched by id; an edge with a new id but the same ends and handles is the same connection.
  const endsKey = (edge: DiffableEdge) => stable([edge.source, edge.sourceHandle ?? null, edge.target, edge.targetHandle ?? null]);
  const beforeEdges = new Map((before.edges ?? []).map((edge) => [edge.id, edge]));
  const afterEdges = new Map((after.edges ?? []).map((edge) => [edge.id, edge]));
  const beforeEnds = new Set((before.edges ?? []).map(endsKey));
  const afterEnds = new Set((after.edges ?? []).map(endsKey));
  const edges: WorkflowDiff["edges"] = { added: [], removed: [], changed: [] };
  for (const [id, edge] of afterEdges) {
    const previous = beforeEdges.get(id);
    if (previous) {
      if (endsKey(previous) !== endsKey(edge) || (previous.label ?? "") !== (edge.label ?? "")) edges.changed.push(edgeRef(edge));
    } else if (!beforeEnds.has(endsKey(edge))) {
      edges.added.push(edgeRef(edge));
    }
  }
  for (const [id, edge] of beforeEdges) {
    if (!afterEdges.has(id) && !afterEnds.has(endsKey(edge))) edges.removed.push(edgeRef(edge));
  }

  const fields: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (IGNORED_WORKFLOW_FIELDS.has(key)) continue;
    // A workflow without a project is in the default one.
    const project = (value: unknown) => (key === "projectId" && blank(value) ? options.defaultProjectId : value);
    if (!same(project(before[key]), project(after[key]))) fields.push(key);
  }

  const identical =
    nodes.added.length + nodes.removed.length + nodes.changed.length + edges.added.length + edges.removed.length + edges.changed.length + fields.length === 0;
  return { nodes, edges, fields, identical };
}
