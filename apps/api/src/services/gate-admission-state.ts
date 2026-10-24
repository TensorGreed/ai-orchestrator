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
 * Unenforced gates have no admission state: every case counts and required
 * marks are ignored, exactly as before admission existed.
 */

import type { ReleaseGateAdmission, ReleaseGateAdmissionState } from "@ai-orchestrator/shared";
import type { EvalFixtureRecord, ReleaseGateRecord, SqliteStore } from "../db/database.js";

export interface GateAdmissionSnapshot {
  workflowId: string;
  /** Every case of the gate's golden sets, in set order. */
  fixtures: EvalFixtureRecord[];
  admittedIds: Set<string>;
  /** Required golden-run cases of the gate's sets. */
  requiredIds: string[];
  names: Record<string, string>;
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
  // A gate enforced without a stored admission (set straight in the store) counts every case, as before admission existed.
  const stored = gate.admittedFixtureIds;
  const admittedIds = new Set(stored === null || stored === undefined ? fixtures.map((fixture) => fixture.id) : stored.filter((id) => seen.has(id)));
  const names: Record<string, string> = {};
  for (const fixture of fixtures) names[fixture.id] = fixture.name;
  return {
    workflowId: gate.workflowId,
    fixtures,
    admittedIds,
    requiredIds: fixtures.filter((fixture) => fixture.required && fixture.recordingId).map((fixture) => fixture.id),
    names
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
 * The admitted cases to store when a gate is saved:
 *   - not enforced: none (null);
 *   - enforced now (an admin): every case of its sets;
 *   - already enforced, saved by an admin: the cases admitted before, plus
 *     every case of a golden set the admin adds to the gate;
 *   - already enforced, saved by a builder: the cases admitted before (cases
 *     of a set a builder adds are pending until admitted).
 * Ids of cases no longer in the gate's sets are dropped.
 */
export function nextAdmittedIds(
  store: Pick<SqliteStore, "listEvalFixtures">,
  before: ReleaseGateRecord | null,
  after: { enforced: boolean; datasetIds: string[] },
  byAdmin: boolean
): string[] | null {
  if (!after.enforced) return null;
  const idsOf = (datasetIds: readonly string[]) => datasetIds.flatMap((datasetId) => store.listEvalFixtures(datasetId).map((fixture) => fixture.id));
  const current = new Set(idsOf(after.datasetIds));
  if (!before?.enforced) return [...current];
  const previous = gateAdmissionSnapshot(store, before)?.admittedIds ?? new Set<string>();
  const admitted = new Set([...previous].filter((id) => current.has(id)));
  if (byAdmin) {
    const added = after.datasetIds.filter((datasetId) => !before.datasetIds.includes(datasetId));
    for (const id of idsOf(added)) admitted.add(id);
  }
  return [...admitted];
}
