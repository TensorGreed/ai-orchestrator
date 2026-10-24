import { describe, expect, it } from "vitest";
import { maskRecording, maskedClassesForNode, resolveOverlaps, type MaskPart } from "./capture-mask";
import { ibanValid, luhnValid, scanDlp } from "./detectors/dlp";
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
    const workflow = JSON.stringify({ nodes: [{ config: { systemPrompt: `Escalate to support@acme.test. ${TOKEN}` } }] });
    const { parts: masked, report } = maskRecording(
      [{ id: "tape:1", value: `Escalate to support@acme.test. ${TOKEN} Customer ${EMAIL}` }],
      { key, keepValuesIn: workflow }
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
});
