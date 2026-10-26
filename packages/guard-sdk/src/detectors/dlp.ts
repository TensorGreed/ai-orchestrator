import { maskedEvidence, maskForDataClass, MASK_CHAR, replaceSpans, shannonEntropy } from "../masking";
import type { DetectorContext, GuardDataClass, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { clampScore } from "../types";
import { unsafeDictionaryPattern, type GuardDictionary } from "../profile";
import { digitsAroundAtLeast, findBasicAuthUrlSpans, findEmailSpans, findJwtSpans, findPrivateKeySpans, findSqlStringLiteralSpans, findUrlQueryMatches } from "./dlp-linear";

export { findBasicAuthUrlSpans, findEmailSpans, findJwtSpans, findPrivateKeySpans, findSqlStringLiteralSpans, findUrlQueryMatches, type UrlQueryMatch } from "./dlp-linear";

export const DLP_DETECTOR_ID = "dlp.patterns";

/**
 * Phase 12.5 — DLP detectors, rule tier. Patterns with checksums where the
 * data has one (Luhn for cards, mod-97 for IBAN, structural rules for the
 * US SSN), a pluggable national-id list, credential and key detection, and
 * custom dictionaries from the profile. Every finding carries masked
 * evidence only.
 */

export interface DlpMatch {
  dataClass: GuardDataClass;
  span: GuardSpan;
  score: number;
  message: string;
}

export interface NationalIdSpec {
  /** Data class reported (defaults to `national_id`). */
  dataClass?: GuardDataClass;
  /** Country code, for messages. */
  country: string;
  label: string;
  pattern: RegExp;
  /** Return false to reject a match that only looks right. */
  validate?(value: string): boolean;
  score?: number;
}

// Checksums

export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 12 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let d = Number(clean[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Make `digits` Luhn-valid by fixing its last digit. */
export function luhnCheckDigit(digitsWithoutCheck: string): string {
  let sum = 0;
  let double = true;
  for (let i = digitsWithoutCheck.length - 1; i >= 0; i -= 1) {
    let d = Number(digitsWithoutCheck[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

export function ibanValid(iban: string): boolean {
  const clean = iban.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) return false;
  const rearranged = clean.slice(4) + clean.slice(0, 4);
  let remainder = 0;
  for (const c of rearranged) {
    const value = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function usSsnValid(ssn: string): boolean {
  const m = /^(\d{3})[- ]?(\d{2})[- ]?(\d{4})$/.exec(ssn);
  if (!m) return false;
  const area = Number(m[1]);
  if (area === 0 || area === 666 || area >= 900) return false;
  if (Number(m[2]) === 0 || Number(m[3]) === 0) return false;
  if (m[1] === "123" && m[2] === "45" && m[3] === "6789") return false;
  return true;
}

/** UK National Insurance number structure (prefix letters that are never issued are rejected). */
export function ukNinoValid(value: string): boolean {
  const clean = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(clean)) return false;
  return !["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"].includes(clean.slice(0, 2));
}

export const DEFAULT_NATIONAL_IDS: NationalIdSpec[] = [
  {
    dataClass: "us_ssn",
    country: "US",
    label: "US Social Security number",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: usSsnValid,
    score: 0.9
  },
  {
    dataClass: "national_id",
    country: "GB",
    label: "UK National Insurance number",
    pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
    validate: ukNinoValid,
    score: 0.85
  }
];

// Patterns. Email, JWT, private keys and `scheme://user:password@` are found by
// the linear-time finders in `dlp-linear.ts`; written as plain regexes they
// backtrack quadratically on long runs without their anchor character.

const PHONE = /(?<![\w.-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g;
// A hyphen next to a letter (`cust-4111…`) is a separator; a hyphen next to another digit is part of a longer number.
const CARD = /(?<!\d)(?<!\d-)(?:\d[ -]?){12,18}\d(?!\d)(?!-\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,4})?\b/g;

/** Well-known credential prefixes. The list is kept short and specific so ordinary words never match. */
const KEY_PREFIXES: Array<{ id: string; pattern: RegExp; score: number }> = [
  { id: "sk-", pattern: /\bsk-(?:proj-|ant-|live_|test_)?[A-Za-z0-9_-]{16,}\b/g, score: 0.9 },
  { id: "pk-live", pattern: /\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, score: 0.85 },
  { id: "gh-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, score: 0.95 },
  { id: "glpat", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, score: 0.95 },
  { id: "slack", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, score: 0.9 },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, score: 0.9 },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, score: 0.9 },
  { id: "npm", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, score: 0.9 },
  { id: "pypi", pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/g, score: 0.95 },
  { id: "hf", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, score: 0.85 },
  { id: "sendgrid", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, score: 0.9 },
  { id: "l2m-mcp", pattern: /\bl2m_mcp_[A-Za-z0-9_-]{16,}\b/g, score: 0.95 },
  { id: "bearer", pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, score: 0.8 }
];
/** `scheme://user:password@`, found by `findBasicAuthUrlSpans` (it follows the key prefixes above). */
const BASIC_AUTH_URL = { id: "basic-auth-url", score: 0.85 };

/** Same heuristic as the MCP config import's credential-name rule (mcp-sdk `CREDENTIAL_NAME_PATTERN`), kept local so this package depends only on shared. */
export const CREDENTIAL_NAME_PATTERN = /(token|key|secret|passw|pwd|auth|credential|cookie|(^|[-_])pat($|[-_]))/i;

const CREDENTIAL_ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]{1,40})\s*(?:[:=]|=>|:=)\s*["'`]?([A-Za-z0-9+/=_\-.~]{12,})["'`]?/g;

function covers(m: DlpMatch, candidate: DlpMatch): boolean {
  return m.span.start <= candidate.span.start && m.span.end >= candidate.span.end && m.score >= candidate.score;
}

/**
 * Append each of `pending` (the findings of one detector pass) that no match
 * already in `matches` covers: same span or wider, and the same score or
 * higher. This equals checking each candidate in turn against everything
 * added before it, because the non-empty findings of one pass never overlap
 * (a pass with an empty span is checked that way, one by one). Small inputs
 * compare pairwise; large ones sweep by score with a prefix-max tree over
 * starts, so thousands of findings cost O(n log n) instead of O(n²).
 */
export function appendUncoveredMatches(matches: DlpMatch[], pending: readonly DlpMatch[], naiveLimit = 1024): void {
  if (pending.length === 0) return;
  if (pending.some((m) => m.span.start >= m.span.end)) {
    for (const candidate of pending) if (!matches.some((m) => covers(m, candidate))) matches.push(candidate);
    return;
  }
  const frozen = matches.length;
  if (frozen * pending.length <= naiveLimit || [...matches, ...pending].some((m) => Number.isNaN(m.score))) {
    // Only the earlier passes can cover a candidate, so the comparison stops at `frozen`.
    for (const candidate of pending) {
      let covered = false;
      for (let i = 0; i < frozen && !covered; i += 1) covered = covers(matches[i]!, candidate);
      if (!covered) matches.push(candidate);
    }
    return;
  }
  const starts = [...new Set(matches.map((m) => m.span.start))].sort((a, b) => a - b);
  const tree = new Float64Array(starts.length + 1).fill(-Infinity);
  const countAtMost = (value: number) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid]! <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const insert = (start: number, end: number) => {
    for (let i = countAtMost(start); i <= starts.length; i += i & -i) if (tree[i]! < end) tree[i] = end;
  };
  const widestEndFrom = (start: number) => {
    let best = -Infinity;
    for (let i = countAtMost(start); i > 0; i -= i & -i) if (tree[i]! > best) best = tree[i]!;
    return best;
  };
  const byScore = Array.from({ length: frozen }, (_, i) => i).sort((a, b) => matches[b]!.score - matches[a]!.score);
  const order = Array.from({ length: pending.length }, (_, i) => i).sort((a, b) => pending[b]!.score - pending[a]!.score);
  const covered = new Uint8Array(pending.length);
  let inserted = 0;
  for (const index of order) {
    const candidate = pending[index]!;
    while (inserted < frozen && matches[byScore[inserted]!]!.score >= candidate.score) {
      const m = matches[byScore[inserted]!]!;
      insert(m.span.start, m.span.end);
      inserted += 1;
    }
    if (widestEndFrom(candidate.span.start) >= candidate.span.end) covered[index] = 1;
  }
  for (let i = 0; i < pending.length; i += 1) if (!covered[i]) matches.push(pending[i]!);
}

export interface DlpScanOptions {
  nationalIds?: NationalIdSpec[];
  dictionaries?: GuardDictionary[];
  /** Data classes to skip. */
  disable?: GuardDataClass[];
  /** Minimum entropy (bits/char) for a value next to a credential-like name. */
  entropyThreshold?: number;
}

export function scanDlp(text: string, options: DlpScanOptions = {}): DlpMatch[] {
  const matches: DlpMatch[] = [];
  const disabled = new Set(options.disable ?? []);
  // Findings of one pass are checked against earlier passes when the pass ends (see `appendUncoveredMatches`).
  const pending: DlpMatch[] = [];
  const add = (m: DlpMatch) => {
    if (!disabled.has(m.dataClass)) pending.push(m);
  };
  const flush = () => {
    appendUncoveredMatches(matches, pending);
    pending.length = 0;
  };
  const run = (regex: RegExp, handler: (match: RegExpMatchArray) => void) => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) handler(match);
    flush();
  };
  const runSpans = (spans: GuardSpan[], handler: (value: string, span: GuardSpan) => void) => {
    for (const span of spans) handler(text.slice(span.start, span.end), span);
    flush();
  };

  runSpans(findPrivateKeySpans(text), (_value, span) => add({ dataClass: "private_key", span, score: 1, message: "Private key block" }));
  runSpans(findJwtSpans(text), (value, span) => {
    if (!looksLikeJwt(value)) return;
    add({ dataClass: "jwt", span, score: 0.95, message: "JSON Web Token" });
  });
  for (const prefix of KEY_PREFIXES) {
    run(prefix.pattern, (m) => add({ dataClass: "credential", span: spanOf(m), score: prefix.score, message: `Credential with a known key prefix (${prefix.id})` }));
  }
  runSpans(findBasicAuthUrlSpans(text), (_value, span) =>
    add({ dataClass: "credential", span, score: BASIC_AUTH_URL.score, message: `Credential with a known key prefix (${BASIC_AUTH_URL.id})` })
  );
  run(CREDENTIAL_ASSIGNMENT, (m) => {
    const name = m[1]!;
    const value = m[2]!;
    if (!CREDENTIAL_NAME_PATTERN.test(name)) return;
    if (/^(?:true|false|null|none|undefined|\$\{[^}]*\}|\{\{[^}]*\}\}|<[^>]*>)$/i.test(value)) return;
    const entropy = shannonEntropy(value);
    const threshold = options.entropyThreshold ?? 3.2;
    if (entropy < threshold && !/^[A-Za-z0-9+/]{20,}={0,2}$/.test(value)) return;
    const valueStart = (m.index ?? 0) + m[0].lastIndexOf(value);
    add({
      dataClass: "credential",
      span: { start: valueStart, end: valueStart + value.length },
      score: clampScore(0.55 + Math.min(0.35, (entropy - threshold) * 0.2)),
      message: `High-entropy value assigned to credential-like name '${name}'`
    });
  });

  run(CARD, (m) => {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return;
    // All one digit (0000…) passes Luhn but is a placeholder.
    if (/^(\d)\1+$/.test(digits)) return;
    add({ dataClass: "card_number", span: spanOf(m), score: 0.9, message: "Payment card number (checksum valid)" });
  });
  run(IBAN, (m) => {
    if (!ibanValid(m[0])) return;
    add({ dataClass: "iban", span: spanOf(m), score: 0.95, message: "IBAN (checksum valid)" });
  });
  for (const spec of options.nationalIds ?? DEFAULT_NATIONAL_IDS) {
    run(spec.pattern, (m) => {
      if (spec.validate && !spec.validate(m[0])) return;
      add({ dataClass: spec.dataClass ?? "national_id", span: spanOf(m), score: spec.score ?? 0.85, message: `${spec.label} (${spec.country})` });
    });
  }
  runSpans(findEmailSpans(text), (_value, span) => add({ dataClass: "email", span, score: 0.95, message: "Email address" }));
  run(PHONE, (m) => {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) return;
    // Date-like, version-like and ordinary numeric ranges have no phone shape.
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(m[0].trim()) || /^\d{1,2}[-.]\d{1,2}[-.]\d{4}$/.test(m[0].trim())) return;
    if (/^(\d)\1+$/.test(digits)) return;
    // Part of a longer digit run (a card or account number) is not a phone number.
    if (digitsAroundAtLeast(text, m.index ?? 0, (m.index ?? 0) + m[0].length, 13)) return;
    add({ dataClass: "phone", span: spanOf(m), score: 0.6, message: "Phone number" });
  });

  for (const dictionary of options.dictionaries ?? []) {
    for (const term of dictionary.terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      run(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), (m) =>
        add({ dataClass: dictionary.dataClass, span: spanOf(m), score: dictionary.score, message: `Dictionary term for class '${dictionary.dataClass}'` })
      );
    }
    for (const source of dictionary.patterns) {
      if (unsafeDictionaryPattern(source)) continue;
      let regex: RegExp;
      try {
        regex = new RegExp(source, "giu");
      } catch {
        continue;
      }
      run(regex, (m) => {
        if (!m[0]) return;
        add({ dataClass: dictionary.dataClass, span: spanOf(m), score: dictionary.score, message: `Custom pattern for class '${dictionary.dataClass}'` });
      });
    }
  }
  return matches.sort((a, b) => a.span.start - b.span.start || b.score - a.score);
}

function spanOf(m: RegExpMatchArray): GuardSpan {
  const start = m.index ?? 0;
  return { start, end: start + m[0].length };
}

function looksLikeJwt(token: string): boolean {
  const [header] = token.split(".");
  try {
    const decoded = JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof decoded === "object" && decoded !== null && ("alg" in decoded || "typ" in decoded);
  } catch {
    return false;
  }
}

/**
 * Text that pattern detectors (egress, exfiltration, SQL, command, path)
 * keep as evidence or put in a message: URL query and fragment values are
 * dropped (scheme, host and path stay), SQL string literals are blanked on
 * request, and whatever the DLP scan finds is masked by its data class.
 */
export function scrubEvidenceText(text: string, options: { sqlLiterals?: boolean } = {}): string {
  let out = dropUrlQueries(text);
  if (options.sqlLiterals) out = blankSqlLiterals(out);
  const matches = scanDlp(out);
  if (matches.length === 0) return out;
  const byStart = new Map(matches.map((match) => [`${match.span.start}:${match.span.end}`, match.dataClass]));
  return replaceSpans(out, matches.map((match) => match.span), (original, span) => maskForDataClass(original, byStart.get(`${span.start}:${span.end}`)));
}

/** Each SQL string literal becomes `'•••'` (in linear time; the plain regex was quadratic on `\'` runs). */
function blankSqlLiterals(text: string): string {
  const literals = findSqlStringLiteralSpans(text);
  if (literals.length === 0) return text;
  const blank = `'${MASK_CHAR.repeat(3)}'`;
  const parts: string[] = [];
  let cursor = 0;
  for (const literal of literals) {
    parts.push(text.slice(cursor, literal.start), blank);
    cursor = literal.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Each URL keeps its scheme, host and path; its query or fragment becomes `?•••`. */
function dropUrlQueries(text: string): string {
  const urls = findUrlQueryMatches(text);
  if (urls.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const url of urls) {
    parts.push(text.slice(cursor, url.baseEnd), `?${MASK_CHAR.repeat(3)}`);
    cursor = url.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** `excerptEvidence` for pattern detectors: the excerpt is scrubbed before it is flattened and capped. */
export function scrubbedExcerpt(text: string, span: GuardSpan, maxLength = 80, options: { sqlLiterals?: boolean } = {}): string {
  const raw = scrubEvidenceText(text.slice(span.start, span.end), options).replace(/\s+/g, " ").trim();
  const chars = Array.from(raw);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}…` : raw;
}

export interface DlpDetectorOptions {
  nationalIds?: NationalIdSpec[];
}

export function createDlpDetector(defaults: DlpDetectorOptions = {}): GuardDetector {
  return {
    id: DLP_DETECTOR_ID,
    tier: "rule",
    description: "Email, phone, payment cards (Luhn), IBAN (mod-97), US SSN and other national ids, credentials, keys and custom dictionaries.",
    channels: ["prompt", "model_output", "tool_arguments", "tool_result", "final_output"],
    categories: ["sensitive_data"],
    detect(_input: GuardInput, context: DetectorContext) {
      const options = context.options;
      const dictionaries = Array.isArray(options.dictionaries) ? (options.dictionaries as GuardDictionary[]) : [];
      const matches = scanDlp(context.text, {
        nationalIds: defaults.nationalIds,
        dictionaries,
        disable: Array.isArray(options.disable) ? (options.disable as GuardDataClass[]) : undefined,
        entropyThreshold: typeof options.entropyThreshold === "number" ? options.entropyThreshold : undefined
      });
      return matches.map<GuardFinding>((match) => ({
        detectorId: DLP_DETECTOR_ID,
        category: "sensitive_data",
        dataClass: match.dataClass,
        score: match.score,
        spans: [match.span],
        evidence: maskedEvidence(context.text.slice(match.span.start, match.span.end), match.dataClass),
        message: match.message
      }));
    }
  };
}
