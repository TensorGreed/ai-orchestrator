import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { scrubbedExcerpt } from "./dlp";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";

export const PATH_GUARD_DETECTOR_ID = "tool.path";

/**
 * Phase 12.3 — path guard. A path argument is resolved against the allowed
 * roots lexically (traversal) and then through `realpath` (symlink escapes).
 * `realpath` is injectable so tests and the wiring layer control filesystem
 * access; the default walks up to the nearest existing ancestor so paths
 * that do not exist yet can still be judged.
 */

export type RealpathFn = (path: string) => Promise<string>;

export interface PathGuardOptions {
  /** Absolute directories the tool may touch. */
  roots: string[];
  realpath?: RealpathFn;
  /** Base for relative paths; defaults to the first root. */
  cwd?: string;
  /** Use POSIX semantics regardless of platform (default true; the runtime is containerised). */
  posix?: boolean;
}

export interface PathCheck {
  ok: boolean;
  input: string;
  resolved: string;
  real?: string;
  root?: string;
  reason?: "no_roots" | "traversal" | "symlink_escape" | "null_byte" | "encoded_traversal" | "realpath_failed";
  message?: string;
}

export const defaultRealpath: RealpathFn = async (target) => {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length ? nodePath.posix.join(real, ...rest.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = nodePath.posix.dirname(current);
      if (parent === current) throw error;
      rest.push(nodePath.posix.basename(current));
      current = parent;
    }
  }
};

function within(candidate: string, root: string, path: nodePath.PlatformPath): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function checkPath(input: string, options: PathGuardOptions): Promise<PathCheck> {
  const path = options.posix === false ? nodePath : nodePath.posix;
  const roots = options.roots.map((root) => path.resolve(root));
  if (roots.length === 0) {
    return { ok: false, input, resolved: input, reason: "no_roots", message: "No allowed roots configured" };
  }
  if (input.includes("\0")) {
    return { ok: false, input, resolved: input, reason: "null_byte", message: "Path contains a null byte" };
  }
  if (/%2e%2e|%252e|%2f|%5c|\.\.%|%c0%ae|%c1%9c/i.test(input)) {
    return { ok: false, input, resolved: input, reason: "encoded_traversal", message: "Path contains URL-encoded traversal sequences" };
  }
  const normalisedInput = input.replace(/\\/g, "/");
  const base = options.cwd ? path.resolve(options.cwd) : roots[0]!;
  const resolved = path.resolve(base, normalisedInput);
  const root = roots.find((r) => within(resolved, r, path));
  if (!root) {
    return { ok: false, input, resolved, reason: "traversal", message: "Path resolves outside the allowed roots" };
  }
  const realpath = options.realpath ?? defaultRealpath;
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(resolved), realpath(root)]);
  } catch (error) {
    return { ok: false, input, resolved, root, reason: "realpath_failed", message: `Could not resolve the real path: ${(error as Error).message}` };
  }
  if (!within(real, realRoot, path) && !roots.some((r) => within(real, r, path))) {
    return { ok: false, input, resolved, real, root, reason: "symlink_escape", message: "Path follows a symbolic link outside the allowed roots" };
  }
  return { ok: true, input, resolved, real, root };
}

const PATH_LIKE = /^(?:\.{0,2}\/|\/|[A-Za-z]:[\\/]|~\/|\\\\)|(?:^|[\\/])\.\.(?:[\\/]|$)/;

export function createPathGuardDetector(defaults: { realpath?: RealpathFn } = {}): GuardDetector {
  return {
    id: PATH_GUARD_DETECTOR_ID,
    tier: "rule",
    description: "Resolves path arguments against allowed roots; blocks traversal and symlink escapes.",
    channels: ["tool_arguments"],
    categories: ["path_traversal"],
    async detect(input: GuardInput, context: DetectorContext) {
      const roots = Array.isArray(context.options.roots) ? (context.options.roots as string[]) : [];
      const keys = new Set(Array.isArray(context.options.pathKeys) ? (context.options.pathKeys as string[]) : ["path", "file", "filename", "filepath", "file_path", "dir", "directory", "src", "dest", "destination", "target", "source", "output", "input"]);
      const candidates: Array<{ value: string; path: string }> = [];
      if (typeof input.content === "string") {
        if (PATH_LIKE.test(input.content)) candidates.push({ value: input.content, path: "" });
      } else {
        const visit = (value: unknown, path: string, key: string) => {
          if (typeof value === "string") {
            if (keys.has(key) || PATH_LIKE.test(value)) candidates.push({ value, path });
            return;
          }
          if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
          else if (value && typeof value === "object") {
            for (const [k, inner] of Object.entries(value as Record<string, unknown>)) visit(inner, path ? `${path}.${k}` : k, k);
          }
        };
        visit(input.content, "", "");
      }
      const findings: GuardFinding[] = [];
      for (const candidate of candidates) {
        const check = await checkPath(candidate.value, { roots, realpath: defaults.realpath, cwd: typeof context.options.cwd === "string" ? context.options.cwd : undefined });
        if (check.ok) continue;
        const span = locateValue(context.text, candidate.value);
        findings.push({
          detectorId: PATH_GUARD_DETECTOR_ID,
          category: "path_traversal",
          score: check.reason === "realpath_failed" ? 0.6 : 1,
          spans: [span],
          evidence: scrubbedExcerpt(context.text, span),
          message: check.message ?? "Path not allowed",
          metadata: { reason: check.reason, path: candidate.path }
        });
      }
      return findings;
    }
  };
}

export function locateValue(text: string, value: string): GuardSpan {
  const direct = text.indexOf(value);
  if (direct >= 0) return { start: direct, end: direct + value.length };
  const encoded = JSON.stringify(value).slice(1, -1);
  const at = text.indexOf(encoded);
  if (at >= 0) return { start: at, end: at + encoded.length };
  return { start: 0, end: text.length };
}
