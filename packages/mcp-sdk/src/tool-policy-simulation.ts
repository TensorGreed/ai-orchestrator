import {
  conditionList,
  parseMcpPolicyPath,
  type McpPolicyCondition,
  type McpPolicyRole,
  type McpToolAnnotations,
  type McpToolPolicyEffect,
  type McpToolPolicyRule,
  type ToolArgumentFieldSummary,
  type ToolArgumentSummary,
  type ToolArgumentValueType
} from "@ai-orchestrator/shared";
import { hashToolArgumentValue, isToolArgumentLocationKey, toolArgumentHashKeyId } from "./tool-argument-summary";
import {
  MAX_EVALUATED_ARGUMENT_CHARS,
  MAX_GLOB_STEPS_PER_EVALUATION,
  MAX_RESOLVED_VALUES,
  conditionQuantifier,
  decidePolicyOutcome,
  describePolicyCondition,
  describePolicyRule,
  effectiveToolHints,
  evaluatePolicyCondition,
  evaluatePolicyConditionValue,
  hashMcpToolPolicyRule,
  matchesHintCondition,
  matchesPolicyServer,
  matchesToolPattern,
  policyRuleHasConditions,
  policyRuleKind,
  policyRuleMode,
  type PolicyConditionQuantifier
} from "./tool-policy";

/**
 * Phase 12.4 — policy simulation over recorded tool calls.
 *
 * A recorded call keeps a safe SUMMARY of its arguments (see
 * tool-argument-summary.ts), not the arguments. The summary is lossy, so a
 * rule's conditions are evaluated three-valued: `true`, `false`, or
 * `unknown` when the summary cannot say what `evaluatePolicyCondition` would
 * have decided on the real arguments. Nothing here guesses: a call is only
 * reported as allowed, denied or needing approval when every reading that is
 * consistent with its summary gives that outcome.
 *
 * The call-time semantics are reused, not re-implemented:
 *   - a value the summary keeps (a token, an enum value, a small number, a
 *     boolean, null) goes through `evaluatePolicyConditionValue`, the same
 *     per-value check `evaluatePolicyCondition` makes;
 *   - quantifiers (`any` for deny and require_approval, `every` for allow),
 *     missing paths, partial `[*]` readings and the 1,000-value cap follow
 *     `evaluatePolicyCondition` step by step, from the summary's per-path
 *     counts and types;
 *   - the outcome comes from `decidePolicyOutcome`, the precedence step of
 *     `evaluateMcpToolPolicy` (deny > require_approval > allow, carve-outs).
 *
 * What a summary determines:
 *   - kept values: every operator;
 *   - a hashed value: `equals`, `one_of` and `not_one_of`, by hashing the
 *     rule's literal with the deployment's summary key; a hash match proves
 *     equality, and no match proves inequality when every text that could
 *     equal the literal was hashed (not for a number literal against a value
 *     that may be a string such as "05", not with `ignoreCase` on cased text);
 *   - `exists`: key presence and the types seen at the path;
 *   - label conditions: only for gateway calls, which carry no data labels.
 * Undetermined: `starts_with`, `ends_with`, `matches` and the number
 * operators against a hashed value; any value only known by its length
 * (strings over 2,048 characters); `[n]` index steps (the summary merges
 * list elements); numbers under a location key (kept to one decimal) unless
 * the rounding cannot change the answer; anything a truncated summary or a
 * `more` list may hide; a call whose argument text could exhaust the
 * evaluator's per-call budgets.
 *
 * Values whose kept or hashed form is not what the evaluator reads:
 *   - a format 3 field marked `adj` (surrounding whitespace, a form NFKC
 *     changed, a rounded number): its text and hashed values are undetermined
 *     for every operator, and so are its kept numbers (a location number
 *     keeps its ±0.05 interval for the number compares);
 *   - a hashed number under a location key was rounded to one decimal before
 *     hashing: undetermined for every operator;
 *   - hashes made under another key (the summary's `kid` differs from this
 *     deployment's, or a format 2 summary, which has no `kid`): undetermined;
 *   - format 2 summaries carry no `adj` mark, so their kept text is treated as
 *     possibly adjusted (undetermined for every operator), and so are kept
 *     numbers that are not integers for the number and equality operators.
 *     Format 2 integers stay determined: one only differs from the value when
 *     the value was within 0.00005 of it.
 */

export type SimulationTruth = true | false | "unknown";

/** A recorded tool call as the simulator reads it. */
export interface PolicySimulationCall {
  role: McpPolicyRole | null;
  projectId: string | null;
  /** The workflow whose run made the call; null for gateway calls. */
  workflowId: string | null;
  /** The gateway client; null when there was none, undefined when not recorded (a run a client started). */
  clientId: string | null | undefined;
  adapterId: string;
  registryServerId?: string | null;
  toolName: string;
  /** The tool's annotations; undefined when not known. */
  annotations?: McpToolAnnotations | null;
  /** The admin's read-only mark for the tool; undefined when not known. */
  manualReadOnly?: boolean | null;
  /** `none`: the call carried no data labels (gateway); `unknown`: not recorded. */
  labels: "none" | "unknown";
  summary: ToolArgumentSummary;
}

export interface PolicySimulationContext {
  /** The deployment's summary hash key (`toolArgumentHashKey`). */
  hashKey: Uint8Array;
}

const keyIdCache = new WeakMap<Uint8Array, string>();

function contextKeyId(context: PolicySimulationContext): string {
  let id = keyIdCache.get(context.hashKey);
  if (id === undefined) {
    id = toolArgumentHashKeyId(context.hashKey);
    keyIdCache.set(context.hashKey, id);
  }
  return id;
}

/** What the summary as a whole says about how far its values can be trusted. */
interface SummaryTrust {
  /** Its hashes were made under this deployment's key (format 3 with a matching `kid`). */
  hashesComparable: boolean;
  /** Format 2: no `adj` marks, so kept text and non-integer numbers may be adjusted. */
  legacy: boolean;
}

function summaryTrust(summary: ToolArgumentSummary, context: PolicySimulationContext): SummaryTrust {
  return {
    hashesComparable: summary.v !== 2 && typeof summary.kid === "string" && summary.kid === contextKeyId(context),
    legacy: summary.v === 2
  };
}

export interface SimulatedRuleState {
  state: "match" | "no_match" | "unknown";
  /** Why the summary cannot decide, for `unknown`. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Three-valued logic
// ---------------------------------------------------------------------------

function and3(values: SimulationTruth[]): SimulationTruth {
  if (values.some((value) => value === false)) return false;
  return values.some((value) => value === "unknown") ? "unknown" : true;
}

function or3(values: SimulationTruth[]): SimulationTruth {
  if (values.some((value) => value === true)) return true;
  return values.some((value) => value === "unknown") ? "unknown" : false;
}

/**
 * A condition result when something may have forced `forced` instead (a cap
 * cut the reading, a budget ran out): kept when it already is `forced`,
 * unknown otherwise.
 */
function orForced(value: SimulationTruth, forced: boolean): SimulationTruth {
  return value === forced ? value : "unknown";
}

// ---------------------------------------------------------------------------
// Reading the summary along a policy path
// ---------------------------------------------------------------------------

type Tri = "yes" | "no" | "unknown";

interface FieldView {
  path: string;
  field: ToolArgumentFieldSummary;
  count: number;
  types: ReadonlySet<ToolArgumentValueType>;
}

const SCALAR_TYPES: ReadonlySet<ToolArgumentValueType> = new Set(["string", "number", "boolean"]);

function fieldTypes(field: ToolArgumentFieldSummary): Set<ToolArgumentValueType> {
  return field.type === "mixed" ? new Set(field.types ?? []) : new Set([field.type]);
}

function viewField(summary: ToolArgumentSummary, path: string): FieldView | null {
  if (!Object.prototype.hasOwnProperty.call(summary.fields, path)) return null;
  const field = summary.fields[path]!;
  return { path, field, count: field.count ?? 1, types: fieldTypes(field) };
}

interface SummaryReading {
  /** The field holding the values the path reaches (before a final list is read element by element); null when none. */
  final: FieldView | null;
  /** The elements of the lists at `final` (a path ending on a list); null when there are none. */
  elements: FieldView | null;
  /** Values the summary does not show may exist at the path (a truncated summary). */
  hidden: boolean;
  /** `evaluatePolicyCondition`'s `partial`: some element reached through `[*]` lacks the rest of the path. */
  partial: Tri;
  /** `evaluatePolicyCondition`'s `incomplete`: the reading was cut at `MAX_RESOLVED_VALUES`. */
  incomplete: Tri;
  /** A key on the path is a location key: its numbers are kept to one decimal. */
  location: boolean;
}

type ReadingResult = { ok: SummaryReading } | { unknown: string } | { unparseable: true };

const keyHashCache = new WeakMap<Uint8Array, Map<string, string>>();

/** The hash a summary writes for an object key it does not keep (`<k:HASH>`). */
function hashedKey(key: string, context: PolicySimulationContext): string {
  let byKey = keyHashCache.get(context.hashKey);
  if (!byKey) {
    byKey = new Map();
    keyHashCache.set(context.hashKey, byKey);
  }
  let hash = byKey.get(key);
  if (hash === undefined) {
    hash = hashToolArgumentValue(key, context.hashKey);
    if (byKey.size > 10_000) byKey.clear();
    byKey.set(key, hash);
  }
  return hash;
}

/**
 * The summary's view of `path`, following `resolveValues` in tool-policy.ts
 * step by step. A key step looks for the key as a plain segment and as its
 * hashed form (`<k:HASH>`); `[*]` reads the `[]` field; an index step cannot
 * be read (the summary merges list elements).
 */
function readSummaryPath(summary: ToolArgumentSummary, path: string, readEndArrays: boolean, context: PolicySimulationContext): ReadingResult {
  const steps = parseMcpPolicyPath(path);
  if (!steps) return { unparseable: true };
  const truncated = summary.truncated === true;
  let currentPath = "";
  let current: FieldView | null = null;
  let root = true;
  let afterWildcard = false;
  let partial: Tri = "no";
  let incomplete: Tri = "no";
  let location = false;
  for (const step of steps) {
    if ("index" in step) return { unknown: "an index step ([n]) cannot be read from a summary, which merges list elements" };
    const count = root ? 1 : current!.count;
    const types: ReadonlySet<ToolArgumentValueType> = root ? new Set(["object"]) : current!.types;
    let next: FieldView | null = null;
    let nonYielding: Tri;
    if ("key" in step) {
      if (isToolArgumentLocationKey(step.key)) location = true;
      if (types.has("object")) {
        const plain = currentPath ? `${currentPath}.${step.key}` : step.key;
        const hashedSegment = `<k:${hashedKey(step.key, context)}>`;
        const hashed = currentPath ? `${currentPath}.${hashedSegment}` : hashedSegment;
        next = viewField(summary, plain) ?? viewField(summary, hashed);
      }
      const others = [...types].some((type) => type !== "object");
      if (others) nonYielding = "yes";
      else if (truncated) nonYielding = "unknown";
      else nonYielding = (next?.count ?? 0) < count ? "yes" : "no";
    } else {
      if (types.has("array")) next = viewField(summary, `${currentPath}[]`);
      const others = [...types].some((type) => type !== "array");
      if (others) nonYielding = "yes";
      else if (!next) nonYielding = "yes";
      else if (count === 1 && !truncated) nonYielding = "no";
      else nonYielding = "unknown";
      if (next) {
        if (next.count > MAX_RESOLVED_VALUES) incomplete = "yes";
        else if (truncated && incomplete === "no") incomplete = "unknown";
      } else if (truncated && incomplete === "no") {
        incomplete = "unknown";
      }
    }
    if (afterWildcard) {
      if (nonYielding === "yes") partial = "yes";
      else if (nonYielding === "unknown" && partial === "no") partial = "unknown";
    }
    if ("any" in step) afterWildcard = true;
    if (incomplete === "yes") break;
    root = false;
    current = next;
    currentPath = next?.path ?? "";
    if (!next) break;
  }
  if (incomplete === "yes" || !current) {
    return { ok: { final: current, elements: null, hidden: truncated, partial, incomplete, location } };
  }
  let elements: FieldView | null = null;
  if (readEndArrays && current.types.has("array")) {
    elements = viewField(summary, `${current.path}[]`);
    if (afterWildcard) {
      if (!elements) partial = "yes";
      else if (!(current.count === 1 && current.types.size === 1 && !truncated) && partial === "no") partial = "unknown";
    }
    const arraysOnly = current.types.size === 1;
    const lower = (elements?.count ?? 0) + (arraysOnly ? 0 : 1);
    const upper = (elements?.count ?? 0) + (arraysOnly ? 0 : current.count - 1);
    if (lower > MAX_RESOLVED_VALUES) incomplete = "yes";
    else if ((upper > MAX_RESOLVED_VALUES || truncated) && incomplete === "no") incomplete = "unknown";
  } else if (current.count > MAX_RESOLVED_VALUES) {
    incomplete = "yes";
  }
  return { ok: { final: current, elements, hidden: truncated, partial, incomplete, location } };
}

// ---------------------------------------------------------------------------
// Values a field shows
// ---------------------------------------------------------------------------

type Representative =
  | { kind: "raw"; value: string | number | boolean }
  | { kind: "null" }
  | { kind: "unreadable" }
  | { kind: "hash"; hash: string };

interface FieldValues {
  reps: Representative[];
  /** The field may hold values it does not show (a dropped list, text kept by length only, a truncated summary). */
  extra: boolean;
  /** Types the hashed values may have. */
  types: ReadonlySet<ToolArgumentValueType>;
  /** The field is marked `adj`: some kept or hashed value differs from what the evaluator reads. */
  adjusted: boolean;
}

/** The values a field shows; `skipLists`: lists at the field are read element by element elsewhere, else each is unreadable. */
function fieldValues(view: FieldView, options: { skipLists: boolean; hidden: boolean }): FieldValues {
  const { field, types } = view;
  const reps: Representative[] = [];
  if (types.has("null")) reps.push({ kind: "null" });
  if (types.has("object")) reps.push({ kind: "unreadable" });
  if (types.has("array") && !options.skipLists) reps.push({ kind: "unreadable" });
  for (const value of field.values ?? []) reps.push({ kind: "raw", value });
  for (const hash of field.hashes ?? []) reps.push({ kind: "hash", hash });
  const scalarTypes = [...types].filter((type) => SCALAR_TYPES.has(type));
  const shown = (field.values?.length ?? 0) + (field.hashes?.length ?? 0);
  const extra =
    options.hidden ||
    field.more === true ||
    field.len === "2049+" ||
    (field.type === "mixed" && (field.types?.length ?? 0) === 0) ||
    (scalarTypes.length > 0 && shown === 0);
  return { reps, extra, types, adjusted: field.adj === true };
}

// ---------------------------------------------------------------------------
// One value against one operator
// ---------------------------------------------------------------------------

const LOCATION_PRECISION = 0.05;
const NUMERIC_TEXT = /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i;

function parseNumber(text: string): number | undefined {
  if (!NUMERIC_TEXT.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function canonicalNumberText(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

/** Literal entries of an equality operator, as `scalarSet` in tool-policy.ts reads them; null for a malformed value. */
function equalityEntries(condition: McpPolicyCondition): unknown[] | null {
  const expected = condition.value;
  if (condition.op === "equals") return Array.isArray(expected) || expected === undefined ? null : [expected];
  return Array.isArray(expected) ? expected : null;
}

function caseVariants(text: string): string[] {
  return [...new Set([text, text.toLowerCase(), text.toUpperCase(), text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()])];
}

interface HashedLiterals {
  /** Hashes of texts that equal an entry whatever the value's type. */
  proving: Set<string>;
  /** Hashes of the canonical number text of numeric string entries: equal for a number value, not for a string. */
  numberOnly: Set<string>;
  /** Some value that may be a string equals an entry without its text being hashed here ("05" for 5, case variants). */
  openForStrings: boolean;
}

const hashedLiteralsCache = new WeakMap<Uint8Array, WeakMap<McpPolicyCondition, HashedLiterals | null>>();

function hashedLiterals(condition: McpPolicyCondition, context: PolicySimulationContext): HashedLiterals | null {
  let byCondition = hashedLiteralsCache.get(context.hashKey);
  if (!byCondition) {
    byCondition = new WeakMap();
    hashedLiteralsCache.set(context.hashKey, byCondition);
  }
  const cached = byCondition.get(condition);
  if (cached !== undefined) return cached;
  const entries = equalityEntries(condition);
  let literals: HashedLiterals | null = null;
  if (entries) {
    const ignoreCase = condition.ignoreCase === true;
    const digest = (text: string) => hashToolArgumentValue(text, context.hashKey);
    literals = { proving: new Set(), numberOnly: new Set(), openForStrings: false };
    for (const entry of entries) {
      if (typeof entry === "number") {
        if (!Number.isFinite(entry)) continue;
        // The number itself, or a string holding exactly its canonical text; other strings ("05", "5.0") equal it too.
        literals.proving.add(digest(canonicalNumberText(entry)));
        literals.openForStrings = true;
      } else if (typeof entry === "boolean" || typeof entry === "string") {
        const text = typeof entry === "boolean" ? String(entry) : entry.trim();
        for (const variant of ignoreCase ? caseVariants(text) : [text]) literals.proving.add(digest(variant));
        if (ignoreCase && text.toLowerCase() !== text.toUpperCase()) literals.openForStrings = true;
        const number = typeof entry === "string" ? parseNumber(text) : undefined;
        if (number !== undefined) literals.numberOnly.add(digest(canonicalNumberText(number)));
      }
    }
    for (const hash of literals.proving) literals.numberOnly.delete(hash);
  }
  byCondition.set(condition, literals);
  return literals;
}

/**
 * Whether a hashed value equals one of the literal entries, the way
 * `inScalarSet` in tool-policy.ts compares: `true` when the hash of a text
 * that equals an entry matches, `false` when no text that could equal an
 * entry has this hash, `unknown` otherwise.
 */
function hashedMembership(
  condition: McpPolicyCondition,
  hash: string,
  types: ReadonlySet<ToolArgumentValueType>,
  context: PolicySimulationContext
): SimulationTruth {
  const literals = hashedLiterals(condition, context);
  if (!literals) return false;
  const mayBeString = types.has("string");
  if (literals.proving.has(hash)) return true;
  if (literals.numberOnly.has(hash)) return mayBeString ? "unknown" : true;
  if (mayBeString && literals.openForStrings) return "unknown";
  return false;
}

type ValueReading = boolean | "unreadable" | "unknown";

function rawNumberAtLocation(condition: McpPolicyCondition, value: number): ValueReading {
  const at = (point: number) => evaluatePolicyConditionValue(condition, point);
  switch (condition.op) {
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const low = at(value - LOCATION_PRECISION);
      const high = at(value + LOCATION_PRECISION);
      return low === high ? low : "unknown";
    }
    case "between": {
      const expected = condition.value;
      if (!Array.isArray(expected) || typeof expected[0] !== "number" || typeof expected[1] !== "number") return at(value);
      const [min, max] = expected as [number, number];
      if (value - LOCATION_PRECISION >= min && value + LOCATION_PRECISION <= max) return true;
      if (max < value - LOCATION_PRECISION || min > value + LOCATION_PRECISION) return false;
      return "unknown";
    }
    default:
      return "unknown";
  }
}

/**
 * True when the condition's literal is malformed for its operator: the
 * evaluator then reads every non-null scalar as `false`, whatever its value.
 */
function malformedLiteral(condition: McpPolicyCondition): boolean {
  const expected = condition.value;
  switch (condition.op) {
    case "equals":
    case "one_of":
    case "not_one_of":
      return equalityEntries(condition) === null;
    case "starts_with":
    case "ends_with":
    case "matches":
      return typeof expected !== "string";
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return typeof expected !== "number" || !Number.isFinite(expected);
    case "between":
      return (
        !Array.isArray(expected) ||
        expected.length !== 2 ||
        typeof expected[0] !== "number" ||
        typeof expected[1] !== "number" ||
        !Number.isFinite(expected[0]) ||
        !Number.isFinite(expected[1])
      );
    default:
      return false;
  }
}

interface RepresentativeReading {
  reading: ValueReading;
  /** Why the reading is unknown. */
  why?: string;
}

const unknownBecause = (why: string): RepresentativeReading => ({ reading: "unknown", why });

function readRepresentative(
  condition: McpPolicyCondition,
  rep: Representative,
  values: FieldValues,
  location: boolean,
  trust: SummaryTrust,
  context: PolicySimulationContext
): RepresentativeReading {
  if (rep.kind === "unreadable") return { reading: "unreadable" };
  if (rep.kind === "null") return { reading: evaluatePolicyConditionValue(condition, null) };
  // A malformed literal reads every non-null scalar as false at call time, whatever the value.
  if (malformedLiteral(condition)) return { reading: false };
  if (rep.kind === "raw") {
    const value = rep.value;
    if (typeof value === "string") {
      if (values.adjusted) return unknownBecause("the kept text differs from the value (whitespace or a Unicode compatibility form)");
      if (trust.legacy) return unknownBecause("a format 2 summary may keep text in a normalised form");
      return { reading: evaluatePolicyConditionValue(condition, value) };
    }
    if (typeof value === "number") {
      if (location) {
        const reading = rawNumberAtLocation(condition, value);
        return reading === "unknown" ? unknownBecause("location numbers are kept to one decimal") : { reading };
      }
      if (values.adjusted) return unknownBecause("the kept number was rounded");
      if (trust.legacy && !Number.isInteger(value)) return unknownBecause("a format 2 summary keeps numbers rounded to four decimals");
    }
    return { reading: evaluatePolicyConditionValue(condition, value) };
  }
  if (condition.op !== "equals" && condition.op !== "one_of" && condition.op !== "not_one_of") {
    return unknownBecause("the value is kept only as a hash");
  }
  if (!trust.hashesComparable) return unknownBecause("the value was hashed under another key, or by a format 2 summary");
  if (location && values.types.has("number")) return unknownBecause("a location number is rounded to one decimal before it is hashed");
  if (values.adjusted) return unknownBecause("the hashed text differs from the value (whitespace or a Unicode compatibility form)");
  const member = hashedMembership(condition, rep.hash, values.types, context);
  if (member === "unknown") return unknownBecause("the value is kept only as a hash");
  return { reading: condition.op === "not_one_of" ? !member : member };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

const LENGTH_BUCKET_MAX: Record<string, number> = {
  "0": 0,
  "1-8": 8,
  "9-32": 32,
  "33-128": 128,
  "129-512": 512,
  "513-2048": 2048,
  "2049+": MAX_EVALUATED_ARGUMENT_CHARS
};

/** Longest kept text: an enum value (64 characters) or a token (32). */
const KEPT_TEXT_MAX = 64;

/** The longest string a field may hold, as far as the summary says. */
function fieldMaxTextLength(view: FieldView): number {
  if (!view.types.has("string")) return 0;
  const bucket = view.field.len ? LENGTH_BUCKET_MAX[view.field.len] ?? MAX_EVALUATED_ARGUMENT_CHARS : 0;
  return Math.max(bucket, KEPT_TEXT_MAX);
}

/**
 * Upper bounds on the work one call-time evaluation of these conditions may
 * do: argument text read (each value once) and glob steps. When a bound is
 * over the evaluator's budget, a value may have read as unreadable at call
 * time, so readings that depend on it are not trusted.
 */
export interface SimulationBudgetCheck {
  textSafe: boolean;
  globSafe: boolean;
}

function budgetCheck(conditions: readonly McpPolicyCondition[], summary: ToolArgumentSummary, context: PolicySimulationContext): SimulationBudgetCheck {
  const charged = new Map<string, number>();
  let globSteps = 0;
  for (const condition of conditions) {
    if (!condition.path || condition.op === "exists" || condition.op === "label_present" || condition.op === "label_absent") continue;
    const reading = readSummaryPath(summary, condition.path, true, context);
    if (!("ok" in reading)) continue;
    for (const view of [reading.ok.final, reading.ok.elements]) {
      if (!view) continue;
      const longest = fieldMaxTextLength(view);
      charged.set(view.path, view.count * longest);
      if (condition.op === "matches" && typeof condition.value === "string") {
        globSteps += view.count * (Math.max(longest, 32) + 1) * (condition.value.length + 1);
      }
    }
  }
  let text = 0;
  for (const value of charged.values()) text += value;
  return { textSafe: text <= MAX_EVALUATED_ARGUMENT_CHARS, globSafe: globSteps <= MAX_GLOB_STEPS_PER_EVALUATION };
}

// ---------------------------------------------------------------------------
// One condition against a summary
// ---------------------------------------------------------------------------

const NEGATED_OPS = new Set<McpPolicyCondition["op"]>(["not_one_of", "label_absent"]);

export interface SimulatedConditionResult {
  value: SimulationTruth;
  reason?: string;
}

function conditionText(condition: McpPolicyCondition): string {
  return describePolicyCondition(condition);
}

/**
 * One condition against a call's summary, three-valued, for a rule whose
 * effect reads several values with `quantifier`. `budget` says whether the
 * call-time budgets may have run out for the call's conditions.
 */
export function evaluateConditionOnSummary(
  condition: McpPolicyCondition,
  call: Pick<PolicySimulationCall, "summary" | "labels">,
  quantifier: PolicyConditionQuantifier,
  context: PolicySimulationContext,
  budget: SimulationBudgetCheck = { textSafe: true, globSafe: true }
): SimulatedConditionResult {
  const anyQuantifier = quantifier === "any";
  if (condition.op === "label_present" || condition.op === "label_absent") {
    if (call.labels === "none") return { value: evaluatePolicyCondition(condition, {}, null, quantifier) };
    return { value: "unknown", reason: `${conditionText(condition)}: the run's data labels are not recorded` };
  }
  if (typeof condition.path !== "string") return { value: anyQuantifier };
  const reading = readSummaryPath(call.summary, condition.path, condition.op !== "exists", context);
  if ("unparseable" in reading) return { value: anyQuantifier };
  if ("unknown" in reading) return { value: "unknown", reason: `${conditionText(condition)}: ${reading.unknown}` };
  const { final, elements, hidden, partial, incomplete, location } = reading.ok;

  let reason: string | undefined;
  let base: SimulationTruth;
  if (incomplete === "yes") return { value: anyQuantifier };
  if (condition.op === "exists") {
    let exists: SimulationTruth;
    if (!final) exists = hidden ? "unknown" : false;
    else if ([...final.types].some((type) => type !== "null")) exists = true;
    else exists = hidden ? "unknown" : false;
    if (exists === "unknown") reason = `${conditionText(condition)}: the summary was cut short`;
    base = exists === "unknown" ? "unknown" : condition.value === false ? !exists : exists;
  } else {
    const groups: FieldValues[] = [];
    // A list at the end of the path is read element by element (`elements`), as `evaluatePolicyCondition` does.
    if (final) groups.push(fieldValues(final, { skipLists: true, hidden }));
    if (elements) groups.push(fieldValues(elements, { skipLists: false, hidden }));
    if (final?.types.has("array") && !elements && hidden) groups.push({ reps: [], extra: true, types: new Set(), adjusted: false });
    const trust = summaryTrust(call.summary, context);
    const readings: RepresentativeReading[] = [];
    let extra = false;
    for (const group of groups) {
      extra ||= group.extra;
      for (const rep of group.reps) readings.push(readRepresentative(condition, rep, group, location, trust, context));
    }
    if (!final && hidden) extra = true;
    const unknownOne = readings.find((entry) => entry.reading === "unknown");
    const describeUnknown = () => {
      if (unknownOne) return unknownOne.why ?? "the summary cannot compare this value";
      if (hidden) return "the summary was cut short";
      return "some values are kept only by their length";
    };
    if (readings.length === 0 && !extra) {
      base = anyQuantifier && NEGATED_OPS.has(condition.op) && Array.isArray(condition.value);
    } else if (anyQuantifier) {
      if (readings.some((entry) => entry.reading === true || entry.reading === "unreadable")) base = true;
      else if (unknownOne || extra) base = "unknown";
      else base = false;
    } else {
      if (readings.some((entry) => entry.reading === false || entry.reading === "unreadable")) base = false;
      else if (unknownOne || extra) base = "unknown";
      else base = true;
    }
    if (base === "unknown") reason = `${conditionText(condition)}: ${describeUnknown()}`;
    if (!budget.textSafe || (condition.op === "matches" && !budget.globSafe)) {
      const before = base;
      base = orForced(base, anyQuantifier);
      if (base === "unknown" && before !== "unknown") reason = `${conditionText(condition)}: the call's arguments may have exceeded the evaluation budget`;
    }
  }
  if (!anyQuantifier) {
    if (partial === "yes") return { value: false };
    if (partial === "unknown" && base !== false) {
      return { value: "unknown", reason: reason ?? `${conditionText(condition)}: the summary cannot tell whether every list element has the path` };
    }
  }
  if (incomplete === "unknown") {
    const value = orForced(base, anyQuantifier);
    return value === "unknown" ? { value, reason: reason ?? `${conditionText(condition)}: the summary cannot tell whether the path holds more than ${MAX_RESOLVED_VALUES} values` } : { value };
  }
  return base === "unknown" ? { value: base, ...(reason ? { reason } : {}) } : { value: base };
}

// ---------------------------------------------------------------------------
// One rule against a call
// ---------------------------------------------------------------------------

function scopeState(rule: McpToolPolicyRule, call: PolicySimulationCall): SimulatedRuleState {
  if (!rule.enabled) return { state: "no_match" };
  if (policyRuleKind(rule) !== "tool") return { state: "no_match" };
  if (rule.projectId && rule.projectId !== (call.projectId ?? null)) return { state: "no_match" };
  if (rule.workflowIds?.length && !(call.workflowId && rule.workflowIds.includes(call.workflowId))) return { state: "no_match" };
  if (!matchesPolicyServer(rule.serverId, { adapterId: call.adapterId, ...(call.registryServerId ? { registryServerId: call.registryServerId } : {}) })) {
    return { state: "no_match" };
  }
  if (!matchesToolPattern(rule.toolPattern, call.toolName)) return { state: "no_match" };
  const unknowns: string[] = [];
  if (rule.roles.length > 0) {
    if (call.role === null) unknowns.push("the call's role is not recorded");
    else if (!rule.roles.includes(call.role)) return { state: "no_match" };
  }
  if (rule.clientIds?.length) {
    if (call.clientId === undefined) unknowns.push("the gateway client that started the run is not recorded");
    else if (!(call.clientId && rule.clientIds.includes(call.clientId))) return { state: "no_match" };
  }
  if (rule.annotationHint) {
    if (call.annotations === undefined) unknowns.push("the tool's annotations are not known");
    else if (!matchesHintCondition(rule.annotationHint, effectiveToolHints(call.annotations, call.manualReadOnly ?? null))) return { state: "no_match" };
  }
  return unknowns.length > 0 ? { state: "unknown", reason: unknowns[0] } : { state: "match" };
}

/** The conditions a set of rules reads, for the budget check. */
function ruleConditions(rules: readonly McpToolPolicyRule[]): McpPolicyCondition[] {
  return rules.flatMap((rule) => conditionList(rule.conditions).items);
}

/**
 * Whether `rule` matches the recorded call, three-valued: its scope from the
 * recorded principals and server, then its conditions from the summary. An
 * invalid rule fails closed as at call time.
 */
export function evaluateRuleOnSummary(
  rule: McpToolPolicyRule,
  call: PolicySimulationCall,
  context: PolicySimulationContext,
  budget?: SimulationBudgetCheck
): SimulatedRuleState {
  const scope = scopeState(rule, call);
  if (scope.state === "no_match") return scope;
  if (rule.invalid) return rule.effect === "allow" ? { state: "no_match" } : scope;
  if (!policyRuleHasConditions(rule)) return scope;
  const { combine, items } = conditionList(rule.conditions);
  const quantifier = conditionQuantifier(rule.effect);
  const checks = budget ?? budgetCheck(items, call.summary, context);
  const results = items.map((condition) => evaluateConditionOnSummary(condition, call, quantifier, context, checks));
  const value = combine === "any" ? or3(results.map((result) => result.value)) : and3(results.map((result) => result.value));
  if (value === false) return { state: "no_match" };
  if (value === true) return scope;
  const reason = results.find((result) => result.value === "unknown")?.reason;
  return { state: "unknown", reason: scope.reason ?? reason ?? "the summary cannot decide the conditions" };
}

// ---------------------------------------------------------------------------
// Current rules vs draft rules for one call
// ---------------------------------------------------------------------------

export type PolicySimulationBucket =
  | "newly_denied"
  | "newly_needs_approval"
  | "no_longer_denied"
  | "no_longer_needs_approval"
  | "unchanged"
  | "undetermined";

export function simulationBucket(current: McpToolPolicyEffect, draft: McpToolPolicyEffect): Exclude<PolicySimulationBucket, "undetermined"> {
  if (current === draft) return "unchanged";
  if (draft === "deny") return "newly_denied";
  if (current === "deny") return "no_longer_denied";
  if (draft === "require_approval") return "newly_needs_approval";
  return "no_longer_needs_approval";
}

/** Most rules whose match the summary cannot decide that are tried in every combination (2^8 readings). */
export const MAX_UNDECIDED_RULES_PER_CALL = 8;

/**
 * Most work one call may cost (the units of `SimulatedTransition.work`), about 50 ms of CPU on a typical machine.
 * A call whose worst case is over it is not evaluated: it is undetermined (`notEvaluated: "too_costly"`).
 */
export const MAX_SIMULATION_WORK_PER_CALL = 2_000_000;

export interface SimulatePolicyTransitionOptions {
  /**
   * The work the caller can still afford. A call whose worst case is over it (and within the per-call ceiling) is
   * not evaluated (`notEvaluated: "over_budget"`), so the caller can stop before spending it.
   */
  maxWork?: number;
}

export interface SimulatedOutcome {
  effect: McpToolPolicyEffect | null;
  /** The deciding rule, when the same in every reading. */
  ruleId?: string;
}

export interface SimulatedTransition {
  bucket: PolicySimulationBucket;
  current: SimulatedOutcome;
  draft: SimulatedOutcome;
  /** Why the bucket is undetermined. */
  reason?: string;
  /**
   * Set when the call was not evaluated because its worst-case work was too high: over the per-call ceiling
   * (`too_costly`, the bucket is undetermined) or over the caller's `maxWork` (`over_budget`). Such a call is never
   * reported as allowed or denied.
   */
  notEvaluated?: "too_costly" | "over_budget";
  /** Each enforced draft rule's match state, by its index in the draft list. */
  draftStates: SimulatedRuleState[];
  /**
   * The work this call cost: per reading tried, the rules in scope (at least
   * 1) plus the decision work of the current and the draft outcome (see
   * `decisionWork`). A caller bounds a whole simulation with it.
   */
  work: number;
}

function ruleIdentity(rule: McpToolPolicyRule): string {
  return `${hashMcpToolPolicyRule(rule)}${rule.invalid ? ":invalid" : ""}`;
}

/** Rule identities memoised by object: a rule set is evaluated against many calls. */
const identityCache = new WeakMap<McpToolPolicyRule, string>();

function identityOf(rule: McpToolPolicyRule): string {
  let identity = identityCache.get(rule);
  if (identity === undefined) {
    identity = ruleIdentity(rule);
    identityCache.set(rule, identity);
  }
  return identity;
}

/**
 * The work of deciding an outcome over these matched rules: each deny and
 * require_approval rule is compared with each allow and require_approval
 * rule (`isStrictlyNarrower`), so the cost grows with their product, not with
 * the number of rules.
 */
export function decisionWork(matched: readonly McpToolPolicyRule[]): number {
  let strict = 0;
  let carving = 0;
  for (const rule of matched) {
    if (rule.effect !== "allow") strict += 1;
    if (rule.effect !== "deny") carving += 1;
  }
  return matched.length + strict * carving;
}

function enforcedOnly(rules: readonly McpToolPolicyRule[]): McpToolPolicyRule[] {
  return rules.filter((rule) => rule.enabled && policyRuleMode(rule) === "enforce");
}

/**
 * The enforced outcome of `current` and of `draft` for one recorded call,
 * and the change between them. Shadow rules never change an outcome, so only
 * enforced rules are read. Rules the summary cannot decide are tried both
 * ways (a rule present in both lists the same way in both); the bucket is
 * determined only when every combination lands in the same bucket.
 */
export function simulatePolicyTransition(
  current: readonly McpToolPolicyRule[],
  draft: readonly McpToolPolicyRule[],
  call: PolicySimulationCall,
  context: PolicySimulationContext,
  options: SimulatePolicyTransitionOptions = {}
): SimulatedTransition {
  const currentRules = enforcedOnly(current);
  const draftRules = enforcedOnly(draft);
  const states = new Map<string, SimulatedRuleState>();
  const relevant: McpToolPolicyRule[] = [];
  const scoped = (rule: McpToolPolicyRule) => scopeState(rule, call).state !== "no_match";
  for (const rule of [...currentRules, ...draftRules]) if (scoped(rule)) relevant.push(rule);
  const budget = budgetCheck(ruleConditions(relevant), call.summary, context);
  const stateOf = (rule: McpToolPolicyRule): SimulatedRuleState => {
    const identity = identityOf(rule);
    let state = states.get(identity);
    if (!state) {
      state = evaluateRuleOnSummary(rule, call, context, budget);
      states.set(identity, state);
    }
    return state;
  };
  const currentStates = currentRules.map(stateOf);
  const draftStates = draftRules.map(stateOf);
  const undecided = [...states.entries()].filter(([, state]) => state.state === "unknown").map(([identity]) => identity);
  const draftStateList = draft.map((rule) => (rule.enabled && policyRuleMode(rule) === "enforce" ? stateOf(rule) : { state: "no_match" as const }));
  const firstReason = () => [...states.values()].find((state) => state.state === "unknown")?.reason;
  const scopedRules = Math.max(1, relevant.length);
  if (undecided.length > MAX_UNDECIDED_RULES_PER_CALL) {
    return {
      bucket: "undetermined",
      current: { effect: null },
      draft: { effect: null },
      reason: `${undecided.length} rules cannot be decided from the summary (${firstReason() ?? "lossy summary"})`,
      draftStates: draftStateList,
      work: scopedRules
    };
  }
  const outcomes = new Set<string>();
  const currentEffects = new Set<McpToolPolicyEffect>();
  const draftEffects = new Set<McpToolPolicyEffect>();
  const currentDeciders = new Set<string | undefined>();
  const draftDeciders = new Set<string | undefined>();
  const combinations = 1 << undecided.length;
  // Worst case before any reading is tried: every rule that may match does match in every reading. Decision work
  // only grows with the matched set, so this bounds the work the readings below would charge.
  const mayMatch = (rules: McpToolPolicyRule[], ruleStates: SimulatedRuleState[]) => rules.filter((_, index) => ruleStates[index]!.state !== "no_match");
  const worstCase = combinations * (scopedRules + decisionWork(mayMatch(currentRules, currentStates)) + decisionWork(mayMatch(draftRules, draftStates)));
  const notEvaluated =
    worstCase > MAX_SIMULATION_WORK_PER_CALL ? ("too_costly" as const) : options.maxWork !== undefined && worstCase > options.maxWork ? ("over_budget" as const) : undefined;
  if (notEvaluated) {
    return {
      bucket: "undetermined",
      current: { effect: null },
      draft: { effect: null },
      reason:
        notEvaluated === "too_costly"
          ? `too many rules match this call to evaluate it (${relevant.length} rules in scope, ${combinations} readings of the summary)`
          : "the simulation's work budget ran out before this call",
      notEvaluated,
      draftStates: draftStateList,
      work: scopedRules
    };
  }
  let work = 0;
  for (let mask = 0; mask < combinations; mask += 1) {
    const assumed = (identity: string) => (mask >> undecided.indexOf(identity)) & 1;
    const matched = (rules: McpToolPolicyRule[], ruleStates: SimulatedRuleState[]) =>
      rules.filter((rule, index) => {
        const state = ruleStates[index]!.state;
        return state === "match" || (state === "unknown" && assumed(identityOf(rule)) === 1);
      });
    const currentMatched = matched(currentRules, currentStates);
    const draftMatched = matched(draftRules, draftStates);
    work += scopedRules + decisionWork(currentMatched) + decisionWork(draftMatched);
    const currentOutcome = decidePolicyOutcome(currentMatched);
    const draftOutcome = decidePolicyOutcome(draftMatched);
    outcomes.add(simulationBucket(currentOutcome.effect, draftOutcome.effect));
    currentEffects.add(currentOutcome.effect);
    draftEffects.add(draftOutcome.effect);
    currentDeciders.add(currentOutcome.rule?.id);
    draftDeciders.add(draftOutcome.rule?.id);
  }
  const single = <T>(set: Set<T>): T | undefined => (set.size === 1 ? [...set][0] : undefined);
  const outcome = (effects: Set<McpToolPolicyEffect>, deciders: Set<string | undefined>): SimulatedOutcome => {
    const effect = single(effects) ?? null;
    const ruleId = effect !== null ? single(deciders) : undefined;
    return { effect, ...(ruleId ? { ruleId } : {}) };
  };
  const bucket = single(outcomes);
  return {
    bucket: (bucket as PolicySimulationBucket | undefined) ?? "undetermined",
    current: outcome(currentEffects, currentDeciders),
    draft: outcome(draftEffects, draftDeciders),
    ...(bucket === undefined ? { reason: firstReason() ?? "the summary cannot decide the outcome" } : {}),
    draftStates: draftStateList,
    work
  };
}

/** A rule's label in simulation messages. */
export function simulationRuleLabel(rule: Pick<McpToolPolicyRule, "id" | "name">): string {
  return describePolicyRule(rule);
}
