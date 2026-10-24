/**
 * Phase 15.6 — pure helpers behind the guard policy simulation card on the
 * Security page: per-workflow rows, checkpoint and change labels, and the
 * busiest detectors and data classes.
 */

import type { GuardSimulationCase, GuardSimulationChange, GuardSimulationCheckpoint, GuardSimulationTally, GuardSimulationView, GuardSimulationWorkflow } from "@ai-orchestrator/shared";

export interface GuardSimulationWorkflowRow {
  workflowId: string;
  workflowName: string;
  runs: number;
  newlyBlocked: number;
  nowMasked: number;
  noLongerBlocked: number;
  changed: number;
  diverged: number;
  notSimulated: number;
  error: string | null;
}

/** Runs per workflow with at least one checkpoint of each kind. */
export function simulationWorkflowRows(workflows: readonly GuardSimulationWorkflow[]): GuardSimulationWorkflowRow[] {
  return workflows.map((workflow) => {
    const count = (test: (entry: GuardSimulationCase) => boolean) => workflow.cases.filter(test).length;
    return {
      workflowId: workflow.workflowId,
      workflowName: workflow.workflowName,
      runs: workflow.cases.length,
      newlyBlocked: count((entry) => entry.counts.newlyBlocked > 0),
      nowMasked: count((entry) => entry.counts.nowMasked > 0),
      noLongerBlocked: count((entry) => entry.counts.noLongerBlocked > 0),
      changed: count((entry) => entry.counts.newlyBlocked + entry.counts.noLongerBlocked + entry.counts.actionChanged > 0),
      diverged: count((entry) => entry.outcome === "diverged"),
      notSimulated: count((entry) => entry.outcome === "not_simulated"),
      error: workflow.error ?? null
    };
  });
}

/** The runs worth a look: changed, diverged or not simulated, changed first. */
export function notableCases(workflow: GuardSimulationWorkflow): GuardSimulationCase[] {
  const rank = (entry: GuardSimulationCase) =>
    entry.counts.newlyBlocked > 0 ? 0 : entry.counts.noLongerBlocked > 0 ? 1 : entry.counts.actionChanged > 0 ? 2 : entry.outcome === "diverged" ? 3 : entry.outcome === "not_simulated" ? 4 : 5;
  return workflow.cases.filter((entry) => rank(entry) < 5).sort((a, b) => rank(a) - rank(b));
}

const CHANGE_LABELS: Record<GuardSimulationChange, string> = {
  newly_blocked: "newly blocked",
  no_longer_blocked: "no longer blocked",
  action_changed: "action changed",
  unchanged: "unchanged"
};

export function changeLabel(change: GuardSimulationChange): string {
  return CHANGE_LABELS[change];
}

/** "guard · prompt" (and "#2" when the place checked more than once). */
export function checkpointPlace(checkpoint: Pick<GuardSimulationCheckpoint, "nodeId" | "channel" | "occurrence">): string {
  const base = `${checkpoint.nodeId ?? "run"} · ${checkpoint.channel.replace(/_/g, " ")}`;
  return checkpoint.occurrence > 1 ? `${base} #${checkpoint.occurrence}` : base;
}

/** "allow → block"; a side without a verdict there reads "nothing". */
export function actionTransition(checkpoint: Pick<GuardSimulationCheckpoint, "before" | "after">): string {
  return `${checkpoint.before ?? "nothing"} → ${checkpoint.after ?? "nothing"}`;
}

export function divergenceText(entry: GuardSimulationCase): string | null {
  if (entry.outcome !== "diverged" || !entry.divergedAt) return null;
  const what = entry.divergedAt.kind === "model" ? "model call" : "tool call";
  return entry.divergedAt.step === null ? `Diverged at a ${what} the recording has no answer for` : `Diverged at step ${entry.divergedAt.step} (${what} ${entry.divergedAt.step})`;
}

/** The keys with the most changes, most first. */
export function topTallies(tallies: Record<string, GuardSimulationTally>, limit = 6): Array<{ key: string; total: number; tally: GuardSimulationTally }> {
  return Object.entries(tallies)
    .map(([key, tally]) => ({ key, tally, total: tally.newlyBlocked + tally.noLongerBlocked + tally.actionChanged }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function simulationFinished(view: Pick<GuardSimulationView, "status"> | null | undefined): boolean {
  return Boolean(view && view.status !== "running");
}
