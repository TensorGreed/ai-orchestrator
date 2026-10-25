import { describe, expect, it } from "vitest";
import { MASK_CHAR, maskForDataClass, normaliseMaskedSpans } from "./masking";

const n = normaliseMaskedSpans;

describe("normaliseMaskedSpans", () => {
  it("returns text without a masked span unchanged", () => {
    expect(n("Plain text, 4111 1111 1111 1111.")).toBe("Plain text, 4111 1111 1111 1111.");
  });

  // M1: each class's mask, built with maskForDataClass, for two different values of the class (layouts differ too).
  const SAME_CLASS: Array<[string, string, string]> = [
    ["card_number", "4111 1111 1111 1111", "5500 0000 0000 0004"],
    ["card_number", "4111111111111111", "5500000000000004"],
    ["card_number", "4111-1111-1111-1111", "5500-0000-0000-0004"],
    ["card_number", "4111 1111 1111 1111", "5500000000000004"],
    ["card_number", "3782 822463 10005", "4111 1111 1111 1111"],
    ["iban", "GB82 WEST 1234 5698 7654 32", "DE89 3704 0044 0532 0130 00"],
    ["iban", "GB82 WEST 1234 5698 7654 32", "GB29 NWBK 6016 1331 9268 19"],
    ["iban", "GB82WEST12345698765432", "DE89370400440532013000"],
    ["iban", "FR76 3000 6000 0112 3456 7890 189", "GB82 WEST 1234 5698 7654 32"],
    ["phone", "+1 (415) 555-0132", "+44 20 7946 0958"],
    ["phone", "(415) 555-0132", "(212) 555-0199"],
    ["phone", "+1 415-555-0123", "415.555.0199"],
    ["phone", "+14155550123", "+442079460958"],
    ["national_id", "AB 12 34 56 C", "CD 98 76 54 A"],
    ["national_id", "AB123456C", "CD987654A"],
    ["national_id", "AB 123456 C", "CD 987654 A"],
    ["us_ssn", "123-45-6788", "536-90-4399"],
    ["us_ssn", "123456788", "536904399"],
    ["us_ssn", "123 45 6788", "536 90 4399"],
    ["email", "jane.doe@example.com", "u-2757eb4e85a6@surrogate.invalid"],
    ["email", "j@x.org", "someone.else@mail.example.co.uk"]
  ];

  it.each(SAME_CLASS)("%s: masks of %s and %s compare equal", (dataClass, a, b) => {
    const left = `Value ${maskForDataClass(a, dataClass)} ok, (${maskForDataClass(a, dataClass)}).`;
    const right = `Value ${maskForDataClass(b, dataClass)} ok, (${maskForDataClass(b, dataClass)}).`;
    expect(left).not.toBe(right);
    expect(n(left)).toBe(n(right));
    // The mask is gone, the words around it stay.
    expect(n(left)).not.toContain(MASK_CHAR);
    expect(n(left).startsWith("Value ")).toBe(true);
    expect(n(left).endsWith(").")).toBe(true);
  });

  it("matches a fully masked value of any length", () => {
    expect(n(`x ${MASK_CHAR.repeat(3)} y`)).toBe(n(`x ${MASK_CHAR.repeat(11)} y`));
    expect(n(`key ${maskForDataClass("-----BEGIN PRIVATE KEY-----abc", "private_key")}`)).not.toContain(MASK_CHAR);
  });

  // H2: the reviewer's examples, none of which may compare equal.
  const DIFFERENT: Array<[string, string]> = [
    ["• 3 tablets daily", "• 30 tablets daily"],
    ["• 2 items left", "• 2000 items left"],
    ["x\n• 1. Approve\n• 2. Reject", "x\n• 2. Approve\n• 1. Reject"],
    ["•Paid", "•Refunded"],
    ["- •Approved", "- •Denied"],
    ["Status: •OK", "Status: •FAIL"],
    ["Status: •••OK", "Status: •••FAIL"],
    ["ssn:•••1111", "id:•••1111"],
    ["Card:••••1111 charged", "Refund:••••1111 charged"],
    ["to=j•••@a.com", "cc=j•••@a.com"],
    ["to=j•••@e••••••.com", "cc=j•••@e••••••.com"],
    ["amount •••-50", "amount •••+50"],
    ["amount •••-50", "amount •••-51"],
    ["•••• 12 items", "•••• 13 items"],
    ["••••1111 12 items", "••••1111 13 items"],
    ["•-1", "•-9999"],
    ["value 4111111111111111", "value ••••••••••••1111"],
    ["a • b", "a • c"],
    ["a •• b", "a •• c"],
    ["Order 12 ••••••••1111", "Order 13 ••••••••1111"],
    ["Card •••• •••• •••• 1111 charged", "Card •••• •••• •••• 1111 refunded"],
    ["mail j•••@e••••••.com", "mail j•••@e••••••.com today"],
    ["x••••1111", "y••••1111"],
    ["••••1111x", "••••1111y"],
    ["Card ••••••••", "Card 41111111"]
  ];

  it.each(DIFFERENT)("keeps %j and %j different", (a, b) => {
    expect(n(a.replace(/\s+/g, " "))).not.toBe(n(b.replace(/\s+/g, " ")));
  });

  it("leaves bullets and glued keys as written", () => {
    expect(n("• 3 tablets daily")).toBe("• 3 tablets daily");
    expect(n("x • 1. Approve • 2. Reject")).toBe("x • 1. Approve • 2. Reject");
    expect(n("•Paid")).toBe("•Paid");
    expect(n("Status: •••OK")).toBe("Status: •••OK");
    expect(n("ssn:•••1111").startsWith("ssn:")).toBe(true);
    expect(n("to=j•••@e••••••.com").startsWith("to=")).toBe(true);
    // A digit word after a single masked group is not its tail.
    expect(n("•••• 12 items")).toMatch(/ 12 items$/);
    expect(n("amount •••-50")).toMatch(/-50$/);
  });

  it("reads an NI suffix letter only in upper case", () => {
    expect(n("\u2022\u2022 \u2022\u2022 \u2022\u2022 56 C")).toBe(n("\u2022\u2022 \u2022\u2022 \u2022\u2022 12 A"));
    // A lowercase letter after the number is text, not an NI suffix, so these differ ("a" is not swallowed).
    expect(n("\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 12 a")).not.toBe(n("\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 12 b"));
  });

  it("never lets a NUL already in the text read as a mask", () => {
    const mask = "\u2022\u2022\u2022\u2022";
    expect(n("a\u0000mask\u0000")).not.toBe(n(`a${mask}`));
    expect(n("\u0000mask\u0000")).not.toBe(n(mask));
    expect(n("\u0000mask:email\u0000")).not.toBe(n(maskForDataClass("jane@example.com", "email")));
    expect(n("\u0000mask:iban\u0000")).not.toBe(n(maskForDataClass("GB82 WEST 1234 5698 7654 32", "iban")));
  });

  it("does not equate masked text with unmasked text", () => {
    expect(n(`Card ${MASK_CHAR.repeat(8)}`)).not.toBe(n("Card 41111111"));
    expect(n(`Card ${maskForDataClass("4111 1111 1111 1111", "card_number")}`)).not.toBe(n("Card 4111 1111 1111 1111"));
  });

  it("keeps masks of different shapes apart", () => {
    const card = maskForDataClass("4111 1111 1111 1111", "card_number");
    const email = maskForDataClass("jane@example.com", "email");
    const iban = maskForDataClass("GB82 WEST 1234 5698 7654 32", "iban");
    expect(n(`x ${card}`)).not.toBe(n(`x ${email}`));
    expect(n(`x ${iban}`)).not.toBe(n(`x ${email}`));
    expect(n(`x ${iban}`)).not.toBe(n(`x ${card}`));
  });

  it("lower-cases redaction placeholders and keeps their class", () => {
    expect(n("Key [REDACTED:Credential] set")).toBe("Key [redacted:credential] set");
    expect(n("Key [REDACTED:credential] set")).not.toBe(n("Key [REDACTED:email] set"));
  });
});
