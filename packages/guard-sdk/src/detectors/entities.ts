import {
  ENTITIES_DETECTOR_ID,
  ENTITY_DATA_CLASSES,
  entityMinScore,
  guardEntitiesOptionsSchema,
  isEntityDataClass,
  type EntityDataClass,
  type GuardEntitiesOptions,
  type GuardEntitiesOptionsInput,
  type GuardEntityEngineInfo
} from "@ai-orchestrator/shared";
import { maskedEvidence } from "../masking";
import { judgeEntities } from "./entities-judge";
import { guardModelRefIssue } from "./output-model";
import { PLACEHOLDER_PATTERN } from "../protection/placeholder";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { clampScore } from "../types";
import { scanDlp } from "./dlp";
import { findEmailSpans } from "./dlp-linear";
import { recognizeEntitiesByRules, resolveOverlaps, RULE_ENTITY_RECOGNIZER_VERSION } from "./entities-rules";

export { ENTITIES_DETECTOR_ID, ENTITY_DATA_CLASSES } from "@ai-orchestrator/shared";

/**
 * Person names, locations and street addresses (`data.entities`, classifier tier). The detector asks a recognizer
 * for spans and then controls false positives itself, the same way for every recognizer:
 *
 * 1. a score below the class's `minScore` keeps the finding as suppressed (it never acts);
 * 2. spans shorter than `minLength` are dropped;
 * 3. a one-word name needs a cue (a title, a field label, a greeting) unless `singleTokenNames` is on;
 * 4. spans inside an email address, a URL, a code block, a placeholder (`[EMAIL_1]`), a vault token or a surrogate
 *    the run issued are dropped;
 * 5. spans overlapping a data rule finding (an email, a phone number) yield to it.
 *
 * The rule set's allow-list and dictionaries apply as for every data detector. Nothing in this package downloads or
 * runs models: a deployment plugs a model or its own service in through `GuardEntityRecognizer`, and without one
 * `RuleBasedEntityRecognizer` stands in. The `engine` option picks the rules, the deployment's service, or both.
 *
 * With `judge.enabled`, spans scored inside `judge.band` are put to the chat model `judge.model` names (through the
 * host's `DetectorContext.models`): a confirmed span is reported, a rejected one dropped. A check that waits on a
 * service or a model gets its own time limit (`timeoutMs`) instead of the rule set's latency budget.
 */

export interface GuardEntitySpan {
  /** Half-open character range in the text the recognizer was given. */
  start: number;
  end: number;
  dataClass: EntityDataClass | (string & {});
  /** 0..1. */
  score: number;
  /** What found it (`rules:title`, a model's label), for traces. */
  source: string;
  /** A name found through a cue word; recognizers that do not know leave it out. */
  cue?: boolean;
}

export interface GuardEntityRequest {
  classes: string[];
  language?: string;
  signal?: AbortSignal;
  /** The lowest score worth returning (the lowest class `minScore`, or the judge's band); recognizers may return lower. */
  minScore?: number;
}

export interface GuardEntityRecognizer {
  /** In traces and in the verdict memo's key. */
  id: string;
  version: string;
  /** Classes it can emit. */
  classes: readonly string[];
  languages: readonly string[] | "any";
  /** One list of spans per text, in order. */
  recognize(texts: string[], request: GuardEntityRequest): Promise<GuardEntitySpan[][]>;
  /** For the detector list: whether a model is loaded, idle or failed. Absent: `loaded`. */
  status?(): Pick<GuardEntityEngineInfo, "status" | "error" | "model" | "message">;
  /**
   * True when spans come from a service over the network (the deployment's names and addresses endpoint): a check
   * that uses it is timed like a model check (`timeoutMs`), not against the rule set's latency budget.
   */
  remote?: boolean;
}

export const RULE_BASED_ENTITY_RECOGNIZER_ID = "rules";

/** The built-in rules: street addresses in six countries (US, UK, CA, AU, DE, FR), names with cues, listed places. */
export class RuleBasedEntityRecognizer implements GuardEntityRecognizer {
  readonly id = RULE_BASED_ENTITY_RECOGNIZER_ID;
  readonly version = RULE_ENTITY_RECOGNIZER_VERSION;
  readonly classes = ENTITY_DATA_CLASSES;
  readonly languages = ["en"] as const;

  async recognize(texts: string[], request: GuardEntityRequest): Promise<GuardEntitySpan[][]> {
    const classes = new Set(request.classes);
    return texts.map((text) => {
      if (request.signal?.aborted) throw new Error("Entity recognition was stopped");
      return recognizeEntitiesByRules(text, { classes });
    });
  }

  status(): Pick<GuardEntityEngineInfo, "status"> {
    return { status: "rules" };
  }
}

/** The detector's options, parsed (defaults filled in); throws with the problems when they are unusable. */
export function parseEntitiesOptions(options: unknown): GuardEntitiesOptions {
  const parsed = guardEntitiesOptionsSchema.safeParse(stripDictionaries(options));
  if (!parsed.success) {
    throw new Error(`Invalid ${ENTITIES_DETECTOR_ID} options: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`).join("; ")}`);
  }
  const modelIssue = guardModelRefIssue(parsed.data.judge?.model);
  if (modelIssue) throw new Error(`Invalid ${ENTITIES_DETECTOR_ID} options: judge.model: ${modelIssue}`);
  return parsed.data;
}

/** The options parsed, or null when they are unusable. */
export function guardEntitiesOptionsOrNull(options: unknown): GuardEntitiesOptions | null {
  const parsed = guardEntitiesOptionsSchema.safeParse(stripDictionaries(options));
  return parsed.success && !guardModelRefIssue(parsed.data.judge?.model) ? parsed.data : null;
}

/** Why a `data.entities` options object is unusable, keyed by option; empty when fine (checked when a rule set is saved). */
export function entitiesOptionIssues(options: Record<string, unknown>): Array<{ option: string; message: string }> {
  const parsed = guardEntitiesOptionsSchema.safeParse(stripDictionaries(options));
  if (!parsed.success) return parsed.error.issues.map((issue) => ({ option: issue.path.map(String).join(".") || "classes", message: issue.message }));
  // The judge's model: model config fields only, no credentials (a key is a stored secret named by secretRef.secretId).
  const modelIssue = guardModelRefIssue(parsed.data.judge?.model);
  return modelIssue ? [{ option: "judge.model", message: modelIssue }] : [];
}

/** Option problems of every `data.entities` entry in a rule set, with dotted paths; empty when there are none. */
export function entitiesProfileIssues(profile: { channels: Partial<Record<string, { detectors: Array<{ id: string; options: Record<string, unknown> }> } | undefined>> }): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [channel, config] of Object.entries(profile.channels)) {
    config?.detectors.forEach((entry, index) => {
      if (entry.id !== ENTITIES_DETECTOR_ID) return;
      for (const issue of entitiesOptionIssues(entry.options ?? {})) issues.push({ path: `channels.${channel}.detectors.${index}.options.${issue.option}`, message: issue.message });
    });
  }
  return issues;
}

/** The engine adds the rule set's dictionaries to every detector's options; they are not entity options. */
function stripDictionaries(options: unknown): unknown {
  if (!options || typeof options !== "object" || Array.isArray(options) || !("dictionaries" in options)) return options;
  const { dictionaries: _dictionaries, ...rest } = options as Record<string, unknown>;
  return rest;
}

export interface EntityMatch {
  start: number;
  end: number;
  dataClass: EntityDataClass;
  score: number;
  source: string;
  /** The class's `minScore`: below it the match is suppressed. */
  minScore: number;
}

export interface FindEntitiesContext {
  /** The deployment's recognizer (`engine: auto`); the rules when absent. */
  recognizer?: GuardEntityRecognizer;
  signal?: AbortSignal;
  /** Surrogates the run issued: never names or addresses. */
  issuedSurrogates?: ReadonlySet<string>;
  /** Overrides `options.maxChars` (a document scan's own limit). */
  maxChars?: number;
}

const RULES = new RuleBasedEntityRecognizer();

/**
 * The built-in rules and a deployment's recognizer asked together; their spans are pooled, and `findEntities` keeps the
 * higher-scored of two overlapping ones.
 */
export class UnionEntityRecognizer implements GuardEntityRecognizer {
  readonly id: string;
  readonly classes: readonly string[];
  readonly languages: readonly string[] | "any";
  readonly remote: boolean;
  constructor(private readonly other: GuardEntityRecognizer) {
    this.id = `${RULE_BASED_ENTITY_RECOGNIZER_ID}+${other.id}`;
    this.classes = [...new Set([...RULES.classes, ...other.classes])];
    this.languages = other.languages;
    this.remote = other.remote === true;
  }

  get version(): string {
    return `${RULES.version}+${this.other.version}`;
  }

  async recognize(texts: string[], request: GuardEntityRequest): Promise<GuardEntitySpan[][]> {
    const forRules = request.classes.filter((dataClass) => (RULES.classes as readonly string[]).includes(dataClass));
    const forOther = request.classes.filter((dataClass) => this.other.classes.includes(dataClass));
    const [rules, other] = await Promise.all([
      forRules.length > 0 ? RULES.recognize(texts, { ...request, classes: forRules }) : texts.map(() => []),
      forOther.length > 0 ? this.other.recognize(texts, { ...request, classes: forOther }) : texts.map(() => [])
    ]);
    return texts.map((_, index) => [...(rules[index] ?? []), ...(other[index] ?? [])]);
  }

  status(): Pick<GuardEntityEngineInfo, "status" | "error" | "model" | "message"> {
    return this.other.status?.() ?? { status: "loaded" };
  }
}

const unions = new WeakMap<GuardEntityRecognizer, UnionEntityRecognizer>();

/** Asked for `endpoint` or `union` on a deployment that configured no names and addresses service. */
export class EntityEngineUnavailableError extends Error {
  constructor(engine: string) {
    super(`The names and addresses engine '${engine}' needs the deployment's names and addresses service, and none is configured`);
    this.name = "EntityEngineUnavailableError";
  }
}

/** The recognizer these options use. `endpoint` and `union` throw when the deployment has no recognizer of its own. */
export function entityRecognizerFor(options: Pick<GuardEntitiesOptions, "engine">, deployment: GuardEntityRecognizer | undefined): GuardEntityRecognizer {
  switch (options.engine) {
    case "rules":
      return RULES;
    case "endpoint":
      if (!deployment) throw new EntityEngineUnavailableError("endpoint");
      return deployment;
    case "union": {
      if (!deployment) throw new EntityEngineUnavailableError("union");
      let union = unions.get(deployment);
      if (!union) {
        union = new UnionEntityRecognizer(deployment);
        unions.set(deployment, union);
      }
      return union;
    }
    default:
      return deployment ?? RULES;
  }
}

/** True when these options make the check wait on a network service (the deployment's recognizer is remote and used). */
export function entityEngineIsRemote(options: Pick<GuardEntitiesOptions, "engine">, deployment: GuardEntityRecognizer | undefined): boolean {
  return options.engine !== "rules" && deployment?.remote === true;
}

/** Entity matches in a text after the false-positive controls (suppressed ones included, marked by `minScore`). */
export async function findEntities(text: string, options: GuardEntitiesOptions, context: FindEntitiesContext = {}): Promise<EntityMatch[]> {
  return (await findEntitiesMany([text], options, context))[0] ?? [];
}

/**
 * `findEntities` for many texts with one recognizer call (a service batches them into few requests). Each text is held
 * to the length limit on its own; one list of matches per text, in order.
 */
export async function findEntitiesMany(texts: readonly string[], options: GuardEntitiesOptions, context: FindEntitiesContext = {}): Promise<EntityMatch[][]> {
  const maxChars = context.maxChars ?? options.maxChars;
  for (const text of texts) {
    if (text.length > maxChars) throw new Error(`text longer than maxChars (${text.length} > ${maxChars})`);
  }
  const out: EntityMatch[][] = texts.map(() => []);
  const classes = [...new Set(options.classes)];
  const asked = texts.flatMap((text, index) => (text.length > 0 ? [index] : []));
  if (classes.length === 0 || asked.length === 0) return out;
  const recognizer = entityRecognizerFor(options, context.recognizer);
  const wanted = classes.filter((dataClass) => recognizer.classes.includes(dataClass));
  if (wanted.length === 0) return out;
  let results: GuardEntitySpan[][];
  try {
    results = await recognizer.recognize(
      asked.map((index) => texts[index]!),
      {
        classes: wanted,
        ...(options.languages[0] ? { language: options.languages[0] } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        minScore: lowestWantedScore(options, wanted)
      }
    );
  } catch {
    // A fixed message: a recognizer's own error text could quote the input, and it would reach traces and logs.
    throw new Error(`Entity recognizer ${recognizer.id} failed`);
  }
  if (!Array.isArray(results) || results.length !== asked.length) throw new Error(`Entity recognizer ${recognizer.id} returned ${Array.isArray(results) ? results.length : 0} results for ${asked.length} texts`);
  asked.forEach((textIndex, position) => {
    const found = results[position];
    out[textIndex] = checkedMatches(texts[textIndex]!, Array.isArray(found) ? found : [], wanted, options, recognizer, context);
  });
  return out;
}

/**
 * The lowest score a span can matter at: the lowest `minScore` of the asked classes, or lower when the judge looks at
 * spans below it. Context words can raise a score by 0.1, so a little below that too.
 */
function lowestWantedScore(options: GuardEntitiesOptions, classes: readonly string[]): number {
  const scores = classes.filter(isEntityDataClass).map((dataClass) => entityMinScore(options, dataClass));
  if (options.judge?.enabled) scores.push(options.judge.band[0]);
  const lowest = Math.min(1, ...scores) - (options.contextWords.boost.length > 0 ? 0.1 : 0);
  return Math.max(0, Math.round(lowest * 1000) / 1000);
}

/** A recognizer's spans for one text after the false-positive controls. */
function checkedMatches(text: string, raw: readonly GuardEntitySpan[], wanted: readonly string[], options: GuardEntitiesOptions, recognizer: GuardEntityRecognizer, context: FindEntitiesContext): EntityMatch[] {
  if (raw.length === 0) return [];
  const wantedSet = new Set<string>(wanted);
  const blocked = protectedRegions(text, context.issuedSurrogates);
  const dataSpans = mergeRegions(scanDlp(text).map((match) => match.span));
  const boost = options.contextWords.boost.map((word) => word.toLowerCase());
  const suppress = options.contextWords.suppress.map((word) => word.toLowerCase());
  const matches: EntityMatch[] = [];
  for (const span of raw) {
    // A recognizer's answer is checked, not trusted: in range, a class that was asked for, a finite score.
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end > text.length || span.end <= span.start) continue;
    if (!isEntityDataClass(span.dataClass) || !wantedSet.has(span.dataClass) || typeof span.score !== "number" || !Number.isFinite(span.score)) continue;
    const value = text.slice(span.start, span.end);
    if (value.trim().length < options.minLength) continue;
    if (span.dataClass === "person_name" && !/\s/.test(value.trim()) && !options.singleTokenNames && span.cue !== true && !hasNameCue(text, span.start)) continue;
    if (overlapsAny(span, blocked) || overlapsAny(span, dataSpans)) continue;
    let score = clampScore(span.score);
    if (boost.length > 0 || suppress.length > 0) {
      const around = text.slice(Math.max(0, span.start - CONTEXT_WINDOW), Math.min(text.length, span.end + CONTEXT_WINDOW)).toLowerCase();
      if (boost.some((word) => containsWord(around, word))) score = clampScore(score + 0.1);
      if (suppress.some((word) => containsWord(around, word))) score = clampScore(score - 0.3);
    }
    matches.push({ start: span.start, end: span.end, dataClass: span.dataClass, score: Math.round(score * 1000) / 1000, source: String(span.source ?? recognizer.id).slice(0, 64), minScore: entityMinScore(options, span.dataClass) });
  }
  // Where spans overlap, one that would be reported beats one that would be suppressed, whatever their raw scores:
  // a low-scored span of another class must never hide a finding.
  const ranked = matches.map((match) => ({ start: match.start, end: match.end, score: (match.score >= match.minScore ? 1 : 0) + match.score, match }));
  return resolveOverlaps(ranked)
    .map((entry) => entry.match)
    .sort((a, b) => a.start - b.start);
}

const CONTEXT_WINDOW = 40;

function containsWord(haystack: string, word: string): boolean {
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = haystack[at + word.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/** A title, a name field label or a greeting just before `start` on the same line. */
const NAME_CUE_BEFORE =
  /(?:\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Rev|Herr|Frau|Mme)\.?|\b(?:name|patient|customer|client|employee|contact|applicant|recipient|sender|attn|attention|cardholder|member|guest|passenger|tenant|owner|beneficiary|surname)\s?[:-]|\b(?:Dear|Hi|Hello|Hey))\s{1,3}$/i;

function hasNameCue(text: string, start: number): boolean {
  // Only the 40 characters before the span are read, so the cost per span is constant.
  const window = text.slice(Math.max(0, start - 40), start);
  return NAME_CUE_BEFORE.test(window.slice(window.lastIndexOf("\n") + 1));
}

/** Regions merged into disjoint intervals in start order, for `overlapsAny`'s binary search. */
function mergeRegions(regions: readonly GuardSpan[]): GuardSpan[] {
  const sorted = regions.filter((region) => region.end > region.start).sort((a, b) => a.start - b.start);
  const merged: GuardSpan[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) last.end = Math.max(last.end, region.end);
    else merged.push({ start: region.start, end: region.end });
  }
  return merged;
}

/** True when the span overlaps one of the disjoint, sorted regions (O(log n)). */
function overlapsAny(span: GuardSpan, regions: readonly GuardSpan[]): boolean {
  let lo = 0;
  let hi = regions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (regions[mid]!.end <= span.start) lo = mid + 1;
    else hi = mid;
  }
  return lo < regions.length && regions[lo]!.start < span.end;
}

const URL_START = /\b(?:[a-z][a-z0-9+.-]{0,15}:\/\/|www\.)[^\s<>"'`]{1,2048}/gi;
const VAULT_TOKEN = /\btok_[A-Za-z0-9_]{1,64}_[A-Za-z0-9_-]{8,128}/g;
const INLINE_CODE = /`[^`\n]{1,500}`/g;

/** Where names and addresses are never reported: emails, URLs, code, placeholders, vault tokens, issued surrogates. Merged and sorted. */
function protectedRegions(text: string, issued: ReadonlySet<string> | undefined): GuardSpan[] {
  const regions: GuardSpan[] = [...findEmailSpans(text)];
  const add = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) regions.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  };
  add(URL_START);
  add(VAULT_TOKEN);
  add(new RegExp(PLACEHOLDER_PATTERN.source, "g"));
  // Fenced code blocks (``` … ```). An unclosed fence is not a block: one stray fence must not hide the rest of the text.
  for (let open = text.indexOf("```"); open !== -1; ) {
    const close = text.indexOf("```", open + 3);
    if (close === -1) break;
    regions.push({ start: open, end: close + 3 });
    open = text.indexOf("```", close + 3);
  }
  add(INLINE_CODE);
  for (const value of issued ?? []) {
    if (!value) continue;
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) regions.push({ start: at, end: at + value.length });
  }
  return mergeRegions(regions);
}

export interface EntitiesDetectorOptions {
  /** The deployment's recognizer, used by `engine: auto`. Absent: the rules. */
  recognizer?: GuardEntityRecognizer;
}

/** The engine behind `data.entities` for the detector list. */
export function entityEngineInfo(recognizer: GuardEntityRecognizer | undefined): GuardEntityEngineInfo {
  const engine: GuardEntityRecognizer = recognizer ?? RULES;
  const status: Pick<GuardEntityEngineInfo, "status" | "error" | "model" | "message"> = engine.status?.() ?? { status: "loaded" };
  const kind = engine === RULES ? "rules" : engine.remote ? "endpoint" : undefined;
  return {
    id: engine.id,
    version: engine.version,
    status: status.status,
    languages: engine.languages,
    classes: [...engine.classes],
    ...(kind ? { kind } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(status.model ? { model: status.model } : {}),
    ...(status.message ? { message: status.message } : {})
  };
}

export function createEntitiesDetector(defaults: EntitiesDetectorOptions = {}): GuardDetector & { engine(): GuardEntityEngineInfo } {
  const deployment = defaults.recognizer;
  return {
    id: ENTITIES_DETECTOR_ID,
    tier: "classifier",
    description: deployment
      ? `Person names, locations and street addresses (${deployment.id} ${deployment.version}; engine 'rules' uses the built-in rules). Classes are opt-in.`
      : "Person names (with a cue such as a title or a field label), locations and street addresses (US, UK, CA, AU, DE, FR) by built-in rules. Classes are opt-in.",
    channels: ["prompt", "model_output", "tool_arguments", "tool_result", "final_output", "response", "trigger_input"],
    categories: ["sensitive_data"],
    // The recognizer in use, so a clean verdict kept in a memo is never reused after the engine changed. Read on every
    // use: a service reports its model, and a new model changes the version.
    get version() {
      return `rules:${RULE_ENTITY_RECOGNIZER_VERSION}${deployment ? `;auto:${deployment.id}@${deployment.version}` : ""}`;
    },
    engine: () => entityEngineInfo(deployment),
    // A check that waits on the deployment's service or on the judge's model is timed apart from the latency budget.
    callsModel: (raw) => {
      const options = guardEntitiesOptionsOrNull(raw);
      if (!options) return false;
      return options.judge?.enabled === true || entityEngineIsRemote(options, deployment);
    },
    async detect(input: GuardInput, context: DetectorContext) {
      const options = parseEntitiesOptions(context.options);
      const found = await findEntities(context.text, options, {
        ...(deployment ? { recognizer: deployment } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        ...(input.issuedSurrogates ? { issuedSurrogates: input.issuedSurrogates } : {})
      });
      // The judge gets half of the check's own time limit, so a slow model never costs the recognizer's findings.
      const matches: Array<EntityMatch & { judge?: string }> = options.judge?.enabled ? await judgeEntities(context.text, found, options.judge, context, (options.timeoutMs ?? 30_000) / 2) : found;
      return matches.map<GuardFinding>((match) => ({
        detectorId: ENTITIES_DETECTOR_ID,
        category: "sensitive_data",
        dataClass: match.dataClass,
        score: match.score,
        minScore: match.minScore,
        spans: [{ start: match.start, end: match.end }],
        evidence: maskedEvidence(context.text.slice(match.start, match.end), match.dataClass),
        message: ENTITY_MESSAGES[match.dataClass],
        metadata: { source: match.source, ...(match.judge ? { judge: match.judge } : {}) }
      }));
    }
  };
}

const ENTITY_MESSAGES: Record<EntityDataClass, string> = {
  person_name: "Person name",
  location: "Location",
  street_address: "Street address"
};

/** Default options for a set of classes (a gateway call that names entity classes without a rule set that configures them). */
export function defaultEntitiesOptions(classes: readonly EntityDataClass[]): GuardEntitiesOptions {
  return guardEntitiesOptionsSchema.parse({ classes: [...new Set(classes)] } satisfies GuardEntitiesOptionsInput);
}
