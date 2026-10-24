/**
 * Phase 15.4 — what a replay job ran against, per golden set.
 *
 * A replay job is proof for the release gate only while its golden sets are
 * as they were when it was queued: removing a hard case, attaching an
 * always-pass scorer to a case, or adding a case all change what the gate
 * would be judging. The snapshot of one set is a hash over its cases in id
 * order: each case's id, the golden run it replays and its own scorer specs.
 * The job stores it when it is queued (server side, in the replay job path);
 * the gate compares it with the sets as they are when someone publishes.
 *
 * Beside the hash the job keeps one fingerprint per case (the golden run it
 * replays and its own scorers). An enforced gate counts only its admitted
 * cases, so it judges staleness over those alone: a pending case added or
 * deleted later changes nothing the gate counts.
 */

import { createHash } from "node:crypto";
import { releaseCanonicalJson } from "@ai-orchestrator/shared";
import type { GoldenSetSnapshot } from "../db/database.js";

export type { GoldenSetSnapshot };

export interface SnapshotFixture {
  id: string;
  recordingId: string | null;
  scorers: unknown[] | null;
}


const caseScorers = (fixture: SnapshotFixture) => (fixture.scorers && fixture.scorers.length > 0 ? fixture.scorers : []);

/** One case's fingerprint: the golden run it replays and its own scorers. */
export function goldenCaseFingerprint(fixture: SnapshotFixture): string {
  return createHash("sha256").update(releaseCanonicalJson({ recordingId: fixture.recordingId ?? null, scorers: caseScorers(fixture) })).digest("hex");
}

/** The snapshot hash of one golden set's cases. */
export function goldenSetSnapshot(fixtures: readonly SnapshotFixture[]): string {
  const cases = [...fixtures]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((fixture) => ({ id: fixture.id, recordingId: fixture.recordingId ?? null, scorers: caseScorers(fixture) }));
  return createHash("sha256").update(releaseCanonicalJson(cases)).digest("hex");
}

/** Snapshots of several sets, keyed by set id: each set's hash and its cases' fingerprints. */
export function goldenSetSnapshots(datasetIds: readonly string[], listFixtures: (datasetId: string) => readonly SnapshotFixture[]): Record<string, GoldenSetSnapshot> {
  const out: Record<string, GoldenSetSnapshot> = {};
  for (const datasetId of datasetIds) {
    const fixtures = listFixtures(datasetId);
    out[datasetId] = { hash: goldenSetSnapshot(fixtures), cases: Object.fromEntries(fixtures.map((fixture) => [fixture.id, goldenCaseFingerprint(fixture)])) };
  }
  return out;
}

/**
 * The sets of `datasetIds` a job's snapshot no longer matches. Without
 * `admittedIds` (an unenforced gate, one whose admission is not stored, or a
 * job from before admission) a set is stale when its hash changed. With
 * them a set is stale only when one of its admitted cases is missing from the
 * job or its fingerprint changed: pending cases added or deleted later do not
 * count, and admitting a case the job never ran does.
 */
export function staleGoldenSets(
  datasetIds: readonly string[],
  job: Record<string, GoldenSetSnapshot>,
  current: Record<string, GoldenSetSnapshot>,
  admittedIds: ReadonlySet<string> | null
): string[] {
  return datasetIds.filter((datasetId) => {
    const ran = job[datasetId];
    const now = current[datasetId];
    if (!ran || !now) return true;
    if (!admittedIds || !ran.cases || !now.cases) return ran.hash !== now.hash;
    for (const [fixtureId, fingerprint] of Object.entries(now.cases)) {
      if (!admittedIds.has(fixtureId)) continue;
      if (ran.cases[fixtureId] !== fingerprint) return true;
    }
    return false;
  });
}
