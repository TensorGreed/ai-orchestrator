import type { GuardDataClass, GuardSpan } from "./types";

/**
 * Masking helpers. Findings carry masked evidence only, and the `mask`
 * action rewrites content with these functions, so raw sensitive values never
 * leave the engine in a verdict, trace or log line.
 */

export const MASK_CHAR = "•";

export interface MaskOptions {
  keepStart?: number;
  keepEnd?: number;
  char?: string;
  /** Keep separators such as spaces, dashes and dots in place. */
  keepSeparators?: boolean;
}

export function maskValue(value: string, options: MaskOptions = {}): string {
  const char = options.char ?? MASK_CHAR;
  const keepStart = Math.max(0, options.keepStart ?? 0);
  const keepEnd = Math.max(0, options.keepEnd ?? 0);
  const chars = Array.from(value);
  if (chars.length <= keepStart + keepEnd) return char.repeat(chars.length);
  return chars
    .map((c, index) => {
      if (index < keepStart || index >= chars.length - keepEnd) return c;
      if (options.keepSeparators && /[\s\-._/:]/.test(c)) return c;
      return char;
    })
    .join("");
}

function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return maskValue(value, { keepStart: 1 });
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const maskedDomain = dot > 0 ? `${maskValue(domain.slice(0, dot), { keepStart: 1 })}${domain.slice(dot)}` : maskValue(domain, { keepStart: 1 });
  return `${maskValue(local, { keepStart: 1 })}@${maskedDomain}`;
}

/** Mask a value the way its data class is usually shown: last four digits of a card, the domain suffix of an email. */
export function maskForDataClass(value: string, dataClass?: GuardDataClass): string {
  switch (dataClass) {
    case "email":
      return maskEmail(value);
    case "card_number":
      return maskValue(value, { keepEnd: 4, keepSeparators: true });
    case "phone":
      return maskValue(value, { keepEnd: 2, keepSeparators: true });
    case "iban":
      return maskValue(value, { keepStart: 2, keepEnd: 4, keepSeparators: true });
    case "us_ssn":
    case "national_id":
      return maskValue(value, { keepEnd: 4, keepSeparators: true });
    case "credential":
    case "jwt":
      return maskValue(value, { keepStart: Math.min(4, Math.max(0, value.length - 8)) });
    case "private_key":
      return "-----BEGIN PRIVATE KEY----- " + MASK_CHAR.repeat(8) + " -----END PRIVATE KEY-----";
    default:
      return maskValue(value, { keepStart: value.length > 8 ? 2 : 0, keepEnd: value.length > 8 ? 2 : 0 });
  }
}

// Shapes `maskForDataClass` writes, matched as whole tokens (see `normaliseMaskedSpans`).
const NOT_BEFORE = String.raw`(?<![\p{L}\p{N}•@_])`;
const NOT_AFTER = String.raw`(?![\p{L}\p{N}•@])`;
/** The separators a class mask keeps (`maskValue` `keepSeparators`), except `:`, which reads as a key before a value. */
const SEP = String.raw`[ \-./_]`;
/** An email: the first character of the local part and of the domain kept, the top-level domain kept. */
const MASKED_EMAIL = new RegExp(String.raw`${NOT_BEFORE}[\p{L}\p{N}_+\-]?•+@[\p{L}\p{N}]?•+\.[\p{L}\p{N}\-]+${NOT_AFTER}`, "gu");
/** An IBAN: the country kept, the last four characters kept (they may hold a separator). */
const IBAN_TAIL = String.raw`(?:[A-Za-z\d]{4}|[A-Za-z\d]${SEP}[A-Za-z\d]{2}|[A-Za-z\d]{2}${SEP}[A-Za-z\d]|${SEP}[A-Za-z\d]{3})`;
const MASKED_IBAN = new RegExp(String.raw`${NOT_BEFORE}[A-Za-z]{2}(•+(?:${SEP}•+)*)${IBAN_TAIL}${NOT_AFTER}`, "gu");
/**
 * A card, SSN, NI number or phone (or a fully masked value): groups of mask
 * characters with the separators kept, then the kept tail: the last four
 * digits (card, SSN), the last two (phone), or an NI number's last digits and
 * suffix letter. The tail may follow a separator (`•••-••-6789`).
 */
const GROUP_TAIL = String.raw`(?:\d{3}[A-D]|\d{2}${SEP}[A-D]|\d${SEP}\d{2}|\d{2}${SEP}\d|\d{4}|\d{2})`;
const MASKED_GROUPS = new RegExp(String.raw`${NOT_BEFORE}(•+(?:${SEP}•+)*)(?:(${SEP})?(${GROUP_TAIL}))?${NOT_AFTER}`, "gu");
const REDACTION_PLACEHOLDER = /\[redacted:([^\]\s]+)\]/gi;
const SEP_TEST = /[ \-./_]/;

/** What a masked span normalises to. A NUL already in the text is doubled before normalising, so the markers never equal unmasked text. */
const NORMALISED_MASK = "\u0000mask\u0000";
const NORMALISED_EMAIL = "\u0000mask:email\u0000";
const NORMALISED_IBAN = "\u0000mask:iban\u0000";

const maskCount = (text: string) => text.split(MASK_CHAR).length - 1;

/**
 * Normalises guard-masked spans so two texts that differ only in what the
 * mask hid compare equal. Only the exact shapes `maskForDataClass` writes are
 * matched, as whole tokens (never glued to a letter, a digit or another
 * mask character):
 *
 *   - an email: `j•••@e••••••.com`
 *   - an IBAN: `GB•• •••• •••• •••• •••4 32`, `GB••••••••••••••••5432`
 *   - a card, SSN, NI number or phone: `•••• •••• •••• 1111`, `••••••••••••1111`,
 *     `•••-••-6789`, `•• •• •• 56 C`, `•• •••-•••-••23`
 *   - a run of at least three mask characters (a fully masked value)
 *
 * A tail kept after a separator (`•••• •••• •••• 1111`) belongs to the mask
 * only when at least two masked groups come before it, so `•••• 12 items`
 * keeps its `12`. A lone `•` or `••` (a bullet) is never a mask, and a key
 * glued before the mask (`ssn:`, `to=`) stays as written. A redaction
 * placeholder (`[REDACTED:Email]`) has its class lower-cased.
 *
 * Callers apply this only when masking is expected in the comparison (a
 * masked capture, or a run whose guard masked, redacted or protected).
 */
export function normaliseMaskedSpans(text: string): string {
  // A NUL already in the text is doubled, so it can never read as one of the markers below.
  const source = text.includes("\u0000") ? text.replaceAll("\u0000", "\u0000\u0000") : text;
  const hasMask = source.includes(MASK_CHAR);
  const hasPlaceholder = /\[redacted:/i.test(source);
  if (!hasMask && !hasPlaceholder) return source;
  let out = source;
  if (hasPlaceholder) out = out.replace(REDACTION_PLACEHOLDER, (_all, dataClass: string) => `[redacted:${dataClass.toLowerCase()}]`);
  if (!hasMask) return out;
  out = out.replace(MASKED_EMAIL, NORMALISED_EMAIL);
  // An IBAN is at least 15 characters: at least nine of them masked.
  out = out.replace(MASKED_IBAN, (all: string, body: string) => (maskCount(body) >= 9 ? NORMALISED_IBAN : all));
  out = out.replace(MASKED_GROUPS, (all: string, body: string, separator: string | undefined, tail: string | undefined) => {
    if (maskCount(body) < 3) return all;
    if (!tail) return NORMALISED_MASK;
    const groups = body.split(new RegExp(SEP, "u")).length;
    // A tail after a separator, or one holding a separator, is part of a multi-group layout only.
    if ((separator || SEP_TEST.test(tail)) && groups < 2) return `${NORMALISED_MASK}${separator ?? ""}${tail}`;
    return NORMALISED_MASK;
  });
  return out;
}

/** Short, masked excerpt for a finding: the masked value, capped in length. */
export function maskedEvidence(value: string, dataClass?: GuardDataClass, maxLength = 48): string {
  const masked = maskForDataClass(value, dataClass);
  const chars = Array.from(masked);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}…` : masked;
}

/**
 * Evidence for non-sensitive pattern hits (injection phrases, SQL fragments):
 * the excerpt is kept but truncated and flattened, since what matters is
 * where it is and roughly what it says.
 */
export function excerptEvidence(text: string, span: GuardSpan, maxLength = 80): string {
  const raw = text.slice(span.start, span.end).replace(/\s+/g, " ").trim();
  const chars = Array.from(raw);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}…` : raw;
}

/** Merge overlapping or touching spans, sorted by start. */
export function mergeSpans(spans: readonly GuardSpan[]): GuardSpan[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: GuardSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * Replace each span in `text` with `replacement(originalSlice, span)`.
 * Overlapping spans are merged first; `replacement` is called right to left.
 * The result is joined once, so many spans stay linear in the text length.
 */
export function replaceSpans(
  text: string,
  spans: readonly GuardSpan[],
  replacement: (original: string, span: GuardSpan) => string
): string {
  const merged = mergeSpans(spans);
  if (merged.some((span) => span.start < 0 || span.end > text.length)) {
    // Out-of-range spans keep the right-to-left splice semantics exactly.
    let out = text;
    for (const span of merged.reverse()) out = out.slice(0, span.start) + replacement(text.slice(span.start, span.end), span) + out.slice(span.end);
    return out;
  }
  const replaced: string[] = new Array<string>(merged.length);
  for (let i = merged.length - 1; i >= 0; i -= 1) replaced[i] = replacement(text.slice(merged[i]!.start, merged[i]!.end), merged[i]!);
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i += 1) {
    parts.push(text.slice(cursor, merged[i]!.start), replaced[i]!);
    cursor = merged[i]!.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
