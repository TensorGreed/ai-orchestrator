/**
 * Phase 15.6 — guard policy simulation.
 *
 * "What would this guard profile change have done to recent traffic?" A
 * simulation replays the most recent recordings of the workflows a guard
 * profile applies to, with model calls answered from each recording's model
 * tape and MCP calls from its cassette (never a live model or server), and
 * the profile swapped for the simulated one: an unsaved document from the
 * editor, or a saved version. It then compares the guard's verdicts at every
 * checkpoint with what the recorded run did.
 *
 * A checkpoint is one guard verdict at one place: a node, its placement
 * (`node` or `agent`) and the channel, counted in order when the same place
 * checks more than once. Each checkpoint is newly blocked, no longer
 * blocked, changed (another action, such as now masked) or unchanged.
 * Checkpoints the replay never reached (the run stopped earlier) are counted
 * apart. When a guard change makes the replay ask for a model or tool answer
 * the recording does not have, the case "diverged at step k": an impact of
 * the change, reported as such, never a live call.
 */

import { z } from "zod";

/** How many recent recordings a simulation replays when the request names no limit. */
export const GUARD_SIMULATION_DEFAULT_CASES = 50;

/** The default of REPLAY_SIMULATION_MAX_CASES: the most recordings one simulation may replay. */
export const GUARD_SIMULATION_MAX_CASES_DEFAULT = 200;

/** How long a simulation (and its replay jobs) is kept. */
export const GUARD_SIMULATION_RETENTION_DAYS = 30;

/** Guard actions that stop content (a person may let it through later). */
export const GUARD_SIMULATION_BLOCKING_ACTIONS: ReadonlySet<string> = new Set(["block", "review", "require_approval"]);

/** Guard actions that rewrite content instead of stopping it. */
export const GUARD_SIMULATION_MASKING_ACTIONS: ReadonlySet<string> = new Set(["mask", "redact", "protect"]);

/**
 * `POST /api/guard/profiles/:id/simulate`. Exactly one of `document` (the
 * editor's unsaved profile document; validated, hashed, never stored) or
 * `version` (a saved version, compared with what the recordings did under
 * the profile in force then).
 */
export const guardSimulationRequestSchema = z
  .object({
    document: z.record(z.string(), z.unknown()).optional(),
    version: z.number().int().positive().optional(),
    /** Most recent recordings to replay; capped by REPLAY_SIMULATION_MAX_CASES. */
    limit: z.number().int().min(1).max(10_000).optional()
  })
  .strict()
  .refine((value) => (value.document === undefined) !== (value.version === undefined), {
    message: "Send either the profile document to simulate or a saved version, not both"
  });
export type GuardSimulationRequest = z.infer<typeof guardSimulationRequestSchema>;

export type GuardSimulationChange = "newly_blocked" | "no_longer_blocked" | "action_changed" | "unchanged";

export interface GuardSimulationCounts {
  newlyBlocked: number;
  noLongerBlocked: number;
  /** Another action that neither starts nor stops a block (includes `nowMasked`). */
  actionChanged: number;
  /** Of `actionChanged`: checkpoints that now mask, redact or protect content they let through unchanged before. */
  nowMasked: number;
  unchanged: number;
  /** Checkpoints the recorded run reached and the replay did not (it stopped or diverged earlier). */
  notReached: number;
}

export interface GuardSimulationDetectorChange {
  detectorId: string;
  dataClass: string | null;
  /** The detector's effective action before and after; null when it did not fire. */
  before: string | null;
  after: string | null;
  change: Exclude<GuardSimulationChange, "unchanged">;
}

export interface GuardSimulationCheckpoint {
  nodeId: string | null;
  placement: string;
  channel: string;
  /** 1-based: the n-th verdict at this node, placement and channel. */
  occurrence: number;
  /** The verdict's action in the recording and in the replay; null when that side has no verdict here. */
  before: string | null;
  after: string | null;
  change: GuardSimulationChange;
  /** Detectors whose action changed at this checkpoint. */
  detectors: GuardSimulationDetectorChange[];
}

export type GuardSimulationCaseOutcome = "compared" | "diverged" | "not_simulated";

export interface GuardSimulationCase {
  recordingId: string;
  recordingName: string;
  recordedAt: string | null;
  /** The replay execution; null when the case never ran. */
  executionId: string | null;
  outcome: GuardSimulationCaseOutcome;
  /**
   * For a diverged case: the 1-based step (the n-th model call, or the n-th
   * tool call) the recording has no answer for; null when the stored replay
   * diff was too large to keep that detail.
   */
  divergedAt?: { step: number | null; kind: "model" | "tool"; nodeId: string | null; message: string };
  /** Why a case could not be simulated (no model tape, the replay failed, …). */
  reason?: string;
  counts: GuardSimulationCounts;
  /** Checkpoints whose verdict changed (unchanged ones are only counted). */
  checkpoints: GuardSimulationCheckpoint[];
}

export interface GuardSimulationWorkflow {
  workflowId: string;
  workflowName: string;
  projectId: string | null;
  /** The replay job that ran this workflow's cases; null when it could not start. */
  jobId: string | null;
  /** Why the job could not start or finish, when it did not. */
  error?: string;
  cases: GuardSimulationCase[];
}

export interface GuardSimulationTally {
  newlyBlocked: number;
  noLongerBlocked: number;
  actionChanged: number;
}

export interface GuardSimulationSummary {
  /** Recordings replayed (every case, whatever its outcome). */
  runs: number;
  workflows: number;
  compared: number;
  diverged: number;
  notSimulated: number;
  /** Runs with at least one checkpoint of that kind. */
  runsNewlyBlocked: number;
  runsNowMasked: number;
  runsNoLongerBlocked: number;
  runsChanged: number;
  runsUnchanged: number;
  checkpoints: GuardSimulationCounts;
  /** Changed detector actions per data class (findings without a data class are not listed here). */
  byDataClass: Record<string, GuardSimulationTally>;
  byDetector: Record<string, GuardSimulationTally>;
  /** One plain sentence for the summary card. */
  sentence: string;
}

export type GuardSimulationStatus = "running" | "completed" | "failed";

export interface GuardSimulationView {
  id: string;
  profileId: string;
  /** What was simulated: the editor's unsaved document, or a saved version. */
  source: { kind: "inline" | "version"; version: number | null; hash: string };
  /** The profile's latest version when the simulation started. */
  baseVersion: number | null;
  status: GuardSimulationStatus;
  createdAt: string;
  createdBy: string | null;
  finishedAt: string | null;
  jobIds: string[];
  /** Over the workflows the viewer can read. Null while running. */
  summary: GuardSimulationSummary | null;
  /** While running: recordings replayed so far, of all. */
  progress?: { done: number; total: number } | null;
  /** Per-workflow detail (detail endpoint only), limited to workflows the viewer can read. */
  workflows?: GuardSimulationWorkflow[];
  /** Workflows of this simulation the viewer cannot read (left out of the summary and detail). */
  hiddenWorkflows?: number;
  /** Why nothing ran, for the empty state. */
  emptyReason?: string | null;
  error?: string | null;
}

export function emptyGuardSimulationCounts(): GuardSimulationCounts {
  return { newlyBlocked: 0, noLongerBlocked: 0, actionChanged: 0, nowMasked: 0, unchanged: 0, notReached: 0 };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Across 50 recent runs in 4 workflows: 3 newly blocked, 7 now masked, 0 no longer blocked." */
export function guardSimulationSentence(summary: Omit<GuardSimulationSummary, "sentence">): string {
  if (summary.runs === 0) return "No recent recorded runs to simulate.";
  const head = `Across ${plural(summary.runs, "recent run", "recent runs")} in ${plural(summary.workflows, "workflow", "workflows")}: ${summary.runsNewlyBlocked} newly blocked, ${summary.runsNowMasked} now masked, ${summary.runsNoLongerBlocked} no longer blocked.`;
  const extra: string[] = [];
  if (summary.diverged > 0) extra.push(`${plural(summary.diverged, "run", "runs")} diverged after the guard change`);
  if (summary.notSimulated > 0) extra.push(`${plural(summary.notSimulated, "run", "runs")} could not be simulated`);
  return extra.length > 0 ? `${head} ${extra.join("; ")}.` : head;
}

/** The summary of some workflows' cases (the viewer's readable ones). */
export function summariseGuardSimulation(workflows: readonly GuardSimulationWorkflow[]): GuardSimulationSummary {
  const checkpoints = emptyGuardSimulationCounts();
  const byDataClass: Record<string, GuardSimulationTally> = {};
  const byDetector: Record<string, GuardSimulationTally> = {};
  const tally = (map: Record<string, GuardSimulationTally>, key: string, change: GuardSimulationDetectorChange["change"]) => {
    const entry = (map[key] ??= { newlyBlocked: 0, noLongerBlocked: 0, actionChanged: 0 });
    if (change === "newly_blocked") entry.newlyBlocked += 1;
    else if (change === "no_longer_blocked") entry.noLongerBlocked += 1;
    else entry.actionChanged += 1;
  };
  let runs = 0;
  let compared = 0;
  let diverged = 0;
  let notSimulated = 0;
  let runsNewlyBlocked = 0;
  let runsNowMasked = 0;
  let runsNoLongerBlocked = 0;
  let runsChanged = 0;
  let runsUnchanged = 0;
  for (const workflow of workflows) {
    for (const entry of workflow.cases) {
      runs += 1;
      if (entry.outcome === "compared") compared += 1;
      else if (entry.outcome === "diverged") diverged += 1;
      else notSimulated += 1;
      for (const key of Object.keys(checkpoints) as Array<keyof GuardSimulationCounts>) checkpoints[key] += entry.counts[key];
      if (entry.counts.newlyBlocked > 0) runsNewlyBlocked += 1;
      if (entry.counts.nowMasked > 0) runsNowMasked += 1;
      if (entry.counts.noLongerBlocked > 0) runsNoLongerBlocked += 1;
      const changed = entry.counts.newlyBlocked + entry.counts.noLongerBlocked + entry.counts.actionChanged > 0;
      if (changed) runsChanged += 1;
      else if (entry.outcome === "compared") runsUnchanged += 1;
      for (const checkpoint of entry.checkpoints) {
        for (const detector of checkpoint.detectors) {
          tally(byDetector, detector.detectorId, detector.change);
          if (detector.dataClass) tally(byDataClass, detector.dataClass, detector.change);
        }
      }
    }
  }
  const summary = {
    runs,
    workflows: workflows.filter((workflow) => workflow.cases.length > 0).length,
    compared,
    diverged,
    notSimulated,
    runsNewlyBlocked,
    runsNowMasked,
    runsNoLongerBlocked,
    runsChanged,
    runsUnchanged,
    checkpoints,
    byDataClass,
    byDetector
  };
  return { ...summary, sentence: guardSimulationSentence(summary) };
}
