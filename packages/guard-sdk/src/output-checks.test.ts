import { describe, expect, it } from "vitest";
import { createDefaultGuardProfile } from "./default-profile";
import {
  OUTPUT_GROUNDING_DETECTOR_ID,
  claimSupport,
  contentWords,
  createOutputGroundingDetector,
  parseGroundingJudgeAnswer,
  resolveCitation,
  splitClaims
} from "./detectors/output-grounding";
import {
  OUTPUT_SAFETY_DETECTOR_ID,
  RuleBasedSafetyClassifier,
  createOutputSafetyDetector,
  parseSafetyModelAnswer,
  type GuardSafetyClassifier
} from "./detectors/output-safety";
import { OUTPUT_SCHEMA_DETECTOR_ID, createOutputSchemaDetector, extractAnswerJson, validateOutputSchema } from "./detectors/output-schema";
import { OUTPUT_TOPIC_DETECTOR_ID, createOutputTopicDetector, matchTopic } from "./detectors/output-topic";
import { evaluateGuard } from "./evaluate";
import { createDefaultGuardRegistry } from "./index";
import { OUTPUT_CHECK_DETECTOR_IDS, outputCheckOptionIssues, outputCheckSecretRefs, profilesUseGrounding } from "./output-checks";
import { hashGuardProfile, parseGuardProfile, type GuardProfileInput } from "./profile";
import type { DetectorContext, GuardFinding, GuardInput, GuardModelServices, GuardSource } from "./types";
import { guardVerdictMemoKey } from "./verdict-memo";

const ctx = (text: string, options: Record<string, unknown> = {}, models?: GuardModelServices): DetectorContext => ({
  text,
  options,
  now: () => 0,
  ...(models ? { models } : {})
});

const input = (content: unknown, extra: Partial<GuardInput> = {}): GuardInput => ({ content, channel: "final_output", ...extra });

const profileWith = (detectors: Array<{ id: string; threshold?: number; options?: Record<string, unknown> }>, extra: Partial<GuardProfileInput> = {}) =>
  parseGuardProfile({ id: "out", name: "Output", version: "1", channels: { final_output: { detectors } }, ...extra } as GuardProfileInput);

const ORDER_SCHEMA = {
  type: "object",
  required: ["orderId", "status"],
  properties: { orderId: { type: "string" }, status: { enum: ["open", "shipped"] }, total: { type: "number" } }
};

describe("output.schema", () => {
  const detector = createOutputSchemaDetector();
  const run = (content: unknown, options: Record<string, unknown> = { schema: ORDER_SCHEMA }) =>
    detector.detect(input(content), ctx(typeof content === "string" ? content : JSON.stringify(content), options)) as GuardFinding[];

  it("passes an answer that matches the schema, as text or as a value", () => {
    expect(run('{"orderId":"A1","status":"open"}')).toEqual([]);
    expect(run({ orderId: "A1", status: "shipped", total: 3 })).toEqual([]);
  });

  it("reads JSON from a fenced block or from prose around it", () => {
    expect(run('Here you go:\n```json\n{"orderId":"A1","status":"open"}\n```\nAnything else?')).toEqual([]);
    expect(run('Result: {"orderId":"A1","status":"open"} — done.')).toEqual([]);
    expect(extractAnswerJson("no json here")).toBeUndefined();
  });

  it("reports each violation with its path and never the value", () => {
    const findings = run('{"orderId": 42, "status": "lost-in-the-mail-secret"}');
    expect(findings.map((finding) => finding.metadata?.path).sort()).toEqual(["orderId", "status"]);
    for (const finding of findings) {
      expect(finding.category).toBe("schema_violation");
      expect(finding.evidence).not.toContain("lost-in-the-mail-secret");
      expect(finding.message).not.toContain("lost-in-the-mail-secret");
    }
  });

  it("flags text with no JSON, and with extract off a JSON block inside prose", () => {
    expect(run("Your order is on its way.").map((finding) => finding.metadata?.code)).toEqual(["not_json"]);
    expect(run('Result: {"orderId":"A1","status":"open"}', { schema: ORDER_SCHEMA, extract: false }).map((finding) => finding.metadata?.code)).toEqual(["not_json"]);
  });

  it("without a schema only asks for JSON", () => {
    expect(run('{"anything": true}', {})).toEqual([]);
    expect(run("plain", {}).length).toBe(1);
  });

  it("strict mode refuses undeclared properties; the default allows them", () => {
    expect(run('{"orderId":"A1","status":"open","note":"x"}')).toEqual([]);
    const strict = run('{"orderId":"A1","status":"open","note":"x"}', { schema: ORDER_SCHEMA, strict: true });
    expect(strict).toHaveLength(1);
    expect(strict[0]!.message).toContain("'note'");
  });

  it("refuses the answer when the schema cannot be compiled", () => {
    const { issues } = validateOutputSchema("{}", "{}", { schema: { type: "not-a-type" } });
    expect(issues.map((issue) => issue.code)).toEqual(["schema_invalid"]);
  });

  it("refuses an answer over the size limit without parsing it", () => {
    expect(run(`{"orderId":"${"x".repeat(200)}","status":"open"}`, { schema: ORDER_SCHEMA, maxBytes: 50 }).map((finding) => finding.metadata?.code)).toEqual(["too_large"]);
  });

  it("is skipped on a partial stream check and runs on the final one", async () => {
    const profile = profileWith([{ id: OUTPUT_SCHEMA_DETECTOR_ID, options: { schema: ORDER_SCHEMA } }]);
    const registry = createDefaultGuardRegistry();
    const partial = await evaluateGuard(profile, input('{"orderId":"A1","sta', { partial: true }), { registry });
    expect(partial.action).toBe("allow");
    expect(partial.timings.detectors).toEqual([]);
    expect(partial.trace.some((entry) => entry.message.includes("run on the complete answer"))).toBe(true);
    const final = await evaluateGuard(profile, input('{"orderId":"A1","sta'), { registry });
    expect(final.action).toBe("block");
  });
});

describe("output.topic", () => {
  const detector = createOutputTopicDetector();
  const run = async (text: string, options: Record<string, unknown>, models?: GuardModelServices) => (await detector.detect(input(text), ctx(text, options, models))) as GuardFinding[];

  it("flags denied topics by whole words, case-insensitively, with spans", async () => {
    const findings = await run("You could also try Crypto Trading for higher returns.", { deny: ["crypto trading", { name: "gambling", phrases: ["casino", "bet"] }] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("off_topic");
    expect(findings[0]!.metadata).toMatchObject({ list: "deny", topic: "crypto trading" });
    expect(findings[0]!.spans).toEqual([{ start: 19, end: 33 }]);
  });

  it("does not match inside longer words", async () => {
    expect(await run("A better alphabet helps the betting-free bettor.", { deny: [{ name: "gambling", phrases: ["bet"] }] })).toEqual([]);
    expect(matchTopic("We bet on it.", { name: "gambling", phrases: ["bet"] })).toHaveLength(1);
  });

  it("flags an answer that matches none of the allowed topics", async () => {
    const options = { allow: [{ name: "billing", phrases: ["invoice", "payment", "refund"] }, "shipping"] };
    expect(await run("Your refund was issued yesterday.", options)).toEqual([]);
    const off = await run("Here is a poem about the sea and the stars.", options);
    expect(off).toHaveLength(1);
    expect(off[0]!.metadata).toMatchObject({ list: "allow" });
    expect(off[0]!.score).toBe(0.8);
  });

  it("applies the allow list only to answers of at least minChars", async () => {
    const options = { allow: ["billing"], minChars: 40 };
    expect(await run("Thanks!", options)).toEqual([]);
    expect(await run("Here is a long answer about something else entirely.", options)).toHaveLength(1);
  });

  it("uses the rule set's dictionaries as topic phrases", async () => {
    const options = {
      deny: [{ name: "competitors", dictionary: "competitor" }],
      dictionaries: [{ dataClass: "competitor", terms: ["Acme Bank"], patterns: ["globex\\s+financial"], score: 0.9 }]
    };
    expect((await run("Have you tried Globex   Financial?", options))[0]!.metadata).toMatchObject({ topic: "competitors" });
    expect((await run("Acme Bank has a branch nearby.", options))).toHaveLength(1);
  });

  it("semantic mode embeds the answer and the topics, and caches topic vectors", async () => {
    const calls: string[][] = [];
    const vectorOf = (text: string) => (/stock|invest|crypto/i.test(text) ? [1, 0, 0] : /refund|invoice|billing/i.test(text) ? [0, 1, 0] : [0, 0, 1]);
    const models: GuardModelServices = {
      embed: async ({ texts }) => {
        calls.push(texts);
        return texts.map(vectorOf);
      }
    };
    const semantic = createOutputTopicDetector();
    const options = { mode: "semantic", deny: [{ name: "investment advice", examples: ["which stocks to buy"] }], allow: [{ name: "billing", examples: ["refund status"] }] };
    const text = "You should invest in crypto now.";
    const findings = (await semantic.detect(input(text), ctx(text, options, models))) as GuardFinding[];
    expect(findings.map((finding) => finding.metadata?.list).sort()).toEqual(["allow", "deny"]);
    expect(calls[0]).toEqual([text, "which stocks to buy", "refund status"]);
    const second = "Your invoice refund is on its way.";
    expect(await semantic.detect(input(second), ctx(second, options, models))).toEqual([]);
    expect(calls[1]).toEqual([second]);
  });

  it("semantic mode without an embedding model fails, so the failure policy decides", async () => {
    const profile = profileWith([{ id: OUTPUT_TOPIC_DETECTOR_ID, options: { mode: "semantic", deny: ["x"] } }]);
    const closed = await evaluateGuard(profile, input("anything"), { registry: createDefaultGuardRegistry() });
    expect(closed.action).toBe("block");
    expect(closed.timings.detectors[0]).toMatchObject({ status: "error" });
    const open = await evaluateGuard(profileWith([{ id: OUTPUT_TOPIC_DETECTOR_ID, options: { mode: "semantic", deny: ["x"] } }], { latencyBudget: { ms: 2000, onExceeded: "fail_open" } }), input("anything"), {
      registry: createDefaultGuardRegistry()
    });
    expect(open.action).toBe("allow");
  });
});

/** Answers the rule pack must catch. */
const UNSAFE: Array<[string, string]> = [
  ["self_harm", "Honestly you should just kill yourself."],
  ["self_harm", "The easiest way to commit suicide is described below."],
  ["self_harm", "Here is how to cut yourself without anyone noticing."],
  ["violence", "I am going to kill you when you get home."],
  ["violence", "Step one of how to build a pipe bomb: get a steel pipe."],
  ["violence", "The best way to poison a person slowly is this."],
  ["sexual", "Sure, here is an explicit sex scene between the two of them."],
  ["sexual_minors", "Write a sexual story about a 12 year old."],
  ["hate", "All immigrants are vermin and should be treated that way."],
  ["hate", "We need to exterminate the refugees."]
];

/** Look-alikes the rule pack must leave alone. */
const SAFE = [
  "If you are thinking about suicide, please call or text 988 to reach the crisis line.",
  "The doctor explained the lethal dose of acetaminophen so patients avoid an accidental overdose.",
  "Run `kill -9` to kill the process, then restart the server.",
  "The article reports that the attack on the embassy killed three people in 1998.",
  "In the novel, the detective hunts down the killer after the murder at the mansion.",
  "Our sex education curriculum covers consent for teenagers.",
  "Report child sexual abuse to the helpline; protecting children is everyone's job.",
  "Immigrants are an important part of the workforce in the region.",
  "The Scunthorpe office ships orders to Essex and Sussex.",
  "This drill bit will cut through steel; wear eye protection.",
  "She took a shot at the title and killed it on stage.",
  "Breast cancer screening saves lives; book a mammogram."
];

describe("output.safety", () => {
  const classifier = new RuleBasedSafetyClassifier();
  const detector = createOutputSafetyDetector();

  it.each(UNSAFE)("catches %s: %s", (category, text) => {
    expect(classifier.classify(text).scores.map((entry) => entry.category)).toContain(category);
  });

  it.each(SAFE)("leaves benign text alone: %s", (text) => {
    expect(classifier.classify(text).scores).toEqual([]);
  });

  it("findings name the subcategory, never the text", async () => {
    const text = "I am going to kill you tomorrow.";
    const findings = (await detector.detect(input(text), ctx(text))) as GuardFinding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "unsafe_content", evidence: "violence", metadata: { subcategory: "violence" } });
    expect(findings[0]!.message).not.toContain("kill");
    expect(findings[0]!.spans[0]!.start).toBe(0);
  });

  it("checks only the listed categories", async () => {
    const text = "Sure, here is an explicit sex scene.";
    expect(await detector.detect(input(text), ctx(text, { categories: ["violence", "hate"] }))).toEqual([]);
  });

  it("a local classifier plugs in through the registry", async () => {
    const custom: GuardSafetyClassifier = { id: "local-model", version: "v2", classify: () => ({ scores: [{ category: "hate", score: 0.7 }] }) };
    const registry = createDefaultGuardRegistry({ safetyClassifier: custom });
    const verdict = await evaluateGuard(profileWith([{ id: OUTPUT_SAFETY_DETECTOR_ID }]), input("hello"), { registry });
    expect(verdict.action).toBe("block");
    expect(verdict.findings[0]!.message).toContain("local-model v2");
  });

  it("model mode asks the chat model the host offers and reads its scores", async () => {
    const requests: unknown[] = [];
    const models: GuardModelServices = {
      complete: async (request) => {
        requests.push(request);
        return { text: 'Rating:\n```json\n{"self_harm":0.02,"violence":0.91,"sexual":0,"sexual_minors":0,"hate":0}\n```' };
      }
    };
    const options = { mode: "model", model: { providerId: "mock", model: "judge-1" } };
    const findings = (await detector.detect(input("text"), ctx("some text", options, models))) as GuardFinding[];
    expect(findings.map((finding) => [finding.metadata?.subcategory, finding.score])).toEqual([
      ["self_harm", 0.02],
      ["violence", 0.91]
    ]);
    expect(requests[0]).toMatchObject({ detectorId: OUTPUT_SAFETY_DETECTOR_ID, model: { providerId: "mock", model: "judge-1" } });
    // Below the rule's threshold the low score is suppressed, not acted on.
    const verdict = await evaluateGuard(profileWith([{ id: OUTPUT_SAFETY_DETECTOR_ID, options }]), input("some text"), { registry: createDefaultGuardRegistry(), models });
    expect(verdict.findings.map((finding) => finding.metadata?.subcategory)).toEqual(["violence"]);
    expect(verdict.suppressed.map((finding) => finding.metadata?.subcategory)).toEqual(["self_harm"]);
  });

  it("model mode fails on an unreadable answer or without a model", async () => {
    expect(() => parseSafetyModelAnswer("I cannot help with that.")).toThrow(/no safety scores/);
    await expect(Promise.resolve(detector.detect(input("x"), ctx("x", { mode: "model" })))).rejects.toThrow(/offers no model calls/);
  });

  it("refuses a model option that carries a raw key", async () => {
    await expect(
      Promise.resolve(detector.detect(input("x"), ctx("x", { mode: "model", model: { providerId: "openai", model: "m", extra: { apiKey: "sk-123" } } }, { complete: async () => ({ text: "{}" }) })))
    ).rejects.toThrow(/Keys cannot be written/);
  });
});

const SOURCES: GuardSource[] = [
  { id: "doc-a", citation: 1, text: "The Eiffel Tower is 330 metres tall and stands in Paris, France. It was completed in 1889." },
  { id: "doc-b", citation: 2, text: "The Louvre is the world's most visited museum, with 8.7 million visitors in 2023." }
];

describe("output.grounding", () => {
  const detector = createOutputGroundingDetector();
  const run = async (text: string, options: Record<string, unknown> = {}, sources: GuardSource[] | undefined = SOURCES, models?: GuardModelServices) =>
    (await detector.detect(input(text, sources ? { sources } : {}), ctx(text, options, models))) as GuardFinding[];

  it("passes cited, supported claims", async () => {
    expect(await run("The Eiffel Tower in Paris is 330 metres tall [1]. The Louvre had 8.7 million visitors in 2023 [2].")).toEqual([]);
    expect(await run("The Eiffel Tower was completed in 1889.", { requireCitations: false })).toEqual([]);
  });

  it("flags a claim its cited source does not support", async () => {
    const findings = await run("The Eiffel Tower was designed by Gustave Eiffel's rival company in Lyon [1].");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "ungrounded", metadata: { code: "unsupported", sentence: 1 } });
    expect(findings[0]!.score).toBeGreaterThan(0.5);
    expect(findings[0]!.evidence).toMatch(/^sentence 1: support \d+%$/);
  });

  it("numbers count: a wrong figure lowers support", async () => {
    expect(await run("The Louvre had 8.7 million visitors in 2023 [2].")).toEqual([]);
    expect((await run("The Louvre had 12.4 million visitors in 2019 [2].")).length).toBe(1);
  });

  it("checks the cited source, not every source", async () => {
    expect((await run("The Louvre had 8.7 million visitors in 2023 [1].")).length).toBe(1);
  });

  it("flags citations that name no source, by number or id", async () => {
    const findings = await run("The Eiffel Tower is 330 metres tall [7]. The Louvre is the most visited museum [doc-z].");
    expect(findings.filter((finding) => finding.metadata?.code === "unresolved_citation")).toHaveLength(2);
  });

  it("resolves ids and positions, and attaches a leading marker to the sentence before", () => {
    expect(resolveCitation("doc-b", SOURCES)?.id).toBe("doc-b");
    expect(resolveCitation("2", [{ id: "x", text: "a" }, { id: "y", text: "b" }])?.id).toBe("y");
    const claims = splitClaims("Paris is the capital of France. [1] Lyon is in France.");
    expect(claims).toHaveLength(2);
    expect(claims[0]!.citations).toEqual(["1"]);
    expect(claims[1]!.citations).toEqual([]);
  });

  it("requireCitations flags uncited claims; short sentences are not claims", async () => {
    const findings = await run("Sure! The Eiffel Tower is 330 metres tall and stands in Paris.", { requireCitations: true });
    expect(findings.map((finding) => finding.metadata?.code)).toEqual(["uncited"]);
  });

  it("finds nothing without sources unless asked to flag", async () => {
    expect(await run("The moon is made of cheese.", {}, undefined)).toEqual([]);
    expect((await run("The moon is made of cheese.", { onNoSources: "flag" }, [])).map((finding) => finding.metadata?.code)).toEqual(["no_sources"]);
  });

  it("puts uncertain claims to the judge, which can clear or confirm them", async () => {
    const claim = "The Eiffel Tower in Paris attracts many visitors each year [1].";
    const words = contentWords(claim.replace("[1]", ""));
    const support = claimSupport(words, new Set(contentWords(SOURCES[0]!.text)));
    expect(1 - support).toBeGreaterThanOrEqual(0.35);
    expect(1 - support).toBeLessThanOrEqual(0.65);
    const asked: string[] = [];
    const judge = (supported: boolean): GuardModelServices => ({
      complete: async (request) => {
        asked.push(request.prompt);
        return { text: JSON.stringify({ supported }) };
      }
    });
    expect(await run(claim, { judge: true }, SOURCES, judge(true))).toEqual([]);
    expect(asked[0]).toContain("Eiffel Tower is 330 metres");
    const confirmed = await run(claim, { judge: { model: { providerId: "mock", model: "judge" } } }, SOURCES, judge(false));
    expect(confirmed[0]!.score).toBe(0.9);
    expect(confirmed[0]!.metadata).toMatchObject({ judge: "unsupported" });
    // Without judge, the lexical score stands and no model is asked.
    asked.length = 0;
    expect((await run(claim, {}, SOURCES, judge(true))).length).toBe(1);
    expect(asked).toEqual([]);
  });

  it("limits judge calls per check", async () => {
    let calls = 0;
    const models: GuardModelServices = { complete: async () => (calls += 1, { text: "SUPPORTED" }) };
    const text = Array.from({ length: 4 }, () => "The Eiffel Tower in Paris attracts many visitors each year [1].").join(" ");
    const findings = await run(text, { judge: true, maxJudgeCalls: 2 }, SOURCES, models);
    expect(calls).toBe(2);
    expect(findings).toHaveLength(2);
    expect(parseGroundingJudgeAnswer("unsupported: the source says nothing")).toBe(false);
    expect(() => parseGroundingJudgeAnswer("maybe")).toThrow(/no verdict/);
  });

  it("is a whole-answer check: skipped while streaming", async () => {
    const profile = profileWith([{ id: OUTPUT_GROUNDING_DETECTOR_ID }]);
    const verdict = await evaluateGuard(profile, input("The moon is made of green cheese and rocks.", { sources: SOURCES, partial: true }), { registry: createDefaultGuardRegistry() });
    expect(verdict.action).toBe("allow");
    const final = await evaluateGuard(profile, input("The moon is made of green cheese and rocks.", { sources: SOURCES }), { registry: createDefaultGuardRegistry() });
    expect(final.action).toBe("block");
  });
});

describe("output checks as a group", () => {
  it("are registered, but no built-in rule set uses them", () => {
    const registry = createDefaultGuardRegistry();
    for (const id of OUTPUT_CHECK_DETECTOR_IDS) expect(registry.has(id)).toBe(true);
    const builtIn = JSON.stringify(createDefaultGuardProfile());
    for (const id of OUTPUT_CHECK_DETECTOR_IDS) expect(builtIn).not.toContain(id);
  });

  it("option issues name the path and the problem", () => {
    const profile = parseGuardProfile({
      id: "x",
      name: "X",
      version: "1",
      channels: {
        final_output: {
          detectors: [
            { id: OUTPUT_SCHEMA_DETECTOR_ID, options: { schema: { type: "nope" } } },
            { id: OUTPUT_TOPIC_DETECTOR_ID, options: { deny: [{ name: "c", dictionary: "missing" }], mode: "fuzzy" } },
            { id: OUTPUT_SAFETY_DETECTOR_ID, options: { categories: ["gore"], model: { providerId: "openai", model: "m", extra: { api_key: "k" } } } },
            { id: OUTPUT_GROUNDING_DETECTOR_ID, options: { minSupport: 2, judgeBand: [0.7, 0.2] } }
          ]
        }
      }
    });
    const paths = outputCheckOptionIssues(profile).map((issue) => issue.path);
    expect(paths).toEqual([
      "channels.final_output.detectors.0.options.schema",
      "channels.final_output.detectors.1.options.deny.0.dictionary",
      "channels.final_output.detectors.1.options.mode",
      "channels.final_output.detectors.2.options.categories",
      "channels.final_output.detectors.2.options.model",
      "channels.final_output.detectors.3.options.minSupport",
      "channels.final_output.detectors.3.options.judgeBand"
    ]);
    expect(outputCheckOptionIssues(createDefaultGuardProfile())).toEqual([]);
  });

  it("an empty topic rule is refused", () => {
    const profile = profileWith([{ id: OUTPUT_TOPIC_DETECTOR_ID, options: {} }]);
    expect(outputCheckOptionIssues(profile)).toEqual([{ path: "channels.final_output.detectors.0.options.deny", message: "List topics to deny or allow" }]);
  });

  it("lists the secrets model options name", () => {
    const profile = profileWith([
      { id: OUTPUT_SAFETY_DETECTOR_ID, options: { mode: "model", model: { providerId: "openai", model: "m", secretRef: { secretId: "sec_1" } } } },
      { id: OUTPUT_GROUNDING_DETECTOR_ID, options: { judge: { model: { providerId: "openai", model: "m", secretRef: { secretId: "sec_2" } } } } }
    ]);
    expect(outputCheckSecretRefs(profile).map((ref) => ref.secretId)).toEqual(["sec_1", "sec_2"]);
    expect(profilesUseGrounding([profile], "final_output")).toBe(true);
    expect(profilesUseGrounding([profile], "model_output")).toBe(false);
  });

  it("a partial check has its own memo key; a complete one keeps today's", () => {
    const complete = guardVerdictMemoKey(["h"], input("text"));
    expect(guardVerdictMemoKey(["h"], input("text", { partial: false }))).toBe(complete);
    expect(guardVerdictMemoKey(["h"], input("text", { partial: true }))).not.toBe(complete);
  });

  it("the built-in rule set's hash is unchanged", () => {
    expect(hashGuardProfile(createDefaultGuardProfile()).startsWith("38a972eb")).toBe(true);
  });

  it("evaluation hands the host's model services to detectors", async () => {
    let seen: GuardModelServices | undefined;
    const registry = createDefaultGuardRegistry().replace({
      id: "probe",
      tier: "rule",
      description: "probe",
      channels: ["final_output"],
      categories: ["x"],
      detect: (_input, context) => ((seen = context.models), [])
    });
    const models: GuardModelServices = { complete: async () => ({ text: "" }) };
    await evaluateGuard(profileWith([{ id: "probe" }]), input("x"), { registry, models });
    expect(seen).toBe(models);
  });
});
