import { DEFAULT_NATIONAL_IDS, scanDlp, type DlpMatch, type NationalIdSpec } from "./detectors/dlp";
import type { GuardDictionary } from "./profile";
import { surrogateDetectable, surrogateFor, surrogateRedacts } from "./protection/surrogate";
import type { GuardDataClass } from "./types";

/**
 * Phase 15.6 — masking a recorded run (a production capture) before it is
 * stored: detect, then substitute, globally.
 *
 *   1. Every string in every part (values and object keys, at any depth) is
 *      scanned with the DLP patterns: the built-in classes plus the bound
 *      guard profile's dictionaries. A profile's `disable` list is not
 *      applied: capture masking always looks for every built-in class.
 *   2. The distinct values found are collected, one data class each.
 *   3. Every occurrence of every value is replaced, in every part, whether
 *      or not the scan would have found it at that spot (like the secret
 *      scrubber), with its keyed surrogate (`surrogateFor`). JSON-escaped
 *      forms of a value (inside a JSON document carried as a string) are
 *      replaced too. Replacement is a single pass, so a surrogate is never
 *      itself replaced.
 *
 * The caller decides what a part is: only content (inputs, outputs, request
 * and response bodies), never identifiers or match keys, which it keeps
 * apart and re-hashes over the masked content afterwards.
 *
 * The report counts values and occurrences per class, per part and per
 * node. It never carries a value.
 */

export interface MaskPart {
  /** Caller's name for the part, used in the report (`input`, `node:llm`, `tape:3`). */
  id: string;
  /** The node the content belongs to, for per-node counts; null when none. */
  nodeId?: string | null;
  value: unknown;
}

export interface MaskRecordingOptions {
  /** The bound guard profile's dictionaries (custom classes); the built-in classes are always on. */
  dictionaries?: GuardDictionary[];
  /** Surrogate key, at least 16 bytes. */
  key: Uint8Array;
  /** National-id specs; the built-in list covers the US SSN and the UK NI number. */
  nationalIds?: NationalIdSpec[];
  /**
   * A value found verbatim in this text is kept (not masked): the workflow
   * definition, whose literals the author wrote and which a replay runs
   * unchanged, so masking them would only break the recorded model calls.
   */
  keepValuesIn?: string;
  /** Deepest nesting walked; deeper content is replaced by `[REDACTED]`. */
  maxDepth?: number;
}

export interface MaskReport {
  /** Distinct values masked, per data class. */
  values: Record<string, number>;
  /** Occurrences replaced, per data class. */
  occurrences: Record<string, number>;
  /** Occurrences replaced per part id, per class. */
  parts: Record<string, Record<string, number>>;
  /** Occurrences replaced per node id, per class. */
  nodes: Record<string, Record<string, number>>;
  /** Classes masked whose surrogates the DLP scan no longer finds (dictionary classes) or that were removed outright. */
  notDetectableAfterMasking: string[];
  /** Distinct detected values left in place because the workflow definition holds them. */
  keptFromWorkflow: number;
}

export interface MaskRecordingResult {
  parts: MaskPart[];
  report: MaskReport;
}

/** When two classes claim one value, the stronger claim wins: secrets first, then the checksum-backed classes. */
const CLASS_PRIORITY: Record<string, number> = {
  private_key: 0,
  jwt: 1,
  credential: 2,
  card_number: 3,
  iban: 4,
  us_ssn: 5,
  national_id: 6,
  email: 7,
  phone: 8
};

const DEFAULT_MAX_DEPTH = 64;
const DEPTH_MARKER = "[REDACTED]";

function priorityOf(dataClass: string): number {
  return CLASS_PRIORITY[dataClass] ?? 9;
}

/**
 * Non-overlapping matches: of overlapping ones the longest wins (an IBAN
 * over the card-shaped run of digits inside it), then the stronger class.
 */
export function resolveOverlaps(matches: readonly DlpMatch[]): DlpMatch[] {
  const ordered = [...matches].sort(
    (a, b) =>
      b.span.end - b.span.start - (a.span.end - a.span.start) ||
      priorityOf(String(a.dataClass)) - priorityOf(String(b.dataClass)) ||
      b.score - a.score ||
      a.span.start - b.span.start
  );
  const kept: DlpMatch[] = [];
  for (const match of ordered) {
    if (kept.some((other) => match.span.start < other.span.end && other.span.start < match.span.end)) continue;
    kept.push(match);
  }
  return kept.sort((a, b) => a.span.start - b.span.start);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The form a string takes inside a JSON string literal (one level of escaping). */
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function forEachString(value: unknown, visit: (text: string) => void, depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) forEachString(entry, visit, depth + 1, maxDepth);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      forEachString(nested, visit, depth + 1, maxDepth);
    }
  }
}

function mapStrings(value: unknown, map: (text: string) => string, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return DEPTH_MARKER;
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map, depth + 1, maxDepth));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) continue;
      out[map(key)] = mapStrings(nested, map, depth + 1, maxDepth);
    }
    return out;
  }
  return value;
}

function bump(target: Record<string, number>, key: string, by = 1): void {
  target[key] = (target[key] ?? 0) + by;
}

/** Detect, then substitute, across every part. See the module comment. */
export function maskRecording(parts: readonly MaskPart[], options: MaskRecordingOptions): MaskRecordingResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const scanOptions = { dictionaries: options.dictionaries ?? [], nationalIds: options.nationalIds ?? DEFAULT_NATIONAL_IDS };

  // 1–2. Distinct values and their class. A value claimed by two classes keeps the stronger one.
  const classOf = new Map<string, GuardDataClass>();
  const scanned = new Set<string>();
  for (const part of parts) {
    forEachString(
      part.value,
      (text) => {
        if (text.length === 0 || scanned.has(text)) return;
        scanned.add(text);
        for (const match of resolveOverlaps(scanDlp(text, scanOptions))) {
          const raw = text.slice(match.span.start, match.span.end);
          if (!raw.trim()) continue;
          const previous = classOf.get(raw);
          if (previous === undefined || priorityOf(String(match.dataClass)) < priorityOf(String(previous))) classOf.set(raw, match.dataClass);
        }
      },
      0,
      maxDepth
    );
  }

  let keptFromWorkflow = 0;
  if (options.keepValuesIn) {
    for (const raw of [...classOf.keys()]) {
      // Secrets are never kept, whatever the workflow holds.
      if (surrogateRedacts(classOf.get(raw)!)) continue;
      if (options.keepValuesIn.includes(raw)) {
        classOf.delete(raw);
        keptFromWorkflow += 1;
      }
    }
  }

  const report: MaskReport = { values: {}, occurrences: {}, parts: {}, nodes: {}, notDetectableAfterMasking: [], keptFromWorkflow };
  if (classOf.size === 0) return { parts: parts.map((part) => ({ ...part })), report };

  // 3. One alternation of every value (and its JSON-escaped forms), longest first, replaced in a single pass.
  const replacement = new Map<string, { surrogate: string; dataClass: string }>();
  const notDetectable = new Set<string>();
  for (const [raw, dataClass] of classOf) {
    const surrogate = surrogateFor(raw, dataClass, options.key);
    bump(report.values, String(dataClass));
    if (surrogateRedacts(dataClass) || !surrogateDetectable(dataClass, raw)) notDetectable.add(String(dataClass));
    replacement.set(raw, { surrogate, dataClass: String(dataClass) });
    let escapedRaw = raw;
    let escapedSurrogate = surrogate;
    for (let level = 0; level < 2; level += 1) {
      const nextRaw = jsonEscaped(escapedRaw);
      if (nextRaw === escapedRaw) break;
      escapedRaw = nextRaw;
      escapedSurrogate = jsonEscaped(escapedSurrogate);
      if (!replacement.has(escapedRaw)) replacement.set(escapedRaw, { surrogate: escapedSurrogate, dataClass: String(dataClass) });
    }
  }
  report.notDetectableAfterMasking = [...notDetectable].sort();
  const pattern = new RegExp([...replacement.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "g");

  const masked = parts.map((part) => {
    const counts: Record<string, number> = {};
    const value = mapStrings(
      part.value,
      (text) =>
        text.replace(pattern, (found) => {
          const hit = replacement.get(found)!;
          bump(counts, hit.dataClass);
          return hit.surrogate;
        }),
      0,
      maxDepth
    );
    for (const [dataClass, count] of Object.entries(counts)) {
      bump(report.occurrences, dataClass, count);
      report.parts[part.id] = report.parts[part.id] ?? {};
      bump(report.parts[part.id]!, dataClass, count);
      if (part.nodeId) {
        report.nodes[part.nodeId] = report.nodes[part.nodeId] ?? {};
        bump(report.nodes[part.nodeId]!, dataClass, count);
      }
    }
    return { ...part, value };
  });
  return { parts: masked, report };
}

/** The data classes a masking report found for one node, sorted. */
export function maskedClassesForNode(report: MaskReport, nodeId: string): string[] {
  return Object.keys(report.nodes[nodeId] ?? {}).sort();
}
