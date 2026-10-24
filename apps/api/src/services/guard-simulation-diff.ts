/**
 * Phase 15.6 — comparing a guard policy simulation's replay with the
 * recorded run, checkpoint by checkpoint (pure; see guard-simulation.ts in
 * shared for the vocabulary).
 *
 * A checkpoint is one guard verdict at one place: node, placement and
 * channel, numbered in order when the same place checks more than once. Its
 * action is the most severe effective action of the verdict's non-shadow
 * findings (a clean verdict's own action otherwise), so a finding in shadow
 * mode never counts as a block. Recorded and replayed checkpoints are paired
 * by place and number:
 *
 *   - both sides: newly blocked, no longer blocked, action changed (with
 *     "now masked" when the replay masks, redacts or protects content the
 *     recording let through) or unchanged;
 *   - only the recording: not reached (the replay stopped or diverged first);
 *   - only the replay: compared with "allow" (nothing checked there before).
 *
 * Changed checkpoints list the detectors whose action changed, with their
 * data class, for the per-detector and per-data-class counts.
 *
 * Rows from facts built before 15.6 carry no verdict number; they are
 * grouped by place, a new verdict starting when a detector repeats or a
 * clean row appears.
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
  type ReplayToolStep,
  type RunFactGuardVerdict
} from "@ai-orchestrator/shared";

interface Verdict {
  key: string;
  nodeId: string | null;
  placement: string;
  channel: string;
  rows: RunFactGuardVerdict[];
}

const placeKey = (row: Pick<RunFactGuardVerdict, "nodeId" | "placement" | "channel">) => [row.nodeId ?? "", row.placement, row.channel].join("\u0000");

/** Rows grouped into verdicts, in the order verdicts first appear. */
export function groupGuardVerdicts(rows: readonly RunFactGuardVerdict[]): Verdict[] {
  const verdicts: Verdict[] = [];
  if (rows.length > 0 && rows.every((row) => typeof row.verdict === "number")) {
    const byIndex = new Map<number, Verdict>();
    for (const row of rows) {
      let verdict = byIndex.get(row.verdict!);
      if (!verdict) {
        verdict = { key: placeKey(row), nodeId: row.nodeId, placement: row.placement, channel: row.channel, rows: [] };
        byIndex.set(row.verdict!, verdict);
        verdicts.push(verdict);
      }
      verdict.rows.push(row);
    }
    return verdicts;
  }
  const open = new Map<string, Verdict>();
  for (const row of rows) {
    const key = placeKey(row);
    let verdict = open.get(key);
    const startsNew =
      !verdict ||
      row.detectorId === null ||
      verdict.rows.some((existing) => existing.detectorId === null || existing.detectorId === row.detectorId);
    if (startsNew) {
      verdict = { key, nodeId: row.nodeId, placement: row.placement, channel: row.channel, rows: [] };
      open.set(key, verdict);
      verdicts.push(verdict);
    }
    verdict!.rows.push(row);
  }
  return verdicts;
}

function severest(actions: string[]): string {
  return actions.length === 0 ? "allow" : mostSevereAction(actions as GuardAction[]);
}

/** The verdict's action: the most severe non-shadow effective action ("allow" when every finding was shadow). */
export function verdictAction(verdict: Verdict): string {
  return severest(verdict.rows.filter((row) => !row.shadow).map((row) => row.effectiveAction));
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

function detectorActions(verdict: Verdict | undefined): Map<string, { action: string; dataClass: string | null }> {
  const out = new Map<string, { actions: string[]; dataClass: string | null }>();
  for (const row of verdict?.rows ?? []) {
    if (row.detectorId === null) continue;
    const entry = out.get(row.detectorId) ?? { actions: [], dataClass: null };
    if (!row.shadow) entry.actions.push(row.effectiveAction);
    entry.dataClass = entry.dataClass ?? row.dataClass ?? null;
    out.set(row.detectorId, entry);
  }
  return new Map([...out].map(([id, entry]) => [id, { action: severest(entry.actions), dataClass: entry.dataClass }]));
}

function detectorChanges(before: Verdict | undefined, after: Verdict | undefined): GuardSimulationDetectorChange[] {
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

/** Pairs the recorded and replayed verdicts and counts what changed; only changed checkpoints are listed. */
export function compareGuardCheckpoints(
  recorded: readonly RunFactGuardVerdict[],
  replayed: readonly RunFactGuardVerdict[]
): { counts: GuardSimulationCounts; checkpoints: GuardSimulationCheckpoint[] } {
  const counts = emptyGuardSimulationCounts();
  const checkpoints: GuardSimulationCheckpoint[] = [];
  const byPlace = (verdicts: Verdict[]) => {
    const map = new Map<string, Verdict[]>();
    for (const verdict of verdicts) map.set(verdict.key, [...(map.get(verdict.key) ?? []), verdict]);
    return map;
  };
  const left = byPlace(groupGuardVerdicts(recorded));
  const right = byPlace(groupGuardVerdicts(replayed));
  // Places in the order the replay reached them, then the ones only the recording has.
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
      const place = (a ?? b)!;
      const beforeAction = b ? verdictAction(b) : null;
      const afterAction = verdictAction(a!);
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
        placement: place.placement,
        channel: place.channel,
        occurrence: index + 1,
        before: beforeAction,
        after: afterAction,
        change,
        detectors: detectorChanges(b, a)
      });
    }
  }
  return { counts, checkpoints };
}

/** The stored part of a replayed case the simulation reads (the replay response without its facts). */
export interface StoredReplayCase {
  status: string;
  error: string | null;
  executionId: string | null;
  /** `ReplayRunResponse` without `facts`, or a truncation marker. */
  diff: unknown;
}

function healthOf(diff: unknown): ReplayHealthWarning[] | null {
  const inner = diff && typeof diff === "object" ? (diff as { diff?: { health?: unknown } }).diff : undefined;
  return inner && Array.isArray(inner.health) ? (inner.health as ReplayHealthWarning[]) : null;
}

/**
 * Where a replay ran out of recorded answers, if it did: the first model
 * call the tape could not answer (its 1-based position: calls the tape
 * answered + 1)
 * or the first tool call the cassette could not answer.
 */
export function divergenceOf(stored: StoredReplayCase): GuardSimulationCase["divergedAt"] | null {
  const health = healthOf(stored.diff);
  if (!health) {
    // The diff was too large to store: only the error text says what happened.
    if (stored.status === "error" && stored.error && /no recorded answer/i.test(stored.error)) {
      return { step: null, kind: /model tape/i.test(stored.error) ? "model" : "tool", nodeId: null, message: stored.error };
    }
    return null;
  }
  const model = health.find((warning) => warning.kind === "model_unmatched" && warning.blocking);
  if (model) {
    const matched = (stored.diff as { modelTape?: { matchedCalls?: unknown } }).modelTape?.matchedCalls;
    return { step: typeof matched === "number" ? matched + 1 : null, kind: "model", nodeId: model.nodeId, message: model.message };
  }
  const tool = health.find((warning) => warning.kind === "mcp_unmatched" && warning.blocking);
  if (tool) {
    const steps = ((stored.diff as { diff?: { toolCalls?: { steps?: unknown } } }).diff?.toolCalls?.steps ?? []) as ReplayToolStep[];
    const index = Array.isArray(steps) ? steps.findIndex((step) => step.kind !== "matched" || step.outcomeChanged) : -1;
    const nodeId = index >= 0 ? (steps[index]!.candidate ?? steps[index]!.baseline)?.nodeId ?? null : tool.nodeId;
    return { step: index >= 0 ? index + 1 : null, kind: "tool", nodeId, message: tool.message };
  }
  return null;
}

/**
 * One case of a simulation: the checkpoints compared, and its outcome.
 * `workflowChanged` says the replayed workflow is not the one the recording
 * ran: a tape miss is then only blamed on the guard change when a guard
 * verdict changed before it.
 */
export function simulateCase(input: {
  recording: { id: string; name: string; createdAt: string | null; guard: readonly RunFactGuardVerdict[] } | null;
  recordingId: string;
  stored: StoredReplayCase | null;
  replayed: readonly RunFactGuardVerdict[];
  workflowChanged: boolean;
  /** Text to keep out of stored reasons (secrets). */
  scrub?: (text: string) => string;
}): GuardSimulationCase {
  const scrub = input.scrub ?? ((text: string) => text);
  const base = {
    recordingId: input.recordingId,
    recordingName: input.recording?.name ?? input.recordingId,
    recordedAt: input.recording?.createdAt ?? null,
    executionId: input.stored?.executionId ?? null
  };
  if (!input.recording) {
    return { ...base, outcome: "not_simulated", reason: "The recording was deleted before it could be replayed.", counts: emptyGuardSimulationCounts(), checkpoints: [] };
  }
  if (!input.stored) {
    return { ...base, outcome: "not_simulated", reason: "The replay did not run (the simulation was stopped first).", counts: emptyGuardSimulationCounts(), checkpoints: [] };
  }
  const { counts, checkpoints } = compareGuardCheckpoints(input.recording.guard, input.replayed);
  const divergedAt = divergenceOf(input.stored);
  const guardChanged = counts.newlyBlocked + counts.noLongerBlocked + counts.actionChanged > 0;
  if (divergedAt) {
    if (guardChanged || !input.workflowChanged) {
      return { ...base, outcome: "diverged", divergedAt: { ...divergedAt, message: scrub(divergedAt.message) }, counts, checkpoints };
    }
    return {
      ...base,
      outcome: "not_simulated",
      reason: "The replay needed an answer this recording does not have, and no guard verdict had changed before it: the workflow changed since this run was recorded, so the difference is not the guard's.",
      counts,
      checkpoints
    };
  }
  if (input.stored.executionId === null || (input.stored.status === "error" && !input.stored.executionId)) {
    return { ...base, outcome: "not_simulated", reason: scrub(input.stored.error ?? "The replay could not run."), counts: emptyGuardSimulationCounts(), checkpoints: [] };
  }
  const health = healthOf(input.stored.diff) ?? [];
  const blocking = health.find((warning) => warning.blocking);
  if (blocking && !guardChanged) {
    return { ...base, outcome: "not_simulated", reason: scrub(blocking.message), counts, checkpoints };
  }
  return { ...base, outcome: "compared", counts, checkpoints };
}
