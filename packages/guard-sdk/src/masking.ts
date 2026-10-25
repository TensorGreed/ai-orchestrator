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

const MASK_EDGE_BEFORE = /^[(\[{"'<]+/;
const MASK_EDGE_AFTER = /[)\]}"'>,.;:!?]+$/;
const REDACTION_PLACEHOLDER = /\[redacted:([^\]\s]+)\]/gi;

/**
 * Normalises masked spans so two texts that differ only in what was masked
 * compare equal: every word holding the mask character (the masked value
 * together with the characters the mask left visible and the separators it
 * kept, such as `j•••@e•••.com` or `••••-••••-••••-1111`) becomes a single
 * mask character, with surrounding punctuation kept, and a redaction
 * placeholder (`[REDACTED:email]`) is lower-cased. Text without a masked span
 * is returned unchanged.
 */
export function normaliseMaskedSpans(text: string): string {
  const hasMask = text.includes(MASK_CHAR);
  const hasPlaceholder = /\[redacted:/i.test(text);
  if (!hasMask && !hasPlaceholder) return text;
  let out = text;
  if (hasPlaceholder) out = out.replace(REDACTION_PLACEHOLDER, (_all, dataClass: string) => `[redacted:${dataClass.toLowerCase()}]`);
  if (!hasMask) return out;
  // Words and the whitespace between them. A spaced value masks to several words
  // (`•••• •••• •••• 1111`): neighbouring words that hold the mask character join the span, and so
  // does one short digit-only word that closes a run of fully masked words (the visible tail).
  const parts = out.split(/(\s+)/);
  const wordCore = (word: string) => {
    const before = MASK_EDGE_BEFORE.exec(word)?.[0] ?? "";
    const rest = word.slice(before.length);
    const after = MASK_EDGE_AFTER.exec(rest)?.[0] ?? "";
    return { before, core: rest.slice(0, rest.length - after.length), after };
  };
  const masked = (word: string) => /^[\d•-]*•[\d•-]*$/.test(wordCore(word).core);
  const result: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const word = parts[i]!;
    if (!wordCore(word).core.includes(MASK_CHAR)) {
      result.push(word, parts[i + 1] ?? "");
      continue;
    }
    let before = wordCore(word).before;
    while (result.length >= 2 && result[result.length - 1] !== "" && masked(result[result.length - 2]!) && wordCore(result[result.length - 2]!).after === "") {
      before = wordCore(result[result.length - 2]!).before;
      result.length -= 2;
    }
    let end = i;
    let last = wordCore(word);
    while (last.after === "" && end + 2 < parts.length && masked(parts[end + 2]!)) {
      end += 2;
      last = wordCore(parts[end]!);
    }
    if (last.after === "" && /^•+$/.test(last.core) && end + 2 < parts.length && /^\d{1,4}$/.test(wordCore(parts[end + 2]!).core)) {
      end += 2;
      last = wordCore(parts[end]!);
    }
    result.push(`${before}${MASK_CHAR}${last.after}`, parts[end + 1] ?? "");
    i = end;
  }
  return result.join("");
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

/** Replace each span in `text` with `replacement(originalSlice, span)`, right to left so offsets stay valid. */
export function replaceSpans(
  text: string,
  spans: readonly GuardSpan[],
  replacement: (original: string, span: GuardSpan) => string
): string {
  let out = text;
  for (const span of mergeSpans(spans).reverse()) {
    out = out.slice(0, span.start) + replacement(text.slice(span.start, span.end), span) + out.slice(span.end);
  }
  return out;
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
