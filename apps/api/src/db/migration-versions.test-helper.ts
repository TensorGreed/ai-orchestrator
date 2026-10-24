/**
 * Test helper: the migration versions expected from 1 up to the highest one,
 * each exactly once. Versions reserved for feature branches that land
 * separately (31; 34 and 35, which merge before 36) may be missing; once one
 * exists it must be in place too.
 */
const RESERVED_UNTIL_MERGED = new Set([31, 34, 35]);

export function contiguousMigrationVersions(versions: readonly number[]): number[] {
  const max = Math.max(0, ...versions);
  return Array.from({ length: max }, (_, index) => index + 1).filter((version) => !RESERVED_UNTIL_MERGED.has(version) || versions.includes(version));
}
