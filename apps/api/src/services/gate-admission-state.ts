/**
 * Release gate admission (migration 36): which cases an enforced gate counts.
 *
 * An enforced gate stores the ids of its admitted cases. Every other case of
 * its golden sets, however it was added (a golden run added in the UI or the
 * API, a golden-set file import, a promoted capture), is pending admission:
 * it runs and is reported, but counts toward nothing until an admin admits
 * it or a gate approver approves an `admit_cases` request. Required cases
 * (golden-run cases an admin marked) must pass whatever the pass rate.
 *
 * Unenforced gates judge with no admission state: every case counts and
 * required marks are ignored, exactly as before admission existed. The list
 * a gate stored while enforced is kept when enforcement is lifted, so cases
 * that were waiting for admission still wait when the gate is enforced again.
 */

import type { ReleaseGateAdmission, ReleaseGateAdmissionState } from "@ai-orchestrator/shared";
import type { EvalFixtureRecord, ReleaseGateRecord, SqliteStore } from "../db/database.js";

export interface GateAdmissionSnapshot {
  workflowId: string;
  /** Every case of the gate's golden sets, in set order. */
  fixtures: EvalFixtureRecord[];
  admittedIds: Set<string>;
  /** Required golden-run cases of the gate's sets; only admitted cases can be required. */
  requiredIds: string[];
  names: Record<string, string>;
  /**
   * True when the gate is enforced but has no stored admission (a save
   * interrupted half-way, or a store edited by hand): it counts nothing
   * until an admin admits its cases.
   */
  admissionMissing: boolean;
}

/** The admission state of an enforced gate; null for a gate that is missing or not enforced. */
export function gateAdmissionSnapshot(store: Pick<SqliteStore, "listEvalFixtures">, gate: ReleaseGateRecord | null): GateAdmissionSnapshot | null {
  if (!gate?.enforced) return null;
  const fixtures: EvalFixtureRecord[] = [];
  const seen = new Set<string>();
  for (const datasetId of gate.datasetIds) {
    for (const fixture of store.listEvalFixtures(datasetId)) {
      if (seen.has(fixture.id)) continue;
      seen.add(fixture.id);
      fixtures.push(fixture);
    }
  }
  // Fails closed: an enforced gate without a stored admission counts nothing until an admin admits its cases.
  const stored = gate.admittedFixtureIds;
  const admissionMissing = stored === null || stored === undefined;
  const admittedIds = new Set(admissionMissing ? [] : stored.filter((id) => seen.has(id)));
  const names: Record<string, string> = {};
  for (const fixture of fixtures) names[fixture.id] = fixture.name;
  return {
    workflowId: gate.workflowId,
    fixtures,
    admittedIds,
    requiredIds: fixtures.filter((fixture) => fixture.required && fixture.recordingId && admittedIds.has(fixture.id)).map((fixture) => fixture.id),
    names,
    admissionMissing
  };
}

/** What `judgeReleaseGate` takes for an enforced gate. */
export function judgeAdmission(snapshot: GateAdmissionSnapshot | null): ReleaseGateAdmission | null {
  if (!snapshot) return null;
  return { admittedIds: [...snapshot.admittedIds], requiredIds: snapshot.requiredIds, caseNames: snapshot.names };
}

/** What the loosening check compares. */
export function admissionState(snapshot: GateAdmissionSnapshot): ReleaseGateAdmissionState {
  return { admittedIds: [...snapshot.admittedIds], requiredIds: snapshot.requiredIds };
}

/**
 * The admitted cases to store when a gate is saved. Nothing is ever admitted
 * silently except on a gate's first enforcement:
 *   - not enforced: the stored list is kept as it is (null when the gate was
 *     never enforced), so enforcing again restores it;
 *   - enforced for the first time (an admin; nothing stored yet): every case
 *     its sets hold now;
 *   - enforced again, or already enforced: the cases admitted before that
 *     its sets still hold. Cases added meanwhile, and cases of golden sets
 *     the save adds, wait for admission, unless an admin passes
 *     `admitAddedSetCases`: then the cases of the added sets are admitted.
 */
export function nextAdmittedIds(
  store: Pick<SqliteStore, "listEvalFixtures">,
  before: ReleaseGateRecord | null,
  after: { enforced: boolean; datasetIds: string[] },
  options: { byAdmin: boolean; admitAddedSetCases: boolean }
): string[] | null {
  const stored = before?.admittedFixtureIds ?? null;
  if (!after.enforced) return stored;
  const idsOf = (datasetIds: readonly string[]) => datasetIds.flatMap((datasetId) => store.listEvalFixtures(datasetId).map((fixture) => fixture.id));
  const current = new Set(idsOf(after.datasetIds));
  if (!before?.enforced && stored === null) return [...current];
  const admitted = new Set((stored ?? []).filter((id) => current.has(id)));
  if (options.byAdmin && options.admitAddedSetCases) {
    const added = after.datasetIds.filter((datasetId) => !(before?.datasetIds ?? []).includes(datasetId));
    for (const id of idsOf(added)) admitted.add(id);
  }
  return [...admitted];
}
