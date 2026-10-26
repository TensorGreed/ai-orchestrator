import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "../default-profile";
import { mergeSpans, replaceSpans, maskForDataClass, MASK_CHAR, shannonEntropy } from "../masking";
import { hashGuardProfile, unsafeDictionaryPattern, type GuardDictionary } from "../profile";
import { clampScore, type GuardSpan } from "../types";
import { stripHiddenUnicode } from "./hidden-unicode";
import {
  appendUncoveredMatches,
  CREDENTIAL_NAME_PATTERN,
  DEFAULT_NATIONAL_IDS,
  findBasicAuthUrlSpans,
  findEmailSpans,
  findJwtSpans,
  findPrivateKeySpans,
  findSqlStringLiteralSpans,
  findUrlQueryMatches,
  ibanValid,
  luhnValid,
  scanDlp,
  scrubbedExcerpt,
  scrubEvidenceText,
  type DlpMatch,
  type DlpScanOptions
} from "./dlp";

/*
 * The DLP scan before it was made linear-time, kept here only as an oracle.
 * Every pattern, the coverage rule, the phone digit count and the span
 * replacement are copied verbatim from the previous implementation; the
 * tests assert the new code returns exactly what this returns.
 */
const OLD_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;
const OLD_PHONE = /(?<![\w.-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g;
const OLD_CARD = /(?<!\d)(?<!\d-)(?:\d[ -]?){12,18}\d(?!\d)(?!-\d)/g;
const OLD_IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,4})?\b/g;
const OLD_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OLD_PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[^\n]*/g;
const OLD_BASIC_AUTH_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@/]{4,}@/g;
const OLD_KEY_PREFIXES: Array<{ id: string; pattern: RegExp; score: number }> = [
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
  { id: "bearer", pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, score: 0.8 },
  { id: "basic-auth-url", pattern: OLD_BASIC_AUTH_URL, score: 0.85 }
];
const OLD_CREDENTIAL_ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_.-]{1,40})\s*(?:[:=]|=>|:=)\s*["'`]?([A-Za-z0-9+/=_\-.~]{12,})["'`]?/g;
const OLD_URL_QUERY_OR_FRAGMENT = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'`<>]*)[?#][^\s"'`<>)\]]*/gi;

function oldPushUnlessCovered(matches: DlpMatch[], candidate: DlpMatch): void {
  const covered = matches.some((m) => m.span.start <= candidate.span.start && m.span.end >= candidate.span.end && m.score >= candidate.score);
  if (!covered) matches.push(candidate);
}

function oldDigitsAround(text: string, start: number, end: number): number {
  let from = start;
  let to = end;
  while (from > 0 && /[\d\s.()-]/.test(text[from - 1]!)) from -= 1;
  while (to < text.length && /[\d\s.()-]/.test(text[to]!)) to += 1;
  return text.slice(from, to).replace(/\D/g, "").length;
}

function oldLooksLikeJwt(token: string): boolean {
  const [header] = token.split(".");
  try {
    const decoded = JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof decoded === "object" && decoded !== null && ("alg" in decoded || "typ" in decoded);
  } catch {
    return false;
  }
}

function oldSpanOf(m: RegExpMatchArray): GuardSpan {
  const start = m.index ?? 0;
  return { start, end: start + m[0].length };
}

function oldScanDlp(text: string, options: DlpScanOptions = {}): DlpMatch[] {
  const matches: DlpMatch[] = [];
  const disabled = new Set(options.disable ?? []);
  const add = (m: DlpMatch) => {
    if (!disabled.has(m.dataClass)) oldPushUnlessCovered(matches, m);
  };
  const run = (regex: RegExp, handler: (match: RegExpMatchArray) => void) => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) handler(match);
  };
  run(OLD_PRIVATE_KEY, (m) => add({ dataClass: "private_key", span: oldSpanOf(m), score: 1, message: "Private key block" }));
  run(OLD_JWT, (m) => {
    if (!oldLooksLikeJwt(m[0])) return;
    add({ dataClass: "jwt", span: oldSpanOf(m), score: 0.95, message: "JSON Web Token" });
  });
  for (const prefix of OLD_KEY_PREFIXES) {
    run(prefix.pattern, (m) => add({ dataClass: "credential", span: oldSpanOf(m), score: prefix.score, message: `Credential with a known key prefix (${prefix.id})` }));
  }
  run(OLD_CREDENTIAL_ASSIGNMENT, (m) => {
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
  run(OLD_CARD, (m) => {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return;
    if (/^(\d)\1+$/.test(digits)) return;
    add({ dataClass: "card_number", span: oldSpanOf(m), score: 0.9, message: "Payment card number (checksum valid)" });
  });
  run(OLD_IBAN, (m) => {
    if (!ibanValid(m[0])) return;
    add({ dataClass: "iban", span: oldSpanOf(m), score: 0.95, message: "IBAN (checksum valid)" });
  });
  for (const spec of options.nationalIds ?? DEFAULT_NATIONAL_IDS) {
    run(spec.pattern, (m) => {
      if (spec.validate && !spec.validate(m[0])) return;
      add({ dataClass: spec.dataClass ?? "national_id", span: oldSpanOf(m), score: spec.score ?? 0.85, message: `${spec.label} (${spec.country})` });
    });
  }
  run(OLD_EMAIL, (m) => add({ dataClass: "email", span: oldSpanOf(m), score: 0.95, message: "Email address" }));
  run(OLD_PHONE, (m) => {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) return;
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(m[0].trim()) || /^\d{1,2}[-.]\d{1,2}[-.]\d{4}$/.test(m[0].trim())) return;
    if (/^(\d)\1+$/.test(digits)) return;
    if (oldDigitsAround(text, m.index ?? 0, (m.index ?? 0) + m[0].length) >= 13) return;
    add({ dataClass: "phone", span: oldSpanOf(m), score: 0.6, message: "Phone number" });
  });
  for (const dictionary of options.dictionaries ?? []) {
    for (const term of dictionary.terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      run(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), (m) =>
        add({ dataClass: dictionary.dataClass, span: oldSpanOf(m), score: dictionary.score, message: `Dictionary term for class '${dictionary.dataClass}'` })
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
        add({ dataClass: dictionary.dataClass, span: oldSpanOf(m), score: dictionary.score, message: `Custom pattern for class '${dictionary.dataClass}'` });
      });
    }
  }
  return matches.sort((a, b) => a.span.start - b.span.start || b.score - a.score);
}

function oldReplaceSpans(text: string, spans: readonly GuardSpan[], replacement: (original: string, span: GuardSpan) => string): string {
  let out = text;
  for (const span of mergeSpans(spans).reverse()) {
    out = out.slice(0, span.start) + replacement(text.slice(span.start, span.end), span) + out.slice(span.end);
  }
  return out;
}

const OLD_SQL_STRING_LITERAL = /'(?:[^'\\]|\\.|'')*'/g;

function oldScrubEvidenceText(text: string, options: { sqlLiterals?: boolean } = {}): string {
  let out = text.replace(OLD_URL_QUERY_OR_FRAGMENT, (_match, base: string) => `${base}?${MASK_CHAR.repeat(3)}`);
  if (options.sqlLiterals) out = out.replace(OLD_SQL_STRING_LITERAL, `'${MASK_CHAR.repeat(3)}'`);
  const matches = oldScanDlp(out);
  if (matches.length === 0) return out;
  const byStart = new Map(matches.map((match) => [`${match.span.start}:${match.span.end}`, match.dataClass]));
  return oldReplaceSpans(out, matches.map((match) => match.span), (original, span) => maskForDataClass(original, byStart.get(`${span.start}:${span.end}`)));
}

function oldScrubbedExcerpt(text: string, span: GuardSpan, maxLength = 80, options: { sqlLiterals?: boolean } = {}): string {
  const raw = oldScrubEvidenceText(text.slice(span.start, span.end), options).replace(/\s+/g, " ").trim();
  const chars = Array.from(raw);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}…` : raw;
}

const viaRegex = (re: RegExp, s: string): Array<[number, number]> => [...s.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
const asPairs = (spans: readonly GuardSpan[]): Array<[number, number]> => spans.map((s) => [s.start, s.end]);
const urlQueryViaRegex = (s: string): Array<[number, number, number]> =>
  [...s.matchAll(OLD_URL_QUERY_OR_FRAGMENT)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[1]!.length, (m.index ?? 0) + m[0].length]);

// Seeded corpus

function rng(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % n;
  };
}

const JWT_SAMPLE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const PIECES = [
  "jane.doe@example.com", "a@b.co", "x_y%z+q-r@sub-1.example-2.org", "@", "@.", "@a.", ".com", "_a", "a_", "-", ".", "..",
  "https://u:pass1@h", "ftp://x:yyyy@", "HTTP://User:Secret9@Host/p?q=1#f", "a://", "://", ":/", "?", "#", "?q=1", "#frag",
  "eyJ", JWT_SAMPLE, "eyJhbGciOiJub25lIn0.", "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----",
  "-----END EC PRIVATE KEY-----", "\n", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "+44 20 7946 0958", "(415) 555-0123",
  "415.555.0123", "123 456 7890", "536-90-4399", "AB 12 34 56 C", "GB82 WEST 1234 5698 7654 32", "DE89370400440532013000",
  "sk-proj-abcdefghijklmnop1234", "api_key=Zx9#kQ2!vB7mL4pR", "token: \"aB3dE5fG7hJ9kL1m\"", "Bearer abcdefghij0123456789xyz",
  "ghp_0123456789abcdefghijABCDEFGHIJ0123", "AKIA0123456789ABCDEF",
  // Top-level domains around the 24-letter limit, and dense anchors.
  "a@b.abcdefghijklmnopqrstuvw", "a@b.abcdefghijklmnopqrstuvwx", "x@y.abcdefghijklmnopqrstuvwxy", ".abcdefghijklmnopqrstuvwxyz",
  "@@", "a@@b.co", "-@-", "a-@-b.co", "@-@", "://://", "a://://b:cccc@", "http://://u:pass@h", "ſ", "K", "\u00a0", "\u2028", "é", "'", "\"", "`", "<", ">", ")", "]", "="
];
const ALPHABET = "aZ9eyJ_.-+%@:/ \n?#x1'\"`<>)]=(".split("");

function randomString(next: (n: number) => number, maxLength: number): string {
  let s = "";
  const length = next(maxLength);
  for (let i = 0; i < length; i += 1) s += next(4) === 0 ? PIECES[next(PIECES.length)]! : ALPHABET[next(ALPHABET.length)]!;
  return s;
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..");

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(path));
    else if (entry.name.endsWith(".test.ts") && entry.name !== "dlp-linear.test.ts") out.push(path);
  }
  return out;
}

/** String literals from the guard-sdk tests, the capture-masking tests and the guard corpus. */
function fixtureStrings(): string[] {
  const files = [...listTestFiles(SRC), join(SRC, "../../../apps/api/src/services/capture-masking.test.ts")];
  const out = new Set<string>();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of source.matchAll(/"(?:[^"\\\n]|\\.)*"/g)) {
      try {
        out.add(JSON.parse(m[0]) as string);
      } catch {
        // not a JSON-compatible literal
      }
    }
    for (const m of source.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.add(m[1]!.replace(/\\(.)/g, "$1"));
    for (const m of source.matchAll(/`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)) out.add(m[1]!.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"));
  }
  const corpusDir = join(SRC, "../corpus");
  for (const name of readdirSync(corpusDir)) {
    if (!name.endsWith(".json")) continue;
    const walk = (value: unknown): void => {
      if (typeof value === "string") out.add(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(JSON.parse(readFileSync(join(corpusDir, name), "utf8")));
  }
  return [...out].filter((s) => s.length > 0);
}

const ADVERSARIAL_UNITS = [
  "1-", "a-1-", ".", "a.", "_", " ", "%", "9", "a", "aZ", "a://", "a-", "eyJ-", "-----BEGIN PRIVATE KEY-----\n", "-----BEGIN PRIVATE KEY----- ",
  "123 456 7890 ", "a@b.co ", "sk-", "key= ", "a:", "1 ", "1.", "x@a.", "ab.", "@a.", "a:/", "a://x:yyyy", "http://a/?", "eyJabcdefgh.",
  "-----BEGIN A ", "-----END PRIVATE KEY-----"
];
const ADVERSARIAL_PREFIXES = ["", "x@", "a://", "eyJ", "-----BEGIN PRIVATE KEY-----", "http://u:"];

function adversarialStrings(size: number): string[] {
  const out: string[] = [];
  for (const unit of ADVERSARIAL_UNITS) {
    for (const prefix of ADVERSARIAL_PREFIXES) {
      const body = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      out.push(prefix + body, prefix + body + "@-", prefix + body + "@a.co", body + "://u:pass@", body + "-----END PRIVATE KEY-----");
    }
  }
  return out;
}

// A few thousand random cases in CI; set DLP_FUZZ_CASES (e.g. 100000) for a longer local run.
const FUZZ_CASES = Number(process.env.DLP_FUZZ_CASES ?? 3000);
const FUZZ_TIMEOUT_MS = Math.max(60_000, FUZZ_CASES * 20);
const DICTIONARIES: GuardDictionary[] = [
  { dataClass: "project_code", terms: ["atlas", "a.b"], patterns: ["PRJ-\\d{3}", "x+"], score: 0.9 },
  { dataClass: "customer", terms: ["jane"], patterns: [], score: 0.95 }
];

function corpus(): string[] {
  const next = rng(0x5eed1);
  const fixtures = fixtureStrings();
  const out = [...fixtures];
  // Fixtures glued together and with random noise between them.
  for (let i = 0; i < Math.min(500, FUZZ_CASES); i += 1) {
    out.push(`${fixtures[next(fixtures.length)]}${ALPHABET[next(ALPHABET.length)]}${fixtures[next(fixtures.length)]}${randomString(next, 20)}`);
  }
  for (const size of [1, 2, 3, 5, 8, 13, 40, 200]) out.push(...adversarialStrings(size));
  for (let i = 0; i < FUZZ_CASES; i += 1) out.push(randomString(next, 120));
  return out;
}

describe("linear-time DLP: identical results to the previous regexes", () => {
  const cases = corpus();

  it("uses a corpus with fixtures, adversarial runs and random strings", () => {
    expect(cases.length).toBeGreaterThan(FUZZ_CASES + 1000);
  });

  it("finds the same email, basic-auth URL, JWT, private-key and URL-query spans", () => {
    const next = rng(0xfeed);
    const extra: string[] = [];
    for (let i = 0; i < FUZZ_CASES * 5; i += 1) extra.push(randomString(next, 80));
    let checked = 0;
    for (const s of [...cases, ...extra]) {
      expect(asPairs(findEmailSpans(s)), JSON.stringify(s)).toEqual(viaRegex(OLD_EMAIL, s));
      expect(asPairs(findBasicAuthUrlSpans(s)), JSON.stringify(s)).toEqual(viaRegex(OLD_BASIC_AUTH_URL, s));
      expect(asPairs(findJwtSpans(s)), JSON.stringify(s)).toEqual(viaRegex(OLD_JWT, s));
      expect(asPairs(findPrivateKeySpans(s)), JSON.stringify(s)).toEqual(viaRegex(OLD_PRIVATE_KEY, s));
      expect(findUrlQueryMatches(s).map((m) => [m.start, m.baseEnd, m.end]), JSON.stringify(s)).toEqual(urlQueryViaRegex(s));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(FUZZ_CASES * 6);
  }, FUZZ_TIMEOUT_MS);

  it("returns the same scanDlp matches (class, span, score, message), with and without options", () => {
    const next = rng(0xabc);
    for (const s of cases) {
      expect(scanDlp(s), JSON.stringify(s)).toEqual(oldScanDlp(s));
      const options: DlpScanOptions = { dictionaries: DICTIONARIES, entropyThreshold: next(2) === 0 ? 2.5 : undefined, disable: next(3) === 0 ? ["phone"] : undefined };
      expect(scanDlp(s, options), JSON.stringify(s)).toEqual(oldScanDlp(s, options));
    }
  }, FUZZ_TIMEOUT_MS);

  it("returns the same scrubbed evidence text", () => {
    for (const s of cases) expect(scrubEvidenceText(s), JSON.stringify(s)).toEqual(oldScrubEvidenceText(s));
  }, FUZZ_TIMEOUT_MS);

  it("returns the same matches on inputs with thousands of overlapping findings", () => {
    const next = rng(77);
    const units = ["a@b.co ", "jane@x.io sk-abcdefghijklmnopqr ", "4111 1111 1111 1111 ", "123 456 7890 ", "api_key=Zx9#kQ2vB7mL4pR ", "atlas PRJ-123 "];
    for (let round = 0; round < 6; round += 1) {
      let s = "";
      while (s.length < 30_000) s += units[next(units.length)]! + (next(5) === 0 ? randomString(next, 10) : "");
      expect(scanDlp(s, { dictionaries: DICTIONARIES })).toEqual(oldScanDlp(s, { dictionaries: DICTIONARIES }));
      expect(scrubEvidenceText(s)).toEqual(oldScrubEvidenceText(s));
    }
  }, FUZZ_TIMEOUT_MS);

  it("keeps the coverage rule exact on the indexed path", () => {
    const next = rng(4242);
    for (let round = 0; round < 300; round += 1) {
      const frozen: DlpMatch[] = [];
      for (let i = 0; i < next(80); i += 1) {
        const start = next(200);
        frozen.push({ dataClass: "email", span: { start, end: start + 1 + next(30) }, score: next(5) / 4, message: "f" });
      }
      // Candidates from one detector run never overlap one another.
      const pending: DlpMatch[] = [];
      let at = next(5);
      while (at < 220) {
        const end = at + 1 + next(12);
        pending.push({ dataClass: "phone", span: { start: at, end }, score: next(5) / 4, message: "p" });
        at = end + next(6);
      }
      const expected = [...frozen];
      for (const candidate of pending) oldPushUnlessCovered(expected, candidate);
      const actual = [...frozen];
      appendUncoveredMatches(actual, pending, 0);
      expect(actual).toEqual(expected);
    }
  });

  it("replaces spans exactly as before", () => {
    const next = rng(99);
    for (let round = 0; round < 500; round += 1) {
      const text = randomString(next, 200);
      const spans: GuardSpan[] = [];
      for (let i = 0; i < next(20); i += 1) {
        const start = next(text.length + 2);
        spans.push({ start, end: start + next(15) });
      }
      const calls: string[] = [];
      const newCalls: string[] = [];
      const expected = oldReplaceSpans(text, spans, (original, span) => {
        calls.push(`${span.start}:${span.end}:${original}`);
        return `<${original.length}>`;
      });
      const actual = replaceSpans(text, spans, (original, span) => {
        newCalls.push(`${span.start}:${span.end}:${original}`);
        return `<${original.length}>`;
      });
      expect(actual).toBe(expected);
      expect(newCalls).toEqual(calls);
    }
    const hidden = "a\u200b\u200bb\u00ad\u00adc".repeat(5);
    expect(stripHiddenUnicode(hidden)).toBe("abc".repeat(5));
  });

  it("keeps the default guard profile hash", () => {
    expect(hashGuardProfile(createDefaultGuardProfile())).toBe("38a972eb9d53a6890647cdc2b7c0f6ce4b9002fd33f497b2b195e3737d2e1aa5");
  });
});

describe("linear-time DLP: time budget on 1 MB adversarial input", () => {
  const MB = 1_000_000;
  // Generous for CI (Node 20, two slow cores); the previous code took minutes to hours on these.
  const BUDGET_MS = 2_000;
  const units = [
    "1-", "a-1-", "a.", ".", "_", " ", "%", "9", "a", "a://", "eyJ-", "-----BEGIN PRIVATE KEY-----\n", "123 456 7890 ", "a@b.co ", "sk-", "1.", "ab.",
    "http://a/b:c", "a\u200b\u200b"
  ];
  for (const unit of units) {
    it(`scans and scrubs 1 MB of ${JSON.stringify(unit)} within ${BUDGET_MS} ms`, () => {
      for (const prefix of ["", "x@"]) {
        const text = prefix + unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
        let started = performance.now();
        scanDlp(text, { dictionaries: DICTIONARIES });
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
        started = performance.now();
        scrubEvidenceText(text);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
        started = performance.now();
        stripHiddenUnicode(text);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      }
    }, 60_000);
  }
});

/*
 * SQL string literals (`scrubEvidenceText(…, { sqlLiterals: true })`, used by
 * the SQL guard's evidence): the linear scanner against the previous regex.
 */
const SQL_UNITS = [
  "'", "\\", "''", "\\'", "'\\", "\\\\", "'''", "a", "x y", " ", "\n", "\r\n", "\r", "\u2028", "\u2029", "\t", "é", "😀", "\ud800", "\udc00",
  "SELECT * FROM t WHERE a = ", "'O''Brien'", "'it\\'s'", "jane.doe@example.com", "https://h/p?q='1'#f", "4111 1111 1111 1111", "sk-proj-abcdefghijklmnop1234"
];

function sqlString(next: (n: number) => number): string {
  let s = "";
  const parts = 1 + next(12);
  for (let i = 0; i < parts; i += 1) {
    const unit = SQL_UNITS[next(SQL_UNITS.length)]!;
    s += next(3) === 0 ? unit.repeat(1 + next(60)) : unit;
  }
  // Sometimes a backslash or an open quote at the very end.
  const tail = next(6);
  return tail === 0 ? `${s}\\` : tail === 1 ? `${s}'` : s;
}

function sqlCorpus(): string[] {
  const next = rng(0x5a1);
  const out = corpus().slice(0, 4000);
  for (const unit of ["\\'", "'\\", "''", "\\'a", "'\\a", "'''", "\\", "'", "\\\\'", "\\'\n"]) {
    for (const size of [1, 2, 3, 4, 5, 8, 13, 41, 79, 80, 81, 200]) {
      const run = unit.repeat(size);
      out.push(run, `'${run}`, `${run}'`, `'${run}'`, `${run}\\`, `x${run}\\\n'`, `'${"a".repeat(size)}${run}`, `a = '${run}' AND b = '${"é".repeat(size)}'`);
    }
  }
  // Literals that cross the 80-character excerpt cap, with CRLF and Unicode inside.
  for (const before of [0, 10, 70, 77, 78, 79, 80, 81, 90]) {
    for (const body of ["abc", "a\r\nb", "😀😀😀", "x\\'y", "O''Brien", "\u2028\u2029", "z".repeat(30)]) {
      out.push(`${"s".repeat(before)}'${body}' rest`, `${"😀".repeat(before)}'${body}`, `${" ".repeat(before)}'${body}\\`);
    }
  }
  for (let i = 0; i < FUZZ_CASES * 4; i += 1) out.push(sqlString(next));
  return out;
}

describe("linear-time SQL string literals: identical results to the previous regex", () => {
  const cases = sqlCorpus();

  it("finds the same literal spans, and blanks them to the same scrubbed text and excerpt", () => {
    const next = rng(0x7e57);
    const differences: string[] = [];
    for (const s of cases) {
      if (JSON.stringify(asPairs(findSqlStringLiteralSpans(s))) !== JSON.stringify(viaRegex(OLD_SQL_STRING_LITERAL, s))) differences.push(`spans ${JSON.stringify(s)}`);
      if (scrubEvidenceText(s, { sqlLiterals: true }) !== oldScrubEvidenceText(s, { sqlLiterals: true })) differences.push(`scrub ${JSON.stringify(s)}`);
      const start = next(s.length + 1);
      for (const span of [{ start, end: start + next(s.length - start + 1) }, { start: 0, end: s.length }]) {
        const max = [80, 10, 1][next(3)]!;
        if (scrubbedExcerpt(s, span, max, { sqlLiterals: true }) !== oldScrubbedExcerpt(s, span, max, { sqlLiterals: true })) {
          differences.push(`excerpt ${JSON.stringify([s, span, max])}`);
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(differences.length).toBe(0);
    expect(cases.length).toBeGreaterThan(FUZZ_CASES * 4 + 1000);
  }, FUZZ_TIMEOUT_MS);
});

describe("linear-time SQL string literals: time budget on 1 MB adversarial input", () => {
  const MB = 1_000_000;
  const BUDGET_MS = 2_000;
  for (const unit of ["\\'", "'\\", "\\'a", "'\\a", "''", "'''\\", "\\\\'", "'a"]) {
    it(`blanks literals in 1 MB of ${JSON.stringify(unit)} within ${BUDGET_MS} ms`, () => {
      for (const prefix of ["", "'", "\\"]) {
        const text = prefix + unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
        let started = performance.now();
        findSqlStringLiteralSpans(text);
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
        started = performance.now();
        scrubEvidenceText(text, { sqlLiterals: true });
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
        started = performance.now();
        scrubbedExcerpt(text, { start: 0, end: text.length }, 80, { sqlLiterals: true });
        expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      }
    }, 60_000);
  }
});
