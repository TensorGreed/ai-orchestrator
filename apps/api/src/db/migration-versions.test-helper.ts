/**
 * Test helper: the migration versions expected from 1 up to the highest one,
 * each exactly once. A version reserved for a feature branch that lands
 * separately may be listed here so it can be missing; once it exists it
 * must be in place too. None is reserved now.
 */
const RESERVED_UNTIL_MERGED = new Set<number>([]);

export function contiguousMigrationVersions(versions: readonly number[]): number[] {
  const max = Math.max(0, ...versions);
  return Array.from({ length: max }, (_, index) => index + 1).filter((version) => !RESERVED_UNTIL_MERGED.has(version) || versions.includes(version));
}
