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
 */

import { createHash } from "node:crypto";
import { releaseCanonicalJson } from "@ai-orchestrator/shared";

export interface SnapshotFixture {
  id: string;
  recordingId: string | null;
  scorers: unknown[] | null;
}

/** The snapshot hash of one golden set's cases. */
export function goldenSetSnapshot(fixtures: readonly SnapshotFixture[]): string {
  const cases = [...fixtures]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((fixture) => ({ id: fixture.id, recordingId: fixture.recordingId ?? null, scorers: fixture.scorers && fixture.scorers.length > 0 ? fixture.scorers : [] }));
  return createHash("sha256").update(releaseCanonicalJson(cases)).digest("hex");
}

/** Snapshots of several sets, keyed by set id. */
export function goldenSetSnapshots(datasetIds: readonly string[], listFixtures: (datasetId: string) => readonly SnapshotFixture[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const datasetId of datasetIds) out[datasetId] = goldenSetSnapshot(listFixtures(datasetId));
  return out;
}
