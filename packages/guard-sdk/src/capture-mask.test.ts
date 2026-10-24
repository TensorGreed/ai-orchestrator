import { describe, expect, it } from "vitest";
import {
  decodeView,
  maskableDataClasses,
  maskRecording,
  maskRecordingAsync,
  maskedClassesForNode,
  MaskIdentifierError,
  MaskUnscannableError,
  resolveOverlaps,
  SubjectIndex,
  type MaskPart
} from "./capture-mask";
import { createDefaultGuardProfile } from "./default-profile";
import { ibanValid, luhnValid, scanDlp } from "./detectors/dlp";
import { maskForDataClass } from "./masking";
import { surrogateFor } from "./protection/surrogate";

const key = Buffer.from("0123456789abcdef0123456789abcdef");

const EMAIL = "jane.doe@example.com";
const CARD = "4111 1111 1111 1111";
const IBAN = "GB82 WEST 1234 5698 7654 32";
const SSN = "536-90-4399";
const PHONE = "+44 20 7946 0958";
const KEY_BLOCK = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
const TOKEN = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";

function serialised(parts: MaskPart[]): string {
  return JSON.stringify(parts.map((part) => part.value));
}

describe("maskRecording", () => {
  const parts: MaskPart[] = [
    { id: "input", value: { customer: EMAIL, message: `Card ${CARD}, call me on ${PHONE}` } },
    { id: "node:lookup", nodeId: "lookup", value: { output: { ssn: SSN, iban: IBAN, [EMAIL]: "keyed by email" } } },
    {
      id: "tape:1",
      nodeId: "agent",
      value: {
        request: { messages: [{ role: "user", content: `Hi, I am ${EMAIL}. My key: ${KEY_BLOCK}` }] },
        response: { content: `Thanks ${EMAIL}` }
      }
    },
    // A tool result carrying a JSON document as a string: the key's newlines are escaped there.
    { id: "cassette:1", value: { result: { content: [{ type: "text", text: JSON.stringify({ apiKey: TOKEN, pem: KEY_BLOCK, mail: EMAIL }) }] } } },
    { id: "facts", value: { output: `done for ${EMAIL}`, error: null } }
  ];

  it("leaves no raw value anywhere, in values, keys or escaped JSON", () => {
    const { parts: masked } = maskRecording(parts, { key });
    const text = serialised(masked);
    for (const raw of [EMAIL, CARD, IBAN, SSN, PHONE, TOKEN, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"]) {
      expect(text).not.toContain(raw);
      expect(text).not.toContain(JSON.stringify(raw).slice(1, -1));
    }
    expect(text).toContain("[redacted:private_key]");
    expect(text).toContain("[redacted:credential]");
  });

  it("replaces every occurrence with the same surrogate, everywhere", () => {
    const { parts: masked } = maskRecording(parts, { key });
    const surrogate = surrogateFor(EMAIL, "email", key);
    const input = masked[0]!.value as { customer: string };
    expect(input.customer).toBe(surrogate);
    const lookup = (masked[1]!.value as { output: Record<string, unknown> }).output;
    expect(lookup[surrogate]).toBe("keyed by email");
    const tape = masked[2]!.value as { response: { content: string } };
    expect(tape.response.content).toBe(`Thanks ${surrogate}`);
    const nested = JSON.parse((masked[3]!.value as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as Record<string, string>;
    expect(nested.mail).toBe(surrogate);
    expect(nested.pem).toBe("[redacted:private_key]");
    // Deterministic across calls.
    expect(serialised(maskRecording(parts, { key }).parts)).toBe(serialised(masked));
  });

  it("surrogates are still detected as the same class with valid checksums", () => {
    const { parts: masked } = maskRecording(parts, { key });
    const message = (masked[0]!.value as { message: string }).message;
    const classes = scanDlp(message).map((match) => match.dataClass);
    expect(classes).toContain("card_number");
    expect(classes).toContain("phone");
    const lookup = (masked[1]!.value as { output: { ssn: string; iban: string } }).output;
    expect(scanDlp(lookup.ssn).map((match) => match.dataClass)).toEqual(["us_ssn"]);
    expect(ibanValid(lookup.iban)).toBe(true);
    const card = scanDlp(message).find((match) => match.dataClass === "card_number")!;
    expect(luhnValid(message.slice(card.span.start, card.span.end))).toBe(true);
  });

  it("reports counts per class, part and node, never values", () => {
    const { report } = maskRecording(parts, { key });
    expect(report.values.email).toBe(1);
    expect(report.occurrences.email).toBe(6);
    expect(report.nodes.lookup).toEqual({ email: 1, iban: 1, us_ssn: 1 });
    expect(maskedClassesForNode(report, "agent")).toEqual(["email", "private_key"]);
    expect(report.parts.input).toEqual({ card_number: 1, email: 1, phone: 1 });
    expect(report.notDetectableAfterMasking).toEqual(["credential", "private_key"]);
    const text = JSON.stringify(report);
    for (const raw of [EMAIL, CARD, IBAN, SSN, PHONE, TOKEN]) expect(text).not.toContain(raw);
  });

  it("masks dictionary classes with a tag the scan no longer finds", () => {
    const dictionaries = [{ dataClass: "codename", terms: ["Project Falcon"], patterns: [], score: 0.9 }];
    const { parts: masked, report } = maskRecording([{ id: "input", value: "Status of Project Falcon? project falcon is late." }], { key, dictionaries });
    const text = masked[0]!.value as string;
    expect(text).not.toMatch(/falcon/i);
    expect(text).toMatch(/\[codename:[0-9a-f]{12}\]/);
    // Both spellings normalise to one surrogate.
    expect(new Set(text.match(/\[codename:[0-9a-f]{12}\]/g)).size).toBe(1);
    expect(report.notDetectableAfterMasking).toEqual(["codename"]);
    expect(scanDlp(text, { dictionaries })).toEqual([]);
  });

  it("an IBAN wins over the card-shaped digits inside it (overlapping matches)", () => {
    const iban = "DE89 3704 0044 0532 0130 00";
    const matches = resolveOverlaps([
      { dataClass: "card_number", span: { start: 2, end: 26 }, score: 0.9, message: "" },
      { dataClass: "iban", span: { start: 0, end: 27 }, score: 0.95, message: "" },
      { dataClass: "phone", span: { start: 5, end: 14 }, score: 0.6, message: "" }
    ]);
    expect(matches.map((match) => match.dataClass)).toEqual(["iban"]);
    const { parts: masked, report } = maskRecording([{ id: "input", value: `IBAN ${iban}` }], { key });
    const text = masked[0]!.value as string;
    expect(text).not.toContain("3704");
    expect(ibanValid(text.slice(5))).toBe(true);
    expect(Object.keys(report.values)).toEqual(["iban"]);
  });

  it("finds a value hidden in one place once it was detected elsewhere", () => {
    // The phone pattern would not match inside "id5552671234x", but the value is replaced there too.
    const { parts: masked } = maskRecording(
      [
        { id: "a", value: "call (415) 555-2671" },
        { id: "b", value: "ref:(415) 555-2671;" }
      ],
      { key }
    );
    expect(serialised(masked)).not.toContain("555-2671");
  });

  it("keeps values the workflow definition holds, but never secrets", () => {
    const workflow = { nodes: [{ config: { systemPrompt: `Escalate to support@acme.test. ${TOKEN}` } }] };
    const { parts: masked, report } = maskRecording(
      [{ id: "tape:1", value: `Escalate to support@acme.test. ${TOKEN} Customer ${EMAIL}` }],
      { key, keepLiteralsFrom: workflow }
    );
    const text = masked[0]!.value as string;
    expect(text).toContain("support@acme.test");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
    expect(report.keptFromWorkflow).toBe(1);
  });

  it("leaves content without findings untouched", () => {
    const value = { a: 1, b: ["plain", true, null], c: { d: "no data here" } };
    const { parts: masked, report } = maskRecording([{ id: "x", value }], { key });
    expect(masked[0]!.value).toEqual(value);
    expect(report.values).toEqual({});
  });

  it("keeps only whole workflow literals: never a value inside a longer one", () => {
    const workflow = {
      nodes: [
        { id: "n-4155550000", position: { x: 3456789012, y: 0 }, config: { prompt: "Write to a@b.com. Hotline +1 345 678 9012 9. Call 212-555-0187 for help." } }
      ]
    };
    const { parts: masked, report } = maskRecording(
      [{ id: "input", value: "from a@b.co, phone 345 678 9012, desk 212-555-0187, also 415-555-0000" }],
      { key, keepLiteralsFrom: workflow }
    );
    const text = masked[0]!.value as string;
    // a@b.co is not a@b.com; 345 678 9012 is only part of a longer number in the literal.
    expect(text).not.toContain("a@b.co");
    expect(text).not.toContain("345 678 9012");
    // The whole literal phone number stays; ids and positions are not literals.
    expect(text).toContain("212-555-0187");
    expect(text).not.toContain("415-555-0000");
    expect(report.keptFromWorkflow).toBe(1);
  });

  // The reviewer's probes: a value detected in one form, present in another.
  it("masks the digits-only form of a phone detected with its country code", () => {
    const { parts: masked } = maskRecording(
      [
        { id: "input", value: { message: "Call me on +1 415-555-1234" } },
        { id: "facts.tool:0", value: { phone: "4155551234" } },
        { id: "cassette:0", value: { args: { phone: "14155551234" } } }
      ],
      { key }
    );
    const text = JSON.stringify(masked.map((part) => part.value));
    expect(text).not.toMatch(/155551234/);
    // The same subject gets the same keyed digits in every form.
    const tool = (masked[1]!.value as { phone: string }).phone;
    const input = (masked[0]!.value as { message: string }).message;
    expect(input.replace(/\D/g, "").slice(-9)).toBe(tool.slice(-9));
  });

  it("masks an SSN's digits-only form", () => {
    const { parts: masked } = maskRecording(
      [
        { id: "input", value: "SSN 123-45-6788" },
        { id: "facts.tool:0", value: { ssn: "123456788", spaced: "123 45 6788" } }
      ],
      { key }
    );
    expect(JSON.stringify(masked.map((part) => part.value))).not.toMatch(/123\D?45\D?6788/);
  });

  it("masks JSON numbers, keeping them numbers", () => {
    const { parts: masked } = maskRecording(
      [
        { id: "input", value: "card 4111 1111 1111 1111, phone (415) 555-1234" },
        { id: "facts.tool:0", value: { card: 4111111111111111, phone: 4155551234, count: 3 } }
      ],
      { key }
    );
    const args = masked[1]!.value as { card: unknown; phone: unknown; count: number };
    expect(typeof args.card).toBe("number");
    expect(typeof args.phone).toBe("number");
    expect(args.card).not.toBe(4111111111111111);
    expect(String(args.phone)).not.toContain("155551234");
    expect(luhnValid(String(args.card))).toBe(true);
    expect(args.count).toBe(3);
  });

  it("masks URL-encoded and JSON-escaped forms, in the same encoding", () => {
    const { parts: masked } = maskRecording(
      [
        { id: "input", value: { email: EMAIL } },
        { id: "tool", value: { url: "https://crm.test/find?email=jane.doe%40example.com&x=1", body: '{"mail":"jane.doe\\u0040example.com"}' } }
      ],
      { key }
    );
    const tool = masked[1]!.value as { url: string; body: string };
    const surrogate = surrogateFor(EMAIL, "email", key);
    expect(tool.url).toBe(`https://crm.test/find?email=${surrogate.replace("@", "%40")}&x=1`);
    expect(tool.body).toBe(`{"mail":"${surrogate.replace("@", "\\u0040")}"}`);
    expect(JSON.stringify(masked)).not.toMatch(/jane\.doe/);
  });

  it("decodes escapes in an email found only in its encoded form", () => {
    const { parts: masked, report } = maskRecording([{ id: "tool", value: "q=jane.doe%40example.com" }], { key });
    expect(masked[0]!.value).toBe(`q=${surrogateFor(EMAIL, "email", key).replace("@", "%40")}`);
    expect(report.values.email).toBe(1);
  });

  it("never matches inside a longer value", () => {
    const { parts: masked } = maskRecording(
      [
        { id: "input", value: "ann@x.co" },
        { id: "other", value: "joann@x.com and ann@x.com" }
      ],
      { key }
    );
    const other = masked[1]!.value as string;
    // Both are different subjects: masked on their own, not by ann@x.co's surrogate.
    expect(other).not.toContain(surrogateFor("ann@x.co", "email", key));
    expect(other).not.toContain("ann@x.co");
  });

  it("drops content nested deeper than the limit instead of storing it, even with nothing else found", () => {
    let deep: unknown = { mail: EMAIL, card: CARD };
    for (let i = 0; i < 70; i += 1) deep = { next: deep };
    expect(() => maskRecording([{ id: "input", value: deep }], { key })).toThrow(MaskUnscannableError);
    expect(() => maskRecording([{ id: "input", value: { plain: "nothing here" } }, { id: "node:x", value: deep }], { key })).toThrow(MaskUnscannableError);
  });

  it("keeps the visible tail only for classes a bound profile can mask", () => {
    const value = `card ${CARD} ssn ${SSN}`;
    const full = maskRecording([{ id: "input", value }], { key }).parts[0]!.value as string;
    const withTail = maskRecording([{ id: "input", value }], { key, visibleTailClasses: ["card_number"] }).parts[0]!.value as string;
    const cardOf = (text: string) => text.slice(5, 5 + CARD.length);
    expect(maskForDataClass(cardOf(withTail), "card_number")).toBe(maskForDataClass(CARD, "card_number"));
    expect(cardOf(full).slice(-4)).not.toBe("1111");
    // SSN has no masking profile here: full surrogate either way.
    expect(withTail.slice(-4)).not.toBe(SSN.slice(-4));
    expect(maskableDataClasses([createDefaultGuardProfile()])).toEqual(["card_number"]);
  });

  // Re-review N3: national forms of an 8-digit national number, detected with its country code.
  it("masks the national forms of an 8-digit number detected with its country code, keeping the country code", () => {
    for (const [international, nationalDigits] of [
      ["+47 2212 3456", "22123456"],
      ["+65 6123 4567", "61234567"]
    ] as const) {
      const cc = international.slice(1, 3);
      const { parts: masked } = maskRecording(
        [
          { id: "input", value: `call ${international}` },
          { id: "tool", value: { a: nationalDigits, b: `${nationalDigits.slice(0, 4)} ${nationalDigits.slice(4)}`, c: `00${cc} ${nationalDigits}`, d: Number(`${cc}${nationalDigits}`) } }
        ],
        { key }
      );
      const text = JSON.stringify(masked.map((part) => part.value));
      expect(text.replace(/\D/g, ""), international).not.toContain(nationalDigits);
      const input = masked[0]!.value as string;
      // The country code is never rewritten.
      expect(input.startsWith(`call +${cc} `), input).toBe(true);
      const tool = masked[1]!.value as { a: string; b: string; c: string; d: number };
      expect(input.slice(`call +${cc} `.length).replace(/\D/g, "")).toBe(tool.a);
      expect(tool.b.replace(/\D/g, "")).toBe(tool.a);
      expect(tool.c.startsWith(`00${cc} `)).toBe(true);
      expect(String(tool.d).startsWith(cc)).toBe(true);
    }
  });

  it("two people whose phones share the last nine digits are masked apart", () => {
    const { parts: masked } = maskRecording([{ id: "input", value: { a: "+1 312 345 6788", b: "+1 412 345 6788", uk: "+44 20 7946 0958", us: "+1 (207) 946-0958" } }], { key });
    const value = masked[0]!.value as Record<string, string>;
    expect(value.a.replace(/\D/g, "").slice(-9)).not.toBe(value.b.replace(/\D/g, "").slice(-9));
    expect(value.uk.startsWith("+44 ")).toBe(true);
    expect(value.us.startsWith("+1 (")).toBe(true);
  });

  it("round 3 A2: international layouts found only in a tool result are masked, the country code kept", () => {
    const forms: Array<[string, string]> = [
      ["+14155551234", "4155551234"],
      ["+447700900123", "7700900123"],
      ["+33 1 23 45 67 89", "123456789"],
      ["+44 (0) 20 7946 0958", "2079460958"],
      ["+61 2 9876 5432", "298765432"],
      ["+91 98765 43210", "9876543210"],
      ["+81 3-1234-5678", "312345678"],
      ["+353 1 234 5678", "12345678"],
      ["+36 1 234 5678", "12345678"],
      ["+7 495 123-45-67", "4951234567"]
    ];
    for (const [written, national] of forms) {
      const cc = written.slice(1).split(/\D/)[0]!.slice(0, written.startsWith("+1") ? 1 : written.startsWith("+7") ? 1 : written.startsWith("+353") ? 3 : 2);
      const { parts: masked, report } = maskRecording(
        [
          { id: "input", value: { q: "look up the customer" } },
          { id: "cassette:1", value: { result: { content: [{ type: "text", text: JSON.stringify({ phone: written }) }] } } }
        ],
        { key }
      );
      const text = JSON.stringify(masked[1]!.value);
      expect(text.replace(/\D/g, ""), written).not.toContain(national);
      expect(report.values.phone, written).toBe(1);
      const stored = (JSON.parse((masked[1]!.value as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { phone: string }).phone;
      expect(stored.startsWith(`+${cc}`), `${written} -> ${stored}`).toBe(true);
      expect(stored.replace(/\d/g, "#"), written).toBe(written.replace(/\d/g, "#"));
    }
  });

  it("round 3 A4: Hungarian 06 and Russian 8 national forms get the same surrogate as the international form", () => {
    for (const [international, national, nationalWritten] of [
      ["+36 30 123 4567", "301234567", "06 30 123 4567"],
      ["+7 495 123 4567", "4951234567", "8 (495) 123-45-67"]
    ] as const) {
      const { parts: masked } = maskRecording([{ id: "input", value: { a: international, b: nationalWritten } }], { key });
      const value = masked[0]!.value as { a: string; b: string };
      expect(JSON.stringify(value).replace(/\D/g, ""), international).not.toContain(national);
      const trunk = nationalWritten.startsWith("06") ? "06" : "8";
      expect(value.b.startsWith(trunk), value.b).toBe(true);
      const cc = international.slice(1).split(" ")[0]!;
      expect(value.a.replace(/\D/g, "").slice(cc.length), value.a).toBe(value.b.replace(/\D/g, "").slice(trunk.length));
    }
  });

  it("round 3 A3: identifiers are never masked; one holding a collected value drops the capture", () => {
    const parts: MaskPart[] = [{ id: "cassette:1", value: { args: { email: EMAIL } } }];
    const kept = maskRecording(parts, { key, identifiers: [{ id: "cassette server", text: "registry:crm" }, { id: "tool name", text: "crm_lookup" }] });
    expect(JSON.stringify(kept.parts)).not.toContain(EMAIL);
    expect(() => maskRecording(parts, { key, identifiers: [{ id: "tool name", text: `lookup_${EMAIL}` }] })).toThrow(MaskIdentifierError);
    const dictionaries = [{ dataClass: "project_name", terms: ["atlas"], patterns: [], score: 0.9 }];
    expect(() =>
      maskRecording([{ id: "input", value: "ask atlas" }], { key, dictionaries, identifiers: [{ id: "cassette server", text: "registry:atlas" }] })
    ).toThrow(MaskIdentifierError);
  });

  it("property: no collected value survives in any form in any part", () => {
    const random = (() => {
      let state = 42;
      return () => {
        state = (state * 1103515245 + 12345) % 2_147_483_648;
        return state / 2_147_483_648;
      };
    })();
    const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(random() * 10))).join("");
    const luhn = (body: string) => {
      for (let d = 0; d <= 9; d += 1) if (luhnValid(body + d)) return body + d;
      return body + "0";
    };
    const subjects: Array<{ dataClass: string; written: string; canonical: string }> = [];
    for (let i = 0; i < 25; i += 1) {
      const local = `user${digits(4)}.x${i}`;
      subjects.push({ dataClass: "email", written: `${local}@example${i}.com`, canonical: `${local}@example${i}.com` });
      const card = luhn(`5${digits(14)}`);
      subjects.push({ dataClass: "card_number", written: card.replace(/(\d{4})(?=\d)/g, "$1 "), canonical: card });
      const phone = `${2 + Math.floor(random() * 7)}${digits(2)}${2 + Math.floor(random() * 7)}${digits(6)}`;
      subjects.push({ dataClass: "phone", written: `+1 (${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`, canonical: phone });
      // An 8-digit national number (Norway), written with its country code; its national forms appear elsewhere.
      const norway = `${2 + Math.floor(random() * 7)}${digits(7)}`;
      subjects.push({ dataClass: "phone8", written: `+47 ${norway.slice(0, 4)} ${norway.slice(4)}`, canonical: norway });
      // Round 3 (A2): international layouts the DLP phone pattern does not read, found only by the capture detector.
      const nz = (n: number) => `${2 + Math.floor(random() * 7)}${digits(n - 1)}`;
      const layouts: Array<[string, string]> = [];
      const us = nz(10);
      layouts.push([`+1${us}`, us]);
      const fr = nz(9);
      layouts.push([`+33 ${fr[0]} ${fr.slice(1, 3)} ${fr.slice(3, 5)} ${fr.slice(5, 7)} ${fr.slice(7)}`, fr]);
      const uk = nz(10);
      layouts.push([`+44 (0) ${uk.slice(0, 2)} ${uk.slice(2, 6)} ${uk.slice(6)}`, uk]);
      const au = nz(9);
      layouts.push([`+61 ${au[0]} ${au.slice(1, 5)} ${au.slice(5)}`, au]);
      const india = nz(10);
      layouts.push([`+91 ${india.slice(0, 5)} ${india.slice(5)}`, india]);
      const jp = nz(9);
      layouts.push([`+81 ${jp[0]}-${jp.slice(1, 5)}-${jp.slice(5)}`, jp]);
      const ie = nz(8);
      layouts.push([`+353 ${ie[0]} ${ie.slice(1, 4)} ${ie.slice(4)}`, ie]);
      const ru = nz(10);
      layouts.push([`+7 ${ru.slice(0, 3)} ${ru.slice(3, 6)}-${ru.slice(6, 8)}-${ru.slice(8)}`, ru]);
      const [written, canonical] = layouts[i % layouts.length]!;
      subjects.push({ dataClass: "intl", written, canonical });
    }
    // Each value appears formatted once, then in other forms elsewhere.
    const forms = (subject: (typeof subjects)[number]): unknown[] => {
      const c = subject.canonical;
      if (subject.dataClass === "email") return [c.toUpperCase(), encodeURIComponent(c), c.replace("@", "\\u0040"), JSON.stringify({ to: c })];
      if (subject.dataClass === "phone8") return [c, `0${c}`, `47${c}`, `0047 ${c}`, Number(`47${c}`), `${c.slice(0, 4)} ${c.slice(4)}`, JSON.stringify({ n: c })];
      if (subject.dataClass === "intl") return [subject.written, subject.written.replace(/[^+\d]/g, ""), JSON.stringify({ phone: subject.written.replace(/[^+\d]/g, "") }), encodeURIComponent(subject.written)];
      return [
        c,
        Number(c),
        c.replace(/(\d{3})(?=\d)/g, "$1-"),
        c.replace(/(\d{4})(?=\d)/g, "$1.").replace(/\./g, "%20"),
        JSON.stringify({ n: c }),
        `${c.slice(0, 3)}\\u0020${c.slice(3)}`
      ];
    };
    const parts: MaskPart[] = [
      // International numbers never appear in the input: only the capture detector can find them in a tool result.
      { id: "input", value: subjects.filter((subject) => subject.dataClass !== "intl").map((subject) => `${subject.written}`).join("; ") },
      ...subjects.map((subject, i) => ({ id: `tool:${i}`, nodeId: `n${i % 5}`, value: { args: forms(subject), [`k-${subject.canonical}`]: [forms(subject)] } }))
    ];
    const { parts: masked } = maskRecording(parts, { key });
    const decodedAll = masked
      .map((part) => JSON.stringify(part.value))
      .map((text) => decodeView(decodeView(text).text).text)
      .join("\n");
    const flat = decodedAll.replace(/[\s().\-]/g, "");
    for (const subject of subjects) {
      if (subject.dataClass === "email") expect(decodedAll.toLowerCase(), subject.written).not.toContain(subject.canonical);
      else if (subject.dataClass === "phone" || subject.dataClass === "phone8" || subject.dataClass === "intl") expect(flat, subject.written).not.toContain(subject.canonical);
      else expect(flat, subject.written).not.toContain(subject.canonical);
    }
    // And the index finds none of them in what is stored.
    const index = new SubjectIndex();
    for (const subject of subjects) index.add(subject.written, subject.dataClass === "phone8" || subject.dataClass === "intl" ? "phone" : subject.dataClass);
    for (const part of masked) expect(index.matches(JSON.stringify(part.value)), part.id).toBe(false);
  });

  it("gives the event loop turns while masking a large run", async () => {
    const big = Array.from({ length: 6_000 }, (_, i) => ({ text: `customer user${i}@example.com paid with ${CARD}`, n: i }));
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    let immediates = 0;
    const spin = () => {
      immediates += 1;
      if (immediates < 1_000_000) setImmediate(spin);
    };
    setImmediate(spin);
    try {
      const { report } = await maskRecordingAsync([{ id: "node:big", nodeId: "big", value: big }], { key });
      expect(report.values.email).toBe(6_000);
    } finally {
      clearInterval(timer);
      immediates = 1_000_000;
    }
    // Other work ran between the chunks.
    expect(immediates).toBeGreaterThan(2);
  });
});

describe("SubjectIndex strict (the data-subject lookup never over-matches)", () => {
  const strict = (value: string, dataClass: string) => {
    const index = new SubjectIndex({ strict: true });
    if (dataClass === "raw") index.addLiteral(value, "raw");
    else index.add(value, dataClass);
    return (text: string) => index.matches(text);
  };

  it("re-review N2 probes: another person's data never matches", () => {
    const usPhone = strict("+1 (207) 946-0958", "phone");
    expect(usPhone("tel +44 20 7946 0958")).toBe(false);
    const ssn = strict("123-45-6788", "us_ssn");
    expect(ssn("call +1 912-345-6788")).toBe(false);
    expect(ssn("order 99123456788")).toBe(false);
    const account = strict("123456789012", "raw");
    expect(account("account 777456789012")).toBe(false);
    expect(account("ref 1-123456789012")).toBe(false);
    const phone = strict("+1 415-555-1234", "phone");
    expect(phone("invoice no. 2024155551234")).toBe(false);
    expect(phone("card 4000 0041 5555 1234")).toBe(false);
    expect(phone("x4155551234")).toBe(false);
  });

  it("true matches: the same number in E.164, national, dashed and digits-only forms", () => {
    const phone = strict("+1 415-555-1234", "phone");
    for (const text of ["+14155551234", "(415) 555-1234", "415.555.1234", "4155551234", "14155551234", '{"phone":"+1 415 555 1234"}', "415-555-1234 / 415-555-9999"]) expect(phone(text), text).toBe(true);
    const ssn = strict("123-45-6788", "us_ssn");
    for (const text of ["SSN 123-45-6788.", "123456788", '{"ssn":"123 45 6788"}']) expect(ssn(text), text).toBe(true);
    const card = strict("4111 1111 1111 1111", "card_number");
    expect(card("4111111111111111")).toBe(true);
    expect(card("94111 1111 1111 1111")).toBe(false);
    expect(strict("123456789012", "raw")("account 123456789012.")).toBe(true);
    const norway = strict("+47 2212 3456", "phone");
    expect(norway("22123456")).toBe(true);
    expect(norway("+47 22 12 34 56")).toBe(true);
    expect(norway("+45 2212 3456")).toBe(false);
  });

  const certaintyOf = (value: string, dataClass: string) => {
    const index = new SubjectIndex({ strict: true });
    index.add(value, dataClass);
    return (text: string) => {
      const spans = index.find(decodeView(text).text);
      if (spans.length === 0) return null;
      return spans.some((span) => (span.certainty ?? "exact") === "exact") ? "exact" : "national_only";
    };
  };

  it("round 3 A1: every re-review 2 over-match is national_only or no match, never exact", () => {
    const rows: Array<[string, string, "national_only" | null]> = [
      ["+44 20 7946 0958", "call (207) 946-0958", "national_only"],
      ["+1 (207) 946-0958", "ring 020 7946 0958", "national_only"],
      ["(415) 555-1234", "+33 415 555 1234", "national_only"],
      ["(415) 555-1234", "+49 415 555 1234", "national_only"],
      ["(207) 946-0958", "44 207 946 0958", null],
      ["020 7946 0958", "(207) 946-0958", "national_only"],
      ["020 7946 0958", "+1 207 946 0958", "national_only"],
      ["415-555-1234", "ids 7 415 555 1234", null],
      ["415-555-1234", "ids 86 415 555 1234", null]
    ];
    for (const [query, stored, expected] of rows) expect(certaintyOf(query, "phone")(stored), `${query} vs ${stored}`).toBe(expected);
  });

  it("round 3 A1: the same number with its country code on both sides is exact", () => {
    const phone = certaintyOf("+1 415-555-1234", "phone");
    for (const text of ["+14155551234", "tel:+14155551234", "0014155551234", '{"phone":"+1 (415) 555-1234"}']) expect(phone(text), text).toBe("exact");
    for (const text of ["4155551234", "1-415-555-1234", '"phone":4155551234', "(415) 555-1234"]) expect(phone(text), text).toBe("national_only");
    expect(certaintyOf("123-45-6788", "us_ssn")("SSN 123 45 6788")).toBe("exact");
  });

  it("round 3 A4: Hungarian and Russian national forms are possible matches, not missed", () => {
    expect(certaintyOf("+36 1 234 5678", "phone")("call 06 1 234 5678")).toBe("national_only");
    expect(certaintyOf("+7 495 123 4567", "phone")("call 8 (495) 123-45-67")).toBe("national_only");
  });

  it("round 3 A5: a hit written with an area code in brackets starts at the bracket", () => {
    const index = new SubjectIndex({ strict: true });
    index.add("+1 (207) 946-0958", "phone");
    const text = "call (207) 946-0958 now";
    const [span] = index.find(text);
    expect(text.slice(span!.start, span!.end)).toBe("(207) 946-0958");
  });
});
