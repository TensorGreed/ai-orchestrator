/**
 * Phase 15.6 — comparing a guard policy simulation's two replays of one
 * recording, checkpoint by checkpoint (pure; see guard-simulation.ts in
 * shared for the vocabulary).
 *
 * Both sides are fresh replays of the same workflow version from the same
 * recording, models from its tape and strict MCP: the baseline under the
 * profiles in force now, the candidate with the simulated profile swapped
 * in. Any difference between them is the simulated change's.
 *
 * A checkpoint is one check: the profile stack evaluated once on one piece
 * of content at one place (node, placement, channel, agent iteration and
 * tool), numbered in order when the same place checks more than once. Its
 * action is the stack's combined action, what the traffic got, so a
 * checkpoint is counted once however many profiles the stack has and
 * wherever it stopped. Per-detector changes are listed as detail.
 *
 *   - both sides: newly blocked, no longer blocked, action changed (with
 *     "now masked" when the candidate masks, redacts or protects content the
 *     baseline let through) or unchanged;
 *   - only the baseline: not reached (the candidate stopped or diverged first);
 *   - only the candidate: compared with "allow" (nothing checked there before).
 */

import { mostSevereAction, type GuardAction } from "@ai-orchestrator/guard-sdk";
import {
  emptyGuardSimulationCounts,
  GUARD_SIMULATION_BLOCKING_ACTIONS,
  GUARD_SIMULATION_MASKING_ACTIONS,
  type GuardSimulationCase,
  type GuardSimulationChange,
  type GuardSimulationCheckpoint,
  type GuardSimulationCounts,
  type GuardSimulationDetectorChange,
  type ReplayHealthWarning,
  type ReplayRunResponse,
  type ReplayToolStep
} from "@ai-orchestrator/shared";
import type { SimulatedGuardCheck } from "./guard-simulation-sink.js";

const checkPlace = (check: SimulatedGuardCheck) =>
  [check.nodeId ?? "", check.placement, check.channel, check.iteration ?? "", check.toolName ?? ""].join("\u0000");

function severest(actions: string[]): string {
  return actions.length === 0 ? "allow" : mostSevereAction(actions as GuardAction[]);
}

export function classifyGuardChange(before: string, after: string): GuardSimulationChange {
  const wasBlocking = GUARD_SIMULATION_BLOCKING_ACTIONS.has(before);
  const isBlocking = GUARD_SIMULATION_BLOCKING_ACTIONS.has(after);
  if (isBlocking && !wasBlocking) return "newly_blocked";
  if (wasBlocking && !isBlocking) return "no_longer_blocked";
  return before === after ? "unchanged" : "action_changed";
}

function isNowMasked(before: string, after: string): boolean {
  return GUARD_SIMULATION_MASKING_ACTIONS.has(after) && !GUARD_SIMULATION_MASKING_ACTIONS.has(before) && !GUARD_SIMULATION_BLOCKING_ACTIONS.has(before);
}

/** Each detector's most severe non-shadow action across the check's profiles. */
function detectorActions(check: SimulatedGuardCheck | undefined): Map<string, { action: string; dataClass: string | null }> {
  const out = new Map<string, { actions: string[]; dataClass: string | null }>();
  for (const verdict of check?.verdicts ?? []) {
    for (const finding of verdict.findings) {
      if (finding.detectorId === null) continue;
      const entry = out.get(finding.detectorId) ?? { actions: [], dataClass: null };
      if (!finding.shadow) entry.actions.push(finding.effectiveAction);
      entry.dataClass = entry.dataClass ?? finding.dataClass ?? null;
      out.set(finding.detectorId, entry);
    }
  }
  return new Map([...out].map(([id, entry]) => [id, { action: severest(entry.actions), dataClass: entry.dataClass }]));
}

function detectorChanges(before: SimulatedGuardCheck | undefined, after: SimulatedGuardCheck | undefined): GuardSimulationDetectorChange[] {
  const left = detectorActions(before);
  const right = detectorActions(after);
  const changes: GuardSimulationDetectorChange[] = [];
  for (const detectorId of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(detectorId) ?? null;
    const b = right.get(detectorId) ?? null;
    const change = classifyGuardChange(a?.action ?? "allow", b?.action ?? "allow");
    if (change === "unchanged") continue;
    changes.push({ detectorId, dataClass: b?.dataClass ?? a?.dataClass ?? null, before: a ? a.action : null, after: b ? b.action : null, change });
  }
  return changes.sort((x, y) => x.detectorId.localeCompare(y.detectorId));
}

/**
 * Pairs the baseline's and the candidate's checks and counts what changed;
 * only changed checkpoints are listed. `nodeNames` names the nodes for the
 * details view.
 */
export function compareGuardChecks(
  baseline: readonly SimulatedGuardCheck[],
  candidate: readonly SimulatedGuardCheck[],
  nodeNames: ReadonlyMap<string, string> = new Map()
): { counts: GuardSimulationCounts; checkpoints: GuardSimulationCheckpoint[] } {
  const counts = emptyGuardSimulationCounts();
  const checkpoints: GuardSimulationCheckpoint[] = [];
  const byPlace = (checks: readonly SimulatedGuardCheck[]) => {
    const map = new Map<string, SimulatedGuardCheck[]>();
    for (const check of checks) map.set(checkPlace(check), [...(map.get(checkPlace(check)) ?? []), check]);
    return map;
  };
  const left = byPlace(baseline);
  const right = byPlace(candidate);
  // Places in the order the candidate reached them, then the ones only the baseline has.
  for (const key of new Set([...right.keys(), ...left.keys()])) {
    const before = left.get(key) ?? [];
    const after = right.get(key) ?? [];
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      const b = before[index];
      const a = after[index];
      if (b && !a) {
        counts.notReached += 1;
        continue;
      }
      const place = a!;
      const beforeAction = b ? b.action : null;
      const afterAction = place.action;
      const change = classifyGuardChange(beforeAction ?? "allow", afterAction);
      if (change === "unchanged") {
        counts.unchanged += 1;
        continue;
      }
      if (change === "newly_blocked") counts.newlyBlocked += 1;
      else if (change === "no_longer_blocked") counts.noLongerBlocked += 1;
      else {
        counts.actionChanged += 1;
        if (isNowMasked(beforeAction ?? "allow", afterAction)) counts.nowMasked += 1;
      }
      checkpoints.push({
        nodeId: place.nodeId,
        nodeName: place.nodeId ? (nodeNames.get(place.nodeId) ?? null) : null,
        placement: place.placement,
        channel: place.channel,
        ...(place.iteration !== null ? { iteration: place.iteration } : {}),
        ...(place.toolName !== null ? { toolName: place.toolName } : {}),
        occurrence: index + 1,
        before: beforeAction,
        after: afterAction,
        change,
        detectors: detectorChanges(b, a),
        ...(place.destination ? { destination: place.destination } : b?.destination ? { destination: b.destination } : {})
      });
    }
  }
  return { counts, checkpoints };
}

/** The part of a replay a simulation reads: its outcome and health, without its facts. */
export interface SimulatedReplay {
  status: string;
  error: string | null;
  executionId: string | null;
  /** The replay response (its `diff.health`, `modelTape` and tool steps). Null when the replay threw before answering. */
  response: Omit<ReplayRunResponse, "facts"> | null;
}

function healthOf(replay: SimulatedReplay): ReplayHealthWarning[] {
  return replay.response?.diff.health ?? [];
}

/**
 * Where a replay ran out of recorded answers, if it did: the first model
 * call the tape could not answer (its 1-based position: calls the tape
 * answered + 1) or the first tool call the cassette could not answer.
 */
export function divergenceOf(replay: SimulatedReplay): GuardSimulationCase["divergedAt"] | null {
  const health = healthOf(replay);
  const model = health.find((warning) => warning.kind === "model_unmatched" && warning.blocking);
  if (model) {
    const matched = replay.response?.modelTape?.matchedCalls;
    return { step: typeof matched === "number" ? matched + 1 : null, kind: "model", nodeId: model.nodeId, message: model.message };
  }
  const tool = health.find((warning) => warning.kind === "mcp_unmatched" && warning.blocking);
  if (tool) {
    const steps = (replay.response?.diff.toolCalls?.steps ?? []) as ReplayToolStep[];
    const index = Array.isArray(steps) ? steps.findIndex((step) => step.kind !== "matched" || step.outcomeChanged) : -1;
    const nodeId = index >= 0 ? (steps[index]!.candidate ?? steps[index]!.baseline)?.nodeId ?? null : tool.nodeId;
    return { step: index >= 0 ? index + 1 : null, kind: "tool", nodeId, message: tool.message };
  }
  return null;
}

/** Why a replay could not follow its recording (a blocking health warning, or no execution at all); null when it could. */
function blockingProblem(replay: SimulatedReplay): string | null {
  const blocking = healthOf(replay).find((warning) => warning.blocking);
  if (blocking) return blocking.message;
  if (!replay.executionId || !replay.response) return replay.error ?? "The replay could not run.";
  return null;
}

export const GUARD_SIMULATION_STALE_REASON = "Not simulated: the recording is stale (replayed under the current profiles, it no longer follows its recorded answers: the workflow changed, the profiles in force now rewrite its content, or a protect token is not deterministic)";

/**
 * One case of a simulation, from its two replays.
 *
 *   - The baseline (current profiles) cannot follow the recording: the
 *     recording is stale for the workflow version replayed, and the case is
 *     not simulated (never counted as an impact).
 *   - The candidate runs out of recorded answers where the baseline did not:
 *     diverged at step k, an impact of the change (a checkpoint's action, or
 *     what the profile does to content without changing an action, such as
 *     spotlighting). When the simulated profile is the current one and no
 *     checkpoint changed, the miss is not the guard's: not simulated.
 *   - Otherwise the checkpoints are compared.
 */
export async function simulateCase(input: {
  recordingId: string;
  recording: { id: string; name: string; createdAt: string | null } | null;
  baseline: { replay: SimulatedReplay; checks: readonly SimulatedGuardCheck[] } | null;
  candidate: { replay: SimulatedReplay; checks: readonly SimulatedGuardCheck[] } | null;
  nodeNames?: ReadonlyMap<string, string>;
  /** The simulated profile differs from the current one (false: the same document, so only chance can tell the replays apart). */
  profileChanged?: boolean;
  /** Text to keep out of stored reasons (secrets). */
  scrub?: (text: string) => string | Promise<string>;
  /** Why the case did not run (the starter lost access, the job stopped), when it did not. */
  skipped?: string;
}): Promise<GuardSimulationCase> {
  const scrub = input.scrub ?? ((text: string) => text);
  const base = {
    recordingId: input.recordingId,
    recordingName: input.recording?.name ?? input.recordingId,
    recordedAt: input.recording?.createdAt ?? null,
    executionId: input.candidate?.replay.executionId ?? null,
    baselineExecutionId: input.baseline?.replay.executionId ?? null
  };
  const notSimulated = async (reason: string): Promise<GuardSimulationCase> => ({ ...base, outcome: "not_simulated", reason: await scrub(reason), counts: emptyGuardSimulationCounts(), checkpoints: [] });
  if (!input.recording) return await notSimulated("The recording was deleted before it could be replayed.");
  if (input.skipped) return await notSimulated(input.skipped);
  if (!input.baseline) return await notSimulated("The replay did not run (the simulation was stopped first).");
  const stale = blockingProblem(input.baseline.replay);
  if (stale) return await notSimulated(`${GUARD_SIMULATION_STALE_REASON}: ${stale}`);
  if (!input.candidate) return await notSimulated("The replay did not run (the simulation was stopped first).");

  const { counts, checkpoints } = compareGuardChecks(input.baseline.checks, input.candidate.checks, input.nodeNames);
  const guardChanged = counts.newlyBlocked + counts.noLongerBlocked + counts.actionChanged > 0;
  const divergedAt = divergenceOf(input.candidate.replay);
  if (divergedAt) {
    if (guardChanged || input.profileChanged !== false) return { ...base, outcome: "diverged", divergedAt: { ...divergedAt, message: await scrub(divergedAt.message) }, counts, checkpoints };
    return await notSimulated(
      "Not simulated: the replay needed an answer this recording does not have, but the simulated profile is the current one and no guard checkpoint changed, so the difference is not the guard's."
    );
  }
  const problem = blockingProblem(input.candidate.replay);
  if (problem) return await notSimulated(problem);
  return { ...base, outcome: "compared", counts, checkpoints };
}
