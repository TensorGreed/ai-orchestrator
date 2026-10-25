import { describe, expect, it } from "vitest";
import { MASK_CHAR, maskForDataClass, normaliseMaskedSpans } from "./masking";

describe("normaliseMaskedSpans", () => {
  it("returns text without a masked span unchanged", () => {
    expect(normaliseMaskedSpans("Plain text, 4111 1111 1111 1111.")).toBe("Plain text, 4111 1111 1111 1111.");
  });

  it("makes masks of different lengths and visible tails of one class equal", () => {
    const a = `Card ${maskForDataClass("4111 1111 1111 1111", "card_number")} on file.`;
    const b = `Card ${maskForDataClass("5500-0000-0000-0004", "card_number")} on file.`;
    expect(a).not.toBe(b);
    expect(normaliseMaskedSpans(a)).toBe(normaliseMaskedSpans(b));
    expect(normaliseMaskedSpans(`x ${MASK_CHAR.repeat(3)} y`)).toBe(normaliseMaskedSpans(`x ${MASK_CHAR.repeat(11)} y`));
  });

  it("makes masked emails equal and keeps punctuation around the span", () => {
    const a = maskForDataClass("john.smith@example.com", "email");
    const b = maskForDataClass("al@x.org", "email");
    expect(normaliseMaskedSpans(`Mail (${a}), thanks`)).toBe(normaliseMaskedSpans(`Mail (${b}), thanks`));
    expect(normaliseMaskedSpans(`Mail (${a}), thanks`)).toBe(`Mail (${MASK_CHAR}), thanks`);
  });

  it("keeps real differences in the surrounding text", () => {
    const m = maskForDataClass("4111111111111111", "card_number");
    expect(normaliseMaskedSpans(`Charged ${m} today`)).not.toBe(normaliseMaskedSpans(`Refunded ${m} today`));
    expect(normaliseMaskedSpans(`Charged ${m} today`)).not.toBe(normaliseMaskedSpans(`Charged ${m} 2 days ago`));
  });

  it("treats a spaced masked value and a solid one alike, without swallowing neighbouring numbers", () => {
    expect(normaliseMaskedSpans("Card •••• •••• •••• 1111 ok")).toBe(normaliseMaskedSpans("Card ••••••••••••9999 ok"));
    expect(normaliseMaskedSpans("Order 12 ••••1111")).not.toBe(normaliseMaskedSpans("Order 13 ••••1111"));
    expect(normaliseMaskedSpans("Card ••••1111 12 items")).not.toBe(normaliseMaskedSpans("Card ••••1111 13 items"));
  });

  it("does not equate masked text with unmasked text", () => {
    expect(normaliseMaskedSpans(`Card ${MASK_CHAR.repeat(8)}`)).not.toBe(normaliseMaskedSpans("Card 41111111"));
  });

  it("lower-cases redaction placeholders and keeps their class", () => {
    expect(normaliseMaskedSpans("Key [REDACTED:Credential] set")).toBe("Key [redacted:credential] set");
    expect(normaliseMaskedSpans("Key [REDACTED:credential] set")).not.toBe(normaliseMaskedSpans("Key [REDACTED:email] set"));
  });
});
