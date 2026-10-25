/**
 * Phase 15.1 — comparing a replay with its golden run.
 *
 * A pure, neutral diff of two `RunFacts`: run status, a path-level diff of
 * the final output (with ignored paths, a number tolerance and whitespace
 * normalisation; changed strings carry a token-overlap similarity), the
 * tool-call tape aligned by server and tool (longest common subsequence)
 * with argument diffs, the nodes that ran, model, token, cost and latency
 * deltas, guard verdict changes, and the replay's health warnings. The
 * verdict is a separate step (`judgeReplayDiff` in shared).
 */

import { normaliseMaskedSpans } from "@ai-orchestrator/guard-sdk";
import type {
  ReplayHealthWarning,
  ReplayNumberDelta,
  ReplayToolStep,
  ReplayValueChange,
  RunDiff,
  RunFactGuardVerdict,
  RunFactToolCall,
  RunFacts
} from "@ai-orchestrator/shared";

/** Fields that differ on every run (timings, ids) and are never compared unless asked. */
export const DEFAULT_REPLAY_IGNORE_PATHS = ["**._telemetry", "**.durationMs", "**.latencyMs", "**.startedAt", "**.completedAt", "**.executionId", "**.execution_id"];

const MAX_VALUE_CHANGES = 200;
const MAX_DEPTH = 64;
/** Above this many cells the tool tape is aligned greedily instead of by LCS. */
const MAX_LCS_CELLS = 4_000_000;

export interface ValueDiffOptions {
  ignorePaths?: string[];
  numberTolerance?: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Whitespace and masked spans normalised: two texts that differ only in what the guard masked (or in the whitespace around it) compare equal. */
function normaliseText(value: string): string {
  return normaliseMaskedSpans(value.replace(/\s+/g, " ").trim());
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2)
  );
}

/** Jaccard similarity of the two texts' word sets, 0..1 (1 for two empty texts). */
export function tokenSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 1 : Math.round((shared / union) * 1000) / 1000;
}

/**
 * A glob compiled to its segments, with consecutive `**` collapsed (they
 * match the same paths as one).
 */
interface CompiledPattern {
  segments: string[];
}

function compilePattern(pattern: string): CompiledPattern {
  const segments: string[] = [];
  for (const segment of pattern
    .trim()
    .replace(/^\$\.?/, "")
    .replace(/\[(\*|\d+)\]/g, ".$1")
    .split(".")) {
    if (segment.length === 0) continue;
    if (segment === "**" && segments[segments.length - 1] === "**") continue;
    segments.push(segment);
  }
  return { segments };
}

/**
 * Matching runs as a set of pattern positions advanced one path segment at
 * a time (a non-deterministic automaton walked breadth-first), so a path of
 * n segments costs O(n · m) for a pattern of m segments, whatever mix of
 * `*` and `**` it has: there is no backtracking to blow up. The state is
 * advanced as the diff walks down the value tree, so each node costs one
 * step per pattern.
 */
type MatchState = Uint8Array;

/** Adds the positions reachable without consuming a segment (a `**` may match nothing). */
function closeState(pattern: CompiledPattern, state: MatchState): MatchState {
  for (let index = 0; index < pattern.segments.length; index += 1) {
    if (state[index] && pattern.segments[index] === "**") state[index + 1] = 1;
  }
  return state;
}

function initialState(pattern: CompiledPattern): MatchState {
  const state = new Uint8Array(pattern.segments.length + 1);
  state[0] = 1;
  return closeState(pattern, state);
}

function advanceState(pattern: CompiledPattern, state: MatchState, segment: string): MatchState {
  const next = new Uint8Array(pattern.segments.length + 1);
  for (let index = 0; index < pattern.segments.length; index += 1) {
    if (!state[index]) continue;
    const expected = pattern.segments[index]!;
    if (expected === "**") next[index] = 1;
    else if (expected === "*" || expected === segment) next[index + 1] = 1;
  }
  return closeState(pattern, next);
}

function stateMatches(pattern: CompiledPattern, state: MatchState): boolean {
  return pattern.segments.length > 0 && state[pattern.segments.length] === 1;
}

/**
 * Whether a path (as segments: keys and array indices) matches a glob:
 * `a.b`, `items[*].id`, `items[3]`, `*` for one segment, `**` for any
 * number of segments, an optional leading `$.`. Linear in the path length
 * times the pattern length.
 */
export function matchesIgnorePath(path: string[], pattern: string): boolean {
  const compiled = compilePattern(pattern);
  if (compiled.segments.length === 0) return false;
  let state = initialState(compiled);
  for (const segment of path) state = advanceState(compiled, state, segment);
  return stateMatches(compiled, state);
}

function displayPath(segments: Array<string | number>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown, tolerance: number): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= tolerance;
  if (typeof a === "string" && typeof b === "string") return a === b || normaliseText(a) === normaliseText(b);
  return a === b;
}

/** An own property only: a key named `__proto__` or `constructor` that one side lacks reads as missing, never as the prototype's member. */
function own(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Deep equality without a depth limit (an explicit stack, so deep values cannot overflow the call stack). */
function deepEqual(a: unknown, b: unknown, tolerance: number): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [left, right] = stack.pop()!;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) stack.push([left[index], right[index]]);
      continue;
    }
    if (isRecord(left) && isRecord(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) stack.push([own(left, key), own(right, key)]);
      continue;
    }
    if (!valuesEqual(left, right, tolerance)) return false;
  }
  return true;
}

/**
 * Path-level differences between two JSON values. `truncated` is true when
 * the list is not the whole story: more than the listed number of changes,
 * or a difference below the depth the walk goes to, which is reported at
 * that depth (marked `truncated`) without the detail below it.
 */
export function diffValues(baseline: unknown, candidate: unknown, options: ValueDiffOptions = {}): { changes: ReplayValueChange[]; ignored: number; truncated: boolean } {
  const ignorePaths = options.ignorePaths ?? [];
  const tolerance = options.numberTolerance ?? 0;
  const changes: ReplayValueChange[] = [];
  let ignored = 0;
  let truncated = false;

  const patterns = ignorePaths.map(compilePattern).filter((pattern) => pattern.segments.length > 0);

  const walk = (a: unknown, b: unknown, path: Array<string | number>, depth: number, states: MatchState[]) => {
    if (changes.length >= MAX_VALUE_CHANGES) {
      if (!truncated && !deepEqual(a, b, tolerance)) truncated = true;
      return;
    }
    if (path.length > 0 && patterns.some((pattern, index) => stateMatches(pattern, states[index]!))) {
      if (!deepEqual(a, b, tolerance)) ignored += 1;
      return;
    }
    const child = (segment: string | number) => patterns.map((pattern, index) => advanceState(pattern, states[index]!, String(segment)));
    if (a === undefined && b === undefined) return;
    if (a === undefined) {
      changes.push({ path: displayPath(path), kind: "added", candidate: b });
      return;
    }
    if (b === undefined) {
      changes.push({ path: displayPath(path), kind: "removed", baseline: a });
      return;
    }
    if (depth < MAX_DEPTH && Array.isArray(a) && Array.isArray(b)) {
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length; index += 1) walk(index < a.length ? a[index] : undefined, index < b.length ? b[index] : undefined, [...path, index], depth + 1, child(index));
      return;
    }
    if (depth < MAX_DEPTH && isRecord(a) && isRecord(b)) {
      const keys = [...Object.keys(a), ...Object.keys(b).filter((key) => !Object.prototype.hasOwnProperty.call(a, key))];
      for (const key of keys) walk(own(a, key), own(b, key), [...path, key], depth + 1, child(key));
      return;
    }
    if (deepEqual(a, b, tolerance)) return;
    const change: ReplayValueChange = { path: displayPath(path), kind: "changed", baseline: a, candidate: b };
    if (depth >= MAX_DEPTH && (Array.isArray(a) || isRecord(a)) && (Array.isArray(b) || isRecord(b))) {
      change.truncated = true;
      truncated = true;
    }
    if (typeof a === "string" && typeof b === "string") change.similarity = tokenSimilarity(a, b);
    changes.push(change);
  };

  walk(baseline, candidate, [], 0, patterns.map(initialState));
  return { changes, ignored, truncated };
}

const toolKey = (call: RunFactToolCall) => `${call.server}\u0000${call.tool}`;

function matchedStep(baseline: RunFactToolCall, candidate: RunFactToolCall): ReplayToolStep {
  const argsChanged = baseline.argsHash !== candidate.argsHash;
  return {
    kind: "matched",
    baseline,
    candidate,
    argsChanged,
    argChanges: argsChanged ? diffValues(baseline.args, candidate.args).changes : [],
    outcomeChanged: baseline.outcome !== candidate.outcome
  };
}

const deletedStep = (baseline: RunFactToolCall): ReplayToolStep => ({ kind: "deleted", baseline, candidate: null, argsChanged: false, argChanges: [], outcomeChanged: false });
const insertedStep = (candidate: RunFactToolCall): ReplayToolStep => ({ kind: "inserted", baseline: null, candidate, argsChanged: false, argChanges: [], outcomeChanged: false });

/**
 * The two tool tapes aligned by (server, tool): matched pairs (with
 * argument and outcome changes), calls only the baseline made (deleted)
 * and calls only the candidate made (inserted), in tape order.
 */
export function alignToolCalls(baseline: RunFactToolCall[], candidate: RunFactToolCall[]): ReplayToolStep[] {
  const n = baseline.length;
  const m = candidate.length;
  const steps: ReplayToolStep[] = [];
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (toolKey(baseline[i]!) === toolKey(candidate[j]!)) steps.push(matchedStep(baseline[i++]!, candidate[j++]!));
      else {
        steps.push(deletedStep(baseline[i++]!));
        steps.push(insertedStep(candidate[j++]!));
      }
    }
    while (i < n) steps.push(deletedStep(baseline[i++]!));
    while (j < m) steps.push(insertedStep(candidate[j++]!));
    return steps;
  }
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  const baselineKeys = baseline.map(toolKey);
  const candidateKeys = candidate.map(toolKey);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        baselineKeys[i] === candidateKeys[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baselineKeys[i] === candidateKeys[j] && table[i * width + j] === table[(i + 1) * width + j + 1]! + 1) {
      steps.push(matchedStep(baseline[i]!, candidate[j]!));
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      steps.push(deletedStep(baseline[i]!));
      i += 1;
    } else {
      steps.push(insertedStep(candidate[j]!));
      j += 1;
    }
  }
  while (i < n) steps.push(deletedStep(baseline[i++]!));
  while (j < m) steps.push(insertedStep(candidate[j++]!));
  return steps;
}

export function numberDelta(baseline: number | null, candidate: number | null): ReplayNumberDelta {
  if (baseline === null || candidate === null) return { baseline, candidate, delta: null, pct: null };
  const delta = Math.round((candidate - baseline) * 1_000_000) / 1_000_000;
  const pct = baseline === 0 ? (delta === 0 ? 0 : null) : Math.round((delta / baseline) * 10_000) / 100;
  return { baseline, candidate, delta, pct };
}

const STATUS_RANK: Record<string, number> = { success: 3, partial: 2 };
const statusRank = (status: string) => STATUS_RANK[status] ?? 1;

/** Nodes that actually ran (anything but skipped or not run). */
function ranNodes(facts: RunFacts): Map<string, string> {
  return new Map(facts.nodes.filter((node) => node.status !== "skipped" && node.status !== "not_run").map((node) => [node.nodeId, node.status]));
}

function firstModels(facts: RunFacts): Map<string, string> {
  const out = new Map<string, string>();
  for (const call of facts.modelCalls) if (!out.has(call.nodeId)) out.set(call.nodeId, `${call.providerId}:${call.model}`);
  return out;
}

const guardKey = (verdict: RunFactGuardVerdict) => [verdict.nodeId ?? "", verdict.placement, verdict.channel, verdict.detectorId ?? ""].join("\u0000");

function diffGuard(baseline: RunFactGuardVerdict[], candidate: RunFactGuardVerdict[]): RunDiff["guard"] {
  const group = (verdicts: RunFactGuardVerdict[]) => {
    const map = new Map<string, RunFactGuardVerdict[]>();
    for (const verdict of verdicts) map.set(guardKey(verdict), [...(map.get(guardKey(verdict)) ?? []), verdict]);
    return map;
  };
  const left = group(baseline);
  const right = group(candidate);
  const result: RunDiff["guard"] = { added: [], removed: [], changed: [] };
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key) ?? [];
    const b = right.get(key) ?? [];
    const pairs = Math.min(a.length, b.length);
    for (let index = 0; index < pairs; index += 1) {
      if (a[index]!.effectiveAction !== b[index]!.effectiveAction || a[index]!.shadow !== b[index]!.shadow) result.changed.push({ baseline: a[index]!, candidate: b[index]! });
    }
    result.removed.push(...a.slice(pairs));
    result.added.push(...b.slice(pairs));
  }
  return result;
}

export interface RunDiffOptions extends ValueDiffOptions {
  /** Replay health warnings to carry on the diff. */
  health?: ReplayHealthWarning[];
}

/** The diff of a candidate run against its baseline (see the module comment). */
export function diffRunFacts(baseline: RunFacts, candidate: RunFacts, options: RunDiffOptions = {}): RunDiff {
  const ignorePaths = [...DEFAULT_REPLAY_IGNORE_PATHS, ...(options.ignorePaths ?? []).filter((path) => !DEFAULT_REPLAY_IGNORE_PATHS.includes(path))];
  const output = diffValues(baseline.output, candidate.output, { ignorePaths, numberTolerance: options.numberTolerance });

  const steps = alignToolCalls(baseline.toolCalls, candidate.toolCalls);
  const counts = new Map<string, { server: string; tool: string; baseline: number; candidate: number }>();
  for (const [side, calls] of [["baseline", baseline.toolCalls], ["candidate", candidate.toolCalls]] as const) {
    for (const call of calls) {
      const key = toolKey(call);
      const entry = counts.get(key) ?? { server: call.server, tool: call.tool, baseline: 0, candidate: 0 };
      entry[side] += 1;
      counts.set(key, entry);
    }
  }
  const countDelta = [...counts.values()]
    .filter((entry) => entry.baseline !== entry.candidate)
    .sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));

  const ranBefore = ranNodes(baseline);
  const ranAfter = ranNodes(candidate);
  const statusChanges: RunDiff["path"]["statusChanges"] = [];
  for (const [nodeId, status] of ranBefore) {
    const after = ranAfter.get(nodeId);
    if (after !== undefined && after !== status) statusChanges.push({ nodeId, baseline: status, candidate: after });
  }

  const modelsBefore = firstModels(baseline);
  const modelsAfter = firstModels(candidate);
  const modelChanges: RunDiff["models"]["changes"] = [];
  for (const nodeId of new Set([...modelsBefore.keys(), ...modelsAfter.keys()])) {
    const before = modelsBefore.get(nodeId) ?? null;
    const after = modelsAfter.get(nodeId) ?? null;
    if (before !== after) modelChanges.push({ nodeId, baseline: before, candidate: after });
  }

  return {
    status: {
      baseline: baseline.status,
      candidate: candidate.status,
      changed: baseline.status !== candidate.status,
      regression: statusRank(candidate.status) < statusRank(baseline.status)
    },
    output: { equal: output.changes.length === 0, changes: output.changes, ignored: output.ignored, ignorePaths, truncated: output.truncated },
    toolCalls: {
      baselineCount: baseline.toolCalls.length,
      candidateCount: candidate.toolCalls.length,
      changed: steps.some((step) => step.kind !== "matched" || step.argsChanged || step.outcomeChanged),
      steps,
      countDelta
    },
    path: {
      added: [...ranAfter.keys()].filter((nodeId) => !ranBefore.has(nodeId)),
      removed: [...ranBefore.keys()].filter((nodeId) => !ranAfter.has(nodeId)),
      statusChanges
    },
    models: { changes: modelChanges, callDelta: numberDelta(baseline.totals.modelCalls, candidate.totals.modelCalls) },
    totals: {
      tokens: numberDelta(baseline.totals.totalTokens, candidate.totals.totalTokens),
      costUsd: numberDelta(baseline.totals.costUsd, candidate.totals.costUsd),
      latencyMs: numberDelta(baseline.totals.durationMs, candidate.totals.durationMs),
      toolCalls: numberDelta(baseline.totals.toolCalls, candidate.totals.toolCalls)
    },
    guard: diffGuard(baseline.guard, candidate.guard),
    health: [
      ...(options.health ?? []),
      ...(output.truncated
        ? [
            {
              kind: "diff_truncated" as const,
              nodeId: null,
              message: `The output differs in more places than are listed (over ${MAX_VALUE_CHANGES} changes, or below ${MAX_DEPTH} levels of nesting, shown without detail).`,
              blocking: false
            }
          ]
        : [])
    ]
  };
}
