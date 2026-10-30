/**
 * Test helper: the migration versions expected from 1 up to the highest one,
 * each exactly once. A version reserved for a feature branch that lands
 * separately may be listed here so it can be missing; once it exists it
 * must be in place too.
 *
 * Merge rule (13.1 lanes): migration numbers are settled at merge time. The second lane to merge renumbers its
 * migration to main's highest version + 1 (a one-line change of its `version`) and empties this set; a branch never
 * merges with a version at or below main's highest. Postgres refuses to start on a database that recorded a version
 * above one it never applied (MigrationGapError), so a mistake is loud rather than a silently skipped migration.
 * Nothing is reserved now: v47 (argument-aware rules) and v48 (argument summaries) both exist.
 */
const RESERVED_UNTIL_MERGED = new Set<number>([]);

export function contiguousMigrationVersions(versions: readonly number[]): number[] {
  const max = Math.max(0, ...versions);
  return Array.from({ length: max }, (_, index) => index + 1).filter((version) => !RESERVED_UNTIL_MERGED.has(version) || versions.includes(version));
}
