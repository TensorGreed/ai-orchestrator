import { loopRoutesBranches, type Workflow, type WorkflowNode } from "@ai-orchestrator/shared";
import { isExecutionEdge } from "./graph";

/** The output a node's failure goes to when its On Error is "branch". */
const ERROR_OUTPUT = "error";

/** Nodes whose outputs choose which next nodes run (they set a branch handle on their output). */
export const LOOP_ROUTING_NODE_TYPES: ReadonlySet<string> = new Set(["if_node", "switch_node", "filter_node", "guard", "chat_intent_router"]);

export interface LoopBody {
  /** The body's nodes, in run order. */
  nodeIds: string[];
  /** Body nodes the run walk leaves to the Loop: every execution parent is the Loop or another body node. */
  inline: Set<string>;
  /** Body nodes no other body node follows: what `collected` holds per pass on a Loop that routes branches. */
  leaves: string[];
  /** True when the body's branching nodes route per pass (the Loop's `routeBranches`). */
  routing: boolean;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A body node whose failure goes to its Error output (On Error is "branch" and no Continue On Fail overrides it). */
function routesFailures(node: WorkflowNode): boolean {
  const errorConfig = toRecord((node as { errorConfig?: unknown }).errorConfig);
  return errorConfig.continueOnFail !== true && toRecord(node.config).onError === "branch";
}

/**
 * The body of a Loop node: the nodes that run once per item.
 *
 * - Always the nodes connected straight after the Loop (not its Error output), in edge order.
 * - With branch routing (`routeBranches`), also the nodes on the outputs of a body IF, Switch, Filter, Content Rules
 *   or Chat Intent Router node, and on the outputs of a body node whose failure goes to its connected Error output
 *   (On Error is "branch"): the Error output and the others. Such a node joins
 *   only when all of its execution parents are the Loop or body nodes, and the rule applies again from it. The body
 *   then runs in the workflow's run order (`order`).
 */
export function loopBodyOf(workflow: Workflow, loopId: string, options: { order?: readonly string[] } = {}): LoopBody {
  const nodeById = new Map(workflow.nodes.map((entry) => [entry.id, entry]));
  const loop = nodeById.get(loopId);
  const routing = loop ? loopRoutesBranches(toRecord(loop.config)) : false;
  const executionEdges = workflow.edges.filter((edge) => isExecutionEdge(edge));
  const parentsOf = new Map<string, string[]>();
  for (const edge of executionEdges) {
    const parents = parentsOf.get(edge.target) ?? [];
    parents.push(edge.source);
    parentsOf.set(edge.target, parents);
  }

  const direct = [
    ...new Set(executionEdges.filter((edge) => edge.source === loopId && edge.sourceHandle !== ERROR_OUTPUT).map((edge) => edge.target))
  ].filter((id) => id !== loopId && nodeById.has(id));
  const members = new Set(direct);
  /** A node whose failure goes to a connected Error output: its outputs route like a branching node's. */
  const hasErrorOutput = (nodeId: string) =>
    routesFailures(nodeById.get(nodeId)!) && executionEdges.some((edge) => edge.source === nodeId && edge.sourceHandle === ERROR_OUTPUT);

  if (routing) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of executionEdges) {
        if (!members.has(edge.source) || members.has(edge.target) || edge.target === loopId || !nodeById.has(edge.target)) continue;
        const source = nodeById.get(edge.source)!;
        if (!LOOP_ROUTING_NODE_TYPES.has(source.type) && !hasErrorOutput(source.id)) continue;
        const parents = parentsOf.get(edge.target) ?? [];
        if (parents.every((parentId) => parentId === loopId || members.has(parentId))) {
          members.add(edge.target);
          grew = true;
        }
      }
    }
  }

  let nodeIds = direct.concat([...members].filter((id) => !direct.includes(id)));
  if (routing && options.order) {
    const position = new Map(options.order.map((id, index) => [id, index]));
    nodeIds = [...nodeIds].sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
  }

  const inline = new Set(
    nodeIds.filter((id) => {
      const parents = parentsOf.get(id) ?? [];
      return parents.length > 0 && parents.every((parentId) => parentId === loopId || (routing && members.has(parentId)));
    })
  );
  const leaves = nodeIds.filter((id) => !executionEdges.some((edge) => edge.source === id && members.has(edge.target)));
  return { nodeIds, inline, leaves, routing };
}

/** True when `nodeId` runs once per item of some Loop of the workflow (a node of a Loop's body). */
export function owningLoopsOf(workflow: Workflow, nodeId: string): string[] {
  return workflow.nodes.filter((entry) => entry.type === "loop_node" && loopBodyOf(workflow, entry.id).nodeIds.includes(nodeId)).map((entry) => entry.id);
}
