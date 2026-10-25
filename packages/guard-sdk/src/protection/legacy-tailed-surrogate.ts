import { createHmac } from "node:crypto";
import { luhnCheckDigit, luhnValid } from "../detectors/dlp";
import { parsePhone } from "../phone";
import { GuardProtectionError } from "../types";

/**
 * LOOKUP ONLY. A frozen copy of the "visible tail" surrogates that captures
 * wrote before surrogates stopped keeping any real character (the guard mask's
 * visible characters: the last four of a card, SSN, NI number or IBAN, the
 * last two of a phone). Captures stored before that change still hold these
 * forms, and the raw value is gone, so the data-subject lookup (find and the
 * delete re-check) must keep building them to find those rows.
 *
 * Never use this for masking: new captures never produce a tailed surrogate.
 * The derivation must stay byte-identical to what those captures wrote; it is
 * pinned by hard-coded fixtures in `legacy-tailed-surrogate.test.ts`. Do not
 * change it, and do not share its helpers or constants with `surrogate.ts`
 * (a change there must not move these forms).
 */

const PROVIDER_ID = "surrogate";
const CARD_PREFIX = "4";
const NINO_PREFIX = "ZY";
const SSN_AREA_MIN = 1;
const SSN_AREA_MAX = 899;

const LEGACY_TAIL: Readonly<Record<string, number>> = { card_number: 4, us_ssn: 4, national_id: 4, phone: 2, iban: 4 };
const NINO_SHAPE = /^([A-Z]{2})(\s?)(\d{2})(\s?)(\d{2})(\s?)(\d{2})(\s?)([A-D])$/i;

/** Classes that had a tailed surrogate form. */
export const LEGACY_TAILED_SURROGATE_CLASSES: readonly string[] = Object.keys(LEGACY_TAIL);

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
}

function phoneKey(value: string): string {
  return parsePhone(value)?.national ?? "";
}

function normaliseForSurrogate(value: string, dataClass: string): string {
  const trimmed = value.trim();
  switch (dataClass) {
    case "card_number":
    case "us_ssn":
      return trimmed.replace(/\D/g, "");
    case "phone":
      return phoneKey(trimmed);
    case "iban":
    case "national_id":
      return trimmed.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    default:
      return trimmed.toLowerCase();
  }
}

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

function keepTail(surrogate: string, value: string, count: number): string {
  if (surrogate.length !== value.length || count <= 0) return surrogate;
  return surrogate.slice(0, surrogate.length - count) + value.slice(value.length - count);
}

function cardSurrogate(value: string, stream: KeyedStream): string {
  const length = value.replace(/\D/g, "").length;
  const bodyLength = Math.max(CARD_PREFIX.length + 1, length) - 1;
  let body = CARD_PREFIX;
  while (body.length < bodyLength) body += stream.digit();
  const full = reshape(value, body + luhnCheckDigit(body), isDigit);
  const shaped = keepTail(full, value, LEGACY_TAIL.card_number!);
  const tailStart = shaped.length - LEGACY_TAIL.card_number!;
  let free = -1;
  for (let i = tailStart - 1; i >= 0; i -= 1) {
    if (isDigit(shaped[i]!)) {
      free = i;
      break;
    }
  }
  const prefixDigits = shaped.slice(0, Math.max(0, free)).replace(/\D/g, "").length;
  if (free < 0 || prefixDigits < CARD_PREFIX.length) return shaped;
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
  const kept = LEGACY_TAIL.iban!;
  const original = clean.slice(4);
  const bban = Array.from(original)
    .map((c, index) => (index >= original.length - kept ? c : isDigit(c) ? stream.digit() : stream.letter()))
    .join("");
  const check = String(98 - mod97(`${bban}${country}00`)).padStart(2, "0");
  return reshape(value, `${country}${check}${bban}`, isAlnum);
}

function ssnSurrogate(value: string, stream: KeyedStream): string {
  let area = SSN_AREA_MIN + stream.below(SSN_AREA_MAX - SSN_AREA_MIN + 1);
  while (area === 666) area = SSN_AREA_MIN + stream.below(SSN_AREA_MAX - SSN_AREA_MIN + 1);
  const group = 1 + stream.below(99);
  const serial = 1 + stream.below(9999);
  const originalSerial = value.replace(/\D/g, "").slice(-4);
  const keptSerial = /^\d{4}$/.test(originalSerial) && originalSerial !== "0000" ? originalSerial : String(serial).padStart(4, "0");
  const digits = `${String(area).padStart(3, "0")}${String(group).padStart(2, "0")}${keptSerial}`;
  return /^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(value.trim()) ? reshape(value, digits, isDigit) : `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * LOOKUP ONLY. The tailed surrogate digits for a phone's keyed digits (the
 * national number, or a plain copy's own digits): drawn digits with the last
 * two kept, as captures wrote them before tails were removed.
 */
export function legacyTailedPhoneSurrogateDigits(keyDigits: string, key: Uint8Array): string {
  if (key.length < 16) throw new GuardProtectionError(PROVIDER_ID, "The surrogate key is shorter than 16 bytes");
  const stream = new KeyedStream(key, `phone\u0000${keyDigits}`);
  const tail = Math.min(LEGACY_TAIL.phone!, keyDigits.length);
  for (;;) {
    let digits = "";
    for (let i = 0; i < keyDigits.length - tail; i += 1) digits += stream.digit();
    digits += keyDigits.slice(keyDigits.length - tail);
    if (keyDigits.length > 1 && keyDigits.length > tail && (allSame(digits) || digits.startsWith("0"))) continue;
    return digits;
  }
}

function phoneSurrogate(value: string, key: Uint8Array): string {
  const all = value.replace(/\D/g, "");
  const keyed = phoneKey(value);
  const replaced = all.slice(0, all.length - keyed.length) + legacyTailedPhoneSurrogateDigits(keyed, key);
  return reshape(value, replaced, isDigit);
}

function ninoSurrogate(value: string, stream: KeyedStream): string | null {
  const match = NINO_SHAPE.exec(value.trim());
  if (!match) return null;
  let digits = "";
  for (let i = 0; i < 6; i += 1) digits += stream.digit();
  const suffix = "ABCD"[stream.below(4)]!;
  const surrogate = `${NINO_PREFIX}${match[2]}${digits.slice(0, 2)}${match[4]}${digits.slice(2, 4)}${match[6]}${digits.slice(4, 6)}${match[8]}${suffix}`;
  return keepTail(surrogate, value.trim(), LEGACY_TAIL.national_id!);
}

/**
 * LOOKUP ONLY. The tailed surrogate a capture wrote for `value` as
 * `dataClass` before tails were removed, or null when the class never had a
 * tailed form (or the value had no format-preserving surrogate: those were
 * the same with or without the tail, and `surrogateFor` still builds them).
 */
export function legacyTailedSurrogate(value: string, dataClass: string, key: Uint8Array): string | null {
  if (key.length < 16) throw new GuardProtectionError(PROVIDER_ID, "The surrogate key is shorter than 16 bytes");
  if (!(dataClass in LEGACY_TAIL)) return null;
  const stream = new KeyedStream(key, `${dataClass}\u0000${normaliseForSurrogate(value, dataClass)}`);
  switch (dataClass) {
    case "card_number":
      return cardSurrogate(value, stream);
    case "iban":
      return /^[A-Z]{2}\d{2}[A-Z0-9]{4,}$/i.test(value.replace(/[\s-]/g, "")) ? ibanSurrogate(value, stream) : null;
    case "us_ssn":
      return ssnSurrogate(value, stream);
    case "phone":
      return phoneSurrogate(value, key);
    case "national_id":
      return ninoSurrogate(value, stream);
    default:
      return null;
  }
}
