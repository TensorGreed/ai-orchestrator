import type { GuardOutputHandle, WorkflowNode } from "@ai-orchestrator/shared";
import { ApprovalHandoffSignal } from "./approval-handoff";
import type { NodeLabelScope } from "./data-labels";
import {
  needsApproval,
  parseGuardNodeConfig,
  protectionBindingsFromNodes,
  resolveGuardNodeProfiles,
  runGuardCheck,
  describeGuardVerdict,
  declassifiedClasses,
  guardNodeLabels,
  profilesUsePropagatedLabels,
  type GuardCheckResult,
  type GuardEvalScope,
  type GuardRunResolution
} from "./guard-runtime";

/**
 * Phase 12.1 — the `guard` node on DAG edges. It inspects one field of the
 * incoming item and routes the item instead of failing the run:
 *
 * - `pass`: allowed, or rewritten by redact / mask / protect / transform; the
 *   item continues with the rewritten field;
 * - `blocked`: a block (and a rejected approval); carries the verdict summary only;
 * - `review`: a `review` verdict; carries the verdict summary only. When the
 *   `review` output has no edge the item goes to `blocked` instead.
 *
 * A `require_approval` verdict pauses the run through the approval hand-off:
 * approving sends the item to `pass`, rejecting sends it to `blocked`.
 * Unconnected outputs simply end that branch.
 */

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return target;
  const root: Record<string, unknown> = { ...target };
  let cursor = root;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    const copy = next && typeof next === "object" && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
    cursor[segment] = copy;
    cursor = copy;
  });
  return root;
}

export interface GuardNodeSummary {
  action: string;
  route: GuardOutputHandle;
  channel: string;
  field: string;
  transformed: boolean;
  reason: string;
  source: GuardRunResolution["source"];
  profiles: Array<{ profileId: string; version: number; hash: string }>;
  shadowAction: string;
  findings: Array<{ detectorId: string; category: string; dataClass?: string; score: number; evidence: string; effective?: string }>;
  verdicts: GuardCheckResult["verdicts"];
}

function summarize(result: GuardCheckResult, route: GuardOutputHandle, config: { channel: string; inputField: string }, source: GuardRunResolution["source"]): GuardNodeSummary {
  const shadowOrder = ["allow", "transform", "mask", "redact", "protect", "review", "require_approval", "block"];
  const shadowAction = result.verdicts
    .map((entry) => entry.summary.shadowAction)
    .reduce((best, next) => (shadowOrder.indexOf(next) > shadowOrder.indexOf(best) ? next : best), "allow");
  return {
    action: result.action,
    route,
    channel: config.channel,
    field: config.inputField,
    transformed: result.transformed,
    reason: describeGuardVerdict(result),
    source,
    profiles: result.verdicts.map((entry) => entry.profile),
    shadowAction,
    findings: result.verdicts.flatMap((entry) =>
      entry.summary.findings.map((finding, index) => ({
        detectorId: finding.detectorId,
        category: finding.category,
        ...(finding.dataClass ? { dataClass: finding.dataClass } : {}),
        score: finding.score,
        evidence: finding.evidence,
        ...(entry.summary.actions[index] ? { effective: entry.summary.actions[index]!.effective } : {})
      }))
    ),
    verdicts: result.verdicts
  };
}

export async function executeGuardNodeStep(input: {
  node: WorkflowNode;
  scope: GuardEvalScope;
  merged: Record<string, unknown>;
  /** Parent node ids: their copies inside `merged` are dropped from the pass output so the unguarded value does not ride along. */
  parentIds: string[];
  globals: Record<string, unknown>;
  protectionNodes: WorkflowNode[];
  /** Output handles of this node that have an edge. */
  connectedHandles: Set<string>;
  /** Phase 16 — the node's labels: its input's provenance (when a profile asks for it), and the classes it rewrites away. */
  labelScope?: NodeLabelScope;
}): Promise<Record<string, unknown>> {
  const config = parseGuardNodeConfig(input.node);
  const { profiles, resolution } = await resolveGuardNodeProfiles(input.scope.guard, config, protectionBindingsFromNodes(input.protectionNodes));
  const fromItem = readPath(input.merged, config.inputField);
  const value = fromItem !== undefined ? fromItem : readPath(input.globals, config.inputField);
  const propagated = input.labelScope && profilesUsePropagatedLabels(profiles) ? input.labelScope.inputLabels().provenance : undefined;
  const result = await runGuardCheck(input.scope, profiles, { content: value ?? "", channel: config.channel, labels: guardNodeLabels(config, propagated) });
  // A redacted, masked or protected class is gone from the inspected field (on tracked runs the output scan finds any left elsewhere in the item).
  input.labelScope?.declassify(declassifiedClasses(result));

  const parentIds = new Set(input.parentIds);
  const itemWithoutParentCopies = Object.fromEntries(Object.entries(input.merged).filter(([key]) => !parentIds.has(key)));
  const passOutput = (summary: GuardNodeSummary) => ({
    ...writePath(itemWithoutParentCopies, config.inputField, result.transformed ? result.content : value ?? ""),
    guard: summary,
    _branchHandle: "pass"
  });
  const stoppedOutput = (route: GuardOutputHandle, summary: GuardNodeSummary) => ({ guard: summary, _branchHandle: route });

  if (result.action === "block") {
    return stoppedOutput("blocked", summarize(result, "blocked", config, resolution.source));
  }
  if (result.action === "review") {
    const route: GuardOutputHandle = input.connectedHandles.has("review") ? "review" : "blocked";
    return stoppedOutput(route, summarize(result, route, config, resolution.source));
  }
  if (needsApproval(result.action)) {
    const approvedSummary = summarize(result, "pass", config, resolution.source);
    const rejectedSummary = summarize(result, "blocked", config, resolution.source);
    throw new ApprovalHandoffSignal({
      message: config.approvalMessage?.trim() || `Guard '${input.node.name}' needs approval: ${describeGuardVerdict(result)}`,
      timeoutMinutes: config.timeoutMinutes,
      handoff: {
        kind: "route",
        source: "guard_node",
        onApprove: passOutput(approvedSummary),
        onReject: stoppedOutput("blocked", rejectedSummary)
      },
      details: { guard: { action: result.action, reason: approvedSummary.reason, findings: approvedSummary.findings, profiles: approvedSummary.profiles } }
    });
  }
  return passOutput(summarize(result, "pass", config, resolution.source));
}
