import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ibanValid, luhnValid, scanDlp, ukNinoValid, usSsnValid } from "../detectors/dlp";
import { maskForDataClass } from "../masking";
import { GuardProtectionError } from "../types";
import { createDefaultProtectionRegistry } from "./index";
import {
  createSurrogateProvider,
  normaliseForSurrogate,
  SURROGATE_CARD_PREFIX,
  SURROGATE_EMAIL_DOMAIN,
  SURROGATE_PROVIDER_ID,
  SURROGATE_VISIBLE_TAIL,
  surrogateDetectable,
  surrogateFor
} from "./surrogate";
import { staticKeyResolver } from "./types";

const key = Buffer.from("0123456789abcdef0123456789abcdef");
const otherKey = Buffer.from("fedcba9876543210fedcba9876543210");

/** The classes scanDlp reports for the whole of `text`. */
function classesOf(text: string): string[] {
  return scanDlp(text)
    .filter((match) => match.span.start === 0 && match.span.end === text.length)
    .map((match) => String(match.dataClass));
}

describe("surrogateFor", () => {
  it("is deterministic per key and differs across keys", () => {
    for (const [value, dataClass] of [
      ["jane.doe@example.com", "email"],
      ["4111 1111 1111 1111", "card_number"],
      ["GB82 WEST 1234 5698 7654 32", "iban"],
      ["536-90-4399", "us_ssn"],
      ["+44 20 7946 0958", "phone"],
      ["AB 12 34 56 C", "national_id"],
      ["Project Falcon", "codename"]
    ] as const) {
      const first = surrogateFor(value, dataClass, key);
      expect(surrogateFor(value, dataClass, key)).toBe(first);
      expect(surrogateFor(value, dataClass, otherKey)).not.toBe(first);
      expect(first).not.toContain(value);
    }
  });

  it("keys the normalised value, so two spellings share a surrogate", () => {
    expect(surrogateFor("Jane.Doe@Example.com", "email", key)).toBe(surrogateFor("jane.doe@example.com", "email", key));
    const spaced = surrogateFor("4111 1111 1111 1111", "card_number", key);
    const plain = surrogateFor("4111111111111111", "card_number", key);
    expect(spaced.replace(/\D/g, "")).toBe(plain);
    expect(normaliseForSurrogate(" GB82-west ", "iban")).toBe("GB82WEST");
  });

  it("emails stay emails on a domain that never resolves", () => {
    const surrogate = surrogateFor("jane.doe@example.com", "email", key);
    expect(surrogate).toMatch(new RegExp(`^u-[0-9a-f]{12}@${SURROGATE_EMAIL_DOMAIN.replace(".", "\\.")}$`));
    expect(classesOf(surrogate)).toEqual(["email"]);
  });

  it("cards keep length and separators, pass Luhn, use the test prefix and are still cards", () => {
    for (const value of ["4111 1111 1111 1111", "5500-0000-0000-0004", "378282246310005", "6011000990139424", "3056930009020004"]) {
      const surrogate = surrogateFor(value, "card_number", key);
      expect(surrogate.length).toBe(value.length);
      expect(surrogate.replace(/\d/g, "#")).toBe(value.replace(/\d/g, "#"));
      const digits = surrogate.replace(/\D/g, "");
      expect(luhnValid(digits)).toBe(true);
      expect(digits.startsWith(SURROGATE_CARD_PREFIX)).toBe(true);
      expect(classesOf(surrogate)).toEqual(["card_number"]);
    }
  });

  it("IBANs keep country, length and spacing with valid mod-97 check digits", () => {
    for (const value of ["GB82 WEST 1234 5698 7654 32", "DE89370400440532013000", "FR14 2004 1010 0505 0001 3M02 606"]) {
      expect(ibanValid(value)).toBe(true);
      const surrogate = surrogateFor(value, "iban", key);
      expect(surrogate.length).toBe(value.length);
      expect(surrogate.slice(0, 2)).toBe(value.slice(0, 2));
      expect(surrogate.replace(/[A-Z]/g, "A").replace(/\d/g, "9")).toBe(value.replace(/[A-Z]/g, "A").replace(/\d/g, "9"));
      expect(ibanValid(surrogate)).toBe(true);
      expect(surrogate).not.toBe(value);
      expect(classesOf(surrogate)).toContain("iban");
    }
  });

  it("SSNs are structurally valid, in the never-assigned area range, and still SSNs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const value = `${String(100 + i).padStart(3, "0")}-${String(10 + (i % 80)).padStart(2, "0")}-${String(1000 + i * 7).padStart(4, "0")}`;
      const surrogate = surrogateFor(value, "us_ssn", key);
      expect(surrogate).toMatch(/^\d{3}-\d{2}-\d{4}$/);
      expect(usSsnValid(surrogate)).toBe(true);
      const area = Number(surrogate.slice(0, 3));
      expect(area).toBeGreaterThanOrEqual(734);
      expect(area).toBeLessThanOrEqual(749);
      expect(classesOf(surrogate)).toEqual(["us_ssn"]);
      seen.add(surrogate);
    }
    expect(seen.size).toBeGreaterThan(190);
  });

  it("phones keep the digit count and every separator, and are still phones", () => {
    for (const value of ["+44 20 7946 0958", "(415) 555-2671", "415.555.2671", "+1 415 555 2671"]) {
      const surrogate = surrogateFor(value, "phone", key);
      expect(surrogate.replace(/\d/g, "#")).toBe(value.replace(/\d/g, "#"));
      expect(surrogate).not.toBe(value);
      expect(scanDlp(`call ${surrogate} today`).map((match) => match.dataClass)).toContain("phone");
    }
  });

  it("UK NI numbers keep their spacing and stay valid", () => {
    const surrogate = surrogateFor("AB 12 34 56 C", "national_id", key);
    expect(surrogate).toMatch(/^ZY \d{2} \d{2} \d{2} [A-D]$/);
    expect(ukNinoValid(surrogate)).toBe(true);
    expect(classesOf(surrogate)).toEqual(["national_id"]);
  });

  it("keeps exactly what the guard mask action shows, so masked output reads the same for the value and its surrogate", () => {
    const samples: Array<[string, string]> = [
      ["card_number", "4111 1111 1111 1111"],
      ["card_number", "5500-0000-0000-0004"],
      ["card_number", "378282246310005"],
      ["iban", "GB82 WEST 1234 5698 7654 32"],
      ["iban", "DE89370400440532013000"],
      ["us_ssn", "123-45-6789"],
      ["phone", "+1 (415) 555-0132"],
      ["national_id", "AB 12 34 56 C"]
    ];
    for (const [dataClass, value] of samples) {
      const surrogate = surrogateFor(value, dataClass, key);
      expect(surrogate, value).not.toBe(value);
      expect(maskForDataClass(surrogate, dataClass), value).toBe(maskForDataClass(value, dataClass));
      expect(surrogate.slice(-SURROGATE_VISIBLE_TAIL[dataClass]!)).toBe(value.slice(-SURROGATE_VISIBLE_TAIL[dataClass]!));
      expect(classesOf(surrogate), value).toContain(dataClass);
    }
    // Checksums still hold with the kept tail.
    expect(luhnValid(surrogateFor("4111 1111 1111 1111", "card_number", key).replace(/\D/g, ""))).toBe(true);
    expect(ibanValid(surrogateFor("GB82 WEST 1234 5698 7654 32", "iban", key))).toBe(true);
    expect(usSsnValid(surrogateFor("123-45-6789", "us_ssn", key))).toBe(true);
    // The rest of a card is not the original's.
    expect(surrogateFor("4111 1111 1111 1111", "card_number", key).slice(0, 14)).not.toBe("4111 1111 1111");
  });

  it("redacts credentials, keys and tokens fully, and tags dictionary classes", () => {
    expect(surrogateFor("sk-proj-abcdefghijklmnopqrstuv", "credential", key)).toBe("[redacted:credential]");
    expect(surrogateFor("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "private_key", key)).toBe("[redacted:private_key]");
    expect(surrogateFor("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "jwt", key)).toBe("[redacted:jwt]");
    const tagged = surrogateFor("Project Falcon", "codename", key);
    expect(tagged).toMatch(/^\[codename:[0-9a-f]{12}\]$/);
    expect(surrogateDetectable("codename")).toBe(false);
    expect(surrogateDetectable("email")).toBe(true);
  });

  it("refuses a short key", () => {
    expect(() => surrogateFor("a@b.co", "email", Buffer.from("short"))).toThrow(GuardProtectionError);
  });
});

describe("surrogate provider", () => {
  it("is registered by default and resolves its key through the key resolver", async () => {
    const registry = createDefaultProtectionRegistry({ keys: staticKeyResolver({ cap: key }), defaultKeyId: "cap" });
    const provider = registry.get(SURROGATE_PROVIDER_ID)!;
    expect(provider).toBeDefined();
    expect(provider.deterministic).toBe(true);
    expect(provider.reversible).toBe(false);
    expect(await provider.protect("jane.doe@example.com", { dataClass: "email" })).toBe(surrogateFor("jane.doe@example.com", "email", key));
  });

  it("fails without a key", async () => {
    const provider = createSurrogateProvider({ keys: staticKeyResolver({ tiny: randomBytes(8) }) });
    await expect(provider.protect("a@b.co", { dataClass: "email" })).rejects.toThrow(/No key id/);
    await expect(provider.protect("a@b.co", { dataClass: "email", keyId: "tiny" })).rejects.toThrow(/shorter than 16 bytes/);
  });
});
