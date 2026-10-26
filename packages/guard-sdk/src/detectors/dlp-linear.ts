import type { GuardSpan } from "../types";

/**
 * Linear-time finders for the DLP patterns whose plain regular expressions
 * backtrack quadratically on long runs without their anchor character
 * (`"a.".repeat(500000)` took about 20 minutes as a regex scan).
 *
 * Each finder returns exactly the matches the original global regex returns
 * (same starts and ends, leftmost first, non-overlapping); `dlp-linear.test.ts`
 * keeps the original regexes as an oracle and checks this on fixtures,
 * adversarial runs and a seeded fuzz.
 *
 * The idea is the same for all of them. The original pattern is
 * `\b<run class>+<anchor><tail>` where the run class excludes the anchor's
 * first character, so a match starting at `i` can only use the first anchor
 * after `i`, and every start inside the same run reaches the same anchor and
 * the same tail. So: find each anchor (`@`, `://`, `-----BEGIN `, `eyJ`),
 * walk left over the run (never before the previous match end, which is
 * where the global scan resumes), take the leftmost start that satisfies
 * `\b`, and match the tail once with a sticky regex. Every character is
 * walked a bounded number of times.
 */

const PLUS = 43;
const HYPHEN = 45;
const DOT = 46;
const PERCENT = 37;
const UNDERSCORE = 95;

const isDigit = (c: number) => c >= 48 && c <= 57;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isAlnum = (c: number) => isDigit(c) || isUpper(c) || isLower(c);
/** `\w` without the `u` flag: ASCII letters, digits and `_`. */
const isWord = (c: number) => isAlnum(c) || c === UNDERSCORE;

function wordAt(s: string, i: number): boolean {
  return i >= 0 && i < s.length && isWord(s.charCodeAt(i));
}

/** `\b` at index `i` of `s` (the regex sees the real previous character even when its scan resumed at `i`). */
function boundaryAt(s: string, i: number): boolean {
  return wordAt(s, i - 1) !== wordAt(s, i);
}

/** Leftmost index in [from, to) where `ok(code)` and `\b` hold, or -1. */
function leftmostBoundary(s: string, from: number, to: number, ok: (c: number) => boolean): number {
  for (let i = from; i < to; i += 1) {
    if (ok(s.charCodeAt(i)) && boundaryAt(s, i)) return i;
  }
  return -1;
}

/** Start of the run of `inRun` characters that ends at `end`, never before `floor`. */
function runStart(s: string, end: number, floor: number, inRun: (c: number) => boolean): number {
  let r = end;
  while (r > floor && inRun(s.charCodeAt(r - 1))) r -= 1;
  return r;
}

// EMAIL: \b[A-Za-z0-9._%+-]+@<domain>
const isEmailLocal = (c: number) => isAlnum(c) || c === DOT || c === UNDERSCORE || c === PERCENT || c === PLUS || c === HYPHEN;
const EMAIL_DOMAIN = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/y;

/** Matches of `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g`. */
export function findEmailSpans(s: string): GuardSpan[] {
  const out: GuardSpan[] = [];
  let lastEnd = 0;
  for (let at = s.indexOf("@"); at !== -1; at = s.indexOf("@", at + 1)) {
    if (at < lastEnd) continue;
    // The local part cannot hold `@`, so the run stops at the previous one.
    const start = leftmostBoundary(s, runStart(s, at, lastEnd, isEmailLocal), at, () => true);
    if (start === -1) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    if (!EMAIL_DOMAIN.exec(s)) continue;
    out.push({ start, end: EMAIL_DOMAIN.lastIndex });
    lastEnd = EMAIL_DOMAIN.lastIndex;
  }
  return out;
}

// URL schemes: \b[a-z][a-z0-9+.-]*:\/\/ (case-sensitive, or any case with the `i` flag)
const isSchemeLower = (c: number) => isLower(c) || isDigit(c) || c === PLUS || c === DOT || c === HYPHEN;
const isSchemeAnyCase = (c: number) => isSchemeLower(c) || isUpper(c);
const isLetter = (c: number) => isLower(c) || isUpper(c);

const BASIC_AUTH_TAIL = /[^\s/:@]+:[^\s@/]{4,}@/y;

/** Matches of `\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@/]{4,}@/g` (a URL carrying `user:password@`). */
export function findBasicAuthUrlSpans(s: string): GuardSpan[] {
  const out: GuardSpan[] = [];
  let lastEnd = 0;
  for (let k = s.indexOf("://"); k !== -1; k = s.indexOf("://", k + 1)) {
    if (k < lastEnd) continue;
    const start = leftmostBoundary(s, runStart(s, k, lastEnd, isSchemeLower), k, isLower);
    if (start === -1) continue;
    // The tail stops at the next `/`, so it never reads past the next `://`.
    BASIC_AUTH_TAIL.lastIndex = k + 3;
    if (!BASIC_AUTH_TAIL.exec(s)) continue;
    out.push({ start, end: BASIC_AUTH_TAIL.lastIndex });
    lastEnd = BASIC_AUTH_TAIL.lastIndex;
  }
  return out;
}

const URL_BODY = /[^\s?#"'`<>]*/y;
const URL_QUERY_REST = /[^\s"'`<>)\]]*/y;

export interface UrlQueryMatch {
  start: number;
  /** End of the scheme, host and path (group 1 of the original pattern); the `?` or `#` is here. */
  baseEnd: number;
  end: number;
}

/** Matches of `(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'`<>]*)[?#][^\s"'`<>)\]]*\/gi` (a URL with a query or fragment). */
export function findUrlQueryMatches(s: string): UrlQueryMatch[] {
  const out: UrlQueryMatch[] = [];
  let lastEnd = 0;
  // The body can run over later `://`s, so its end is remembered for every anchor inside it.
  let bodyFrom = -1;
  let bodyEnd = -1;
  for (let k = s.indexOf("://"); k !== -1; k = s.indexOf("://", k + 1)) {
    if (k < lastEnd) continue;
    const start = leftmostBoundary(s, runStart(s, k, lastEnd, isSchemeAnyCase), k, isLetter);
    if (start === -1) continue;
    const from = k + 3;
    if (!(bodyFrom !== -1 && from >= bodyFrom && from <= bodyEnd)) {
      URL_BODY.lastIndex = from;
      URL_BODY.exec(s);
      bodyFrom = from;
      bodyEnd = URL_BODY.lastIndex;
    }
    const baseEnd = bodyEnd;
    const next = s[baseEnd];
    if (next !== "?" && next !== "#") continue;
    URL_QUERY_REST.lastIndex = baseEnd + 1;
    URL_QUERY_REST.exec(s);
    const end = URL_QUERY_REST.lastIndex;
    out.push({ start, baseEnd, end });
    lastEnd = end;
  }
  return out;
}

// JWT: \beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b
const isJwtChar = (c: number) => isAlnum(c) || c === UNDERSCORE || c === HYPHEN;

function jwtRunEnd(s: string, from: number): number {
  let q = from;
  while (q < s.length && isJwtChar(s.charCodeAt(q))) q += 1;
  return q;
}

/** End of a JWT whose first segment ends at `dot` (the `.` before the second segment), or -1. */
function jwtTailEnd(s: string, dot: number): number {
  if (s.charCodeAt(dot) !== DOT) return -1;
  const second = dot + 1;
  const secondEnd = jwtRunEnd(s, second);
  if (secondEnd - second < 8 || s.charCodeAt(secondEnd) !== DOT) return -1;
  const third = secondEnd + 1;
  const thirdEnd = jwtRunEnd(s, third);
  // The last segment is greedy, then gives back characters until `\b` holds.
  for (let j = thirdEnd; j >= third + 8; j -= 1) if (boundaryAt(s, j)) return j;
  return -1;
}

/** Matches of `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g` (before the header is decoded). */
export function findJwtSpans(s: string): GuardSpan[] {
  const out: GuardSpan[] = [];
  let lastEnd = 0;
  // Every `eyJ` in one run of segment characters shares the run's end and therefore the rest of the match.
  let runFrom = -1;
  let runEnd = -1;
  let tailFor = -1;
  let tail = -1;
  for (let i = s.indexOf("eyJ"); i !== -1; i = s.indexOf("eyJ", i + 1)) {
    if (i < lastEnd || !boundaryAt(s, i)) continue;
    const first = i + 3;
    if (!(runFrom !== -1 && first >= runFrom && first <= runEnd)) {
      runFrom = first;
      runEnd = jwtRunEnd(s, first);
    }
    if (runEnd - first < 8) continue;
    if (tailFor !== runEnd) {
      tailFor = runEnd;
      tail = jwtTailEnd(s, runEnd);
    }
    if (tail === -1) continue;
    out.push({ start: i, end: tail });
    lastEnd = tail;
  }
  return out;
}

// PRIVATE KEY: header … first END after it, else header and the rest of its line.
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g;
const PRIVATE_KEY_FOOTER = /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;

/**
 * Matches of
 * `-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[^\n]*\/g`.
 * The lazy body of the first branch reaches the first footer after the
 * header; the regex searched for it again from every header, this finder
 * remembers it.
 */
export function findPrivateKeySpans(s: string): GuardSpan[] {
  const out: GuardSpan[] = [];
  let footerFrom = -1;
  let footerAt = -1;
  let footerEnd = -1;
  PRIVATE_KEY_HEADER.lastIndex = 0;
  for (let header = PRIVATE_KEY_HEADER.exec(s); header; header = PRIVATE_KEY_HEADER.exec(s)) {
    const headerEnd = header.index + header[0].length;
    if (!(footerFrom !== -1 && headerEnd >= footerFrom && (footerAt === -1 || headerEnd <= footerAt))) {
      PRIVATE_KEY_FOOTER.lastIndex = headerEnd;
      const footer = PRIVATE_KEY_FOOTER.exec(s);
      footerFrom = headerEnd;
      footerAt = footer ? footer.index : -1;
      footerEnd = footer ? footer.index + footer[0].length : -1;
    }
    let end: number;
    if (footerAt !== -1) {
      end = footerEnd;
    } else {
      const newline = s.indexOf("\n", headerEnd);
      end = newline === -1 ? s.length : newline;
    }
    out.push({ start: header.index, end });
    PRIVATE_KEY_HEADER.lastIndex = end;
  }
  return out;
}

const DIGIT_RUN_CHAR = /[\d\s.()-]/;

/** Whether the digits of `text[start, end)` and of the digit/separator run around it reach `limit` (it stops counting there). */
export function digitsAroundAtLeast(text: string, start: number, end: number, limit: number): boolean {
  let count = 0;
  for (let i = start; i < end; i += 1) if (isDigit(text.charCodeAt(i))) count += 1;
  if (count >= limit) return true;
  for (let i = start; i > 0 && DIGIT_RUN_CHAR.test(text[i - 1]!); i -= 1) {
    if (isDigit(text.charCodeAt(i - 1)) && ++count >= limit) return true;
  }
  for (let i = end; i < text.length && DIGIT_RUN_CHAR.test(text[i]!); i += 1) {
    if (isDigit(text.charCodeAt(i)) && ++count >= limit) return true;
  }
  return false;
}

const QUOTE = 39;
const BACKSLASH = 92;
/** What `.` does not match without the `s` flag. */
const isLineTerminator = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/**
 * The matches of `/'(?:[^'\\]|\\.|'')*'/g` (a SQL string literal) in one pass.
 *
 * The regex is deterministic except at `''`: it first reads the pair as an
 * escaped quote and goes on, and only if nothing after that can close the
 * literal does it close at the first quote of the pair. Going on fails only
 * at a dead end (the end of the text, or `\` before a line terminator or the
 * end) reached before any lone quote, since any quote it reads either closes
 * the literal or is another pair. So the body is walked once: a lone quote
 * closes it; at a dead end it closes at the last pair, or there is no
 * literal from this quote. With no literal, every quote up to the dead end
 * was the second character of a `\x` on the same walk, so a literal starting
 * there would walk the same way to the same dead end: the search resumes at
 * the dead end, not at the next quote (the regex retries each of them, which
 * is what made it quadratic on `\'` runs). Each character is read at most
 * twice (once more after a literal closed at its last pair).
 */
export function findSqlStringLiteralSpans(s: string): GuardSpan[] {
  const out: GuardSpan[] = [];
  const n = s.length;
  let from = 0;
  for (;;) {
    const start = s.indexOf("'", from);
    if (start === -1) return out;
    let p = start + 1;
    let lastPair = -1;
    let end = -1;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === BACKSLASH) {
        if (p + 1 < n && !isLineTerminator(s.charCodeAt(p + 1))) {
          p += 2;
          continue;
        }
        break;
      }
      if (c === QUOTE) {
        if (p + 1 < n && s.charCodeAt(p + 1) === QUOTE) {
          lastPair = p;
          p += 2;
          continue;
        }
        end = p + 1;
        break;
      }
      p += 1;
    }
    if (end === -1 && lastPair !== -1) end = lastPair + 1;
    if (end === -1) {
      from = p;
      continue;
    }
    out.push({ start, end });
    from = end;
  }
}
