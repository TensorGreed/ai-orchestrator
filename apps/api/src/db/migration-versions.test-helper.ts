/**
 * Test helper: the migration versions expected from 1 up to the highest one,
 * each exactly once. Version 31 is reserved for a feature branch that lands
 * separately, so it may be missing; once it exists it must be in place too.
 * Version 34 (Phase 15.6 production capture) is reserved the same way while
 * 35 (guard policy simulation) can land before it.
 */
const RESERVED_UNTIL_MERGED = new Set([31, 34]);

export function contiguousMigrationVersions(versions: readonly number[]): number[] {
  const max = Math.max(0, ...versions);
  return Array.from({ length: max }, (_, index) => index + 1).filter((version) => !RESERVED_UNTIL_MERGED.has(version) || versions.includes(version));
}
