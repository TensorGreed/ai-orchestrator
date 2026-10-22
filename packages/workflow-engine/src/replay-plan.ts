/**
 * Phase 15.1 — what each node does when a golden run is replayed.
 *
 * `buildReplayPlan` takes the candidate workflow and the recorded node
 * outputs and returns a hook the executor calls before it runs any node
 * handler: at the top level, inside loop bodies, for workers and in
 * sub-workflows alike. For a node whose class is stubbed (external reads
 * and writes, approvals, waits, unknown types) the hook returns the
 * recorded output, the recorded error, or a synthetic stub; the handler is
 * never called. Nothing in a replay can reach a live side effect through a
 * node, because the decision is made per node type at the single place
 * every handler is dispatched from, and unknown types count as writes.
 */

import {
  REPLAY_ALWAYS_STUBBED_CLASSES,
  REPLAY_NODE_CLASSES,
  REPLAY_STUB_MARKER,
  REPLAY_TRUNCATED_MARKER,
  replayNodeClass,
  type ReplayNodeClass,
  type ReplayRecordedNode,
  type Workflow,
  type WorkflowNode
} from "@ai-orchestrator/shared";

/** What the executor does instead of running a node's handler. */
export type ReplayNodeStub =
  | { kind: "output"; output: unknown }
  | { kind: "error"; message: string }
  | { kind: "pass_through" };

/** Hook handed to the executor: a stub for the node, or null to run it. */
export type ReplayNodeHook = (node: Pick<WorkflowNode, "id" | "type" | "config">) => ReplayNodeStub | null;

export type ReplayNodeAction =
  /** The handler runs (logic, models, guard, sandboxed session state). */
  | "run"
  /** The handler runs, and its MCP calls are answered from the cassette. */
  | "cassette"
  /** The recorded output (or error) is replayed. */
  | "recorded"
  /** Stubbed with a synthetic output: the recording has nothing usable for this node. */
  | "unrecorded_stub"
  /** Passed straight through (waits). */
  | "pass_through";

export interface ReplayNodeDecision {
  nodeId: string;
  nodeType: string;
  nodeClass: ReplayNodeClass;
  action: ReplayNodeAction;
}

export interface ReplayPlanWarning {
  kind: "unrecorded_stub" | "unknown_node_type" | "truncated_recording";
  nodeId: string;
  message: string;
}

/** A stub the hook actually returned during the run. */
export interface ReplayStubHit {
  nodeId: string;
  nodeType: string;
  nodeClass: ReplayNodeClass;
  stub: ReplayNodeStub["kind"];
  recorded: boolean;
}

export interface ReplayPlan {
  decisions: ReplayNodeDecision[];
  warnings: ReplayPlanWarning[];
  hook: ReplayNodeHook;
  /** Every stub returned while the run went on, in order. */
  hits: ReplayStubHit[];
}

function recordedFor(recorded: Record<string, ReplayRecordedNode>, node: { id: string; type: string }): ReplayRecordedNode | null {
  if (!Object.prototype.hasOwnProperty.call(recorded, node.id)) return null;
  const entry = recorded[node.id];
  // A node id reused for a different node type is a different node.
  if (!entry || entry.nodeType !== node.type) return null;
  if (entry.status !== "success" && entry.status !== "error") return null;
  return entry;
}

function isTruncated(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && !Array.isArray(output) && REPLAY_TRUNCATED_MARKER in (output as Record<string, unknown>));
}

function isKnownType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(REPLAY_NODE_CLASSES, type);
}

/** The synthetic output a stubbed node gets when the recording has nothing for it. */
export function unrecordedStubOutput(node: { id: string; type: string }): Record<string, unknown> {
  return { [REPLAY_STUB_MARKER]: "unrecorded", nodeId: node.id, nodeType: node.type };
}

/**
 * The plan for replaying `recorded` (node id → recorded result) against
 * `workflow`. A node type outside `knownTypes` (default: every type the
 * replay table classifies) is reported as unknown and stubbed like a write.
 */
export function buildReplayPlan(
  workflow: Pick<Workflow, "nodes">,
  recorded: Record<string, ReplayRecordedNode>,
  options: { knownTypes?: ReadonlySet<string> } = {}
): ReplayPlan {
  const known = (type: string) => (options.knownTypes ? options.knownTypes.has(type) : isKnownType(type));

  const decide = (node: Pick<WorkflowNode, "id" | "type" | "config">): { nodeClass: ReplayNodeClass; stub: ReplayNodeStub | null; recorded: boolean } => {
    const nodeClass = replayNodeClass({ type: node.type, config: node.config });
    if (nodeClass === "wait") return { nodeClass, stub: { kind: "pass_through" }, recorded: false };
    const entry = recordedFor(recorded, node);
    if (nodeClass === "trigger") {
      // The trigger's recorded output is the run's input; an unrecorded trigger runs (triggers only read the run's own input).
      if (entry && entry.status === "success") return { nodeClass, stub: { kind: "output", output: entry.output }, recorded: true };
      return { nodeClass, stub: null, recorded: false };
    }
    if (!REPLAY_ALWAYS_STUBBED_CLASSES.has(nodeClass)) return { nodeClass, stub: null, recorded: false };
    if (entry?.status === "success") return { nodeClass, stub: { kind: "output", output: entry.output }, recorded: true };
    if (entry?.status === "error") {
      return { nodeClass, stub: { kind: "error", message: entry.error?.trim() || "The node failed in the recorded run." }, recorded: true };
    }
    return { nodeClass, stub: { kind: "output", output: unrecordedStubOutput(node) }, recorded: false };
  };

  const decisions: ReplayNodeDecision[] = [];
  const warnings: ReplayPlanWarning[] = [];
  for (const node of workflow.nodes) {
    if (node.type === "sticky_note") continue;
    const decision = decide(node);
    let action: ReplayNodeAction;
    if (decision.stub?.kind === "pass_through") action = "pass_through";
    else if (decision.stub) action = decision.recorded ? "recorded" : "unrecorded_stub";
    else action = decision.nodeClass === "mcp" ? "cassette" : "run";
    decisions.push({ nodeId: node.id, nodeType: node.type, nodeClass: decision.nodeClass, action });
    if (!known(node.type)) {
      warnings.push({ kind: "unknown_node_type", nodeId: node.id, message: `Node ${node.id} has a type this deployment does not know (${node.type}); it is stubbed, never run.` });
    }
    if (action === "unrecorded_stub" && node.disabled !== true) {
      warnings.push({
        kind: "unrecorded_stub",
        nodeId: node.id,
        message: `Node ${node.id} (${node.type}) has no recorded output to replay; it gets a stub output instead of running.`
      });
    }
    if (action === "recorded" && decision.stub?.kind === "output" && isTruncated(decision.stub.output)) {
      warnings.push({ kind: "truncated_recording", nodeId: node.id, message: `The recorded output of node ${node.id} was cut to fit the size limit.` });
    }
  }

  const hits: ReplayStubHit[] = [];
  const hook: ReplayNodeHook = (node) => {
    const decision = decide(node);
    if (!decision.stub) return null;
    hits.push({ nodeId: node.id, nodeType: node.type, nodeClass: decision.nodeClass, stub: decision.stub.kind, recorded: decision.recorded });
    return decision.stub;
  };

  return { decisions, warnings, hook, hits };
}
