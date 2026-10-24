/**
 * Phase 15.6 — phone numbers as one subject, whichever way they are written.
 *
 * A phone number is read as its country code (when it is written with `+`
 * or `00` and starts with an assigned calling code), an optional trunk `0`,
 * and its national number. ITU calling codes are prefix-free, so a number
 * written with `+` has one country code at most.
 *
 * Uses, with different rules:
 *
 *   - Masking (`phoneMaskKeys`) may over-mask: a detected number is replaced
 *     in its international, national and trunk forms (the trunk table:
 *     `0`, Hungary `06`, Russia, Kazakhstan and Belarus `8`, none for Italy),
 *     and a number written without a country code is also tried as if its
 *     first one to three digits were one. The country code digits are never
 *     rewritten.
 *   - Capture finds international numbers the DLP pattern does not read
 *     (`scanInternationalPhones`); the runtime guard's scan is unchanged.
 *   - The data-subject lookup (`comparePhones`) must never over-match: two
 *     numbers are `exact` only when both carry the same country code and
 *     national number. When one side has no country code they can only be
 *     `national_only` (a possible match a delete needs confirmed). A shared
 *     suffix or a guessed country code never matches.
 */

/** Assigned ITU-T E.164 country calling codes (prefix-free). */
const CALLING_CODE_LIST = [
  "1", "7",
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
  "211", "212", "213", "216", "218",
  "220", "221", "222", "223", "224", "225", "226", "227", "228", "229",
  "230", "231", "232", "233", "234", "235", "236", "237", "238", "239",
  "240", "241", "242", "243", "244", "245", "246", "247", "248", "249",
  "250", "251", "252", "253", "254", "255", "256", "257", "258",
  "260", "261", "262", "263", "264", "265", "266", "267", "268", "269",
  "290", "291", "297", "298", "299",
  "350", "351", "352", "353", "354", "355", "356", "357", "358", "359",
  "370", "371", "372", "373", "374", "375", "376", "377", "378", "379",
  "380", "381", "382", "383", "385", "386", "387", "389",
  "420", "421", "423",
  "500", "501", "502", "503", "504", "505", "506", "507", "508", "509",
  "590", "591", "592", "593", "594", "595", "596", "597", "598", "599",
  "670", "672", "673", "674", "675", "676", "677", "678", "679",
  "680", "681", "682", "683", "685", "686", "687", "688", "689", "690", "691", "692",
  "800", "808", "850", "852", "853", "855", "856", "870", "878", "880", "881", "882", "883", "886", "888",
  "960", "961", "962", "963", "964", "965", "966", "967", "968",
  "970", "971", "972", "973", "974", "975", "976", "977", "979",
  "992", "993", "994", "995", "996", "998"
];

export const CALLING_CODES: ReadonlySet<string> = new Set(CALLING_CODE_LIST);

/** Fewest digits a national number is taken to have when a number written without a country code is tried with one. */
export const MIN_NATIONAL_DIGITS = 7;

/** The calling code `digits` starts with, or null. */
export function callingCodeOf(digits: string): string | null {
  for (let length = 1; length <= 3 && length < digits.length; length += 1) {
    const code = digits.slice(0, length);
    if (CALLING_CODES.has(code)) return code;
  }
  return null;
}

/**
 * Trunk prefixes: what a country's numbers start with when written without
 * the country code. `0` unless listed. Hungary writes `06`; Russia,
 * Kazakhstan (both `+7`) and Belarus write `8`. Italy has none: its leading
 * `0` is part of the number and stays after `+39`.
 */
const TRUNK_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "36": ["06"],
  "7": ["8"],
  "375": ["8"],
  "39": []
};

/** The trunk prefixes of a country calling code (`0` unless the table says otherwise). */
export function trunkPrefixesFor(cc: string): readonly string[] {
  return TRUNK_PREFIXES[cc] ?? ["0"];
}

/** How sure a lookup match is: the same full number with its country code on both sides, or only the national digits agree. */
export type PhoneCertainty = "exact" | "national_only";

export interface ParsedPhone {
  /** Every digit as written, an international `00` prefix removed. */
  digits: string;
  /** Written with `+` or `00`: the leading digits are a country code. */
  explicit: boolean;
  /** The country code, when explicit and assigned. */
  cc: string | null;
  /** The national number: without the country code and without a trunk prefix. */
  national: string;
}

/** The national number after a country code: a `(0)` trunk written after it is dropped, except where the 0 belongs to the number (Italy). */
function nationalAfterCode(cc: string, rest: string): string {
  if (trunkPrefixesFor(cc).length === 0) return rest;
  return rest.startsWith("0") && rest.length > 1 ? rest.slice(1) : rest;
}

/**
 * Reads a written phone number. `explicitHint` says the text before it holds
 * the `+` (a match that starts after it).
 */
export function parsePhone(written: string, explicitHint = false): ParsedPhone | null {
  const trimmed = written.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let explicit = explicitHint || trimmed.startsWith("+");
  if (!explicit && digits.startsWith("00") && digits.length > 6) {
    explicit = true;
    digits = digits.slice(2);
  }
  if (explicit) {
    const cc = callingCodeOf(digits);
    if (cc) return { digits, explicit, cc, national: nationalAfterCode(cc, digits.slice(cc.length)) };
    return { digits, explicit, cc: null, national: digits };
  }
  const national = digits.startsWith("0") && digits.length > 1 ? digits.slice(1) : digits;
  return { digits, explicit: false, cc: null, national };
}

/** A number the admin typed without its country code, read as a number of the country `cc` (a country chosen in the lookup). */
export function phoneInCountry(written: string, cc: string): ParsedPhone | null {
  const parsed = parsePhone(written);
  if (!parsed || !CALLING_CODES.has(cc)) return null;
  if (parsed.explicit) return parsed.cc === cc ? parsed : null;
  const readings = plainReadings(parsed.digits, cc);
  // The national number: the trunk prefix removed when it is written.
  const national = readings.length > 1 ? readings[1]! : readings[0]!;
  return { digits: cc + national, explicit: true, cc, national };
}

/** A number written without a country code, read as a number of `cc`: as written, and with the country's trunk prefix removed. */
function plainReadings(digits: string, cc: string): string[] {
  const out = [digits];
  for (const trunk of trunkPrefixesFor(cc)) if (digits.startsWith(trunk) && digits.length > trunk.length) out.push(digits.slice(trunk.length));
  return out;
}

/** Whether `full` is `cc` followed by `national` (optionally with a `(0)` trunk between). */
function internationalForm(full: string, cc: string, national: string): boolean {
  return full === cc + national || (trunkPrefixesFor(cc).length > 0 && full === `${cc}0${national}`);
}

/** `p` written with a known country code, `q` written without one: could `q` be the same number? */
function explicitVersusPlain(p: ParsedPhone, q: ParsedPhone): boolean {
  // q is p's national form (with or without its trunk prefix), or p's full number without the `+`.
  return plainReadings(q.digits, p.cc!).includes(p.national) || internationalForm(q.digits, p.cc!, p.national);
}

/**
 * The data-subject lookup's comparison. It must never over-match, because
 * what it finds can be deleted:
 *
 *   - `exact`: both numbers carry the same country code and national number.
 *   - `national_only`: one side (or both) has no country code, and its
 *     digits are the other's national form. That cannot prove it is the same
 *     person (a US `(207) 946-0958` and a UK `020 7946 0958` read alike), so
 *     the lookup lists it as a possible match and never deletes it without
 *     an explicit confirmation.
 *   - null otherwise: never a shared suffix, never another country code, and
 *     never a guessed country code in front of a number written without one.
 */
export function comparePhones(a: ParsedPhone, b: ParsedPhone): PhoneCertainty | null {
  const aKnown = a.explicit && a.cc !== null;
  const bKnown = b.explicit && b.cc !== null;
  if (aKnown && bKnown) return a.cc === b.cc && a.national === b.national ? "exact" : null;
  if (aKnown && !b.explicit) return explicitVersusPlain(a, b) ? "national_only" : null;
  if (bKnown && !a.explicit) return explicitVersusPlain(b, a) ? "national_only" : null;
  // A `+` with an unassigned code on either side: only the very same digits.
  if (a.explicit && b.explicit) return a.digits === b.digits ? "exact" : null;
  if (a.explicit || b.explicit) return a.digits === b.digits ? "national_only" : null;
  // Neither has a country code: the same digits, or a trunk 0 apart.
  return a.digits === b.digits || a.national === b.national ? "national_only" : null;
}

/** Whether the lookup counts two numbers as the same at all (`comparePhones` not null). */
export function samePhone(a: ParsedPhone, b: ParsedPhone): boolean {
  return comparePhones(a, b) !== null;
}

/** A run of digits read as a number without a country code, and, when it starts with an assigned calling code, as one with it. */
function nationalReadings(digits: string): string[] {
  const out = new Set<string>();
  const strip = (text: string) => (text.startsWith("0") && text.length > 1 ? text.slice(1) : text);
  out.add(digits);
  out.add(strip(digits));
  const body = digits.startsWith("00") && digits.length > 6 ? digits.slice(2) : digits;
  const cc = body.startsWith("0") ? null : callingCodeOf(body);
  if (cc && body.length - cc.length >= MIN_NATIONAL_DIGITS) {
    out.add(body.slice(cc.length));
    out.add(strip(body.slice(cc.length)));
  }
  return [...out];
}

/** How sure a masking key is: from a number written with its country code, as written, or a guessed country code. */
export type PhoneKeyStrength = 0 | 1 | 2;

/**
 * Masking: the digit strings a detected phone number is replaced as, each
 * with the national number whose digits the surrogate replaces. The national
 * number is always the key's tail, so everything in front of it (a country
 * code, a trunk `0`) stays as written. When two keys collide the stronger
 * one wins (`strength`).
 */
export function phoneMaskKeys(phone: ParsedPhone): Array<{ key: string; national: string; strength: PhoneKeyStrength }> {
  const out = new Map<string, { national: string; strength: PhoneKeyStrength }>();
  const put = (key: string, national: string, strength: PhoneKeyStrength) => {
    if (national.length === 0 || !key.endsWith(national)) return;
    const previous = out.get(key);
    if (!previous || strength > previous.strength) out.set(key, { national, strength });
  };
  const add = (national: string, cc: string | null, strength: PhoneKeyStrength) => {
    put(national, national, strength);
    for (const trunk of cc ? trunkPrefixesFor(cc) : ["0"]) put(trunk + national, national, strength);
    if (cc) {
      put(cc + national, national, strength);
      if (trunkPrefixesFor(cc).length > 0) put(`${cc}0${national}`, national, strength);
    }
  };
  if (phone.cc) {
    add(phone.national, phone.cc, 2);
  } else {
    put(phone.digits, phone.national, 1);
    add(phone.national, null, 1);
    // Written without a country code: when its first digits are an assigned calling code, it may have been written with one.
    const body = phone.digits;
    const cc = body.startsWith("0") ? null : callingCodeOf(body);
    if (cc && body.length - cc.length >= MIN_NATIONAL_DIGITS) {
      add(nationalAfterCode(cc, body.slice(cc.length)), cc, 0);
    }
  }
  return [...out].map(([key, value]) => ({ key, ...value }));
}

/** The readings of a run of digits that masking looks up as keys, longest first. */
export function phoneMaskCandidates(digits: string): string[] {
  return nationalReadings(digits).sort((a, b) => b.length - a.length);
}

/**
 * A run that may be an international phone number: `+` or `00`, then digits
 * with common separators between them (spaces, dots, dashes, brackets, as in
 * `+1 (415) 555-1234` and `+44 (0) 20 7946 0958`). Never after a letter, a
 * digit, `_` or another `+`.
 */
const INTERNATIONAL_RUN = /(?<![\p{L}\p{N}_+])(?:\+|(?<!\.)00)[ \t.-]?\(?\d(?:[ \t().-]{0,3}\d)*/gu;
/** Digits after the country code an international phone number has (7–14, one more for a `(0)` trunk). */
const INTERNATIONAL_REST_MIN = 7;
const INTERNATIONAL_REST_MAX = 14;

/**
 * Production capture only (never the runtime guard's DLP scan): international
 * phone numbers the DLP phone pattern does not read, such as E.164 without
 * separators (`+14155551234`), French pairs (`+33 1 23 45 67 89`), `(0)`
 * trunk notation, and the Australian, Indian, Japanese, Irish, Hungarian and
 * Russian layouts. A run counts when it starts with `+` or `00`, an assigned
 * calling code follows, then 7 to 14 digits that do not start with 0 (unless
 * written `(0)`). The longest such run ending on a whole group is taken.
 * Masking may over-mask, so this errs towards finding a number.
 */
export function scanInternationalPhones(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const run of text.matchAll(INTERNATIONAL_RUN)) {
    const base = run.index ?? 0;
    const written = run[0];
    const prefixLength = written.startsWith("+") ? 1 : 2;
    const groups = [...written.slice(prefixLength).matchAll(/\d+/g)].map((group) => ({ end: prefixLength + (group.index ?? 0) + group[0].length, digits: group[0] }));
    const trunkWritten = /\(0\)/.test(written);
    let digits = "";
    let best = -1;
    for (const group of groups) {
      digits += group.digits;
      const cc = callingCodeOf(digits);
      if (!cc) continue;
      const restWritten = digits.slice(cc.length);
      const rest = trunkWritten && restWritten.startsWith("0") ? restWritten.slice(1) : restWritten;
      if (rest.length > INTERNATIONAL_REST_MAX) break;
      // Only Italy-style numbers keep a leading 0 after the country code.
      const leadingZeroOk = trunkPrefixesFor(cc).length === 0;
      if (rest.length >= INTERNATIONAL_REST_MIN && (leadingZeroOk || !rest.startsWith("0"))) best = group.end;
    }
    if (best > 0) out.push({ start: base, end: base + best });
  }
  return out;
}
