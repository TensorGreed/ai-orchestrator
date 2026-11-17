import { z } from "zod";

/**
 * A rule set's allow-list: values the data detectors never flag (a support address, test card numbers). Applied to
 * every finding that has a data class, whatever detector made it (the data scan, dictionaries and custom patterns).
 *
 * - `values`: exact values, compared without case and also with spaces and dashes removed, so a test card written
 *   `4111 1111 1111 1111` or `4111111111111111` matches either way.
 * - `patterns`: simple globs, `*` for any run of characters and `?` for one (`*@example.com`). Not regular
 *   expressions: a glob is split at `*` into literal segments, each found once from left to right, so a pattern never
 *   backtracks. Findings longer than MAX_ALLOW_LIST_MATCH_LENGTH are never allow-listed (no listed value is that long),
 *   and a matcher remembers its answers for repeated values.
 */

export const MAX_ALLOW_LIST_ENTRIES = 500;
export const MAX_ALLOW_LIST_PATTERNS = 100;
export const MAX_ALLOW_LIST_ENTRY_LENGTH = 256;
/** Longest finding an allow-list is checked against. */
export const MAX_ALLOW_LIST_MATCH_LENGTH = 512;

const entry = z.string().trim().min(1).max(MAX_ALLOW_LIST_ENTRY_LENGTH);

export const allowListSchema = z.object({
  values: z.array(entry).max(MAX_ALLOW_LIST_ENTRIES).default([]),
  patterns: z.array(entry).max(MAX_ALLOW_LIST_PATTERNS).default([])
});

export type AllowList = z.output<typeof allowListSchema>;
export type AllowListInput = z.input<typeof allowListSchema>;

function squash(value: string): string {
  return value.replace(/[\s-]+/g, "");
}

/** A glob as its literal segments between `*` (`?` matches one character inside a segment). */
interface CompiledGlob {
  segments: string[];
  anchoredStart: boolean;
  anchoredEnd: boolean;
}

function compileGlob(pattern: string): CompiledGlob {
  const segments = pattern.split("*");
  return { segments: segments.filter((segment, index) => segment.length > 0 || index === 0 || index === segments.length - 1), anchoredStart: !pattern.startsWith("*"), anchoredEnd: !pattern.endsWith("*") };
}

function segmentAt(segment: string, value: string, at: number): boolean {
  if (at + segment.length > value.length) return false;
  for (let i = 0; i < segment.length; i += 1) if (segment[i] !== "?" && segment[i] !== value[at + i]) return false;
  return true;
}

/** The first position at or after `from` where the segment matches, or -1. */
function findSegment(segment: string, value: string, from: number): number {
  if (!segment.includes("?")) return value.indexOf(segment, from);
  for (let at = from; at + segment.length <= value.length; at += 1) if (segmentAt(segment, value, at)) return at;
  return -1;
}

/** Leftmost placement of each segment is enough for `*` globs: no backtracking. */
function globMatches(glob: CompiledGlob, value: string): boolean {
  const { segments } = glob;
  if (segments.length === 1) return glob.anchoredStart && glob.anchoredEnd ? segments[0]!.length === value.length && segmentAt(segments[0]!, value, 0) : true;
  let at = 0;
  let first = 0;
  let last = segments.length;
  if (glob.anchoredStart) {
    if (!segmentAt(segments[0]!, value, 0)) return false;
    at = segments[0]!.length;
    first = 1;
  }
  let end = value.length;
  if (glob.anchoredEnd) {
    const tail = segments[segments.length - 1]!;
    if (tail.length > value.length - at || !segmentAt(tail, value, value.length - tail.length)) return false;
    end = value.length - tail.length;
    last = segments.length - 1;
  }
  for (let i = first; i < last; i += 1) {
    const segment = segments[i]!;
    if (segment.length === 0) continue;
    const found = findSegment(segment, value, at);
    if (found < 0 || found + segment.length > end) return false;
    at = found + segment.length;
  }
  return true;
}

export interface AllowListMatcher {
  readonly empty: boolean;
  /** True when the value is allow-listed. */
  allows(value: string): boolean;
}

const NONE: AllowListMatcher = { empty: true, allows: () => false };

/** A matcher over one or more allow-lists (a rule set's and a caller's own, merged). */
export function compileAllowList(...lists: Array<Partial<AllowListInput> | null | undefined>): AllowListMatcher {
  const exact = new Set<string>();
  const globs: Array<{ raw: CompiledGlob; squashed: CompiledGlob }> = [];
  for (const list of lists) {
    for (const value of list?.values ?? []) {
      const lower = value.trim().toLowerCase();
      if (!lower) continue;
      exact.add(lower);
      exact.add(squash(lower));
    }
    for (const pattern of list?.patterns ?? []) {
      const lower = pattern.trim().toLowerCase();
      if (lower) globs.push({ raw: compileGlob(lower), squashed: compileGlob(squash(lower)) });
    }
  }
  if (exact.size === 0 && globs.length === 0) return NONE;
  const seen = new Map<string, boolean>();
  return {
    empty: false,
    allows(value: string): boolean {
      if (value.length > MAX_ALLOW_LIST_MATCH_LENGTH) return false;
      const cached = seen.get(value);
      if (cached !== undefined) return cached;
      const lower = value.trim().toLowerCase();
      const squashed = squash(lower);
      const allowed = exact.has(lower) || exact.has(squashed) || globs.some((glob) => globMatches(glob.raw, lower) || globMatches(glob.squashed, squashed));
      if (seen.size >= 1_000) seen.clear();
      seen.set(value, allowed);
      return allowed;
    }
  };
}
