import { DEFAULT_NATIONAL_IDS, findEmailSpans, scanDlp, type DlpMatch, type NationalIdSpec } from "./detectors/dlp";
import type { GuardDictionary, GuardProfile } from "./profile";
import { comparePhones, parsePhone, phoneMaskCandidates, phoneMaskKeys, scanInternationalPhones, type ParsedPhone, type PhoneCertainty, type PhoneKeyStrength } from "./phone";
import {
  phoneSurrogateDigits,
  surrogateDetectable,
  surrogateFor,
  surrogateRedacts
} from "./protection/surrogate";

/**
 * Phase 15.6 — masking a recorded run (a production capture) before it is
 * stored: detect, then substitute, globally.
 *
 *   1. Every string in every part (values, object keys and the decimal text
 *      of numbers, at any depth) is scanned with the DLP patterns (the
 *      built-in classes plus the bound guard profile's dictionaries) and the
 *      capture-only international phone detector (`scanForCapture`). A
 *      profile's `disable` list is not applied. The scan reads a decoded view
 *      of each string: URL-encoding (`%40`) and JSON escapes (`@`, `\n`)
 *      are decoded first, so an escaped value is found as well.
 *   2. Each value found is reduced to its canonical form for its class:
 *      digits only for cards and SSNs, the national number for phones (a
 *      number with or without its country code, with or without a trunk 0;
 *      see phone.ts), upper-case letters and
 *      digits for IBANs and NI numbers, lower case for emails and dictionary
 *      terms. One canonical value is one subject.
 *   3. Every rendering of every canonical value is replaced, in every part,
 *      whether or not the scan would have found it at that spot: as written,
 *      digits only, with other separators, URL-encoded, JSON-escaped, and as a
 *      JSON number. A match is boundary-aware (`a@b.co` never matches inside
 *      `a@b.com`; a card's digits must be whole digit groups). The surrogate is
 *      written back in the encoding the original used at that spot.
 *   4. The result is checked: every string the scan found something in, or
 *      that masking changed, is scanned again, and if a collected value is
 *      still there masking throws `MaskIncompleteError` and the caller drops
 *      the capture.
 *
 * Content nested deeper than `maxDepth` cannot be scanned completely, so it
 * throws `MaskUnscannableError` (fail closed) instead of being stored.
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
   * The workflow definition. A detected value that equals a literal the
   * workflow holds (a whole string-literal token, compared in canonical form)
   * is kept: the author wrote it, and a replay runs the workflow unchanged,
   * so masking it would only break the recorded model calls. Ids, positions
   * and numbers are not literals. Secrets are never kept.
   */
  keepLiteralsFrom?: unknown;
  /**
   * Phase 16 — surrogates the run itself issued (runtime `protect` with the
   * surrogate provider, same key as capture masking). They are kept as they
   * are: masking them again would give a surrogate of a surrogate, and a
   * data-subject lookup of the original still finds them (the original's
   * surrogate is the issued one).
   */
  keepValues?: Iterable<string>;
  /** Deepest nesting walked; deeper content throws `MaskUnscannableError`. */
  maxDepth?: number;
  /**
   * Identifiers kept as written (replay looks them up as they are: MCP server
   * keys, tool names). They are not masked; when one holds a collected value
   * masking throws `MaskIdentifierError` and the caller drops the capture.
   * A `free` identifier (the default) is also scanned on its own, so a value
   * that appears only there drops the capture too. A `generated` one (an id
   * the server made: a registry server key, an adapter id) and a `catalog`
   * one (a tool or server name the MCP server's own catalog lists) are not:
   * their digit runs and words are not personal data, and scanning them
   * would drop every capture of a workflow for good. Collected values are
   * looked for in every identifier on token boundaries (emails and secrets
   * anywhere).
   */
  identifiers?: ReadonlyArray<MaskIdentifier>;
}

/** An identifier kept as written; see `MaskRecordingOptions.identifiers`. */
export interface MaskIdentifier {
  id: string;
  text: string;
  kind?: "free" | "generated" | "catalog";
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

/** Content that cannot be scanned completely (nested deeper than the limit). The capture must be dropped. */
export class MaskUnscannableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaskUnscannableError";
  }
}

/** After masking, the scan still finds a collected value. The capture must be dropped. */
export class MaskIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaskIncompleteError";
  }
}

/** A collected value appears in an identifier the capture keeps as written (an MCP server key, a tool name). The capture must be dropped. */
export class MaskIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaskIdentifierError";
  }
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
/** Strings (or this many characters) processed between two yields of the stepping API. */
const YIELD_EVERY_STRINGS = 2_000;
const YIELD_EVERY_CHARS = 256 * 1024;

/**
 * The scan production capture uses: the DLP patterns (the runtime guard's
 * scan, unchanged) plus the capture-only international phone detector
 * (`scanInternationalPhones`), so a number written `+14155551234` or
 * `+33 1 23 45 67 89` is masked too.
 */
export function scanForCapture(text: string, options: Parameters<typeof scanDlp>[1] = {}): DlpMatch[] {
  const matches = scanDlp(text, options);
  for (const span of scanInternationalPhones(text)) {
    matches.push({ dataClass: "phone", span, score: 0.6, message: "International phone number" });
  }
  return matches;
}

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

// ---------------------------------------------------------------------------
// Decoded view: URL-encoding and JSON escapes decoded, mapped back to the original
// ---------------------------------------------------------------------------

type EscapeStyle = { kind: "percent"; upper: boolean } | { kind: "unicode"; slashes: string; upper: boolean } | { kind: "short"; slashes: string };

/** A string as the scan reads it, with each view character's span in the original and how it was escaped there. */
export interface DecodedView {
  text: string;
  /** Null when the view is the original (nothing was decoded). */
  starts: number[] | null;
  ends: number[] | null;
  styles: Array<EscapeStyle | null> | null;
}

const SHORT_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "/": "/" };
const SHORT_LETTERS: Record<string, string> = { "\n": "n", "\r": "r", "\t": "t", '"': '"', "/": "/" };
const HEX = /^[0-9a-fA-F]+$/;

export function decodeView(original: string): DecodedView {
  if (!original.includes("%") && !original.includes("\\")) return { text: original, starts: null, ends: null, styles: null };
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const styles: Array<EscapeStyle | null> = [];
  let i = 0;
  while (i < original.length) {
    const c = original[i]!;
    if (c === "%" && i + 3 <= original.length && HEX.test(original.slice(i + 1, i + 3))) {
      const hex = original.slice(i + 1, i + 3);
      text += String.fromCharCode(parseInt(hex, 16));
      starts.push(i);
      ends.push(i + 3);
      styles.push({ kind: "percent", upper: hex !== hex.toLowerCase() });
      i += 3;
      continue;
    }
    if (c === "\\") {
      let j = i;
      while (j < original.length && original[j] === "\\") j += 1;
      const slashes = original.slice(i, j);
      const next = original[j];
      if (next === "u" && j + 5 <= original.length && HEX.test(original.slice(j + 1, j + 5))) {
        const hex = original.slice(j + 1, j + 5);
        text += String.fromCharCode(parseInt(hex, 16));
        starts.push(i);
        ends.push(j + 5);
        styles.push({ kind: "unicode", slashes, upper: hex !== hex.toLowerCase() });
        i = j + 5;
        continue;
      }
      if (next !== undefined && SHORT_ESCAPES[next] !== undefined) {
        text += SHORT_ESCAPES[next];
        starts.push(i);
        ends.push(j + 1);
        styles.push({ kind: "short", slashes });
        i = j + 1;
        continue;
      }
      for (let k = i; k < j; k += 1) {
        text += "\\";
        starts.push(k);
        ends.push(k + 1);
        styles.push(null);
      }
      i = j;
      continue;
    }
    text += c;
    starts.push(i);
    ends.push(i + 1);
    styles.push(null);
    i += 1;
  }
  return { text, starts, ends, styles };
}

function hex(code: number, width: number, upper: boolean): string {
  const out = code.toString(16).padStart(width, "0");
  return upper ? out.toUpperCase() : out;
}

function render(char: string, style: EscapeStyle | null): string {
  if (!style) return char;
  const code = char.charCodeAt(0);
  if (style.kind === "percent") return code < 256 ? `%${hex(code, 2, style.upper)}` : encodeURIComponent(char);
  if (style.kind === "short" && SHORT_LETTERS[char] !== undefined) return `${style.slashes}${SHORT_LETTERS[char]}`;
  const slashes = style.slashes;
  return `${slashes}u${hex(code, 4, style.kind === "unicode" ? style.upper : false)}`;
}

interface ViewEdit {
  start: number;
  end: number;
  replacement: string;
  /** Same length as the span: each changed character is written back on its own, in its own encoding. */
  perChar: boolean;
}

/** Applies edits made on the view to the original string. */
function applyEdits(original: string, view: DecodedView, edits: readonly ViewEdit[]): string {
  if (edits.length === 0) return original;
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  if (!view.starts) {
    let out = "";
    let at = 0;
    for (const edit of sorted) {
      out += original.slice(at, edit.start) + edit.replacement;
      at = edit.end;
    }
    return out + original.slice(at);
  }
  const starts = view.starts;
  const ends = view.ends!;
  const styles = view.styles!;
  let out = "";
  let at = 0;
  for (const edit of sorted) {
    const from = starts[edit.start]!;
    const to = ends[edit.end - 1]!;
    out += original.slice(at, from);
    if (edit.perChar && edit.replacement.length === edit.end - edit.start) {
      for (let k = edit.start; k < edit.end; k += 1) {
        const next = edit.replacement[k - edit.start]!;
        out += next === view.text[k] ? original.slice(starts[k]!, ends[k]!) : render(next, styles[k]!);
      }
    } else {
      // A replacement of another length: characters that were escaped in the span are escaped the same way.
      const escaped = new Map<string, EscapeStyle>();
      for (let k = edit.start; k < edit.end; k += 1) if (styles[k]) escaped.set(view.text[k]!, styles[k]!);
      let fallback: EscapeStyle | null = null;
      for (let k = edit.start; k < edit.end; k += 1) if (styles[k]) fallback = fallback ?? styles[k]!;
      for (const char of edit.replacement) {
        const style = escaped.get(char) ?? (fallback && fallback.kind === "percent" && !/[A-Za-z0-9._~-]/.test(char) ? fallback : null);
        out += render(char, style);
      }
    }
    at = to;
  }
  return out + original.slice(at);
}

// ---------------------------------------------------------------------------
// Subject index: canonical values per class family, and where they occur in a text
// ---------------------------------------------------------------------------

type Family = "digits" | "phone" | "email" | "alnum" | "literal";

export interface SubjectEntry {
  dataClass: string;
  family: Family;
  /** Canonical form (the index key). */
  key: string;
}

export interface SubjectSpan {
  start: number;
  end: number;
  entry: SubjectEntry;
  /** Phones: the national number whose digits the span holds (the surrogate replaces exactly these). */
  national?: string;
  /** Lookup: how sure the match is (`comparePhones`); every other class is `exact`. */
  certainty?: PhoneCertainty;
  /** Lookup: the longer phone number a text hit sits inside (its `+cc` or `00cc` before it), when there is one. */
  around?: { start: number; end: number };
}

const DIGIT_RUN = /\d+(?:[\s().\/-]{1,3}\d+)*/g;
const DIGIT_GROUP = /\d+/g;
const ALNUM_RUN = /[A-Za-z0-9]+(?:[\s-][A-Za-z0-9]+)*/g;
const ALNUM_GROUP = /[A-Za-z0-9]+/g;
const MAX_DIGIT_VALUE = 19;
const MAX_ALNUM_VALUE = 34;
const DIGIT_CLASSES = new Set(["card_number", "us_ssn"]);
const ALNUM_CLASSES = new Set(["iban"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which family a detected value of a class belongs to, and its canonical form. */
export function canonicalFor(raw: string, dataClass: string): { family: Family; key: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (surrogateRedacts(dataClass)) return { family: "literal", key: trimmed };
  if (dataClass === "email") return { family: "email", key: trimmed.toLowerCase() };
  if (dataClass === "phone") {
    const key = parsePhone(trimmed)?.national ?? "";
    return key.length > 0 ? { family: "phone", key } : null;
  }
  const letters = /[A-Za-z]/.test(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  if (DIGIT_CLASSES.has(dataClass) || (dataClass === "national_id" && !letters && digits.length > 0)) {
    return digits.length > 0 && digits.length <= MAX_DIGIT_VALUE ? { family: "digits", key: digits } : { family: "literal", key: trimmed.toLowerCase() };
  }
  if (ALNUM_CLASSES.has(dataClass) || dataClass === "national_id") {
    const alnum = trimmed.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return alnum.length > 0 && alnum.length <= MAX_ALNUM_VALUE ? { family: "alnum", key: alnum } : { family: "literal", key: trimmed.toLowerCase() };
  }
  return { family: "literal", key: trimmed.toLowerCase() };
}

/** Separators that end one value and start another inside a run of digits (a list, a sentence end, a gap). */
const STRICT_BREAK = /\/|\.\s|\s{2,}/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Canonical values and a boundary-aware finder for them. Masking collects
 * detected values here and replaces what `find` returns; the data-subject
 * lookup puts a value (and its surrogates) here and asks whether a stored
 * text holds any of them.
 *
 * Masking may over-mask, so its finder is generous: a card or SSN is any run
 * of whole digit groups with its digits, and a phone is found in its
 * international, national and trunk forms (phone.ts). The lookup's finder
 * (`strict`) must never over-match, because what it finds is deleted: a
 * number is a whole run of digits (never a suffix or part of a longer run,
 * never next to a letter), a phone is the same number only by `samePhone`,
 * and a literal is a whole token.
 */
export class SubjectIndex {
  private readonly byFamily: Record<Family, Map<string, SubjectEntry>> = {
    digits: new Map(),
    phone: new Map(),
    email: new Map(),
    alnum: new Map(),
    literal: new Map()
  };
  /** Masking: every form a phone is replaced as, with the national number it holds. */
  private readonly phoneKeys = new Map<string, { entry: SubjectEntry; national: string; strength: PhoneKeyStrength }>();
  /** Lookup: the phones as written, compared with `samePhone`. */
  private strictPhones: Array<{ entry: SubjectEntry; phone: ParsedPhone }> = [];
  private literalPatterns: { exact: RegExp | null; folded: RegExp | null } | null = null;

  /**
   * @param options.strict the data-subject lookup's matching (see the class
   *   comment); masking leaves it off, so a secret or a dictionary term is
   *   replaced wherever it appears and a number in any of its forms.
   */
  constructor(private readonly options: { strict?: boolean } = {}) {}

  get size(): number {
    let total = 0;
    for (const map of Object.values(this.byFamily)) total += map.size;
    return total;
  }

  entries(): SubjectEntry[] {
    return Object.values(this.byFamily).flatMap((map) => [...map.values()]);
  }

  /** Adds a value of a class; a value two classes claim keeps the stronger class. */
  add(raw: string, dataClass: string): SubjectEntry | null {
    const canonical = canonicalFor(raw, dataClass);
    if (!canonical) return null;
    const map = this.byFamily[canonical.family];
    const previous = map.get(canonical.key);
    let entry: SubjectEntry;
    if (previous && priorityOf(previous.dataClass) <= priorityOf(dataClass)) {
      entry = previous;
    } else {
      entry = { dataClass, family: canonical.family, key: canonical.key };
      if (previous) this.replaceEntry(previous, entry);
      map.set(canonical.key, entry);
      if (canonical.family === "literal") this.literalPatterns = null;
    }
    if (canonical.family === "phone") this.addPhone(raw, entry);
    return entry;
  }

  private replaceEntry(previous: SubjectEntry, entry: SubjectEntry): void {
    for (const value of this.phoneKeys.values()) if (value.entry === previous) value.entry = entry;
    for (const value of this.strictPhones) if (value.entry === previous) value.entry = entry;
  }

  private addPhone(raw: string, entry: SubjectEntry): void {
    const phone = parsePhone(raw);
    if (!phone) return;
    if (this.options.strict) {
      if (!this.strictPhones.some((other) => other.phone.digits === phone.digits && other.phone.explicit === phone.explicit)) this.strictPhones.push({ entry, phone });
      return;
    }
    for (const { key, national, strength } of phoneMaskKeys(phone)) {
      const previous = this.phoneKeys.get(key);
      if (!previous || strength > previous.strength) this.phoneKeys.set(key, { entry, national, strength });
    }
  }

  /** Adds a value to be matched exactly as written (case-insensitively): for a finding in a shape the other families do not read. */
  addLiteral(raw: string, dataClass: string): void {
    const key = surrogateRedacts(dataClass) ? raw : raw.toLowerCase();
    if (!key || this.byFamily.literal.has(key)) return;
    this.byFamily.literal.set(key, { dataClass, family: "literal", key });
    this.literalPatterns = null;
  }

  has(entry: Pick<SubjectEntry, "family" | "key">): boolean {
    if (entry.family === "phone" && this.phoneKeys.has(entry.key)) return true;
    return this.byFamily[entry.family].has(entry.key);
  }

  delete(entry: Pick<SubjectEntry, "family" | "key">): void {
    const stored = this.byFamily[entry.family].get(entry.key);
    this.byFamily[entry.family].delete(entry.key);
    if (entry.family === "literal") this.literalPatterns = null;
    if (entry.family === "phone" && stored) {
      for (const [key, value] of this.phoneKeys) if (value.entry === stored) this.phoneKeys.delete(key);
      this.strictPhones = this.strictPhones.filter((value) => value.entry !== stored);
    }
  }

  private literals(): { exact: RegExp | null; folded: RegExp | null } {
    if (this.literalPatterns) return this.literalPatterns;
    const exact: string[] = [];
    const folded: string[] = [];
    // A secret is matched exactly as written; everything else case-insensitively.
    for (const entry of this.byFamily.literal.values()) (surrogateRedacts(entry.dataClass) ? exact : folded).push(entry.key);
    const build = (keys: string[], flags: string) => {
      if (keys.length === 0) return null;
      const body = keys.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
      // Strict: a whole token, never glued to a longer number by a dash or a dot.
      return this.options.strict
        ? new RegExp(`(?<![\\p{L}\\p{N}_])(?<!\\p{N}[-.])(?:${body})(?![\\p{L}\\p{N}_])(?![-.]\\p{N})`, `${flags}u`)
        : new RegExp(body, flags);
    };
    this.literalPatterns = { exact: build(exact, "g"), folded: build(folded, "gi") };
    return this.literalPatterns;
  }

  /** Masking: card and SSN digits as whole groups, phones in every form (`phoneMaskKeys`). */
  private findNumbersLoose(text: string, found: SubjectSpan[]): void {
    const { digits } = this.byFamily;
    for (const run of text.matchAll(DIGIT_RUN)) {
      const base = run.index ?? 0;
      const groups = [...run[0].matchAll(DIGIT_GROUP)].map((group) => ({ start: base + (group.index ?? 0), digits: group[0] }));
      // Card and SSN values are whole digit groups, joined by any separators.
      if (digits.size > 0) {
        for (let i = 0; i < groups.length; i += 1) {
          let acc = "";
          for (let j = i; j < groups.length; j += 1) {
            acc += groups[j]!.digits;
            if (acc.length > MAX_DIGIT_VALUE) break;
            const entry = digits.get(acc);
            if (entry) found.push({ start: groups[i]!.start, end: groups[j]!.start + groups[j]!.digits.length, entry });
          }
        }
      }
      // A phone is any run of whole groups read as a number with or without its country code; only its national digits are replaced.
      if (this.phoneKeys.size > 0) {
        for (let i = 0; i < groups.length; i += 1) {
          let acc = "";
          for (let j = i; j < groups.length; j += 1) {
            acc += groups[j]!.digits;
            if (acc.length > MAX_PHONE_RUN) break;
            for (const candidate of phoneMaskCandidates(acc)) {
              const hit = this.phoneKeys.get(candidate);
              if (!hit) continue;
              const end = groups[j]!.start + groups[j]!.digits.length;
              found.push({ start: digitPosition(groups, i, j, acc.length - hit.national.length), end, entry: hit.entry, national: hit.national });
              break;
            }
          }
        }
      }
    }
  }

  /** Lookup: whole runs of digits only (split where one value ends and another starts), never next to a letter. */
  private findNumbersStrict(text: string, found: SubjectSpan[]): void {
    const { digits } = this.byFamily;
    for (const run of text.matchAll(DIGIT_RUN)) {
      const base = run.index ?? 0;
      const groups = [...run[0].matchAll(DIGIT_GROUP)].map((group) => ({ start: base + (group.index ?? 0), digits: group[0] }));
      let first = 0;
      for (let g = 0; g < groups.length; g += 1) {
        const last = g === groups.length - 1;
        const gap = last ? "" : text.slice(groups[g]!.start + groups[g]!.digits.length, groups[g + 1]!.start);
        if (!last && !STRICT_BREAK.test(gap)) continue;
        const start = groups[first]!.start;
        const end = groups[g]!.start + groups[g]!.digits.length;
        const segmentFirst = first;
        first = g + 1;
        if ((start > 0 && WORD_CHAR.test(text[start - 1]!)) || (end < text.length && WORD_CHAR.test(text[end]!))) continue;
        // The excerpt starts at an opening bracket the value is written with: `(207) 946-0958`.
        const shown = start > 0 && text[start - 1] === "(" && text[groups[segmentFirst]!.start + groups[segmentFirst]!.digits.length] === ")" ? start - 1 : start;
        let value = "";
        for (let k = segmentFirst; k <= g; k += 1) value += groups[k]!.digits;
        const entry = digits.get(value);
        if (entry) found.push({ start: shown, end, entry, certainty: "exact" });
        if (this.strictPhones.length > 0) {
          const phone = parsePhone(text.slice(start, end), start > 0 && text[start - 1] === "+");
          if (phone) {
            let best: { entry: SubjectEntry; certainty: PhoneCertainty } | null = null;
            for (const other of this.strictPhones) {
              const certainty = comparePhones(other.phone, phone);
              if (certainty && (!best || certainty === "exact")) best = { entry: other.entry, certainty };
              if (best?.certainty === "exact") break;
            }
            if (best) found.push({ start: shown, end, entry: best.entry, national: phone.national, certainty: best.certainty });
          }
        }
      }
    }
  }

  /** Every occurrence of an indexed value in `text` (a decoded view), without overlaps: the longest wins, then the stronger class. */
  find(text: string): SubjectSpan[] {
    const found: SubjectSpan[] = [];
    const { digits, email, alnum, literal } = this.byFamily;

    if (this.options.strict) {
      if (digits.size > 0 || this.strictPhones.length > 0) this.findNumbersStrict(text, found);
    } else if (digits.size > 0 || this.phoneKeys.size > 0) {
      this.findNumbersLoose(text, found);
    }

    if (email.size > 0) {
      // The DLP email pattern, found in linear time.
      for (const span of findEmailSpans(text)) {
        const entry = email.get(text.slice(span.start, span.end).toLowerCase());
        if (entry) found.push({ start: span.start, end: span.end, entry });
      }
    }

    if (alnum.size > 0) {
      for (const run of text.matchAll(ALNUM_RUN)) {
        const base = run.index ?? 0;
        const groups = [...run[0].matchAll(ALNUM_GROUP)].map((group) => ({ start: base + (group.index ?? 0), text: group[0] }));
        for (let i = 0; i < groups.length; i += 1) {
          let acc = "";
          for (let j = i; j < groups.length; j += 1) {
            acc += groups[j]!.text.toUpperCase();
            if (acc.length > MAX_ALNUM_VALUE) break;
            const entry = alnum.get(acc);
            if (entry) found.push({ start: groups[i]!.start, end: groups[j]!.start + groups[j]!.text.length, entry });
          }
        }
      }
    }

    if (literal.size > 0) {
      let intlSpans: Array<{ start: number; end: number }> | undefined;
      const { exact, folded } = this.literals();
      for (const [pattern, fold] of [
        [exact, false],
        [folded, true]
      ] as const) {
        if (!pattern) continue;
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          if (!match[0]) continue;
          const entry = literal.get(fold ? match[0].toLowerCase() : match[0]);
          if (!entry) continue;
          const start = match.index ?? 0;
          const end = start + match[0].length;
          // Lookup: bare digits searched as text, found inside a longer phone number (another country's `+cc`), are only a possible match.
          const around = this.options.strict && PHONE_SHAPED_LITERAL.test(entry.key) ? longerPhoneAround(text, start, end, () => (intlSpans ??= scanInternationalPhones(text))) : null;
          found.push(around ? { start, end, entry, certainty: "national_only", around } : { start, end, entry });
        }
      }
    }

    if (found.length <= 1) return found;
    const ordered = found.sort((a, b) => b.end - b.start - (a.end - a.start) || priorityOf(a.entry.dataClass) - priorityOf(b.entry.dataClass) || a.start - b.start);
    const kept: SubjectSpan[] = [];
    for (const span of ordered) {
      if (kept.some((other) => span.start < other.end && other.start < span.end)) continue;
      kept.push(span);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  /** True when `text` (decoded first) holds any indexed value. */
  matches(text: string): boolean {
    return this.find(decodeView(text).text).length > 0;
  }
}

/** A literal of 7 to 15 digits, written only with digits and phone separators: it may be part of a longer phone number. */
const PHONE_SHAPED_LITERAL = /^(?=(?:\D*\d){7,15}\D*$)[\d\s().-]+$/;
/** What a longer international number puts right before its national digits: `+33 `, `0033 `, `+33(0)`, `+44 (0) `, `(0)`. */
const PHONE_PREFIX_BEFORE = /(?:(?:\+\s?|(?<!\d)00)\d{1,3}[\s.-]?(?:\(\s?0\s?\)[\s.-]?|\(\s?)?|\(\s?0\s?\)[\s.-]?)$/;

/**
 * The longer phone number a text hit at `start..end` sits inside: written
 * right after a `+cc`, `00cc` or `(0)`, or inside a number the international
 * detector finds that is longer than the hit. Null when there is none.
 */
function longerPhoneAround(text: string, start: number, end: number, international: () => ReadonlyArray<{ start: number; end: number }>): { start: number; end: number } | null {
  const prefix = PHONE_PREFIX_BEFORE.exec(text.slice(Math.max(0, start - 12), start));
  if (prefix) return { start: start - prefix[0].length, end };
  for (const span of international()) {
    if (span.start <= start && span.end >= end && span.end - span.start > end - start) return span;
  }
  return null;
}

/** Longest run of digits read as one phone number (a 15-digit number with an international prefix and a trunk 0). */
const MAX_PHONE_RUN = 20;

/** The text position of digit `offset` of the groups `i..j` joined. */
function digitPosition(groups: ReadonlyArray<{ start: number; digits: string }>, i: number, j: number, offset: number): number {
  let remaining = offset;
  for (let k = i; k <= j; k += 1) {
    const group = groups[k]!;
    if (remaining < group.digits.length) return group.start + remaining;
    remaining -= group.digits.length;
  }
  return groups[j]!.start + groups[j]!.digits.length;
}

// ---------------------------------------------------------------------------
// Walking parts
// ---------------------------------------------------------------------------

interface WalkBudget {
  strings: number;
  chars: number;
}

function spend(budget: WalkBudget, text: string): boolean {
  budget.strings += 1;
  budget.chars += text.length;
  if (budget.strings >= YIELD_EVERY_STRINGS || budget.chars >= YIELD_EVERY_CHARS) {
    budget.strings = 0;
    budget.chars = 0;
    return true;
  }
  return false;
}

/** The text a number is scanned and masked as (its decimal form); null for NaN and infinities. */
export function numberText(value: number): string | null {
  return Number.isFinite(value) ? String(value) : null;
}

/** Visits every string, object key and number's text; throws when content is nested deeper than `maxDepth`. */
function* forEachText(value: unknown, visit: (text: string) => void, depth: number, maxDepth: number, budget: WalkBudget, where: string): Generator<void, void, void> {
  if (depth > maxDepth) throw new MaskUnscannableError(`Content in ${where} is nested deeper than ${maxDepth} levels and cannot be scanned completely.`);
  if (typeof value === "string") {
    visit(value);
    if (spend(budget, value)) yield;
    return;
  }
  if (typeof value === "number") {
    const text = numberText(value);
    if (text) visit(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) yield* forEachText(entry, visit, depth + 1, maxDepth, budget, where);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      visit(key);
      yield* forEachText(nested, visit, depth + 1, maxDepth, budget, where);
    }
  }
}

function* mapTexts(value: unknown, map: (text: string) => string, depth: number, maxDepth: number, budget: WalkBudget, where: string): Generator<void, unknown, void> {
  if (depth > maxDepth) throw new MaskUnscannableError(`Content in ${where} is nested deeper than ${maxDepth} levels and cannot be scanned completely.`);
  if (typeof value === "string") {
    const out = map(value);
    if (spend(budget, value)) yield;
    return out;
  }
  if (typeof value === "number") {
    const text = numberText(value);
    if (!text) return value;
    const out = map(text);
    if (out === text) return value;
    // A number whose digits were replaced stays a number when the surrogate reads back exactly; otherwise it becomes a string.
    const parsed = Number(out);
    return /^-?\d+$/.test(out) && Number.isSafeInteger(parsed) && String(parsed) === out ? parsed : out;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) out.push(yield* mapTexts(entry, map, depth + 1, maxDepth, budget, where));
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) continue;
      out[map(key)] = yield* mapTexts(nested, map, depth + 1, maxDepth, budget, where);
    }
    return out;
  }
  return value;
}

function bump(target: Record<string, number>, key: string, by = 1): void {
  target[key] = (target[key] ?? 0) + by;
}

/** Keys that hold identifiers or layout in a workflow definition, never literals the author wrote. */
const NON_LITERAL_KEYS = new Set(["id", "nodeId", "source", "target", "sourceHandle", "targetHandle", "position", "positionAbsolute", "x", "y", "width", "height", "createdAt", "updatedAt", "secretId", "secretRef"]);

/**
 * The text of a finding. A phone's `+` is part of it even when the pattern
 * matched from the digits after it (the scan's phone pattern does for
 * `+47 2212 3456`): it says the leading digits are a country code.
 */
export function findingText(view: string, match: Pick<DlpMatch, "dataClass" | "span">): string {
  const start = match.span.start > 0 && String(match.dataClass) === "phone" && view[match.span.start - 1] === "+" ? match.span.start - 1 : match.span.start;
  return view.slice(start, match.span.end);
}

/** The canonical values a workflow definition holds as whole literal tokens. */
function workflowLiterals(workflow: unknown, scanOptions: Parameters<typeof scanDlp>[1]): { index: SubjectIndex; digitRuns: Set<string>; phoneRuns: Set<string> } {
  const index = new SubjectIndex();
  const digitRuns = new Set<string>();
  /** National readings of each whole run of digits (phone.ts): a phone is kept only when a literal is that number. */
  const phoneRuns = new Set<string>();
  const visit = (text: string) => {
    const view = decodeView(text).text;
    for (const match of resolveOverlaps(scanForCapture(view, scanOptions))) {
      const dataClass = String(match.dataClass);
      if (surrogateRedacts(dataClass)) continue;
      index.add(findingText(view, match), dataClass);
    }
    // Numbers count as written: a value is kept only when it is a whole run of digits in a literal.
    for (const run of view.matchAll(DIGIT_RUN)) {
      const digits = run[0].replace(/\D/g, "");
      digitRuns.add(digits);
      if (digits.length <= MAX_PHONE_RUN) for (const reading of phoneMaskCandidates(digits)) phoneRuns.add(reading);
    }
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > DEFAULT_MAX_DEPTH) return;
    if (typeof value === "string") return visit(value);
    if (Array.isArray(value)) return value.forEach((entry) => walk(entry, depth + 1));
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (NON_LITERAL_KEYS.has(key)) continue;
        walk(nested, depth + 1);
      }
    }
  };
  walk(workflow, 0);
  return { index, digitRuns, phoneRuns };
}

/** The surrogate text for a span (on the view), and whether it is the same length (written back per character). */
function surrogateEdit(view: string, span: SubjectSpan, key: Uint8Array): ViewEdit {
  const raw = view.slice(span.start, span.end);
  const dataClass = span.entry.dataClass;
  if (span.entry.family === "phone") {
    // Only the national digits change, in place: the span starts after any country code or trunk 0, and separators stay.
    const digits = phoneSurrogateDigits(span.national ?? span.entry.key, key);
    let index = 0;
    let out = "";
    for (const char of raw) {
      if (char >= "0" && char <= "9" && index < digits.length) out += digits[index++]!;
      else out += char;
    }
    return { start: span.start, end: span.end, replacement: out, perChar: true };
  }
  const surrogate = surrogateFor(raw, dataClass, key);
  return { start: span.start, end: span.end, replacement: surrogate, perChar: surrogate.length === raw.length && (span.entry.family === "digits" || span.entry.family === "alnum") };
}

/** Separators allowed inside a number written in an identifier (`415-555-1234`, `(415) 555 1234`). */
const IDENTIFIER_DIGIT_SEPARATORS = "[\\s().-]*";

/**
 * Whether an identifier kept as written holds a collected value, or (a
 * `free` identifier) a value its own scan detects. A collected value counts
 * only as a whole token: a number not glued to other letters or digits (an
 * optional `+cc` before a phone), a dictionary term or other word not glued
 * to letters, digits or `_` (`atlas` is not in `atlas_search`). An email or
 * a secret counts anywhere (`lookup_jane@example.com`). A false alarm only
 * drops the capture.
 */
export function identifierHolds(
  index: SubjectIndex,
  identifier: Pick<MaskIdentifier, "text" | "kind">,
  scanOptions: Parameters<typeof scanDlp>[1] = {}
): boolean {
  const view = decodeView(identifier.text).text;
  // A value found only in an identifier was never collected: a free identifier's own scan counts too.
  if ((identifier.kind ?? "free") === "free" && scanForCapture(view, scanOptions).some((match) => view.slice(match.span.start, match.span.end).trim())) return true;
  if (index.size === 0) return false;
  const lower = view.toLowerCase();
  return index.entries().some((entry) => {
    if (entry.family === "email" || surrogateRedacts(entry.dataClass)) return surrogateRedacts(entry.dataClass) ? view.includes(entry.key) : lower.includes(entry.key.toLowerCase());
    if (entry.family === "digits" || entry.family === "phone") {
      const body = [...entry.key].join(IDENTIFIER_DIGIT_SEPARATORS);
      const countryCode = entry.family === "phone" ? `(?:\\+?\\d{1,3}${IDENTIFIER_DIGIT_SEPARATORS})?` : "";
      return new RegExp(`(?<![\\p{L}\\p{N}])${countryCode}${body}(?![\\p{L}\\p{N}])`, "u").test(view);
    }
    if (entry.family === "alnum") {
      const body = [...entry.key].map(escapeRegExp).join("[\\s-]*");
      return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "i").test(view);
    }
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(entry.key)}(?![\\p{L}\\p{N}_])`, "iu").test(view);
  });
}

/** Detect, then substitute, across every part, yielding between chunks of work. See the module comment. */
export function* maskRecordingSteps(parts: readonly MaskPart[], options: MaskRecordingOptions): Generator<void, MaskRecordingResult, void> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const scanOptions = { dictionaries: options.dictionaries ?? [], nationalIds: options.nationalIds ?? DEFAULT_NATIONAL_IDS };
  const budget: WalkBudget = { strings: 0, chars: 0 };

  // 1–2. Distinct canonical values and their class.
  const index = new SubjectIndex();
  const samples = new Map<string, string>();
  const scanned = new Set<string>();
  /** Texts the scan found something in: they are scanned again after masking. */
  const withFindings = new Set<string>();
  for (const part of parts) {
    yield* forEachText(
      part.value,
      (text) => {
        if (text.length === 0 || scanned.has(text)) return;
        scanned.add(text);
        const view = decodeView(text).text;
        const matches = resolveOverlaps(scanForCapture(view, scanOptions)).filter((match) => view.slice(match.span.start, match.span.end).trim());
        if (matches.length === 0) return;
        withFindings.add(text);
        for (const match of matches) {
          const raw = findingText(view, match);
          const entry = index.add(raw, String(match.dataClass));
          if (entry && !samples.has(`${entry.family}:${entry.key}`)) samples.set(`${entry.family}:${entry.key}`, raw);
        }
        // Every finding must be found again by the index; one in a shape it does not read is replaced as written.
        const spans = index.find(view);
        for (const match of matches) {
          if (spans.some((span) => span.start < match.span.end && match.span.start < span.end)) continue;
          index.addLiteral(view.slice(match.span.start, match.span.end).trim(), String(match.dataClass));
        }
      },
      0,
      maxDepth,
      budget,
      part.id
    );
  }
  scanned.clear();

  // Values the workflow holds as whole literals stay (never secrets).
  let keptFromWorkflow = 0;
  if (options.keepLiteralsFrom !== undefined && index.size > 0) {
    const literals = workflowLiterals(options.keepLiteralsFrom, scanOptions);
    for (const entry of index.entries()) {
      if (surrogateRedacts(entry.dataClass)) continue;
      const kept =
        entry.family === "digits"
          ? literals.digitRuns.has(entry.key)
          : entry.family === "phone"
            ? literals.phoneRuns.has(entry.key)
            : literals.index.has(entry);
      if (kept) {
        index.delete(entry);
        keptFromWorkflow += 1;
      }
    }
    yield;
  }

  // Phase 16 — the run's issued surrogates stay as they are.
  if (options.keepValues && index.size > 0) {
    for (const value of options.keepValues) {
      const view = decodeView(value).text;
      for (const match of scanForCapture(view, scanOptions)) {
        const canonical = canonicalFor(findingText(view, match), String(match.dataClass));
        if (canonical && !surrogateRedacts(String(match.dataClass)) && index.has(canonical)) index.delete(canonical);
      }
      index.delete({ family: "literal", key: value.toLowerCase() });
    }
    yield;
  }

  const report: MaskReport = { values: {}, occurrences: {}, parts: {}, nodes: {}, notDetectableAfterMasking: [], keptFromWorkflow };
  const notDetectable = new Set<string>();
  for (const entry of index.entries()) {
    bump(report.values, entry.dataClass);
    const sample = samples.get(`${entry.family}:${entry.key}`);
    if (surrogateRedacts(entry.dataClass) || !surrogateDetectable(entry.dataClass, sample)) notDetectable.add(entry.dataClass);
  }
  report.notDetectableAfterMasking = [...notDetectable].sort();

  // 3. Every rendering of every value, replaced; then 4. nothing collected may remain.
  const masked: MaskPart[] = [];
  for (const part of parts) {
    const counts: Record<string, number> = {};
    const replace = (text: string): string => {
      if (index.size === 0 || text.length === 0) return text;
      const view = decodeView(text);
      const spans = index.find(view.text);
      if (spans.length === 0) return text;
      const out = applyEdits(text, view, spans.map((span) => surrogateEdit(view.text, span, options.key)));
      for (const span of spans) bump(counts, span.entry.dataClass);
      return out;
    };
    const check = (text: string, original: string) => {
      if (text === original && !withFindings.has(original)) return;
      const view = decodeView(text).text;
      for (const match of scanForCapture(view, scanOptions)) {
        const canonical = canonicalFor(findingText(view, match), String(match.dataClass));
        if (canonical && index.has(canonical)) throw new MaskIncompleteError(`A detected value could not be replaced everywhere in ${part.id}.`);
      }
    };
    const replaceAndCheck = (text: string): string => {
      const out = replace(text);
      check(out, text);
      return out;
    };
    const value = yield* mapTexts(part.value, replaceAndCheck, 0, maxDepth, budget, part.id);
    for (const [dataClass, count] of Object.entries(counts)) {
      bump(report.occurrences, dataClass, count);
      report.parts[part.id] = report.parts[part.id] ?? {};
      bump(report.parts[part.id]!, dataClass, count);
      if (part.nodeId) {
        report.nodes[part.nodeId] = report.nodes[part.nodeId] ?? {};
        bump(report.nodes[part.nodeId]!, dataClass, count);
      }
    }
    masked.push({ ...part, value });
  }
  // Identifiers stay as written: none may hold a collected value.
  for (const identifier of options.identifiers ?? []) {
    if (identifier.text && identifierHolds(index, identifier, scanOptions)) {
      throw new MaskIdentifierError(`A detected value appears in ${identifier.id}, which is kept as written for replay.`);
    }
  }
  return { parts: masked, report };
}

/** Runs a stepping generator to completion on the spot. */
export function runSteps<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Runs a stepping generator, giving the event loop a turn at every step. */
export async function runStepsAsync<T>(steps: Generator<void, T, void>): Promise<T> {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Detect, then substitute, across every part. See the module comment. Blocks until done; prefer `maskRecordingAsync` on a server. */
export function maskRecording(parts: readonly MaskPart[], options: MaskRecordingOptions): MaskRecordingResult {
  return runSteps(maskRecordingSteps(parts, options));
}

/** `maskRecording` in chunks, yielding to the event loop between them. */
export function maskRecordingAsync(parts: readonly MaskPart[], options: MaskRecordingOptions): Promise<MaskRecordingResult> {
  return runStepsAsync(maskRecordingSteps(parts, options));
}

/** The data classes a masking report found for one node, sorted. */
export function maskedClassesForNode(report: MaskReport, nodeId: string): string[] {
  return Object.keys(report.nodes[nodeId] ?? {}).sort();
}
