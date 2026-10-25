import { describe, expect, it } from "vitest";
import { LEGACY_TAILED_SURROGATE_CLASSES, legacyTailedPhoneSurrogateDigits, legacyTailedSurrogate } from "./legacy-tailed-surrogate";
import { surrogateFor } from "./surrogate";

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

/**
 * Hard-coded from ae2f542's `surrogateFor(value, class, KEY, { visibleTail: true })` and
 * `phoneSurrogateDigits(keyDigits, KEY, true)`: exactly what captures stored before tails were removed.
 */
const TAILED: Array<[string, string, string]> = [
  ["card_number", "4111 1111 1111 1111", "4007 4095 3241 1111"],
  ["card_number", "4111111111111111", "4007409532411111"],
  ["card_number", "5555-5555-5555-4444", "4605-5996-7452-4444"],
  ["iban", "GB82 WEST 1234 5698 7654 32", "GB46 CXKX 9102 9510 0754 32"],
  ["iban", "DE89370400440532013000", "DE19147125966267723000"],
  ["phone", "+1 415-555-0123", "+1 758-324-0323"],
  ["phone", "+44 20 7946 0958", "+44 75 9507 5358"],
  ["phone", "020 7946 0958", "075 9507 5358"],
  ["national_id", "AB 12 34 56 C", "ZY 50 70 56 C"],
  ["national_id", "AB123456C", "ZY507456C"],
  ["us_ssn", "123-45-6789", "113-18-6789"],
  ["us_ssn", "123456789", "113186789"]
];

const TAILED_PHONE_DIGITS: Array<[string, string]> = [
  ["4155550123", "7583240323"],
  ["14155550123", "58541546923"],
  ["2079460958", "7595075358"],
  ["02079460958", "70187924058"]
];

describe("legacy tailed surrogates (lookup only)", () => {
  it.each(TAILED)("%s %s rebuilds the stored tailed form", (dataClass, value, stored) => {
    expect(legacyTailedSurrogate(value, dataClass, KEY)).toBe(stored);
    // The current surrogate is a different string: without the legacy form a lookup would miss the row.
    expect(surrogateFor(value, dataClass, KEY)).not.toBe(stored);
  });

  it.each(TAILED_PHONE_DIGITS)("phone keyed digits %s rebuild %s", (keyDigits, stored) => {
    expect(legacyTailedPhoneSurrogateDigits(keyDigits, KEY)).toBe(stored);
  });

  it("covers exactly the classes that had a tail, and nothing else", () => {
    expect([...LEGACY_TAILED_SURROGATE_CLASSES].sort()).toEqual(["card_number", "iban", "national_id", "phone", "us_ssn"]);
    expect(legacyTailedSurrogate("jane.doe@example.com", "email", KEY)).toBeNull();
    expect(legacyTailedSurrogate("sk-abcdefghijklmnop1234", "credential", KEY)).toBeNull();
    expect(legacyTailedSurrogate("Project Falcon", "codename", KEY)).toBeNull();
    // An IBAN without the format-preserving shape had a `[iban:…]` surrogate with or without the tail.
    expect(legacyTailedSurrogate("XX", "iban", KEY)).toBeNull();
  });

  it("refuses a short key", () => {
    expect(() => legacyTailedSurrogate("4111 1111 1111 1111", "card_number", new Uint8Array(8))).toThrow(/shorter than 16 bytes/);
    expect(() => legacyTailedPhoneSurrogateDigits("4155550123", new Uint8Array(8))).toThrow(/shorter than 16 bytes/);
  });
});
