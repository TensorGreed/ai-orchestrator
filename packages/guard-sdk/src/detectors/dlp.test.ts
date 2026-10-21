import { describe, expect, it } from "vitest";
import type { GuardFinding } from "../types";
import { createDlpDetector, ibanValid, luhnCheckDigit, luhnValid, scanDlp, ukNinoValid, usSsnValid } from "./dlp";

const classes = (text: string, options?: Parameters<typeof scanDlp>[1]) => scanDlp(text, options).map((m) => m.dataClass);

describe("checksums", () => {
  it("validates Luhn, IBAN mod-97 and SSN structure", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnCheckDigit("411111111111111")).toBe("1");
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(usSsnValid("536-90-4399")).toBe(true);
    expect(usSsnValid("000-12-3456")).toBe(false);
    expect(usSsnValid("666-12-3456")).toBe(false);
    expect(usSsnValid("900-12-3456")).toBe(false);
    expect(usSsnValid("123-45-6789")).toBe(false);
    expect(ukNinoValid("AB 12 34 56 C")).toBe(true);
    expect(ukNinoValid("BG 12 34 56 A")).toBe(false);
  });
});

describe("dlp patterns", () => {
  it("finds email, phone, card, IBAN and SSN with accurate spans", () => {
    const text = "Mail ana.lopez@example.org, call +44 20 7946 0958, card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, SSN 536-90-4399.";
    const matches = scanDlp(text);
    const by = Object.fromEntries(matches.map((m) => [m.dataClass, text.slice(m.span.start, m.span.end)]));
    expect(by.email).toBe("ana.lopez@example.org");
    expect(by.phone).toBe("+44 20 7946 0958");
    expect(by.card_number).toBe("4111 1111 1111 1111");
    expect(by.iban).toBe("GB82 WEST 1234 5698 7654 32");
    expect(by.us_ssn).toBe("536-90-4399");
  });

  it("rejects numbers that only look like cards or ids", () => {
    expect(classes("Order 4111 1111 1111 1112 shipped")).toEqual([]);
    expect(classes("Reference 0000000000000000")).toEqual([]);
    expect(classes("SSN placeholder 123-45-6789")).toEqual([]);
    expect(classes("Released 2024-01-15 and 15.01.2024; build 1.2.3")).toEqual([]);
  });

  it("finds credentials: key prefixes, JWTs, private keys, high-entropy assignments", () => {
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from('{"sub":"1"}').toString("base64url")}.c2lnbmF0dXJlX2hlcmVfMTIz`;
    const text = [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "key AKIAIOSFODNN7EXAMPLE",
      `Authorization: Bearer ${jwt}`,
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "DB_PASSWORD=xK9#mP2$vL5nQ8wR3tY7",
      "api_key: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA'"
    ].join("\n");
    const found = classes(text);
    expect(found.filter((c) => c === "credential").length).toBeGreaterThanOrEqual(4);
    expect(found).toContain("jwt");
    expect(found).toContain("private_key");
  });

  it("does not flag ordinary assignments or placeholders", () => {
    expect(classes("password = ${env:DB_PASSWORD}")).toEqual([]);
    expect(classes("api_key: <your key here>")).toEqual([]);
    expect(classes("token = true")).toEqual([]);
    expect(classes("keyboard = 'mechanical keyboard'")).toEqual([]);
    expect(classes("The secret ingredient is love")).toEqual([]);
  });

  it("applies custom dictionaries and patterns and lets classes be disabled", () => {
    const text = "Project Bluebird ships on Monday; ticket ACME-12345; mail bob@example.com";
    const matches = scanDlp(text, {
      dictionaries: [
        { dataClass: "codename", terms: ["bluebird"], patterns: [], score: 0.9 },
        { dataClass: "ticket", terms: [], patterns: ["ACME-\\d{5}"], score: 0.8 }
      ],
      disable: ["email"]
    });
    expect(matches.map((m) => [m.dataClass, text.slice(m.span.start, m.span.end)])).toEqual([
      ["codename", "Bluebird"],
      ["ticket", "ACME-12345"]
    ]);
  });

  it("emits findings with masked evidence only", () => {
    const text = "card 4111 1111 1111 1111 and mail ana.lopez@example.org and ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const findings = createDlpDetector().detect({ channel: "tool_result", content: text }, { text, options: {}, now: () => 0 }) as GuardFinding[];
    const evidence = Object.fromEntries(findings.map((f) => [f.dataClass, f.evidence]));
    expect(evidence.card_number).toBe("•••• •••• •••• 1111");
    expect(evidence.email).toBe("a••••••••@e••••••.org");
    expect(evidence.credential).toMatch(/^ghp_•+$/);
    for (const f of findings) {
      expect(f.evidence).not.toContain("4111 1111 1111");
      expect(f.message).not.toContain("ana.lopez");
    }
  });

  it("supports a pluggable national-id list", () => {
    const text = "Aadhaar-like 1234 5678 9012; NI QQ123456C";
    const matches = scanDlp(text, {
      nationalIds: [{ country: "XX", label: "Test id", pattern: /\b\d{4} \d{4} \d{4}\b/g, dataClass: "test_id" }]
    });
    expect(matches.map((m) => m.dataClass)).toEqual(["test_id"]);
  });
});
