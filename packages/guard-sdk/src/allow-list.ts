import { z } from "zod";

/**
 * A rule set's allow-list: values the data detectors never flag (a support address, test card numbers). Applied to
 * every finding that has a data class, whatever detector made it (the data scan, dictionaries and custom patterns).
 *
 * - `values`: exact values, compared without case and also with spaces and dashes removed, so a test card written
 *   `4111 1111 1111 1111` or `4111111111111111` matches either way.
 * - `patterns`: simple globs, `*` for any run of characters and `?` for one (`*@example.com`). Not regular
 *   expressions: a glob is matched in linear time, so a pattern can never backtrack.
 */

export const MAX_ALLOW_LIST_ENTRIES = 500;
export const MAX_ALLOW_LIST_ENTRY_LENGTH = 256;

const entry = z.string().trim().min(1).max(MAX_ALLOW_LIST_ENTRY_LENGTH);

export const allowListSchema = z.object({
  values: z.array(entry).max(MAX_ALLOW_LIST_ENTRIES).default([]),
  patterns: z.array(entry).max(MAX_ALLOW_LIST_ENTRIES).default([])
});

export type AllowList = z.output<typeof allowListSchema>;
export type AllowListInput = z.input<typeof allowListSchema>;

function squash(value: string): string {
  return value.replace(/[\s-]+/g, "");
}

/** `*` any run, `?` one character; everything else literal. Greedy two-pointer match with one backtrack point: linear. */
function globMatches(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = v;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
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
  const globs: string[] = [];
  for (const list of lists) {
    for (const value of list?.values ?? []) {
      const lower = value.trim().toLowerCase();
      if (!lower) continue;
      exact.add(lower);
      exact.add(squash(lower));
    }
    for (const pattern of list?.patterns ?? []) {
      const lower = pattern.trim().toLowerCase();
      if (lower) globs.push(lower);
    }
  }
  if (exact.size === 0 && globs.length === 0) return NONE;
  return {
    empty: false,
    allows(value: string): boolean {
      const lower = value.trim().toLowerCase();
      if (exact.has(lower) || exact.has(squash(lower))) return true;
      return globs.some((glob) => globMatches(glob, lower) || globMatches(squash(glob), squash(lower)));
    }
  };
}
