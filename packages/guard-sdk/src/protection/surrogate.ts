import { createHmac } from "node:crypto";
import { luhnCheckDigit, luhnValid } from "../detectors/dlp";
import type { GuardDataClass } from "../types";
import { GuardProtectionError } from "../types";
import type { KeyResolver, ProtectionProvider } from "./types";

/**
 * Phase 15.6 — surrogates: deterministic, keyed, format-preserving stand-ins
 * for sensitive values. The same value under the same key always gets the
 * same surrogate (joins, lookups and recorded model calls keep matching), the
 * surrogate cannot be turned back into the value without trying candidates
 * under the key, and it keeps the shape of the value so the DLP scan still
 * finds it as the same class:
 *
 *   - email: `u-<12 hex>@surrogate.invalid` (the `.invalid` top-level domain never resolves)
 *   - payment card: same length and separators, Luhn-valid, in the 400000 test range
 *   - IBAN: same country, length and separators, valid mod-97 check digits
 *   - US SSN: same separators, structurally valid, area 734–749 (never assigned before 2011)
 *   - phone: the same number of digits, separators and leading `+` kept
 *   - UK National Insurance number: same spacing, prefix `ZY`
 *   - credentials, private keys and JSON Web Tokens: fully redacted, no hash
 *   - any other class (a profile dictionary's): `[<class>:<12 hex>]`, which the
 *     DLP scan no longer finds
 *
 * This is pseudonymisation, not anonymisation: whoever holds the key can
 * test a guessed value. Values are normalised before keying (an email's case,
 * a number's separators), so two spellings of one value share a surrogate.
 */

export const SURROGATE_PROVIDER_ID = "surrogate";
export const SURROGATE_EMAIL_DOMAIN = "surrogate.invalid";
/** The issuer prefix of every payment-card surrogate (a test range). */
export const SURROGATE_CARD_PREFIX = "400000";
/** UK National Insurance prefix used by surrogates. */
export const SURROGATE_NINO_PREFIX = "ZY";
/** First and last SSN area number surrogates use. */
export const SURROGATE_SSN_AREA_MIN = 734;
export const SURROGATE_SSN_AREA_MAX = 749;

const REDACTED_CLASSES = new Set<string>(["credential", "private_key", "jwt"]);
const NINO_SHAPE = /^([A-Z]{2})(\s?)(\d{2})(\s?)(\d{2})(\s?)(\d{2})(\s?)([A-D])$/i;

/** Classes whose surrogates the built-in DLP scan still detects as the same class. */
export function surrogateDetectable(dataClass: GuardDataClass, value?: string): boolean {
  if (["email", "card_number", "iban", "us_ssn", "phone"].includes(dataClass)) return true;
  if (dataClass === "national_id") return value === undefined || NINO_SHAPE.test(value.trim());
  return false;
}

/** Classes that are removed outright rather than replaced by a keyed stand-in. */
export function surrogateRedacts(dataClass: GuardDataClass): boolean {
  return REDACTED_CLASSES.has(dataClass);
}

/** The form of a value that is keyed: lower-case email, digits only for numbers, upper-case letters and digits for an IBAN or NI number. */
export function normaliseForSurrogate(value: string, dataClass: GuardDataClass): string {
  const trimmed = value.trim();
  switch (dataClass) {
    case "email":
      return trimmed.toLowerCase();
    case "card_number":
    case "phone":
    case "us_ssn":
      return trimmed.replace(/\D/g, "");
    case "iban":
    case "national_id":
      return trimmed.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    default:
      return trimmed.toLowerCase();
  }
}

/** A keyed byte stream for one value: HMAC-SHA-256 blocks under the key, counter-extended. */
class KeyedStream {
  private buffer: Buffer = Buffer.alloc(0);
  private offset = 0;
  private counter = 0;

  constructor(
    private readonly key: Uint8Array,
    private readonly seed: string
  ) {}

  private refill(): void {
    this.buffer = createHmac("sha256", this.key).update(`${this.seed}\u0000${this.counter}`).digest();
    this.counter += 1;
    this.offset = 0;
  }

  byte(): number {
    if (this.offset >= this.buffer.length) this.refill();
    return this.buffer[this.offset++]!;
  }

  /** A uniform value in [0, n) (n up to 2^32) by rejection sampling over 32-bit draws. */
  below(n: number): number {
    const range = 0x1_0000_0000;
    const limit = range - (range % n);
    for (;;) {
      const draw = this.byte() * 0x100_0000 + (this.byte() << 16) + (this.byte() << 8) + this.byte();
      if (draw < limit) return draw % n;
    }
  }

  digit(): string {
    return String(this.below(10));
  }

  letter(): string {
    return String.fromCharCode(65 + this.below(26));
  }

  hex(length: number): string {
    let out = "";
    while (out.length < length) out += this.byte().toString(16).padStart(2, "0");
    return out.slice(0, length);
  }
}

/** Put `digits` (or letters) back where the original's alphanumerics were, keeping every separator. */
function reshape(original: string, replacement: string, isSlot: (c: string) => boolean): string {
  let index = 0;
  let out = "";
  for (const c of original) {
    if (isSlot(c) && index < replacement.length) {
      out += replacement[index]!;
      index += 1;
    } else {
      out += c;
    }
  }
  return out;
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isAlnum = (c: string) => /[A-Za-z0-9]/.test(c);

function allSame(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

/**
 * The surrogate keeps the characters the guard `mask` action leaves visible
 * (`maskForDataClass`: the last four of a card, SSN or national id, the last
 * two of a phone, the country and last four of an IBAN). A masked output
 * then reads the same whether the run saw the real value or its surrogate,
 * so a replay of a captured run compares equal; nothing beyond what the mask
 * action already shows is kept.
 */
export const SURROGATE_VISIBLE_TAIL: Partial<Record<string, number>> = { card_number: 4, us_ssn: 4, national_id: 4, phone: 2, iban: 4 };

/** `surrogate` with the last `count` characters of `value` (same length; otherwise unchanged). */
function keepTail(surrogate: string, value: string, count: number): string {
  if (surrogate.length !== value.length || count <= 0) return surrogate;
  return surrogate.slice(0, surrogate.length - count) + value.slice(value.length - count);
}

function cardSurrogate(value: string, stream: KeyedStream): string {
  const length = value.replace(/\D/g, "").length;
  const bodyLength = Math.max(SURROGATE_CARD_PREFIX.length + 1, length) - 1;
  let body = SURROGATE_CARD_PREFIX;
  while (body.length < bodyLength) body += stream.digit();
  const shaped = keepTail(reshape(value, body + luhnCheckDigit(body), isDigit), value, SURROGATE_VISIBLE_TAIL.card_number!);
  // The kept tail holds the check digit: repair the checksum through the last free digit before it.
  const tailStart = shaped.length - SURROGATE_VISIBLE_TAIL.card_number!;
  let free = -1;
  for (let i = tailStart - 1; i >= 0; i -= 1) {
    if (isDigit(shaped[i]!)) {
      free = i;
      break;
    }
  }
  const prefixDigits = shaped.slice(0, Math.max(0, free)).replace(/\D/g, "").length;
  if (free < 0 || prefixDigits < SURROGATE_CARD_PREFIX.length) return shaped;
  for (let d = 0; d <= 9; d += 1) {
    const candidate = shaped.slice(0, free) + String(d) + shaped.slice(free + 1);
    if (luhnValid(candidate.replace(/\D/g, ""))) return candidate;
  }
  return shaped;
}

function mod97(text: string): number {
  let remainder = 0;
  for (const c of text) {
    const v = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

function ibanSurrogate(value: string, stream: KeyedStream): string {
  const clean = value.replace(/[\s-]/g, "").toUpperCase();
  const country = clean.slice(0, 2);
  // The visible tail (last four characters of the value as written) stays; count the letters and digits in it.
  const kept = value.slice(-SURROGATE_VISIBLE_TAIL.iban!).replace(/[\s-]/g, "").length;
  const original = clean.slice(4);
  const bban = Array.from(original)
    .map((c, index) => (index >= original.length - kept ? c : isDigit(c) ? stream.digit() : stream.letter()))
    .join("");
  const check = String(98 - mod97(`${bban}${country}00`)).padStart(2, "0");
  const surrogate = `${country}${check}${bban}`;
  // Letters keep their case position: the original's lower-case letters were upper-cased for the checksum only.
  return reshape(value, surrogate, isAlnum);
}

function ssnSurrogate(value: string, stream: KeyedStream): string {
  const area = SURROGATE_SSN_AREA_MIN + stream.below(SURROGATE_SSN_AREA_MAX - SURROGATE_SSN_AREA_MIN + 1);
  const group = 1 + stream.below(99);
  const serial = 1 + stream.below(9999);
  const originalSerial = value.replace(/\D/g, "").slice(-4);
  const keptSerial = /^\d{4}$/.test(originalSerial) && originalSerial !== "0000" ? originalSerial : String(serial).padStart(4, "0");
  const digits = `${area}${String(group).padStart(2, "0")}${keptSerial}`;
  return /^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(value.trim()) ? reshape(value, digits, isDigit) : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function phoneSurrogate(value: string, stream: KeyedStream): string {
  const length = value.replace(/\D/g, "").length;
  for (;;) {
    let digits = "";
    for (let i = 0; i < length; i += 1) digits += stream.digit();
    const shaped = keepTail(reshape(value, digits, isDigit), value, SURROGATE_VISIBLE_TAIL.phone!);
    const all = shaped.replace(/\D/g, "");
    // Never all one digit (the phone scan skips those), never a checksum-valid card number.
    if (allSame(all)) continue;
    if (all.length >= 13 && luhnValid(all)) continue;
    return shaped;
  }
}

function ninoSurrogate(value: string, stream: KeyedStream): string | null {
  const match = NINO_SHAPE.exec(value.trim());
  if (!match) return null;
  let digits = "";
  for (let i = 0; i < 6; i += 1) digits += stream.digit();
  const suffix = "ABCD"[stream.below(4)]!;
  const surrogate = `${SURROGATE_NINO_PREFIX}${match[2]}${digits.slice(0, 2)}${match[4]}${digits.slice(2, 4)}${match[6]}${digits.slice(4, 6)}${match[8]}${suffix}`;
  return keepTail(surrogate, value.trim(), SURROGATE_VISIBLE_TAIL.national_id!);
}

function classTag(dataClass: string): string {
  return dataClass.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || "data";
}

/**
 * The surrogate of `value` as data class `dataClass` under `key` (at least 16
 * bytes). Synchronous; the provider below resolves the key first.
 */
export function surrogateFor(value: string, dataClass: GuardDataClass, key: Uint8Array): string {
  if (key.length < 16) throw new GuardProtectionError(SURROGATE_PROVIDER_ID, "The surrogate key is shorter than 16 bytes");
  if (REDACTED_CLASSES.has(dataClass)) return `[redacted:${dataClass}]`;
  const stream = new KeyedStream(key, `${dataClass}\u0000${normaliseForSurrogate(value, dataClass)}`);
  switch (dataClass) {
    case "email":
      return `u-${stream.hex(12)}@${SURROGATE_EMAIL_DOMAIN}`;
    case "card_number":
      return cardSurrogate(value, stream);
    case "iban":
      return /^[A-Z]{2}\d{2}[A-Z0-9]{4,}$/i.test(value.replace(/[\s-]/g, "")) ? ibanSurrogate(value, stream) : `[iban:${stream.hex(12)}]`;
    case "us_ssn":
      return ssnSurrogate(value, stream);
    case "phone":
      return phoneSurrogate(value, stream);
    case "national_id":
      return ninoSurrogate(value, stream) ?? `[national_id:${stream.hex(12)}]`;
    default:
      return `[${classTag(dataClass)}:${stream.hex(12)}]`;
  }
}

export interface SurrogateProviderOptions {
  keys: KeyResolver;
  defaultKeyId?: string;
}

/** Protection provider: keyed, deterministic, format-preserving surrogates (see `surrogateFor`). Irreversible. */
export function createSurrogateProvider(options: SurrogateProviderOptions): ProtectionProvider {
  return {
    id: SURROGATE_PROVIDER_ID,
    description: "Keyed, format-preserving surrogate that the DLP scan still detects as the same class (pseudonymisation).",
    deterministic: true,
    reversible: false,
    dataClasses: "*",
    async protect(value, context) {
      const keyId = context.keyId ?? (typeof context.options?.keyId === "string" ? context.options.keyId : undefined) ?? options.defaultKeyId;
      if (!keyId) throw new GuardProtectionError(SURROGATE_PROVIDER_ID, "No key id configured for surrogates");
      const key = await options.keys(keyId);
      if (!key || key.length < 16) throw new GuardProtectionError(SURROGATE_PROVIDER_ID, `Key '${keyId}' is missing or shorter than 16 bytes`);
      return surrogateFor(value, context.dataClass, key);
    }
  };
}
