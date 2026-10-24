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

/** "Prompt guard · prompt" (the node's name when known; "#2" when the place checked more than once; the agent's tool when it has one). */
export function checkpointPlace(checkpoint: Pick<GuardSimulationCheckpoint, "nodeId" | "nodeName" | "channel" | "occurrence" | "toolName">): string {
  const node = checkpoint.nodeName || checkpoint.nodeId || "run";
  const base = `${node} · ${checkpoint.channel.replace(/_/g, " ")}${checkpoint.toolName ? ` (${checkpoint.toolName})` : ""}`;
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

/** Delay before the n-th retry (1-based) of a failed poll: 2 s, 4 s, 8 s, … capped at 30 s. */
export function pollRetryDelay(attempt: number, baseMs = 2000): number {
  return Math.min(30_000, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Failed polls in a row before the card stops and offers a retry. */
export const POLL_MAX_RETRIES = 5;

/**
 * Why this user may not simulate the profile (a plain tooltip), or null when
 * they may. The same rule as saving: admins, and builders on profiles that
 * are neither built-in nor enforced on a project.
 */
export function simulateDenial(role: string, profile: { builtIn: boolean; enforced?: boolean }): string | null {
  if (role === "admin") return null;
  if (role !== "builder") return "Only admins and builders can simulate guard profile changes.";
  if (profile.builtIn) return "The built-in profile is read-only: only an admin can simulate changes to it. Duplicate it to simulate your own.";
  if (profile.enforced) return "A project enforces this profile: only an admin can change or simulate it.";
  return null;
}
