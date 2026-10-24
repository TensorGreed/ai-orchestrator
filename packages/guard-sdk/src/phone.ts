/**
 * Phase 15.6 — phone numbers as one subject, whichever way they are written.
 *
 * A phone number is read as its country code (when it is written with `+`
 * or `00` and starts with an assigned calling code), an optional trunk `0`,
 * and its national number. ITU calling codes are prefix-free, so a number
 * written with `+` has one country code at most.
 *
 * Two uses, with different rules:
 *
 *   - Masking (`phoneMaskKeys`) may over-mask: a detected number is replaced
 *     in its international, national and trunk forms, and a number written
 *     without a country code is also tried as if its first one to three
 *     digits were one. The country code digits are never rewritten.
 *   - The data-subject lookup (`samePhone`) must never over-match: two
 *     numbers are the same only when their full numbers are equal, or one is
 *     the other's exact national form (country code and an optional trunk `0`
 *     removed). A shared suffix is never enough.
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

export interface ParsedPhone {
  /** Every digit as written, an international `00` prefix removed. */
  digits: string;
  /** Written with `+` or `00`: the leading digits are a country code. */
  explicit: boolean;
  /** The country code, when explicit and assigned. */
  cc: string | null;
  /** The national number: without the country code and without one trunk `0`. */
  national: string;
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
    if (cc) {
      const rest = digits.slice(cc.length);
      const national = rest.startsWith("0") && rest.length > 1 ? rest.slice(1) : rest;
      return { digits, explicit, cc, national };
    }
    return { digits, explicit, cc: null, national: digits };
  }
  const national = digits.startsWith("0") && digits.length > 1 ? digits.slice(1) : digits;
  return { digits, explicit: false, cc: null, national };
}

/** Whether `full` is `cc` followed by `national` (optionally with a trunk `0` between). */
function internationalForm(full: string, cc: string, national: string): boolean {
  return full === cc + national || full === `${cc}0${national}`;
}

/** `p` written with a known country code, `q` written without one: is `q` the same number? */
function explicitVersusPlain(p: ParsedPhone, q: ParsedPhone): boolean {
  // q is p's national form (with or without the trunk 0), or p's full number without the `+`.
  return q.national === p.national || internationalForm(q.digits, p.cc!, p.national);
}

/**
 * Strict equality for the data-subject lookup: the full numbers are equal,
 * or one is the other's exact national form. Never a shared suffix, never a
 * different country code.
 */
export function samePhone(a: ParsedPhone, b: ParsedPhone): boolean {
  const aKnown = a.explicit && a.cc !== null;
  const bKnown = b.explicit && b.cc !== null;
  if (aKnown && bKnown) return a.cc === b.cc && a.national === b.national;
  if (aKnown && !b.explicit) return explicitVersusPlain(a, b);
  if (bKnown && !a.explicit) return explicitVersusPlain(b, a);
  // A `+` with an unassigned code on either side: only the very same digits.
  if (a.explicit || b.explicit) return a.digits === b.digits;
  // Neither has a country code: equal, a trunk 0 apart, or one is the other with an assigned code in front.
  if (a.digits === b.digits || a.national === b.national) return true;
  const withCode = (long: ParsedPhone, short: ParsedPhone) => {
    const cc = callingCodeOf(long.digits);
    return cc !== null && short.national.length >= MIN_NATIONAL_DIGITS && internationalForm(long.digits, cc, short.national);
  };
  return withCode(a, b) || withCode(b, a);
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
    put(`0${national}`, national, strength);
    if (cc) {
      put(cc + national, national, strength);
      put(`${cc}0${national}`, national, strength);
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
      const rest = body.slice(cc.length);
      add(rest.startsWith("0") ? rest.slice(1) : rest, cc, 0);
    }
  }
  return [...out].map(([key, value]) => ({ key, ...value }));
}

/** The readings of a run of digits that masking looks up as keys, longest first. */
export function phoneMaskCandidates(digits: string): string[] {
  return nationalReadings(digits).sort((a, b) => b.length - a.length);
}
