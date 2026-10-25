import { describe, expect, it } from "vitest";
import { GUARD_CHANNEL_VALUES, SURROGATE_REVEAL_REFUSED_MESSAGE, type DataLabels, type ResolvedDestination } from "@ai-orchestrator/shared";
import { createDefaultGuardProfile } from "./default-profile";
import { dropIssuedSurrogates, evaluateDestinationRules, isSurrogateEmail, LABEL_ONLY_REASON, profileHasDestinationRules } from "./destinations";
import { scanDlp } from "./detectors/dlp";
import { createDefaultProtectionRegistry, revealRefusal, staticKeyResolver, surrogateFor } from "./protection/index";
import { guardChannelSchema, hashGuardProfile, parseGuardProfile, type GuardProfileInput } from "./profile";
import { GUARD_CHANNELS, GuardProtectionError } from "./types";

/** The built-in default profile's hash on main before Phase 16. Destination rules and the egress channel must not move it. */
const DEFAULT_PROFILE_HASH = "38a972eb9d53a6890647cdc2b7c0f6ce4b9002fd33f497b2b195e3737d2e1aa5";

const labels = (partial: Partial<DataLabels> = {}): DataLabels => ({ provenance: [], dataClasses: [], source: "propagated", ...partial });
const dest = (partial: Partial<ResolvedDestination> = {}): ResolvedDestination => ({ tier: "public", region: "unknown", holdsDataClasses: [], matchedBy: "unmatched", ...partial });

function profileWith(rules: unknown[], extra: Partial<GuardProfileInput> = {}) {
  return parseGuardProfile({ id: "p", name: "P", version: "1", ...extra, destinations: { rules } });
}

const keepInHouse = { when: { dataClasses: ["card_number", "iban", "us_ssn"] }, allow: { maxTier: "private" }, action: "redact" };

describe("profile destinations section", () => {
  it("keeps the built-in default profile hash and adds no destinations or egress channel to it", () => {
    const base = createDefaultGuardProfile();
    expect(hashGuardProfile(base)).toBe(DEFAULT_PROFILE_HASH);
    expect(base.destinations).toBeUndefined();
    expect(base.channels.egress).toBeUndefined();
    expect(profileHasDestinationRules(base)).toBe(false);
  });

  it("parses rules with defaults, and a profile with rules hashes differently", () => {
    const base = createDefaultGuardProfile();
    const withRules = parseGuardProfile({ ...base, destinations: { rules: [{ allow: { maxTier: "vendor" }, action: "block" }] } });
    expect(withRules.destinations?.rules[0]).toEqual({ when: {}, allow: { maxTier: "vendor" }, action: "block" });
    expect(hashGuardProfile(withRules)).not.toBe(hashGuardProfile(base));
    expect(profileHasDestinationRules(withRules)).toBe(true);
    expect(profileHasDestinationRules(parseGuardProfile({ ...base, destinations: {} }))).toBe(false);
  });

  it("refuses bad rules with the reason", () => {
    expect(() => profileWith([{ allow: { maxTier: "nearby" }, action: "block" }])).toThrow(/destinations/);
    expect(() => profileWith([{ allow: { maxTier: "private" }, action: "allow" }])).toThrow(/action/);
    expect(() => profileWith([{ allow: { maxTier: "private" }, action: "transform" }])).toThrow(/action/);
    expect(() => profileWith([{ when: { provenance: ["somewhere"] }, allow: { maxTier: "private" }, action: "block" }])).toThrow(/provenance/);
    expect(() => profileWith([{ allow: { maxTier: "private" }, action: "redact" }])).toThrow(/need data classes/);
  });

  it("accepts an egress channel on profiles; the Guard node's channel list stays without it", () => {
    expect(GUARD_CHANNELS).toContain("egress");
    expect(guardChannelSchema.safeParse("egress").success).toBe(true);
    const profile = parseGuardProfile({ id: "p", name: "P", version: "1", channels: { egress: { detectors: [{ id: "dlp" }] } } });
    expect(profile.channels.egress?.detectors[0]?.id).toBe("dlp");
    expect(GUARD_CHANNEL_VALUES as readonly string[]).not.toContain("egress");
  });
});

describe("evaluateDestinationRules", () => {
  it("evaluates nothing without rules", () => {
    expect(evaluateDestinationRules(createDefaultGuardProfile(), { labels: labels({ dataClasses: ["card_number"] }), foundClasses: ["card_number"], destination: dest() })).toEqual({ fired: [] });
  });

  it("fires when a matching class goes beyond the allowed tier, with basis content", () => {
    const result = evaluateDestinationRules(profileWith([keepInHouse]), { labels: labels(), foundClasses: ["card_number", "email"], destination: dest({ name: "api.example.com" }) });
    expect(result.fired).toEqual([
      {
        ruleIndex: 0,
        dataClass: "card_number",
        action: "redact",
        requestedAction: "redact",
        shadow: false,
        basis: "content",
        reason: "Data of class card_number may go no further than private network; this destination is api.example.com (public)"
      }
    ]);
  });

  it("does not fire within the allowed tier", () => {
    const profile = profileWith([keepInHouse]);
    for (const tier of ["local", "private"] as const) {
      expect(evaluateDestinationRules(profile, { labels: labels(), foundClasses: ["card_number"], destination: dest({ tier }) }).fired).toEqual([]);
    }
    expect(evaluateDestinationRules(profile, { labels: labels(), foundClasses: ["card_number"], destination: dest({ tier: "vendor" }) }).fired).toHaveLength(1);
  });

  it("lets through classes the destination is approved to hold", () => {
    const profile = profileWith([keepInHouse]);
    const result = evaluateDestinationRules(profile, { labels: labels({ dataClasses: ["iban"] }), foundClasses: ["card_number"], destination: dest({ tier: "vendor", holdsDataClasses: ["card_number"] }) });
    expect(result.fired.map((entry) => entry.dataClass)).toEqual(["iban"]);
  });

  it("a class only the labels carry falls back to the protection fallback (block by default) with the plain reason", () => {
    const result = evaluateDestinationRules(profileWith([keepInHouse]), { labels: labels({ dataClasses: ["us_ssn"] }), foundClasses: [], destination: dest() });
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]).toMatchObject({ dataClass: "us_ssn", basis: "labels", action: "block", requestedAction: "redact" });
    expect(result.fired[0]!.reason).toContain(LABEL_ONLY_REASON);
    expect(LABEL_ONLY_REASON).toBe("matched by where the data came from, not found in the text");
  });

  it("uses the profile's protection fallback for label-only rewrites only when it still stops the data", () => {
    const run = (fallback: string, action = "mask") =>
      evaluateDestinationRules(profileWith([{ ...keepInHouse, action }], { protection: { fallback } } as Partial<GuardProfileInput>), {
        labels: labels({ dataClasses: ["iban"] }),
        foundClasses: [],
        destination: dest()
      }).fired[0]!;
    // A fallback that stops the data is kept.
    expect(run("block").action).toBe("block");
    expect(run("require_approval").action).toBe("require_approval");
    // Anything that would let the data leave (or rewrite text that is not there) becomes block.
    for (const fallback of ["allow", "review", "redact", "mask", "transform"]) {
      expect(run(fallback, "protect")).toMatchObject({ action: "block", requestedAction: "protect", basis: "labels" });
    }
    // Block, review and approval rules keep their action on labels alone.
    expect(run("allow", "require_approval")).toMatchObject({ action: "require_approval", basis: "labels" });
    expect(run("allow", "review")).toMatchObject({ action: "review", basis: "labels" });
  });

  it("a class found in the content and in the labels counts as content", () => {
    const result = evaluateDestinationRules(profileWith([keepInHouse]), { labels: labels({ dataClasses: ["iban"] }), foundClasses: ["iban"], destination: dest() });
    expect(result.fired[0]).toMatchObject({ basis: "content", action: "redact" });
  });

  it("matches provenance labels (basis labels) and any-match across conditions", () => {
    const profile = profileWith([{ when: { dataClasses: ["email"], provenance: ["sensitive", "untrusted_external"] }, allow: { maxTier: "vendor" }, action: "block", name: "Sensitive stays home" }]);
    const result = evaluateDestinationRules(profile, { labels: labels({ provenance: ["user", "sensitive"] }), foundClasses: ["email"], destination: dest() });
    expect(result.fired.map((entry) => [entry.dataClass ?? entry.provenance, entry.basis])).toEqual([
      ["email", "content"],
      ["sensitive", "labels"]
    ]);
    expect(result.fired[1]!.reason).toMatch(/^Rule "Sensitive stays home": Data labelled sensitive may go no further than approved vendor/);
    // Provenance never passes through holdsDataClasses.
    expect(evaluateDestinationRules(profile, { labels: labels({ provenance: ["sensitive"] }), foundClasses: [], destination: dest({ holdsDataClasses: ["sensitive"] }) }).fired).toHaveLength(1);
    expect(evaluateDestinationRules(profile, { labels: labels({ provenance: ["trusted"] }), foundClasses: [], destination: dest() }).fired).toEqual([]);
  });

  it("a rule without conditions covers any outgoing data", () => {
    const profile = profileWith([{ allow: { maxTier: "vendor" }, action: "review" }]);
    expect(evaluateDestinationRules(profile, { labels: labels(), foundClasses: [], destination: dest() }).fired).toEqual([
      expect.objectContaining({ ruleIndex: 0, action: "review", basis: "content" })
    ]);
    expect(evaluateDestinationRules(profile, { labels: labels(), foundClasses: [], destination: dest({ tier: "vendor" }) }).fired).toEqual([]);
  });

  it("checks regions by prefix; an unknown region fails a region rule", () => {
    const profile = profileWith([{ when: { dataClasses: ["email"] }, allow: { maxTier: "public", regions: ["eu"] }, action: "block" }]);
    const run = (region: string) => evaluateDestinationRules(profile, { labels: labels(), foundClasses: ["email"], destination: dest({ tier: "vendor", region }) }).fired;
    expect(run("eu-west-1")).toEqual([]);
    expect(run("us-east-1")).toHaveLength(1);
    expect(run("unknown")).toHaveLength(1);
    expect(run("us-east-1")[0]!.reason).toContain("may only go to regions eu");
  });

  it("applies region conditions to vendor and public destinations only; local and private always pass", () => {
    const profile = profileWith([{ when: { dataClasses: ["email"] }, allow: { maxTier: "public", regions: ["eu"] }, action: "block" }]);
    const run = (tier: ResolvedDestination["tier"], region: string) =>
      evaluateDestinationRules(profile, { labels: labels(), foundClasses: ["email"], destination: dest({ tier, region }) }).fired;
    expect(run("local", "unknown")).toEqual([]);
    expect(run("private", "unknown")).toEqual([]);
    expect(run("private", "us-east-1")).toEqual([]);
    expect(run("vendor", "unknown")).toHaveLength(1);
    expect(run("public", "us-east-1")).toHaveLength(1);
    expect(run("public", "eu-central-1")).toEqual([]);
  });

  it("takes shadow from the rule, else from the profile's per-action flag", () => {
    const profile = profileWith([{ ...keepInHouse, action: "block" }, { ...keepInHouse, action: "block", shadow: true }, { ...keepInHouse, action: "review", shadow: false }], { shadow: { block: true, review: true } });
    const fired = evaluateDestinationRules(profile, { labels: labels(), foundClasses: ["iban"], destination: dest() }).fired;
    expect(fired.map((entry) => [entry.ruleIndex, entry.shadow])).toEqual([
      [0, true],
      [1, true],
      [2, false]
    ]);
  });
});

describe("issued surrogates", () => {
  const key = new Uint8Array(32).fill(7);

  it("recognises surrogate emails by their domain", () => {
    expect(isSurrogateEmail("u-0123456789ab@surrogate.invalid")).toBe(true);
    expect(isSurrogateEmail(" Someone@SURROGATE.invalid ")).toBe(true);
    expect(isSurrogateEmail("someone@surrogate.invalid.example.com")).toBe(false);
    expect(isSurrogateEmail("someone@example.com")).toBe(false);
    expect(isSurrogateEmail("@surrogate.invalid")).toBe(false);
  });

  it("drops scan matches that are surrogates this run issued, keeps the real values", () => {
    const card = surrogateFor("4111 1111 1111 1111", "card_number", key);
    const email = surrogateFor("ann@example.com", "email", key);
    const text = `card ${card} and real 5500 0000 0000 0004, mail ${email} and bob@example.com`;
    const matches = scanDlp(text);
    expect(matches.map((m) => m.dataClass).sort()).toEqual(["card_number", "card_number", "email", "email"]);
    const kept = dropIssuedSurrogates(matches, new Set([card]), text);
    expect(kept.map((m) => text.slice(m.span.start, m.span.end))).toEqual(expect.arrayContaining(["5500 0000 0000 0004", "bob@example.com"]));
    expect(kept).toHaveLength(2);
  });

  it("works on matches carrying values or several spans, and keeps what it cannot read", () => {
    expect(dropIssuedSurrogates([{ value: "123-45-6789", dataClass: "us_ssn" }, { value: "987-65-4321", dataClass: "us_ssn" }], new Set(["123-45-6789"]))).toEqual([{ value: "987-65-4321", dataClass: "us_ssn" }]);
    const text = "x AAA y BBB";
    const finding = { dataClass: "custom", spans: [{ start: 2, end: 5 }, { start: 8, end: 11 }] };
    expect(dropIssuedSurrogates([finding], new Set(["AAA"]), text)).toEqual([finding]);
    expect(dropIssuedSurrogates([finding], new Set(["AAA", "BBB"]), text)).toEqual([]);
    expect(dropIssuedSurrogates([{ dataClass: "email", span: { start: 0, end: 3 } }], new Set(["abc"]))).toHaveLength(1);
    // Only emails are recognised by domain; another class at that domain needs the issued set.
    expect(dropIssuedSurrogates([{ value: "x@surrogate.invalid", dataClass: "custom" }], new Set())).toHaveLength(1);
  });
});

describe("surrogate reveal", () => {
  it("is refused with a pointer to the token vault", async () => {
    const registry = createDefaultProtectionRegistry({ keys: staticKeyResolver({ k: new Uint8Array(32).fill(1) }), defaultKeyId: "k" });
    const surrogate = registry.get("surrogate")!;
    expect(surrogate.reversible).toBe(false);
    expect(revealRefusal(surrogate)).toBe(SURROGATE_REVEAL_REFUSED_MESSAGE);
    await expect(surrogate.reveal!("u-0123456789ab@surrogate.invalid", { dataClass: "email" })).rejects.toThrow(GuardProtectionError);
    await expect(surrogate.reveal!("x", { dataClass: "email" })).rejects.toThrow(SURROGATE_REVEAL_REFUSED_MESSAGE);
    expect(revealRefusal(registry.get("token_vault")!)).toBeUndefined();
    expect(revealRefusal(registry.get("keyed_hash")!)).toMatch(/one-way/);
  });
});
