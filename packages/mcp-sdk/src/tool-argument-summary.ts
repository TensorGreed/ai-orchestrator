import {
  TOOL_ARGUMENT_LENGTH_BUCKETS,
  TOOL_ARGUMENT_SUMMARY_VERSION,
  type ToolArgumentFieldSummary,
  type ToolArgumentLengthBucket,
  type ToolArgumentSummary,
  type ToolArgumentValueType
} from "@ai-orchestrator/shared";
import { CREDENTIAL_NAME_PATTERN } from "./client-features";

/**
 * Phase 12.4 — a safe summary of a tool call's arguments for telemetry.
 *
 * Pure and deterministic: the same arguments (in any key order) and schema
 * give the same summary. What is kept, per argument path:
 *
 *   - null, booleans and finite numbers below nine integer digits, as values
 *     (with min and max); a longer integer (an account, card or phone number
 *     written as a number) keeps only its type and any data class;
 *   - short enum-like strings (one word, at most 64 characters, not random-
 *     looking, no long digit run) and any string the tool's input schema
 *     lists in an `enum` / `const` at that path;
 *   - for identifier-like strings, only a stable prefix: `owner/` of
 *     `owner/name`, `@domain` of an email, scheme and host of a URL, the
 *     first two segments of a filesystem path;
 *   - for anything else (free text, long or random-looking strings) only the
 *     type and a length bucket; the text is never kept.
 *
 * Every string, object key and long integer is passed to `detect` (the
 * production-capture DLP scan, injected by the caller so this package stays
 * free of the guard SDK). A value it flags is replaced by its data classes,
 * and a key it flags is written `*`. A string under a credential-like key
 * (`token`, `password`, `api_key`, ...) is kept only as `credential`; a
 * string under a key that usually holds people's words or names (`query`,
 * `message`, `body`, `assignee`, `to`, ...) is never kept as a value.
 *
 * Caps bound the work on hostile input (depth, paths, array items, keys per
 * object, values visited and characters scanned); reaching one sets
 * `truncated`. A string that could not be scanned within the budget is
 * never kept as a value or prefix.
 */

/** Data classes found in `text` (empty when none). May throw; a throw counts as "not scanned". */
export type ToolArgumentDetector = (text: string) => readonly string[];

export interface SummarizeToolArgumentsOptions {
  detect: ToolArgumentDetector;
  /** The tool's JSON Schema for its input, when known; only `enum` / `const` are read. */
  inputSchema?: unknown;
}

export const TOOL_ARGUMENT_SUMMARY_LIMITS = {
  /** Nesting below the top-level arguments that is still walked. */
  maxDepth: 8,
  /** Distinct paths kept. */
  maxFields: 128,
  /** Elements walked per array (its length is still reported). */
  maxArrayItems: 64,
  /** Keys walked per object, in sorted order. */
  maxKeysPerObject: 64,
  /** Values visited in total. */
  maxNodes: 4_000,
  /** Distinct values and prefixes kept per path. */
  maxValues: 16,
  maxPrefixes: 16,
  /** Longest string kept as a value. */
  maxKeptLength: 64,
  /** Longest string reduced to a prefix. */
  maxIdentifierLength: 2_048,
  /** Characters of one string passed to the detector. */
  maxScanChars: 8_192,
  /** Characters passed to the detector in total. */
  scanBudgetChars: 262_144
} as const;

const LIMITS = TOOL_ARGUMENT_SUMMARY_LIMITS;
const TYPE_ORDER: ToolArgumentValueType[] = ["null", "boolean", "number", "string", "array", "object"];
const SAFE_KEY = /^[A-Za-z0-9_$-]{1,64}$/;
const KEEPABLE = /^[\p{L}\p{N}][\p{L}\p{N}_.:+-]*$/u;
const URL_SHAPE = /^[a-z][a-z0-9+.-]{0,15}:\/\/\S/i;
const EMAIL_SHAPE = /^[^\s@]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63})$/;
const REPO_SHAPE = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/[A-Za-z0-9_.-]{1,100}$/;
const PATH_ROOT = /^(\/|~\/|\.\.?\/|[A-Za-z]:[\\/])/;
const PREFIX_SEGMENT = /^[^\s\\/]{1,64}$/;
/** Keys whose strings are people's words or names: never kept as values, even when one short word. */
const FREE_TEXT_KEY =
  /^(?:query|q|search|search_?term|keywords?|prompt|message|messages|text|body|content|comment|comments|note|notes|title|subject|description|summary|address|phone|email|emails|to|cc|bcc|from|recipient|recipients|user|username|user_?name|login|handle|first_?name|last_?name|full_?name|display_?name|author|assignee|assignees|reviewer|reviewers)$/i;

/** How the key that holds a value affects what is kept of it. */
type KeyKind = "plain" | "credential" | "free_text";

function keyKindOf(key: string): KeyKind {
  if (CREDENTIAL_NAME_PATTERN.test(key)) return "credential";
  return FREE_TEXT_KEY.test(key) ? "free_text" : "plain";
}

/** The length bucket for a string of `length` characters. */
export function toolArgumentLengthBucket(length: number): ToolArgumentLengthBucket {
  if (length <= 0) return "0";
  if (length <= 8) return "1-8";
  if (length <= 32) return "9-32";
  if (length <= 128) return "33-128";
  if (length <= 512) return "129-512";
  if (length <= 2048) return "513-2048";
  return "2049+";
}

type Kept = string | number | boolean;

interface FieldAccumulator {
  types: Set<ToolArgumentValueType>;
  count: number;
  values: Map<string, Kept>;
  valuesOverflow: boolean;
  min: number | null;
  max: number | null;
  prefixes: Set<string>;
  prefixesOverflow: boolean;
  classes: Set<string>;
  lenIndex: number;
  items: number;
  keys: number;
}

interface ScanResult {
  classes: string[];
  /** False when the string was not (fully) scanned: too long, out of budget, or the detector threw. */
  complete: boolean;
}

type SchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** A schema node with the branches of its combinators, a few levels deep. */
function expandSchema(node: unknown, depth = 0, out: SchemaNode[] = []): SchemaNode[] {
  if (!isRecord(node) || out.length >= 32) return out;
  out.push(node);
  if (depth >= 3) return out;
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    const branches = ownValue(node, combinator);
    if (Array.isArray(branches)) {
      for (const branch of branches.slice(0, 16)) expandSchema(branch, depth + 1, out);
    }
  }
  return out;
}

function childSchemas(nodes: SchemaNode[], segment: string | null): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const node of nodes) {
    let child: unknown;
    if (segment === null) {
      child = ownValue(node, "items");
    } else {
      const properties = ownValue(node, "properties");
      child = isRecord(properties) ? ownValue(properties, segment) : undefined;
      if (child === undefined) {
        const additional = ownValue(node, "additionalProperties");
        if (isRecord(additional)) child = additional;
      }
    }
    expandSchema(child, 0, out);
    if (out.length >= 32) break;
  }
  return out;
}

function schemaAllows(nodes: SchemaNode[], value: string): boolean {
  for (const node of nodes) {
    const options = ownValue(node, "enum");
    if (Array.isArray(options) && options.includes(value)) return true;
    if (ownValue(node, "const") === value) return true;
  }
  return false;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  const length = [...text].length;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Ids, hashes and tokens: not enum-like, even when short. */
function looksRandom(text: string): boolean {
  if (/\d{6,}/.test(text)) return true;
  // Numbers written with separators (ids, account, phone and national numbers): mostly digits, six or more.
  const digits = text.replace(/\D/g, "").length;
  if (digits >= 6 && digits * 2 >= text.length) return true;
  if (text.length >= 16 && /[A-Za-z]/.test(text) && /\d/.test(text) && shannonEntropy(text) >= 3) return true;
  return text.length >= 32 && !/[_.:+-]/.test(text);
}

function isKeepable(text: string): boolean {
  if (text === "") return true;
  return text.length <= LIMITS.maxKeptLength && KEEPABLE.test(text) && !looksRandom(text);
}

/** The stable prefix of an identifier-like string, or null when it is not one. */
function identifierPrefix(text: string): string | null {
  if (URL_SHAPE.test(text)) {
    try {
      const url = new URL(text);
      if (!url.hostname) return null;
      return `${url.protocol}//${url.hostname}`.toLowerCase();
    } catch {
      return null;
    }
  }
  const email = EMAIL_SHAPE.exec(text);
  if (email) return `@${email[1]!.toLowerCase()}`;
  const repo = REPO_SHAPE.exec(text);
  if (repo) return `${repo[1]}/`;
  const root = PATH_ROOT.exec(text);
  if (root) {
    const rootText = root[1]!.replace(/\\/g, "/");
    const segments = text.slice(root[1]!.length).split(/[\\/]+/).filter((segment) => segment.length > 0);
    // Never the whole path: at most two segments, and always fewer than all of them.
    const kept = segments.slice(0, Math.min(2, segments.length - 1));
    if (!kept.every((segment) => PREFIX_SEGMENT.test(segment))) return null;
    return kept.length > 0 ? `${rootText}${kept.join("/")}/` : rootText;
  }
  return null;
}

function compareKept(a: Kept, b: Kept): number {
  const order = (value: Kept) => (typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2);
  const byType = order(a) - order(b);
  if (byType !== 0) return byType;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Summarise one tool call's arguments. Never throws for any JSON value, and
 * never returns argument text other than kept values and prefixes.
 */
export function summarizeToolArguments(args: unknown, options: SummarizeToolArgumentsOptions): ToolArgumentSummary {
  const fields = new Map<string, FieldAccumulator>();
  let truncated = false;
  let nodes = 0;
  let scanned = 0;

  const scan = (text: string): ScanResult => {
    if (text.length > LIMITS.maxScanChars || scanned + text.length > LIMITS.scanBudgetChars) {
      truncated = true;
      // A long string is still scanned up to the per-string cap while budget remains, for its classes.
      const head = text.slice(0, LIMITS.maxScanChars);
      if (scanned + head.length > LIMITS.scanBudgetChars) return { classes: [], complete: false };
      scanned += head.length;
      try {
        return { classes: [...options.detect(head)], complete: false };
      } catch {
        return { classes: [], complete: false };
      }
    }
    scanned += text.length;
    try {
      return { classes: [...options.detect(text)], complete: true };
    } catch {
      return { classes: [], complete: false };
    }
  };

  const fieldFor = (path: string): FieldAccumulator | null => {
    const existing = fields.get(path);
    if (existing) return existing;
    if (fields.size >= LIMITS.maxFields) {
      truncated = true;
      return null;
    }
    const created: FieldAccumulator = {
      types: new Set(),
      count: 0,
      values: new Map(),
      valuesOverflow: false,
      min: null,
      max: null,
      prefixes: new Set(),
      prefixesOverflow: false,
      classes: new Set(),
      lenIndex: -1,
      items: -1,
      keys: -1
    };
    fields.set(path, created);
    return created;
  };

  const keep = (field: FieldAccumulator, value: Kept) => {
    if (field.valuesOverflow) return;
    const key = `${typeof value}:${String(value)}`;
    if (field.values.has(key)) return;
    if (field.values.size >= LIMITS.maxValues) {
      field.valuesOverflow = true;
      field.values.clear();
      return;
    }
    field.values.set(key, value);
  };

  const addPrefix = (field: FieldAccumulator, prefix: string) => {
    if (field.prefixesOverflow || field.prefixes.has(prefix)) return;
    if (field.prefixes.size >= LIMITS.maxPrefixes) {
      field.prefixesOverflow = true;
      field.prefixes.clear();
      return;
    }
    field.prefixes.add(prefix);
  };

  const addLength = (field: FieldAccumulator, length: number) => {
    field.lenIndex = Math.max(field.lenIndex, TOOL_ARGUMENT_LENGTH_BUCKETS.indexOf(toolArgumentLengthBucket(length)));
  };

  const summarizeString = (field: FieldAccumulator, text: string, schema: SchemaNode[], keyKind: KeyKind) => {
    const result = scan(text);
    const isFreeText = /\s/.test(text) || text.length > LIMITS.maxKeptLength;
    if (result.classes.length > 0) {
      for (const dataClass of result.classes) field.classes.add(dataClass);
      if (result.classes.includes("email") && result.complete) {
        const email = EMAIL_SHAPE.exec(text);
        if (email) addPrefix(field, `@${email[1]!.toLowerCase()}`);
      }
      if (isFreeText) addLength(field, text.length);
      return;
    }
    if (!result.complete) {
      addLength(field, text.length);
      return;
    }
    if (schemaAllows(schema, text)) {
      keep(field, text);
      return;
    }
    if (keyKind === "credential") {
      field.classes.add("credential");
      return;
    }
    if (keyKind === "plain" && isKeepable(text)) {
      keep(field, text);
      return;
    }
    if (text.length <= LIMITS.maxIdentifierLength && !/\s/.test(text)) {
      const prefix = identifierPrefix(text);
      if (prefix !== null) {
        const prefixScan = scan(prefix);
        if (prefixScan.complete && prefixScan.classes.length === 0) {
          addPrefix(field, prefix);
          return;
        }
        for (const dataClass of prefixScan.classes) field.classes.add(dataClass);
      }
    }
    addLength(field, text.length);
  };

  const summarizeNumber = (field: FieldAccumulator, value: number) => {
    if (!Number.isFinite(value)) return;
    // A long integer may be a card, account, phone or national number written as a JSON number: never kept, and
    // checked with the detector for its class.
    if (Number.isInteger(value) && Math.abs(value) >= 1e8) {
      if (Math.abs(value) < 1e21) {
        for (const dataClass of scan(String(Math.abs(value))).classes) field.classes.add(dataClass);
      }
      return;
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    keep(field, normalized);
    field.min = field.min === null ? normalized : Math.min(field.min, normalized);
    field.max = field.max === null ? normalized : Math.max(field.max, normalized);
  };

  const segmentFor = (key: string): string => {
    // `__proto__` would not survive as a record key in every reader of the summary.
    if (!SAFE_KEY.test(key) || key === "__proto__") return "*";
    const result = scan(key);
    return result.complete && result.classes.length === 0 ? key : "*";
  };

  const walk = (value: unknown, path: string, depth: number, schema: SchemaNode[], keyKind: KeyKind): void => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return;
    nodes += 1;
    if (nodes > LIMITS.maxNodes) {
      truncated = true;
      return;
    }
    const field = fieldFor(path);
    if (!field) return;
    field.count += 1;

    if (value === null) {
      field.types.add("null");
      return;
    }
    if (typeof value === "boolean") {
      field.types.add("boolean");
      keep(field, value);
      return;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      field.types.add("number");
      if (typeof value === "number") summarizeNumber(field, value);
      return;
    }
    if (typeof value === "string") {
      field.types.add("string");
      summarizeString(field, value, schema, keyKind);
      return;
    }
    if (Array.isArray(value)) {
      field.types.add("array");
      field.items = Math.max(field.items, value.length);
      if (depth >= LIMITS.maxDepth) {
        if (value.length > 0) truncated = true;
        return;
      }
      if (value.length > LIMITS.maxArrayItems) truncated = true;
      const itemSchema = childSchemas(schema, null);
      const limit = Math.min(value.length, LIMITS.maxArrayItems);
      for (let index = 0; index < limit; index += 1) {
        walk(value[index], `${path}[]`, depth + 1, itemSchema, keyKind);
      }
      return;
    }
    if (typeof value === "object") {
      field.types.add("object");
      walkObject(value as Record<string, unknown>, path, depth, schema, field);
    }
  };

  const walkObject = (
    value: Record<string, unknown>,
    path: string,
    depth: number,
    schema: SchemaNode[],
    field: FieldAccumulator | null
  ): void => {
    let keys = Object.keys(value);
    if (field) field.keys = Math.max(field.keys, keys.length);
    if (depth >= LIMITS.maxDepth) {
      if (keys.length > 0) truncated = true;
      return;
    }
    // Bound the sort on a huge object; the summary is marked truncated then anyway.
    if (keys.length > LIMITS.maxKeysPerObject * 16) keys = keys.slice(0, LIMITS.maxKeysPerObject * 16);
    keys.sort(compareText);
    if (keys.length > LIMITS.maxKeysPerObject) {
      truncated = true;
      keys = keys.slice(0, LIMITS.maxKeysPerObject);
    }
    for (const key of keys) {
      let child: unknown;
      try {
        child = value[key];
      } catch {
        truncated = true;
        continue;
      }
      const segment = segmentFor(key);
      const childPath = path ? `${path}.${segment}` : segment;
      walk(child, childPath, depth + 1, childSchemas(schema, key), keyKindOf(key));
    }
  };

  const rootSchema = expandSchema(options.inputSchema);
  if (isRecord(args)) {
    walkObject(args, "", 0, rootSchema, null);
  } else if (args !== undefined && args !== null) {
    walk(args, "$", 0, rootSchema, "plain");
  }

  const entries: Array<[string, ToolArgumentFieldSummary]> = [...fields.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([path, field]) => [path, finishField(field)]);
  return {
    v: TOOL_ARGUMENT_SUMMARY_VERSION,
    fields: Object.fromEntries(entries),
    ...(truncated ? { truncated: true as const } : {})
  };
}

function finishField(field: FieldAccumulator): ToolArgumentFieldSummary {
  const types = TYPE_ORDER.filter((type) => field.types.has(type));
  const summary: ToolArgumentFieldSummary = types.length === 1 ? { type: types[0]! } : { type: "mixed", types };
  if (field.count > 1) summary.count = field.count;
  if (field.values.size > 0) summary.values = [...field.values.values()].sort(compareKept);
  if (field.min !== null && field.max !== null) {
    summary.min = field.min;
    summary.max = field.max;
  }
  if (field.prefixes.size > 0) summary.prefixes = [...field.prefixes].sort(compareText);
  if (field.valuesOverflow || field.prefixesOverflow) summary.more = true;
  if (field.classes.size > 0) summary.classes = [...field.classes].sort(compareText);
  if (field.lenIndex >= 0) summary.len = TOOL_ARGUMENT_LENGTH_BUCKETS[field.lenIndex];
  if (field.items >= 0) summary.items = field.items;
  if (field.keys >= 0) summary.keys = field.keys;
  return summary;
}
