import type { GuardDictionary } from "../profile";
import { unsafeDictionaryPattern } from "../profile";
import { clampScore, type DetectorContext, type GuardDetector, type GuardFinding, type GuardInput, type GuardSpan } from "../types";
import { clipForModel, cosineSimilarity, guardModelRefIssue, guardModelRefOption, positiveNumber, requireEmbedding, unitNumber } from "./output-model";
import { plainView } from "./text-normalize";

export const OUTPUT_TOPIC_DETECTOR_ID = "output.topic";

/**
 * Phase 12 coverage — topic limits on an answer. `deny` lists topics the
 * answer may not touch; `allow` lists the only topics it may be about (an
 * answer that matches none of them is off topic). A topic is a name, or
 * `{ name, phrases?, dictionary?, examples? }`: phrases match whole words,
 * case-insensitively; `dictionary` names a dictionary of the rule set (its
 * terms and patterns count as phrases).
 *
 * `mode: "semantic"` compares the answer with each topic by embedding
 * similarity instead (the topic's `examples`, else its name and phrases),
 * through an embedding model the host offers (`model` names one; the host's
 * default otherwise). Topic vectors are cached per detector, so only the
 * answer is embedded on later checks. Phrase mode makes no model calls.
 *
 * Options: `deny`, `allow`, `mode` (`phrases` | `semantic`), `model`,
 * `denyThreshold` (semantic, default 0.8), `allowThreshold` (semantic,
 * default 0.5), `minChars` (an allow list applies only to answers at least
 * this long, default 1), `denyScore` (default 0.9), `allowMissScore`
 * (default 0.8).
 */

export interface TopicSpec {
  name: string;
  phrases?: string[];
  dictionary?: string;
  examples?: string[];
}

const MAX_TOPICS = 100;
const MAX_PHRASES = 500;
const EMBED_CHARS = 4000;
const VECTOR_CACHE_ENTRIES = 1000;

function readTopics(value: unknown, option: string, issues?: Array<{ option: string; message: string }>): TopicSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues?.push({ option, message: "Must be a list of topics" });
    return [];
  }
  if (value.length > MAX_TOPICS) issues?.push({ option, message: `At most ${MAX_TOPICS} topics` });
  const topics: TopicSpec[] = [];
  value.forEach((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      topics.push({ name: entry.trim() });
      return;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as TopicSpec).name === "string" && (entry as TopicSpec).name.trim()) {
      const spec = entry as TopicSpec;
      const strings = (list: unknown, field: string): string[] | undefined => {
        if (list === undefined) return undefined;
        if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim())) {
          issues?.push({ option: `${option}.${index}.${field}`, message: "Must be a list of non-empty strings" });
          return undefined;
        }
        if (list.length > MAX_PHRASES) issues?.push({ option: `${option}.${index}.${field}`, message: `At most ${MAX_PHRASES} entries` });
        return (list as string[]).map((item) => item.trim());
      };
      const phrases = strings(spec.phrases, "phrases");
      const examples = strings(spec.examples, "examples");
      if (spec.dictionary !== undefined && (typeof spec.dictionary !== "string" || !spec.dictionary.trim())) {
        issues?.push({ option: `${option}.${index}.dictionary`, message: "Must name a dictionary of this rule set" });
      }
      topics.push({
        name: spec.name.trim(),
        ...(phrases ? { phrases } : {}),
        ...(typeof spec.dictionary === "string" && spec.dictionary.trim() ? { dictionary: spec.dictionary.trim() } : {}),
        ...(examples ? { examples } : {})
      });
      return;
    }
    issues?.push({ option: `${option}.${index}`, message: "A topic is a name, or an object with a name" });
  });
  return topics;
}

/** Why an `output.topic` options object is unusable, keyed by option; empty when fine. */
export function outputTopicOptionIssues(options: Record<string, unknown>, dictionaries: readonly GuardDictionary[] = []): Array<{ option: string; message: string }> {
  const issues: Array<{ option: string; message: string }> = [];
  const deny = readTopics(options.deny, "deny", issues);
  const allow = readTopics(options.allow, "allow", issues);
  if (deny.length === 0 && allow.length === 0 && issues.length === 0) issues.push({ option: "deny", message: "List topics to deny or allow" });
  const names = new Set(dictionaries.map((dictionary) => dictionary.dataClass));
  for (const [list, topics] of [["deny", deny], ["allow", allow]] as const) {
    topics.forEach((topic, index) => {
      if (topic.dictionary && !names.has(topic.dictionary)) issues.push({ option: `${list}.${index}.dictionary`, message: `No dictionary '${topic.dictionary}' in this rule set` });
    });
  }
  if (options.mode !== undefined && options.mode !== "phrases" && options.mode !== "semantic") issues.push({ option: "mode", message: "Use 'phrases' or 'semantic'" });
  const modelIssue = guardModelRefIssue(options.model);
  if (modelIssue) issues.push({ option: "model", message: modelIssue });
  for (const key of ["denyThreshold", "allowThreshold", "denyScore", "allowMissScore"]) {
    const value = options[key];
    if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) issues.push({ option: key, message: "Must be a number from 0 to 1" });
  }
  return issues;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A phrase as a whole-word, case-insensitive pattern; spaces match any run of white space. */
function phrasePattern(phrase: string): RegExp {
  const body = phrase
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "gu");
}

function topicPatterns(topic: TopicSpec, dictionaries: readonly GuardDictionary[]): RegExp[] {
  const patterns = [topic.name, ...(topic.phrases ?? [])].map(phrasePattern);
  if (topic.dictionary) {
    const dictionary = dictionaries.find((entry) => entry.dataClass === topic.dictionary);
    for (const term of dictionary?.terms ?? []) patterns.push(phrasePattern(term));
    for (const source of dictionary?.patterns ?? []) {
      // Refused when saved; skipped here if an old rule set still has one.
      if (unsafeDictionaryPattern(source)) continue;
      try {
        patterns.push(new RegExp(source, "giu"));
      } catch {
        // invalid patterns are refused when a rule set is saved
      }
    }
  }
  return patterns;
}

/** Spans in the original text where a topic's phrases occur. */
export function matchTopic(text: string, topic: TopicSpec, dictionaries: readonly GuardDictionary[] = []): GuardSpan[] {
  const view = plainView(text);
  const spans: GuardSpan[] = [];
  for (const pattern of topicPatterns(topic, dictionaries)) {
    for (const match of view.text.matchAll(pattern)) {
      if (!match[0]) continue;
      const start = view.toOriginal(match.index ?? 0);
      const end = view.toOriginal((match.index ?? 0) + match[0].length);
      spans.push({ start, end });
      if (spans.length >= 50) return spans;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function topicTexts(topic: TopicSpec): string[] {
  if (topic.examples && topic.examples.length > 0) return topic.examples;
  return [[topic.name, ...(topic.phrases ?? [])].join(", ")];
}

export function createOutputTopicDetector(): GuardDetector {
  // Topic vectors by model and text: a rule set's topics are embedded once per process.
  const vectors = new Map<string, number[]>();
  const remember = (key: string, vector: number[]) => {
    vectors.set(key, vector);
    if (vectors.size > VECTOR_CACHE_ENTRIES) vectors.delete(vectors.keys().next().value as string);
  };

  return {
    id: OUTPUT_TOPIC_DETECTOR_ID,
    tier: "classifier",
    description: "Topic limits: phrases (or, in semantic mode, embedding similarity) for topics the answer must avoid or stay within.",
    channels: ["model_output", "final_output", "response"],
    categories: ["off_topic"],
    async detect(_input: GuardInput, context: DetectorContext) {
      const options = context.options;
      const deny = readTopics(options.deny, "deny");
      const allow = readTopics(options.allow, "allow");
      const text = context.text;
      if ((deny.length === 0 && allow.length === 0) || !text.trim()) return [];
      const denyScore = unitNumber(options.denyScore, 0.9);
      const allowMissScore = unitNumber(options.allowMissScore, 0.8);
      const allowApplies = allow.length > 0 && text.trim().length >= positiveNumber(options.minChars, 1);
      const whole: GuardSpan = { start: 0, end: text.length };
      const findings: GuardFinding[] = [];
      const deniedFinding = (topic: TopicSpec, score: number, spans: GuardSpan[], metadata: Record<string, unknown>): GuardFinding => ({
        detectorId: OUTPUT_TOPIC_DETECTOR_ID,
        category: "off_topic",
        score: clampScore(score),
        spans,
        evidence: `denied topic '${topic.name}'`,
        message: `The answer touches the denied topic '${topic.name}'`,
        metadata: { list: "deny", topic: topic.name, ...metadata }
      });
      const allowMiss = (metadata: Record<string, unknown>): GuardFinding => ({
        detectorId: OUTPUT_TOPIC_DETECTOR_ID,
        category: "off_topic",
        score: allowMissScore,
        spans: [whole],
        evidence: "none of the allowed topics",
        message: `The answer is about none of the allowed topics (${allow.map((topic) => topic.name).slice(0, 5).join(", ")})`,
        metadata: { list: "allow", ...metadata }
      });

      if (options.mode === "semantic") {
        const model = guardModelRefOption(options.model, OUTPUT_TOPIC_DETECTOR_ID);
        const embed = requireEmbedding(context, OUTPUT_TOPIC_DETECTOR_ID);
        const modelKey = model ? `${model.providerId}/${model.model}` : "default";
        const topicStrings = [...new Set([...deny, ...allow].flatMap(topicTexts))];
        const missing = topicStrings.filter((entry) => !vectors.has(`${modelKey}\u0000${entry}`));
        const request = [clipForModel(text, EMBED_CHARS), ...missing];
        const answer = await embed({ ...(model ? { model } : {}), texts: request, detectorId: OUTPUT_TOPIC_DETECTOR_ID });
        if (!Array.isArray(answer) || answer.length !== request.length) throw new Error(`${OUTPUT_TOPIC_DETECTOR_ID}: the embedding model returned ${Array.isArray(answer) ? answer.length : 0} vectors for ${request.length} texts`);
        missing.forEach((entry, index) => remember(`${modelKey}\u0000${entry}`, answer[index + 1]!));
        const textVector = answer[0]!;
        const similarity = (topic: TopicSpec) =>
          Math.max(...topicTexts(topic).map((entry) => cosineSimilarity(textVector, vectors.get(`${modelKey}\u0000${entry}`) ?? [])));
        const denyThreshold = unitNumber(options.denyThreshold, 0.8);
        for (const topic of deny) {
          const value = similarity(topic);
          if (value >= denyThreshold) findings.push(deniedFinding(topic, value, [whole], { mode: "semantic", similarity: clampScore(value) }));
        }
        if (allowApplies) {
          const best = Math.max(...allow.map(similarity));
          if (best < unitNumber(options.allowThreshold, 0.5)) findings.push(allowMiss({ mode: "semantic", similarity: clampScore(best) }));
        }
        return findings;
      }

      const dictionaries = Array.isArray(options.dictionaries) ? (options.dictionaries as GuardDictionary[]) : [];
      for (const topic of deny) {
        const spans = matchTopic(text, topic, dictionaries);
        if (spans.length > 0) findings.push(deniedFinding(topic, denyScore, spans, { mode: "phrases", matches: spans.length }));
      }
      if (allowApplies && !allow.some((topic) => matchTopic(text, topic, dictionaries).length > 0)) findings.push(allowMiss({ mode: "phrases" }));
      return findings;
    }
  };
}
