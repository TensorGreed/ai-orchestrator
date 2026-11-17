import { checkRegexSafety, ENTITIES_DETECTOR_ID } from "@ai-orchestrator/shared";
import { describe, expect, it } from "vitest";
import { entityClassesFor, EntityScanError, riskLevelOf, scanSensitiveTextAsync, sensitiveScanSettingsOf } from "../content-tools";
import { DEFAULT_GUARD_PROFILE_DOCUMENT } from "../default-profile";
import { evaluateGuard } from "../evaluate";
import { createDefaultGuardRegistry } from "../index";
import { maskForDataClass } from "../masking";
import { parseGuardProfile } from "../profile";
import { createDefaultProtectionRegistry } from "../protection/index";
import { InMemoryPlaceholderBook } from "../protection/placeholder";
import { guardDetectorVersions, guardVerdictMemoKey } from "../verdict-memo";
import { createEntitiesDetector, entitiesOptionIssues, entityEngineInfo, findEntities, parseEntitiesOptions, RuleBasedEntityRecognizer, type GuardEntityRecognizer } from "./entities";
import { CA_POSTCODE_PATTERN, ENTITY_TOKEN_PATTERN, recognizeEntitiesByRules, UK_POSTCODE_PATTERN } from "./entities-rules";

const ALL = new Set(["person_name", "location", "street_address"]);

function found(text: string, classes: ReadonlySet<string> = ALL): Array<[string, string, number]> {
  return recognizeEntitiesByRules(text, { classes }).map((span) => [span.dataClass, text.slice(span.start, span.end), span.score]);
}

function values(text: string, dataClass: string): string[] {
  return found(text)
    .filter(([found]) => found === dataClass)
    .map(([, value]) => value);
}

function profileWith(options: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return parseGuardProfile({
    id: "names",
    name: "Names",
    version: "1",
    channels: {
      prompt: {
        detectors: [{ id: ENTITIES_DETECTOR_ID, threshold: 0.5, options }],
        actions: { person_name: { action: "redact" }, street_address: { action: "redact" }, location: { action: "redact" } },
        defaultAction: { action: "allow" }
      }
    },
    ...extra
  });
}

describe("rule-based street addresses", () => {
  it("finds US addresses with a state and ZIP code", () => {
    expect(found("Ship to 1600 Pennsylvania Avenue NW, Washington, DC 20500 today")).toEqual([["street_address", "1600 Pennsylvania Avenue NW, Washington, DC 20500", 0.95]]);
    expect(values("350 5th Ave, Suite 300\nNew York, NY 10118-0110", "street_address")).toEqual(["350 5th Ave, Suite 300\nNew York, NY 10118-0110"]);
    expect(values("PO Box 123, Springfield, IL 62704", "street_address")).toEqual(["PO Box 123, Springfield, IL 62704"]);
  });

  it("finds UK, Canadian and Australian addresses", () => {
    expect(found("Write to 221B Baker Street, London NW1 6XE.")).toEqual([["street_address", "221B Baker Street, London NW1 6XE", 0.95]]);
    expect(found("Office: 100 King St W, Toronto, ON M5H 1A1")).toEqual([["street_address", "100 King St W, Toronto, ON M5H 1A1", 0.95]]);
    expect(found("Deliver to 12 Smith Rd, Bondi NSW 2026")).toEqual([["street_address", "12 Smith Rd, Bondi NSW 2026", 0.95]]);
  });

  it("finds German and French addresses", () => {
    expect(found("Bitte an Hauptstraße 5, 10115 Berlin senden")).toEqual([["street_address", "Hauptstraße 5, 10115 Berlin", 0.95]]);
    expect(values("an die Berliner Straße 12a", "street_address")).toEqual(["Berliner Straße 12a"]);
    expect(found("Envoyez au 12 rue de la Paix, 75002 Paris")).toEqual([["street_address", "12 rue de la Paix, 75002 Paris", 0.95]]);
  });

  it("scores a street line without a locality lower, and higher after an address label", () => {
    expect(found("We met at 10 Downing Street.")).toEqual([["street_address", "10 Downing Street", 0.75]]);
    expect(found("Address: 10 Downing Street")).toEqual([["street_address", "10 Downing Street", 0.85]]);
  });

  it("never reports a postcode, a number or a version on its own", () => {
    expect(found("ZIP 62704, postcode SW1A 2AA, PLZ 10115, version 1.2.3 and 3 Way handshake, order 500 units")).toEqual([]);
    expect(found("const mainStreet = getMainStreet(42);")).toEqual([]);
  });
});

describe("rule-based names", () => {
  it("reports names after a title, a field label, a greeting, a sign-off or a phrase", () => {
    expect(values("Please call Dr. Ana Diaz tomorrow", "person_name")).toEqual(["Ana Diaz"]);
    expect(values("Patient: Wanjiru Kamau\nDOB: 1990", "person_name")).toEqual(["Wanjiru Kamau"]);
    expect(values("Dear Priyanka,\nthanks for the note", "person_name")).toEqual(["Priyanka"]);
    expect(values("See you soon.\nKind regards,\nOlusegun Bello", "person_name")).toEqual(["Olusegun Bello"]);
    expect(values("Hello, my name is Tom Lee and I need help", "person_name")).toEqual(["Tom Lee"]);
    expect(values("Mr O'Brien's account", "person_name")).toEqual(["O'Brien"]);
  });

  it("reports a listed given name and surname without a cue", () => {
    expect(found("Maria Garcia approved it")).toEqual([["person_name", "Maria Garcia", 0.8]]);
  });

  it("does not take look-alikes for names", () => {
    expect(values("Dear Customer, Hello World, Hi Team, Dear Sir or Madam", "person_name")).toEqual([]);
    // A listed word alone or with an unlisted second word scores below the default minimum (0.75).
    const scores = found("We met in May 2024 about the Jordan release. Will Power played.").filter(([dataClass]) => dataClass === "person_name");
    expect(scores.every(([, , score]) => score < 0.75)).toBe(true);
    expect(values("Contact ACME Corp support", "person_name")).toEqual([]);
  });
});

describe("rule-based locations", () => {
  it("reports listed places after a place cue and labelled places", () => {
    expect(values("She lives in Lisbon and was born in Jordan", "location")).toEqual(["Lisbon", "Jordan"]);
    expect(values("City: Springfield\nCountry: United States", "location")).toEqual(["Springfield", "United States"]);
    expect(values("Our office in Paris, France opened", "location")).toEqual(["Paris, France"]);
  });

  it("scores a listed place without a cue low, and needs a strong cue for one that is also a name or word", () => {
    expect(found("Australia won")).toEqual([["location", "Australia", 0.6]]);
    expect(values("Talk to Jordan about Nice ideas", "location")).toEqual([]);
  });
});

describe("rule-based patterns", () => {
  it("pass the backtracking check", () => {
    for (const pattern of [ENTITY_TOKEN_PATTERN, UK_POSTCODE_PATTERN, CA_POSTCODE_PATTERN]) expect(checkRegexSafety(pattern.source).safe).toBe(true);
  });

  it("run in time linear in the text", () => {
    const hostile = "1 ".repeat(50_000) + "Aa ".repeat(50_000) + "Dear ".repeat(20_000) + ":".repeat(20_000);
    const started = performance.now();
    recognizeEntitiesByRules(hostile, { classes: ALL });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("data.entities options", () => {
  it("requires classes and refuses unknown keys such as an endpoint", () => {
    expect(entitiesOptionIssues({}).map((issue) => issue.option)).toContain("classes");
    expect(entitiesOptionIssues({ classes: [] }).length).toBeGreaterThan(0);
    expect(entitiesOptionIssues({ classes: ["person_name"], url: "http://10.0.0.1" }).length).toBeGreaterThan(0);
    expect(entitiesOptionIssues({ classes: ["person_name"], minScore: { person_name: 2 } }).length).toBeGreaterThan(0);
    expect(entitiesOptionIssues({ classes: ["person_name", "location"], dictionaries: [] })).toEqual([]);
    expect(parseEntitiesOptions({ classes: ["street_address"] })).toMatchObject({ engine: "auto", minLength: 3, singleTokenNames: false, languages: ["en"], maxChars: 20_000 });
  });
});

describe("data.entities detector", () => {
  const registry = createDefaultGuardRegistry();

  it("is registered, opt-in and absent from the built-in rule set", () => {
    expect(registry.get(ENTITIES_DETECTOR_ID)?.tier).toBe("classifier");
    expect(JSON.stringify(DEFAULT_GUARD_PROFILE_DOCUMENT)).not.toContain(ENTITIES_DETECTOR_ID);
    expect(JSON.stringify(DEFAULT_GUARD_PROFILE_DOCUMENT)).not.toContain("person_name");
  });

  it("redacts names and addresses with masked evidence only", async () => {
    const text = "Patient: Ana Diaz lives at 221B Baker Street, London NW1 6XE.";
    const verdict = await evaluateGuard(profileWith({ classes: ["person_name", "street_address"] }), { channel: "prompt", content: text }, { registry });
    expect(verdict.content).toBe("Patient: [REDACTED:person_name] lives at [REDACTED:street_address].");
    expect(verdict.findings.map((finding) => finding.evidence)).toEqual(["A•• D•••", "•••• B•••• S•••••, L••••• N•• •••"]);
    expect(JSON.stringify(verdict.findings)).not.toContain("Diaz");
    expect(JSON.stringify(verdict.trace)).not.toContain("Baker");
  });

  it("reports only the classes asked for", async () => {
    const verdict = await evaluateGuard(profileWith({ classes: ["location"] }), { channel: "prompt", content: "Dr. Ana Diaz moved to Lisbon" }, { registry });
    expect(verdict.findings.map((finding) => finding.dataClass)).toEqual(["location"]);
  });

  it("keeps findings under the class's minimum score as suppressed", async () => {
    const text = "Maria Garcia approved it";
    const strict = await evaluateGuard(profileWith({ classes: ["person_name"], minScore: { person_name: 0.85 } }), { channel: "prompt", content: text }, { registry });
    expect(strict.findings).toEqual([]);
    expect(strict.suppressed.map((finding) => finding.dataClass)).toEqual(["person_name"]);
    expect(strict.action).toBe("allow");
    const loose = await evaluateGuard(profileWith({ classes: ["person_name"] }), { channel: "prompt", content: text }, { registry });
    expect(loose.findings.map((finding) => finding.dataClass)).toEqual(["person_name"]);
  });

  it("applies the rule set's allow-list", async () => {
    const verdict = await evaluateGuard(profileWith({ classes: ["person_name"] }, { allowList: { values: ["Ana Diaz"] } }), { channel: "prompt", content: "Dr. Ana Diaz and Dr. Tom Lee" }, { registry });
    expect(verdict.content).toBe("Dr. Ana Diaz and Dr. [REDACTED:person_name]");
  });

  it("drops spans in emails, URLs, code, placeholders and issued surrogates, and yields to data rule findings", async () => {
    const recognizer = fixedRecognizer((text) => ["Ana", "Diaz", "Tom Lee", "Main", "Rosa Park", "Iris Wu"].flatMap((value) => occurrences(text, value).map((start) => ({ start, end: start + value.length, dataClass: "person_name", score: 0.9, source: "test", cue: true }))));
    const text = "ana.diaz@example.com https://x.io/Tom%20Lee/?q=Tom Lee `Main` [PERSON_NAME_1] Rosa Park and Iris Wu";
    const matches = await findEntities(text, parseEntitiesOptions({ classes: ["person_name"] }), { recognizer, issuedSurrogates: new Set(["Rosa Park"]) });
    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["Iris Wu"]);
  });

  it("does not hide the rest of the text behind an unclosed code fence", async () => {
    const text = "```\nconst x = 1\nDr. Ana Diaz wrote ``` and then ``` Dr. Tom Lee replied";
    const matches = await findEntities(text, parseEntitiesOptions({ classes: ["person_name"] }));
    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["Tom Lee"]);
  });

  it("stays fast on long text with many one-word names, emails and data findings", async () => {
    const names = fixedRecognizer((text) => occurrences(text, "Kim").map((start) => ({ start, end: start + 3, dataClass: "person_name", score: 0.9, source: "model" })));
    const oneLine = "Kim ".repeat(200_000);
    let started = performance.now();
    await findEntities(oneLine, parseEntitiesOptions({ classes: ["person_name"], maxChars: 1_000_000 }), { recognizer: names });
    expect(performance.now() - started).toBeLessThan(3_000);
    const mixed = "Kim a@b.io 10.0.0.1 ".repeat(30_000);
    started = performance.now();
    const matches = await findEntities(mixed, parseEntitiesOptions({ classes: ["person_name"], singleTokenNames: true, maxChars: 1_000_000 }), { recognizer: names });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(matches).toHaveLength(30_000);
  });

  it("needs a cue for a one-word name unless singleTokenNames is on", async () => {
    const recognizer = fixedRecognizer((text) => occurrences(text, "Kim").map((start) => ({ start, end: start + 3, dataClass: "person_name", score: 0.9, source: "model" })));
    const text = "Kim said hi. Dear Kim, thanks";
    const off = await findEntities(text, parseEntitiesOptions({ classes: ["person_name"] }), { recognizer });
    expect(off.map((match) => match.start)).toEqual([text.lastIndexOf("Kim")]);
    const on = await findEntities(text, parseEntitiesOptions({ classes: ["person_name"], singleTokenNames: true }), { recognizer });
    expect(on).toHaveLength(2);
  });

  it("raises and lowers scores by context words", async () => {
    const text = "Maria Garcia approved it";
    const [boosted] = await findEntities(text, parseEntitiesOptions({ classes: ["person_name"], contextWords: { boost: ["approved"] } }));
    const [lowered] = await findEntities(text, parseEntitiesOptions({ classes: ["person_name"], contextWords: { suppress: ["approved"] } }));
    expect(boosted!.score).toBeCloseTo(0.9);
    expect(lowered!.score).toBeCloseTo(0.5);
  });

  it("uses the deployment's recognizer for engine auto and the rules for engine rules, ignoring malformed spans", async () => {
    const recognizer = fixedRecognizer((text) => [
      { start: 0, end: 4, dataClass: "location", score: 0.95, source: "model" },
      { start: -1, end: 2, dataClass: "location", score: 0.95, source: "model" },
      { start: 0, end: 4, dataClass: "credit_card", score: 0.95, source: "model" },
      { start: 0, end: text.length + 5, dataClass: "location", score: 0.95, source: "model" }
    ]);
    const deployment = createDefaultGuardRegistry({ entityRecognizer: recognizer });
    const auto = await evaluateGuard(profileWith({ classes: ["location"] }), { channel: "prompt", content: "Oslo is cold" }, { registry: deployment });
    expect(auto.findings.map((finding) => [finding.evidence, finding.metadata?.source])).toEqual([["O•••", "model"]]);
    const rules = await evaluateGuard(profileWith({ classes: ["location"], engine: "rules" }), { channel: "prompt", content: "Oslo is cold" }, { registry: deployment });
    expect(rules.findings).toEqual([]);
  });

  it("fails the check on long text, recognizer errors and timeouts, and the rule set's policy decides", async () => {
    const long = "word ".repeat(10);
    for (const onExceeded of ["fail_closed", "fail_open"] as const) {
      const profile = profileWith({ classes: ["person_name"], maxChars: 10 }, { latencyBudget: { ms: 2000, onExceeded } });
      const verdict = await evaluateGuard(profile, { channel: "prompt", content: long }, { registry });
      expect(verdict.timings.detectors[0]).toMatchObject({ status: "error", error: expect.stringContaining("text longer than maxChars") });
      expect(verdict.action).toBe(onExceeded === "fail_closed" ? "block" : "allow");
    }
    const failing = createDefaultGuardRegistry({ entityRecognizer: { ...fixedRecognizer(() => []), recognize: async () => Promise.reject(new Error("model not loaded")) } });
    const error = await evaluateGuard(profileWith({ classes: ["person_name"] }, { latencyBudget: { ms: 2000, onExceeded: "fail_closed" } }), { channel: "prompt", content: "hi" }, { registry: failing });
    expect(error.action).toBe("block");
    const leaky = createDefaultGuardRegistry({ entityRecognizer: { ...fixedRecognizer(() => []), recognize: async () => Promise.reject(new Error("could not parse 'Ana Diaz'")) } });
    const quiet = await evaluateGuard(profileWith({ classes: ["person_name"] }, { latencyBudget: { ms: 2000, onExceeded: "fail_closed" } }), { channel: "prompt", content: "Ana Diaz" }, { registry: leaky });
    expect(JSON.stringify([quiet.trace, quiet.timings, quiet.actions])).not.toContain("Ana Diaz");
    expect(quiet.timings.detectors[0]!.error).toContain("Entity recognizer test failed");
    const slow = createDefaultGuardRegistry({ entityRecognizer: { ...fixedRecognizer(() => []), recognize: () => new Promise(() => undefined) } });
    const timedOut = await evaluateGuard(profileWith({ classes: ["person_name"] }, { latencyBudget: { ms: 20, onExceeded: "fail_open" } }), { channel: "prompt", content: "hi" }, { registry: slow });
    expect(timedOut.timings.detectors[0]!.status).toBe("timed_out");
    expect(timedOut.action).toBe("allow");
  });

  it("writes readable placeholders for the new classes", async () => {
    const book = new InMemoryPlaceholderBook();
    const protection = createDefaultProtectionRegistry({ placeholders: book });
    const profile = parseGuardProfile({
      id: "p",
      name: "P",
      version: "1",
      channels: {
        prompt: {
          detectors: [{ id: ENTITIES_DETECTOR_ID, threshold: 0.5, options: { classes: ["person_name", "street_address", "location"] } }],
          actions: { person_name: { action: "redact", providerId: "placeholder" }, street_address: { action: "redact", providerId: "placeholder" }, location: { action: "redact", providerId: "placeholder" } },
          defaultAction: { action: "allow" }
        }
      }
    });
    const verdict = await evaluateGuard(profile, { channel: "prompt", content: "Dr. Ana Diaz, 10 Downing Street, moved to Lisbon. Dr. Ana Diaz agreed." }, { registry, protection });
    expect(verdict.content).toBe("Dr. [PERSON_NAME_1], [STREET_ADDRESS_1], moved to [LOCATION_1]. Dr. [PERSON_NAME_1] agreed.");
  });

  it("puts the recognizer's version in the verdict memo key", () => {
    const profile = profileWith({ classes: ["person_name"] });
    const input = { channel: "prompt" as const, content: "hello" };
    const rules = guardDetectorVersions(input, [profile], registry);
    const model = guardDetectorVersions(input, [profile], createDefaultGuardRegistry({ entityRecognizer: fixedRecognizer(() => [], "2") }));
    const modelNext = guardDetectorVersions(input, [profile], createDefaultGuardRegistry({ entityRecognizer: fixedRecognizer(() => [], "3") }));
    expect(rules[0]).toMatch(/^data\.entities=rules:/);
    const keys = new Set([rules, model, modelNext].map((versions) => guardVerdictMemoKey(["h"], input, versions)));
    expect(keys.size).toBe(3);
    // Rule sets without a versioned detector keep the key they had.
    expect(guardVerdictMemoKey(["h"], input, guardDetectorVersions(input, [parseGuardProfile({ id: "d", name: "D", version: "1", channels: { prompt: { detectors: [{ id: "dlp.patterns" }] } } })], registry))).toBe(guardVerdictMemoKey(["h"], input));
  });

  it("reads text already sent for a cue, and rewrites only the released part of a stream", async () => {
    const sent = "Please contact Dr. ";
    const release = "Ana Diaz today. ";
    const held = "Then Dr. Tom Lee";
    const content = sent + release + held;
    const verdict = await evaluateGuard(profileWith({ classes: ["person_name"] }), { channel: "prompt", content, streamWindow: { start: sent.length, end: sent.length + release.length } }, { registry });
    expect(verdict.content).toBe(`${sent}[REDACTED:person_name] today. ${held}`);
  });

  it("reports the engine for the detector list", () => {
    expect(entityEngineInfo(undefined)).toMatchObject({ id: "rules", status: "rules", languages: ["en"] });
    expect(createEntitiesDetector({ recognizer: fixedRecognizer(() => []) }).engine()).toMatchObject({ id: "test", status: "loaded" });
  });
});

describe("masking names, places and addresses", () => {
  it("keeps the first letter of each word and masks digits", () => {
    expect(maskForDataClass("Ana María Diaz", "person_name")).toBe("A•• M•••• D•••");
    expect(maskForDataClass("O'Brien", "person_name")).toBe("O••••••");
    expect(maskForDataClass("221B Baker St.", "street_address")).toBe("•••• B•••• S•.");
    expect(maskForDataClass("New York", "location")).toBe("N•• Y•••");
  });
});

describe("content tools with names and addresses", () => {
  it("scans entity classes only when named or configured, never as part of all classes", async () => {
    const text = "Dr. Ana Diaz, ana@example.com, 10 Downing Street";
    const plain = await scanSensitiveTextAsync(text, { dictionaries: [] });
    expect(plain.findings.map((finding) => finding.dataClass)).toEqual(["email"]);
    const named = await scanSensitiveTextAsync(text, { dictionaries: [] }, { entityTypes: ["person_name", "street_address"] });
    expect(named.findings.map((finding) => [finding.dataClass, finding.preview])).toEqual([["person_name", "A•• D•••"], ["street_address", "•• D•••••• S•••••"]]);
    const settings = sensitiveScanSettingsOf(profileWith({ classes: ["street_address"] }));
    expect(entityClassesFor(settings, {})).toEqual(["street_address"]);
    const configured = await scanSensitiveTextAsync(text, settings);
    expect(configured.findings.map((finding) => finding.dataClass)).toEqual(["email", "street_address"]);
    expect(riskLevelOf(configured.findings)).toBe("medium");
  });

  it("wraps recognizer failures in EntityScanError and leaves other scans alone", async () => {
    const failing: GuardEntityRecognizer = { ...fixedRecognizer(() => []), recognize: async () => Promise.reject(new Error("boom")) };
    await expect(scanSensitiveTextAsync("Ana", { dictionaries: [] }, { entityTypes: ["person_name"] }, { recognizer: failing })).rejects.toBeInstanceOf(EntityScanError);
    await expect(scanSensitiveTextAsync("Ana", { dictionaries: [] }, {}, { recognizer: failing })).resolves.toMatchObject({ findings: [] });
  });

  it("applies allow-lists and lets data rule matches win", async () => {
    const text = "Dr. Ana Diaz and Dr. Tom Lee";
    const result = await scanSensitiveTextAsync(text, { dictionaries: [], allowList: { values: ["Tom Lee"] } }, { entityTypes: ["person_name"] });
    expect(result.findings.map((finding) => text.slice(finding.start, finding.end))).toEqual(["Ana Diaz"]);
    const dictionary = await scanSensitiveTextAsync(text, { dictionaries: [{ dataClass: "person_name", terms: ["Tom Lee"], patterns: [], score: 0.95 }] }, { entityTypes: ["person_name"] });
    expect(dictionary.findings.map((finding) => [text.slice(finding.start, finding.end), finding.score])).toEqual([["Ana Diaz", 0.9], ["Tom Lee", 0.95]]);
  });
});

function fixedRecognizer(spans: (text: string) => Array<{ start: number; end: number; dataClass: string; score: number; source: string; cue?: boolean }>, version = "1"): GuardEntityRecognizer {
  return {
    id: "test",
    version,
    classes: ["person_name", "location", "street_address"],
    languages: "any",
    recognize: async (texts) => texts.map((text) => spans(text))
  };
}

function occurrences(text: string, value: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) out.push(at);
  return out;
}

// The rules recognizer is the default stand-in.
void RuleBasedEntityRecognizer;
