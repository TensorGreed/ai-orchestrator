/**
 * Phase 15.1 — what each node does when a golden run is replayed.
 *
 * `buildReplayPlan` takes the candidate workflow and the recorded node
 * outputs and returns a hook the executor calls before it runs any node
 * handler: at the top level, inside loop bodies, for workers and in
 * sub-workflows alike. For a node whose class is stubbed (external reads
 * and writes, code nodes, approvals, waits, unknown types) the hook returns
 * the recorded output, the recorded error, or a synthetic stub; the handler
 * is never called. The decision is made per node type at the single place
 * every handler is dispatched from, and unknown types count as writes.
 *
 * A recorded stub whose node changed since the golden run (its type and
 * configuration no longer match the recorded workflow) is still answered
 * from the recording, and the plan says so: for a code node that means the
 * new code was never tested. A node that ran several times in the golden
 * run (a loop body) is answered call by call; a call past the recorded ones
 * reuses the last answer and is marked as an overrun.
 *
 * Nodes that do run (logic, models, guard) still evaluate the workflow's
 * own `{{ }}` and sort expressions in the host realm, as in any run, so an
 * expression written to make a network call can make it in a replay too.
 */

import { createHash } from "node:crypto";
import {
  canonicalJson,
  REPLAY_ALWAYS_STUBBED_CLASSES,
  REPLAY_NODE_CLASSES,
  REPLAY_STUB_MARKER,
  REPLAY_TRUNCATED_MARKER,
  replayNodeClass,
  type ReplayNodeClass,
  type ReplayRecordedNode,
  type ReplayRecordedRun,
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
  | "pass_through"
  /** Phase 15.3 — an external read the candidate asked to run live (`liveNodes`). */
  | "live";

export interface ReplayNodeDecision {
  nodeId: string;
  nodeType: string;
  nodeClass: ReplayNodeClass;
  action: ReplayNodeAction;
}

export interface ReplayPlanWarning {
  kind: "unrecorded_stub" | "unknown_node_type" | "truncated_recording" | "config_changed";
  nodeId: string;
  nodeClass?: ReplayNodeClass;
  message: string;
}

/** A stub the hook actually returned during the run. */
export interface ReplayStubHit {
  nodeId: string;
  nodeType: string;
  nodeClass: ReplayNodeClass;
  stub: ReplayNodeStub["kind"];
  recorded: boolean;
  /** 0 for the node's first stubbed call in this replay, 1 for the second... */
  iteration: number;
  /** The node was called more often than the golden run recorded; the last recorded answer was reused. */
  overrun: boolean;
  /** The node's type or configuration differs from the golden run's workflow. */
  configChanged: boolean;
}

export interface ReplayPlanOptions {
  /** Node types the deployment knows; default: every type the replay table classifies. */
  knownTypes?: ReadonlySet<string>;
  /** The workflow as the golden run recorded it, to tell which recorded stubs changed since. */
  recordedWorkflow?: Pick<Workflow, "nodes">;
  /** Applied to both sides' configuration before they are compared (the recorded side was scrubbed when saved). */
  normaliseConfig?: (config: unknown) => unknown;
  /**
   * Phase 15.3 — nodes to run live instead of answering from the recording.
   * Only external reads (`read` class) ever run live: a write, code node,
   * approval or unknown type named here is still stubbed.
   */
  liveNodes?: ReadonlySet<string>;
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

/** The finished results to answer successive calls with, in run order. */
function runsOf(entry: ReplayRecordedNode): ReplayRecordedRun[] {
  const runs = Array.isArray(entry.runs) ? entry.runs.filter((run) => run && (run.status === "success" || run.status === "error")) : [];
  return runs.length > 0 ? runs : [entry];
}

function stubFromRun(run: ReplayRecordedRun): ReplayNodeStub {
  if (run.status === "error") return { kind: "error", message: run.error?.trim() || "The node failed in the recorded run." };
  return { kind: "output", output: run.output };
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
  options: ReplayPlanOptions = {}
): ReplayPlan {
  const known = (type: string) => (options.knownTypes ? options.knownTypes.has(type) : isKnownType(type));
  const normalise = options.normaliseConfig ?? ((config: unknown) => config);
  const fingerprint = (node: Pick<WorkflowNode, "type" | "config">) =>
    createHash("sha256").update(canonicalJson({ type: node.type, config: normalise(node.config ?? {}) ?? null })).digest("hex");
  const recordedFingerprints = new Map<string, string>();
  for (const node of options.recordedWorkflow?.nodes ?? []) {
    if (node && typeof node.id === "string" && !recordedFingerprints.has(node.id)) recordedFingerprints.set(node.id, fingerprint(node));
  }
  const changedSince = (node: Pick<WorkflowNode, "id" | "type" | "config">): boolean =>
    Boolean(options.recordedWorkflow) && recordedFingerprints.get(node.id) !== fingerprint(node);

  const decide = (node: Pick<WorkflowNode, "id" | "type" | "config">): { nodeClass: ReplayNodeClass; entry: ReplayRecordedNode | null; stub: ReplayNodeStub | null; recorded: boolean } => {
    const nodeClass = replayNodeClass({ type: node.type, config: node.config });
    if (nodeClass === "wait") return { nodeClass, entry: null, stub: { kind: "pass_through" }, recorded: false };
    if (nodeClass === "read" && options.liveNodes?.has(node.id)) return { nodeClass, entry: null, stub: null, recorded: false };
    const entry = recordedFor(recorded, node);
    if (nodeClass === "trigger") {
      // The trigger's recorded output is the run's input; an unrecorded trigger runs (triggers only read the run's own input).
      if (entry && entry.status === "success") return { nodeClass, entry: null, stub: { kind: "output", output: entry.output }, recorded: true };
      return { nodeClass, entry: null, stub: null, recorded: false };
    }
    if (!REPLAY_ALWAYS_STUBBED_CLASSES.has(nodeClass)) return { nodeClass, entry: null, stub: null, recorded: false };
    if (entry) return { nodeClass, entry, stub: stubFromRun(entry), recorded: true };
    return { nodeClass, entry: null, stub: { kind: "output", output: unrecordedStubOutput(node) }, recorded: false };
  };

  const decisions: ReplayNodeDecision[] = [];
  const warnings: ReplayPlanWarning[] = [];
  for (const node of workflow.nodes) {
    if (node.type === "sticky_note") continue;
    const decision = decide(node);
    let action: ReplayNodeAction;
    if (decision.stub?.kind === "pass_through") action = "pass_through";
    else if (decision.stub) action = decision.recorded ? "recorded" : "unrecorded_stub";
    else if (decision.nodeClass === "read") action = "live";
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
    if (action === "recorded" && decision.entry && node.disabled !== true && changedSince(node)) {
      warnings.push({
        kind: "config_changed",
        nodeId: node.id,
        nodeClass: decision.nodeClass,
        message:
          decision.nodeClass === "code"
            ? `Node ${node.id} (${node.type}): code changed since the golden run; code nodes are not executed in replay, so its recorded output was used and the new code is untested.`
            : `Node ${node.id} (${node.type}): configuration changed since the golden run; it is not run in a replay, so its recorded output was used and the change is untested.`
      });
    }
    if (action === "recorded" && decision.entry && runsOf(decision.entry).some((run) => run.status === "success" && isTruncated(run.output))) {
      warnings.push({ kind: "truncated_recording", nodeId: node.id, message: `The recorded output of node ${node.id} was cut to fit the size limit.` });
    } else if (action === "recorded" && !decision.entry && decision.stub?.kind === "output" && isTruncated(decision.stub.output)) {
      warnings.push({ kind: "truncated_recording", nodeId: node.id, message: `The recorded output of node ${node.id} was cut to fit the size limit.` });
    }
  }

  const hits: ReplayStubHit[] = [];
  const calls = new Map<string, number>();
  const hook: ReplayNodeHook = (node) => {
    const decision = decide(node);
    if (!decision.stub) return null;
    const iteration = calls.get(node.id) ?? 0;
    calls.set(node.id, iteration + 1);
    let stub = decision.stub;
    let overrun = false;
    if (decision.entry) {
      const runs = runsOf(decision.entry);
      overrun = iteration >= runs.length;
      stub = stubFromRun(runs[Math.min(iteration, runs.length - 1)]!);
    }
    hits.push({
      nodeId: node.id,
      nodeType: node.type,
      nodeClass: decision.nodeClass,
      stub: stub.kind,
      recorded: decision.recorded,
      iteration,
      overrun,
      configChanged: decision.recorded && decision.entry !== null && changedSince(node)
    });
    return stub;
  };

  return { decisions, warnings, hook, hits };
}
