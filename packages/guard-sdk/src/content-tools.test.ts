import { describe, expect, it } from "vitest";
import { compileAllowList } from "./allow-list";
import { highestRiskLevel, mapStrings, riskLevelOf, rewriteMatches, scanSensitiveText, sensitiveScanSettingsOf, stringsIn } from "./content-tools";
import { DEFAULT_GUARD_PROFILE_DOCUMENT } from "./default-profile";
import { findIpAddressSpans } from "./detectors/ip-address";
import { scanDlp } from "./detectors/dlp";
import { evaluateGuard } from "./evaluate";
import { createDefaultGuardRegistry } from "./index";
import { hashGuardProfile, parseGuardProfile, profileRevealRules } from "./profile";
import { createDefaultProtectionRegistry } from "./protection/index";
import { createPlaceholderProvider, InMemoryPlaceholderBook, placeholderLabel, placeholdersIn } from "./protection/placeholder";
import { revealTokens } from "./protection/reveal";

const ips = (text: string) => findIpAddressSpans(text).map((span) => text.slice(span.start, span.end));

describe("IP address detector", () => {
  it("finds IPv4 and IPv6 addresses", () => {
    expect(ips("from 10.0.0.1 and 192.168.1.254, then 2001:db8::8a2e:370:7334 and ::1.")).toEqual(["10.0.0.1", "192.168.1.254", "2001:db8::8a2e:370:7334", "::1"]);
    expect(ips("mapped ::ffff:10.0.0.7 here")).toEqual(["::ffff:10.0.0.7"]);
  });

  it("skips version strings, bad octets, longer dotted runs and clock times", () => {
    expect(ips("upgrade to v1.2.3.4 or version 2.0.0.1, release 3.1.4.1 and 1.2.3.4-beta")).toEqual([]);
    expect(ips("999.1.1.1 01.2.3.4 1.2.3.4.5 12:30:45 a::b::c")).toEqual([]);
  });

  it("is opt-in: the data scan reports ip_address only when asked", () => {
    const text = "server 10.1.2.3";
    expect(scanDlp(text).map((match) => match.dataClass)).toEqual([]);
    expect(scanDlp(text, { include: ["ip_address"] }).map((match) => match.dataClass)).toEqual(["ip_address"]);
  });

  it("leaves the built-in rule set unchanged (no ip_address there)", () => {
    expect(JSON.stringify(DEFAULT_GUARD_PROFILE_DOCUMENT)).not.toContain("ip_address");
  });
});

describe("allow-list", () => {
  it("matches exact values without case and with separators removed, and simple globs", () => {
    const list = compileAllowList({ values: ["Support@Company.com", "4111 1111 1111 1111"], patterns: ["*@example.com", "test-??@corp.io"] });
    expect(list.allows("support@company.com")).toBe(true);
    expect(list.allows("4111111111111111")).toBe(true);
    expect(list.allows("anyone@example.com")).toBe(true);
    expect(list.allows("test-01@corp.io")).toBe(true);
    expect(list.allows("test-001@corp.io")).toBe(false);
    expect(list.allows("alice@company.com")).toBe(false);
  });

  it("matches globs by their segments, anchored where the pattern has no star", () => {
    const list = compileAllowList({ patterns: ["*@example.com", "test-??@acme.*", "a*b*c", "*"] });
    expect(compileAllowList({ patterns: ["*@example.com"] }).allows("ana@example.com")).toBe(true);
    expect(compileAllowList({ patterns: ["*@example.com"] }).allows("ana@example.community")).toBe(false);
    expect(compileAllowList({ patterns: ["test-??@acme.*"] }).allows("test-01@acme.io")).toBe(true);
    expect(compileAllowList({ patterns: ["test-??@acme.*"] }).allows("test-1@acme.io")).toBe(false);
    expect(compileAllowList({ patterns: ["a*b*c"] }).allows("axxbyyc")).toBe(true);
    expect(compileAllowList({ patterns: ["a*b*c"] }).allows("axxcyyb")).toBe(false);
    expect(compileAllowList({ patterns: ["ab*ba"] }).allows("aba")).toBe(false);
    expect(list.allows("anything")).toBe(true);
  });

  it("stays fast on adversarial patterns and long findings", () => {
    const patterns = Array.from({ length: 100 }, (_, index) => `*${"a".repeat(250)}${index}`);
    const list = compileAllowList({ patterns });
    const started = performance.now();
    expect(list.allows("a".repeat(200_000))).toBe(false);
    for (let i = 0; i < 200; i += 1) expect(list.allows(`${"a".repeat(500)}b${i}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("drops allow-listed values in the data scan", () => {
    const text = "write to support@company.com or alice@company.com, card 4111 1111 1111 1111";
    const classes = scanDlp(text, { allowList: compileAllowList({ values: ["support@company.com", "4111111111111111"] }) }).map((match) => text.slice(match.span.start, match.span.end));
    expect(classes).toEqual(["alice@company.com"]);
  });

  it("is part of the rule set schema and applies to every data-class finding in evaluation", async () => {
    const base = parseGuardProfile({ id: "a", name: "A", version: "1", channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], defaultAction: { action: "block" }, actions: { email: { action: "redact" } } } }, dictionaries: [{ dataClass: "project_code", terms: ["ORION"] }] });
    const listed = parseGuardProfile({ ...base, allowList: { values: ["support@company.com", "orion"] } });
    expect(hashGuardProfile(listed)).not.toBe(hashGuardProfile(base));
    expect(parseGuardProfile({ ...base }).allowList).toBeUndefined();
    const verdict = await evaluateGuard(listed, { channel: "prompt", content: "mail support@company.com about ORION" }, { registry: createDefaultGuardRegistry() });
    expect(verdict.action).toBe("allow");
    const blocked = await evaluateGuard(base, { channel: "prompt", content: "mail support@company.com about ORION" }, { registry: createDefaultGuardRegistry() });
    expect(blocked.action).toBe("block");
  });
});

describe("risk level", () => {
  it("maps findings to none, low, medium and high", () => {
    expect(riskLevelOf([])).toBe("none");
    expect(riskLevelOf([{ dataClass: "phone", score: 0.5 }])).toBe("low");
    expect(riskLevelOf([{ dataClass: "email", score: 0.95 }])).toBe("medium");
    expect(riskLevelOf([{ dataClass: "card_number", score: 0.9 }, { dataClass: "email", score: 0.95 }])).toBe("high");
    expect(riskLevelOf([{ dataClass: "credential", score: 0.7 }])).toBe("medium");
    expect(highestRiskLevel(["low", "high", "none"])).toBe("high");
    expect(highestRiskLevel([])).toBe("none");
  });
});

describe("scanSensitiveText", () => {
  it("reports masked previews, never values, filtered by entity types", () => {
    const text = "alice@example.com, 4111 1111 1111 1111, 10.0.0.9";
    const all = scanSensitiveText(text, { dictionaries: [] });
    expect(all.findings.map((finding) => finding.dataClass)).toEqual(["email", "card_number"]);
    expect(JSON.stringify(all.findings)).not.toContain("alice@example.com");
    expect(JSON.stringify(all.findings)).not.toContain("4111 1111 1111 1111");
    const only = scanSensitiveText(text, { dictionaries: [] }, { entityTypes: ["ip_address"] });
    expect(only.findings.map((finding) => [finding.dataClass, finding.preview])).toEqual([["ip_address", "••.•.•.•"]]);
  });

  it("takes dictionaries, allow-list and data detector options from a rule set", () => {
    const profile = parseGuardProfile({
      id: "s",
      name: "S",
      version: "1",
      channels: { tool_arguments: { detectors: [{ id: "dlp.patterns", options: { include: ["ip_address"], disable: ["phone"] } }] } },
      allowList: { values: ["10.0.0.1"] }
    });
    const settings = sensitiveScanSettingsOf(profile);
    const found = scanSensitiveText("10.0.0.1 10.0.0.2 +1 415 555 0100", settings).findings.map((finding) => finding.dataClass);
    expect(found).toEqual(["ip_address"]);
  });

  it("walks JSON values without putting value-like keys in paths", async () => {
    const value = { a: ["x", { b: "y" }], "bob@example.com": "z", n: 3 };
    expect(stringsIn(value).map((ref) => ref.path)).toEqual(["$.a{key}", "$.a[0]", "$.a[1].b{key}", "$.a[1].b", "${#1}{key}", "${#1}", "$.n{key}"]);
    expect(stringsIn(value).find((ref) => ref.path === "${#1}{key}")).toEqual({ path: "${#1}{key}", text: "bob@example.com", key: true });
    let deep: unknown = "x";
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(() => stringsIn(deep)).toThrow(/nested deeper/);
    await expect(mapStrings(deep, async (text) => text)).rejects.toThrow(/nested deeper/);
    const rewritten = await mapStrings({ ...value, ["__proto__"]: "p" }, async (text) => text.toUpperCase());
    expect(rewritten).toMatchObject({ a: ["X", { b: "Y" }], "bob@example.com": "Z", n: 3 });
    expect(Object.getPrototypeOf(rewritten)).toBe(Object.prototype);
  });

  it("rewrites disjoint matches", async () => {
    const text = "card 4111 1111 1111 1111 and alice@example.com";
    const { matches } = scanSensitiveText(text, { dictionaries: [] });
    expect(await rewriteMatches(text, matches, async (_value, dataClass) => `<${dataClass}>`)).toBe("card <card_number> and <email>");
  });
});

describe("placeholder provider", () => {
  it("numbers per class, keeps the same placeholder for the same value, and reserves placeholders already in the text", async () => {
    const book = new InMemoryPlaceholderBook();
    const provider = createPlaceholderProvider({ book });
    const text = "[EMAIL_1] was typed by hand; a@x.io, b@x.io, a@x.io, +1 415 555 0100";
    expect(await provider.protect("a@x.io", { dataClass: "email", text })).toBe("[EMAIL_2]");
    expect(await provider.protect("b@x.io", { dataClass: "email", text })).toBe("[EMAIL_3]");
    expect(await provider.protect("a@x.io", { dataClass: "email", text })).toBe("[EMAIL_2]");
    expect(await provider.protect("+1 415 555 0100", { dataClass: "phone", text })).toBe("[PHONE_1]");
    expect(await book.lookup("[EMAIL_1]")).toBeUndefined();
    expect(await provider.reveal!("[EMAIL_3]", { dataClass: "email" })).toBe("b@x.io");
    await expect(provider.reveal!("[EMAIL_3]", { dataClass: "phone" })).rejects.toThrow(/another data class/);
    // A reserved placeholder stays reserved for later texts too.
    expect(await provider.protect("c@x.io", { dataClass: "email", text: "nothing" })).toBe("[EMAIL_4]");
    const restored = new InMemoryPlaceholderBook(book.state());
    expect(await restored.assign("email", "d@x.io")).toBe("[EMAIL_5]");
    expect(await restored.assign("email", "a@x.io")).toBe("[EMAIL_2]");
  });

  it("labels classes readably and finds placeholders in text", () => {
    expect(placeholderLabel("card_number")).toBe("CARD_NUMBER");
    expect(placeholderLabel("acme.customer-id")).toBe("ACME_CUSTOMER_ID");
    expect(placeholderLabel("--")).toBe("VALUE");
    expect([...placeholdersIn("x [EMAIL_1] [card_1] [US_SSN_12] [EMAIL_]")]).toEqual(["[EMAIL_1]", "[US_SSN_12]"]);
  });

  it("is a registered provider usable by protect and redact rules, with the run's book", async () => {
    const book = new InMemoryPlaceholderBook();
    const protection = createDefaultProtectionRegistry({ placeholders: book });
    const profile = parseGuardProfile({
      id: "p",
      name: "P",
      version: "1",
      channels: {
        prompt: {
          detectors: [{ id: "dlp.patterns", threshold: 0.5 }],
          actions: { email: { action: "protect", providerId: "placeholder" }, card_number: { action: "redact", providerId: "placeholder" } },
          defaultAction: { action: "allow" }
        }
      }
    });
    const verdict = await evaluateGuard(profile, { channel: "prompt", content: "a@x.io [EMAIL_1] 4111 1111 1111 1111 a@x.io" }, { registry: createDefaultGuardRegistry(), protection });
    expect(verdict.content).toBe("[EMAIL_2] [EMAIL_1] [CARD_NUMBER_1] [EMAIL_2]");
    expect(book.size).toBe(2);
  });
});

describe("reveal rules and placeholders", () => {
  it("reveals placeholders of a book under the same rules and leaves unknown ones alone", async () => {
    const book = new InMemoryPlaceholderBook();
    await book.assign("email", "a@x.io");
    await book.assign("phone", "+1 415 555 0100");
    const result = await revealTokens("to [EMAIL_1] call [PHONE_1], not [EMAIL_9]", {
      placeholders: book,
      grant: (dataClass) => (dataClass === "email" ? { rule: { profileId: "p", version: 1, index: 0 } } : undefined),
      allowedClasses: ["email"],
      projectId: "p1",
      allowUnscoped: false
    });
    expect(result.content).toBe("to a@x.io call [PHONE_1], not [EMAIL_9]");
    expect(result.revealed.map((entry) => [entry.dataClass, entry.count])).toEqual([["email", 1]]);
    expect(result.refused.map((entry) => [entry.dataClass, entry.reason])).toEqual([["phone", "no_rule"]]);
  });

  it("accepts gateway clients as reveal rule subjects", () => {
    const profile = parseGuardProfile({ id: "r", name: "R", version: "1", reveal: { rules: [{ dataClasses: ["email"], subjects: { gatewayClients: ["mcpc_1"] } }] } });
    expect(profileRevealRules(profile)[0]!.subjects.gatewayClients).toEqual(["mcpc_1"]);
    expect(() => parseGuardProfile({ id: "r", name: "R", version: "1", reveal: { rules: [{ dataClasses: ["email"], subjects: {} }] } })).toThrow(/gateway client/);
  });
});
