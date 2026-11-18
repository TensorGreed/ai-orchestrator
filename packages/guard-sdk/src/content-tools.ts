import { compileAllowList, type AllowListInput } from "./allow-list";
import { ENTITIES_DETECTOR_ID, isEntityDataClass, type EntityDataClass, type GuardEntitiesOptions } from "@ai-orchestrator/shared";
import { DLP_DETECTOR_ID, scanDlp, type DlpMatch, type DlpScanOptions } from "./detectors/dlp";
import { defaultEntitiesOptions, findEntitiesMany, guardEntitiesOptionsOrNull, type EntityMatch, type GuardEntityRecognizer } from "./detectors/entities";
import { maskForDataClass } from "./masking";
import type { GuardProfile } from "./profile";
import type { GuardDataClass } from "./types";

/**
 * Content rules as tools: the data scan of one or more inputs (a text, a list of texts or any JSON value), a risk
 * level per input, and redaction through a caller-supplied protector (placeholders, vault tokens, masks or keyed
 * hashes). Findings carry masked previews only, never values.
 */

export const RISK_LEVELS = ["none", "low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Classes that make an input `high` when found with a score of at least 0.8. */
export const HIGH_RISK_DATA_CLASSES: readonly GuardDataClass[] = ["private_key", "credential", "jwt", "card_number", "iban", "us_ssn", "national_id"];
export const HIGH_RISK_MIN_SCORE = 0.8;
export const MEDIUM_RISK_MIN_SCORE = 0.6;

/**
 * The risk level of an input from its findings:
 * - `high`: a private key, credential, JWT, card number, IBAN, US SSN or national id with a score of at least 0.8;
 * - `medium`: any other finding with a score of at least 0.6 (an email, a phone number, an IP address, a person name,
 *   a location, a street address, a dictionary term);
 * - `low`: findings, all with a score below 0.6;
 * - `none`: no finding.
 */
export function riskLevelOf(findings: ReadonlyArray<{ dataClass?: string | null; score: number }>): RiskLevel {
  if (findings.length === 0) return "none";
  if (findings.some((finding) => finding.dataClass && HIGH_RISK_DATA_CLASSES.includes(finding.dataClass) && finding.score >= HIGH_RISK_MIN_SCORE)) return "high";
  if (findings.some((finding) => finding.score >= MEDIUM_RISK_MIN_SCORE)) return "medium";
  return "low";
}

/** The higher of risk levels. */
export function highestRiskLevel(levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((best, level) => (RISK_LEVELS.indexOf(level) > RISK_LEVELS.indexOf(best) ? level : best), "none");
}

export interface SensitiveScanSettings {
  dictionaries: GuardProfile["dictionaries"];
  allowList?: AllowListInput;
  include?: GuardDataClass[];
  disable?: GuardDataClass[];
  entropyThreshold?: number;
  /** Names, locations and addresses: the options of the rule set's `data.entities` detector, when it runs one. */
  entities?: GuardEntitiesOptions;
  /**
   * The rule set runs `data.entities` with stored options that do not parse (only a hand-edited stored row can, since
   * saving validates them): they are ignored, and the check runs with its default options for the classes the stored
   * options list (when those parse) or that a call names. Hosts warn.
   */
  entitiesOptionsInvalid?: true;
}

/**
 * What a rule set says about the data scan: its dictionaries and allow-list, the data detector options (`include`,
 * `disable`, `entropyThreshold`) of the first channel that runs it, and the `data.entities` options of the first
 * channel that runs that (options that do not parse are replaced by the defaults for their classes and flagged with
 * `entitiesOptionsInvalid`). No rule set: the built-in defaults (no names or addresses).
 */
export function sensitiveScanSettingsOf(profile: GuardProfile | null | undefined): SensitiveScanSettings {
  if (!profile) return { dictionaries: [] };
  const entry = Object.values(profile.channels)
    .flatMap((channel) => channel?.detectors ?? [])
    .find((detector) => detector.id === DLP_DETECTOR_ID);
  const options = entry?.options ?? {};
  const classes = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
  const include = classes(options.include);
  const disable = classes(options.disable);
  const entitiesEntry = Object.values(profile.channels)
    .flatMap((channel) => channel?.detectors ?? [])
    .find((detector) => detector.id === ENTITIES_DETECTOR_ID);
  const parsed = entitiesEntry ? guardEntitiesOptionsOrNull(entitiesEntry.options) : null;
  // Stored options that do not parse: the defaults for the classes they list, so the rule set's check stays on.
  const fallback = entitiesEntry && !parsed ? guardEntitiesOptionsOrNull({ classes: (entitiesEntry.options as Record<string, unknown> | undefined)?.classes }) : null;
  const entities = parsed ?? fallback;
  return {
    ...(entities ? { entities } : {}),
    ...(entitiesEntry && !parsed ? { entitiesOptionsInvalid: true as const } : {}),
    dictionaries: profile.dictionaries,
    ...(profile.allowList ? { allowList: profile.allowList } : {}),
    ...(include ? { include } : {}),
    ...(disable ? { disable } : {}),
    ...(typeof options.entropyThreshold === "number" ? { entropyThreshold: options.entropyThreshold } : {})
  };
}

export interface SensitiveScanRequest {
  /** Only these classes are reported (opt-in classes such as `ip_address` are scanned when named here). */
  entityTypes?: readonly string[];
  /** Values never reported in this call, on top of the rule set's allow-list. */
  allowList?: Partial<AllowListInput>;
}

export interface SensitiveTextFinding {
  dataClass: string;
  start: number;
  end: number;
  score: number;
  /** The value masked the way its class is usually shown; never the value. */
  preview: string;
  message: string;
}

/** One text's findings, ordered by position. */
export function scanSensitiveText(text: string, settings: SensitiveScanSettings, request: SensitiveScanRequest = {}): { matches: DlpMatch[]; findings: SensitiveTextFinding[] } {
  const wanted = request.entityTypes && request.entityTypes.length > 0 ? new Set(request.entityTypes) : undefined;
  const include = new Set<GuardDataClass>(settings.include ?? []);
  for (const type of wanted ?? []) include.add(type);
  const options: DlpScanOptions = {
    dictionaries: settings.dictionaries,
    allowList: compileAllowList(settings.allowList, request.allowList),
    ...(include.size > 0 ? { include: [...include] } : {}),
    ...(settings.disable ? { disable: settings.disable } : {}),
    ...(settings.entropyThreshold !== undefined ? { entropyThreshold: settings.entropyThreshold } : {})
  };
  const matches = scanDlp(text, options).filter((match) => !wanted || wanted.has(String(match.dataClass)));
  return disjointResult(text, matches);
}

/** Overlapping matches (a phone number inside a card number) keep the earlier, wider one: a rewrite needs disjoint spans. */
function disjointResult(text: string, matches: readonly DlpMatch[]): { matches: DlpMatch[]; findings: SensitiveTextFinding[] } {
  const disjoint: DlpMatch[] = [];
  let end = -1;
  for (const match of [...matches].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end || b.score - a.score)) {
    if (match.span.start < end) continue;
    disjoint.push(match);
    end = match.span.end;
  }
  return {
    matches: disjoint,
    findings: disjoint.map((match) => ({
      dataClass: String(match.dataClass),
      start: match.span.start,
      end: match.span.end,
      score: Math.round(match.score * 100) / 100,
      preview: maskForDataClass(text.slice(match.span.start, match.span.end), match.dataClass),
      message: match.message
    }))
  };
}

/** The entity classes a scan looks for: those `entityTypes` names, or (without `entityTypes`) the rule set's. Never implied by "all". */
export function entityClassesFor(settings: Pick<SensitiveScanSettings, "entities">, request: Pick<SensitiveScanRequest, "entityTypes">): EntityDataClass[] {
  if (request.entityTypes && request.entityTypes.length > 0) return [...new Set(request.entityTypes.filter(isEntityDataClass))];
  return [...(settings.entities?.classes ?? [])];
}

export interface SensitiveScanContext {
  /** The deployment's recognizer (`engine: auto`). Absent: the built-in rules. */
  recognizer?: GuardEntityRecognizer;
  signal?: AbortSignal;
  /** The longest text names and addresses are looked for in (the caller's own input limit); default the options' `maxChars`. */
  maxChars?: number;
}

/** Names and addresses could not be looked for. `cause` keeps the original error for server logs; it may quote the input. */
export class EntityScanError extends Error {
  constructor(cause: unknown) {
    super("Names and addresses could not be checked", { cause });
    this.name = "EntityScanError";
  }
}

/**
 * `scanSensitiveText` plus person names, locations and street addresses, when the request names an entity class in
 * `entityTypes` or (without `entityTypes`) the rule set runs `data.entities`. Entity spans that overlap a data rule
 * match yield to it, and the allow-lists apply to them too.
 */
export async function scanSensitiveTextAsync(
  text: string,
  settings: SensitiveScanSettings,
  request: SensitiveScanRequest = {},
  context: SensitiveScanContext = {}
): Promise<{ matches: DlpMatch[]; findings: SensitiveTextFinding[] }> {
  return (await scanSensitiveTextsAsync([text], settings, request, context))[0]!;
}

/**
 * `scanSensitiveTextAsync` for many texts (the cells of a CSV file, the strings of a JSON value): names and addresses
 * are looked for in all of them together, so a service recognizer gets few requests of many texts instead of one per
 * text. One result per text, in order.
 */
export async function scanSensitiveTextsAsync(
  texts: readonly string[],
  settings: SensitiveScanSettings,
  request: SensitiveScanRequest = {},
  context: SensitiveScanContext = {}
): Promise<Array<{ matches: DlpMatch[]; findings: SensitiveTextFinding[] }>> {
  const bases = texts.map((text) => scanSensitiveText(text, settings, request));
  const classes = entityClassesFor(settings, request);
  if (classes.length === 0) return bases;
  const options = settings.entities ? { ...settings.entities, classes } : defaultEntitiesOptions(classes);
  let found: EntityMatch[][];
  try {
    found = await findEntitiesInPieces(texts, options, context);
  } catch (error) {
    throw new EntityScanError(error);
  }
  const allowList = compileAllowList(settings.allowList, request.allowList);
  return texts.map((text, index) => {
    const base = bases[index]!;
    const entities: DlpMatch[] = (found[index] ?? [])
      .filter((match) => match.score >= match.minScore && !(allowList.allows(text.slice(match.start, match.end))))
      .filter(notOverlapping(base.matches))
      .map((match) => ({ dataClass: match.dataClass, span: { start: match.start, end: match.end }, score: match.score, message: ENTITY_LABELS[match.dataClass] }));
    return entities.length === 0 ? base : disjointResult(text, [...base.matches, ...entities]);
  });
}

/** Names and addresses are looked for in pieces of this many characters at most, so a long text does not hold the event loop. */
export const ENTITY_SCAN_CHUNK_CHARS = 20_000;
/** Pieces overlap by this much; a span is taken from the piece that has at least half of it as context on each side. */
const ENTITY_SCAN_CHUNK_OVERLAP = 2_000;
/** Pieces asked for in one recognizer call at most (a service's request takes up to 64 texts). */
export const ENTITY_SCAN_BATCH_TEXTS = 64;
/** Characters asked for in one recognizer call at most; the event loop gets a turn between calls. */
export const ENTITY_SCAN_BATCH_CHARS = ENTITY_SCAN_CHUNK_CHARS * 2;

const nextTurn = () => new Promise<void>((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

interface EntityPiece {
  /** The text it belongs to. */
  text: number;
  /** Where the piece starts in that text. */
  offset: number;
  /** The piece owns spans that start in [from, to) of the text: the overlap is split in the middle between neighbours. */
  from: number;
  to: number;
  value: string;
}

/** A text as overlapping pieces of at most ENTITY_SCAN_CHUNK_CHARS (one piece when it is short enough). */
function piecesOf(text: string, index: number): EntityPiece[] {
  if (text.length <= ENTITY_SCAN_CHUNK_CHARS) return text.length === 0 ? [] : [{ text: index, offset: 0, from: 0, to: text.length, value: text }];
  const step = ENTITY_SCAN_CHUNK_CHARS - ENTITY_SCAN_CHUNK_OVERLAP;
  const half = ENTITY_SCAN_CHUNK_OVERLAP / 2;
  const pieces: EntityPiece[] = [];
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + ENTITY_SCAN_CHUNK_CHARS);
    const last = end === text.length;
    pieces.push({ text: index, offset: start, from: start === 0 ? 0 : start + half, to: last ? text.length : start + step + half, value: text.slice(start, end) });
    if (last) break;
  }
  return pieces;
}

/**
 * `findEntitiesMany` over many texts: long texts in overlapping pieces, pieces asked for in batches (at most
 * ENTITY_SCAN_BATCH_TEXTS pieces and about ENTITY_SCAN_BATCH_CHARS characters per recognizer call), yielding to the
 * event loop between batches and stopping when `signal` aborts. A text over the limit (the context's `maxChars`,
 * else the options') fails the whole scan.
 */
async function findEntitiesInPieces(texts: readonly string[], options: GuardEntitiesOptions, context: SensitiveScanContext): Promise<EntityMatch[][]> {
  const findContext = {
    ...(context.recognizer ? { recognizer: context.recognizer } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.maxChars !== undefined ? { maxChars: context.maxChars } : {})
  };
  const limit = context.maxChars ?? options.maxChars;
  for (const text of texts) {
    if (text.length > limit) throw new Error(`text longer than maxChars (${text.length} > ${limit})`);
  }
  const pieces = texts.flatMap((text, index) => piecesOf(text, index));
  const out: EntityMatch[][] = texts.map(() => []);
  let batch: EntityPiece[] = [];
  let batchChars = 0;
  let calls = 0;
  const run = async () => {
    if (batch.length === 0) return;
    if (calls > 0) await nextTurn();
    calls += 1;
    if (context.signal?.aborted) throw new Error("The names and addresses check was cancelled");
    const found = await findEntitiesMany(batch.map((piece) => piece.value), options, findContext);
    batch.forEach((piece, position) => {
      for (const match of found[position] ?? []) {
        const at = match.start + piece.offset;
        if (at >= piece.from && at < piece.to) out[piece.text]!.push({ ...match, start: at, end: match.end + piece.offset });
      }
    });
    batch = [];
    batchChars = 0;
  };
  for (const piece of pieces) {
    if (batch.length > 0 && (batch.length >= ENTITY_SCAN_BATCH_TEXTS || batchChars + piece.value.length > ENTITY_SCAN_BATCH_CHARS)) await run();
    batch.push(piece);
    batchChars += piece.value.length;
  }
  await run();
  // Pieces are in order, so each text's spans are in start order; one that crosses into the next piece's first span keeps the earlier.
  return out.map((matches) => {
    const disjoint: EntityMatch[] = [];
    for (const match of matches) {
      const previous = disjoint[disjoint.length - 1];
      if (previous && match.start < previous.end) continue;
      disjoint.push(match);
    }
    return disjoint;
  });
}

/** A filter for spans in start order: false for one that overlaps a match (matches disjoint, in start order). */
function notOverlapping(matches: readonly DlpMatch[]): (span: { start: number; end: number }) => boolean {
  let at = 0;
  return (span) => {
    while (at < matches.length && matches[at]!.span.end <= span.start) at += 1;
    return !(at < matches.length && matches[at]!.span.start < span.end);
  };
}

const ENTITY_LABELS: Record<EntityDataClass, string> = { person_name: "Person name", location: "Location", street_address: "Street address" };

/** Where a string sits in a JSON value: `$`, `$[0]`, `$.a.b`; an object key's own text has `{key}` after its path. */
export interface SensitiveStringRef {
  path: string;
  text: string;
  /** The text is an object key (scanned, never rewritten). */
  key?: boolean;
}

export const MAX_SCANNED_DEPTH = 32;

/** A JSON value nested deeper than MAX_SCANNED_DEPTH: refused rather than passed through unscanned. */
export class JsonTooDeepError extends Error {
  constructor() {
    super(`The value is nested deeper than ${MAX_SCANNED_DEPTH} levels`);
    this.name = "JsonTooDeepError";
  }
}

/**
 * The path of an object member: `.name` for a plain identifier key, else `{#n}` (the member's position), so a key that
 * is itself a value (an email used as a key) never appears in a path.
 */
function childPath(path: string, key: string, index: number): string {
  return /^[A-Za-z_$][\w$]{0,63}$/.test(key) ? `${path}.${key}` : `${path}{#${index}}`;
}

/** Strings in a JSON value with their paths, object keys included (marked `key`). Throws JsonTooDeepError past the depth limit. */
export function stringsIn(value: unknown, path = "$", depth = 0, out: SensitiveStringRef[] = []): SensitiveStringRef[] {
  if (typeof value === "string") {
    out.push({ path, text: value });
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (depth >= MAX_SCANNED_DEPTH) throw new JsonTooDeepError();
  if (Array.isArray(value)) {
    value.forEach((item, index) => stringsIn(item, `${path}[${index}]`, depth + 1, out));
    return out;
  }
  for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>).entries()) {
    const memberPath = childPath(path, key, index);
    out.push({ path: `${memberPath}{key}`, text: key, key: true });
    stringsIn(item, memberPath, depth + 1, out);
  }
  return out;
}

/** A JSON value with each string replaced by `rewrite(string, path)` (same shape; keys untouched). */
export async function mapStrings(value: unknown, rewrite: (text: string, path: string) => Promise<string>, path = "$", depth = 0): Promise<unknown> {
  if (typeof value === "string") return await rewrite(value, path);
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_SCANNED_DEPTH) throw new JsonTooDeepError();
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const [index, item] of value.entries()) next.push(await mapStrings(item, rewrite, `${path}[${index}]`, depth + 1));
    return next;
  }
  const next: Record<string, unknown> = {};
  for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>).entries()) {
    // defineProperty: a `__proto__` key stays an own member instead of replacing the prototype.
    Object.defineProperty(next, key, { value: await mapStrings(item, rewrite, childPath(path, key, index), depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return next;
}

/** One text with each match replaced by what `protect` returns for it (spans must be disjoint, as `scanSensitiveText` gives them). */
export async function rewriteMatches(text: string, matches: readonly DlpMatch[], protect: (value: string, dataClass: string) => Promise<string>): Promise<string> {
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.span.start) + (await protect(text.slice(match.span.start, match.span.end), String(match.dataClass)));
    cursor = match.span.end;
  }
  return out + text.slice(cursor);
}
