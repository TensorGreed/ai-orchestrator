import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import formatsPlugin from "ajv-formats";
import { unsafeDictionaryPattern } from "../profile";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { DEFAULT_ARGUMENT_LIMITS, jsonLimitIssues, strictSchema } from "./argument-validation";
import { positiveNumber } from "./output-model";
import { locateValue } from "./path-guard";

export const OUTPUT_SCHEMA_DETECTOR_ID = "output.schema";

/**
 * Phase 12 coverage — schema conformance of an answer. The answer is read as
 * JSON (the whole text, else a fenced ```json block, else the outermost
 * object or array in the text) and validated with Ajv against the JSON
 * Schema in `options.schema`. Without a schema the check only asks for JSON.
 * It judges a complete answer, so a partial stream check skips it.
 *
 * Answers are model output an attacker can steer, so validation is bounded:
 * schemas are at most 64 KB and 32 levels deep, `$ref` stays inside the
 * schema, `pattern`s that can backtrack catastrophically (nested or
 * alternated quantifiers, backreferences, more than two unbounded
 * quantifiers) are refused at save and at compile, `format`s are checked
 * (an unknown format is refused), and the answer's JSON is held to size,
 * depth and string-length limits before Ajv sees it.
 *
 * Options: `schema` (JSON Schema), `strict` (true: objects may not carry
 * properties the schema does not declare; default false), `extract` (false:
 * the whole text must be JSON), `maxBytes` (default 1 000 000),
 * `maxFindings` (default 20).
 */

export type OutputSchemaIssueCode = "not_json" | "too_large" | "schema" | "schema_invalid";

export interface OutputSchemaIssue {
  code: OutputSchemaIssueCode;
  path: string;
  message: string;
}

const DEFAULT_MAX_BYTES = 1_000_000;

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_PATTERN_LENGTH = 200;
/** Longest string a pattern is run on: keeps even quadratic patterns cheap. */
const MAX_PATTERNED_STRING = 5_000;
const ANSWER_LIMITS = { ...DEFAULT_ARGUMENT_LIMITS, maxStringLength: 100_000 };

/** Why a schema `pattern` is refused, or undefined when it is safe to run on model output. */
export function unsafeSchemaPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return `Patterns are limited to ${MAX_PATTERN_LENGTH} characters`;
  const nested = unsafeDictionaryPattern(pattern);
  if (nested) return nested;
  if (/\\[1-9]|\\k</.test(pattern)) return "Backreferences can backtrack catastrophically; remove them";
  if (/\(\?<?[=!]/.test(pattern)) return "Lookarounds are not allowed in answer schemas";
  // A quantified group with alternatives, such as (a|ab)*, can backtrack catastrophically.
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[*+]|\{\d+,\d*\})/.test(pattern)) return "Quantified alternatives such as (a|ab)* can backtrack catastrophically; rewrite the pattern";
  const unbounded = pattern.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "x").match(/[*+]|\{\d+,\}/g)?.length ?? 0;
  if (unbounded > 2) return "Use at most two unbounded repetitions (*, +, {n,}) in one pattern";
  try {
    new RegExp(pattern, "u");
  } catch {
    return "Not a valid regular expression";
  }
  return undefined;
}

/** The regular expression engine the answer schemas compile with: refuses unsafe patterns (the schema then fails to compile). */
const safeRegExp = Object.assign(
  (pattern: string, flags: string) => {
    const issue = unsafeSchemaPattern(pattern);
    if (issue) throw new Error(issue);
    return new RegExp(pattern, flags);
  },
  { code: "new RegExp" }
);

const addFormats = ((formatsPlugin as unknown as { default?: typeof formatsPlugin }).default ?? formatsPlugin) as typeof formatsPlugin;
const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false, allowUnionTypes: true, code: { regExp: safeRegExp } });
addFormats(ajv, { mode: "fast" });
const KNOWN_FORMATS = new Set(Object.keys((ajv as unknown as { formats: Record<string, unknown> }).formats));
/** Compiled schemas by text, oldest dropped first (also from Ajv's own cache). */
const compiled = new Map<string, { validate: ValidateFunction; schema: Record<string, unknown> }>();
const COMPILED_ENTRIES = 200;

/** Compile an answer schema (null when it cannot be compiled or holds an unsafe part). */
export function compileOutputSchema(schema: Record<string, unknown>, strict: boolean): ValidateFunction | null {
  if (outputSchemaSafetyIssues(schema).length > 0) return null;
  const { $schema: _s, $id: _i, ...rest } = schema;
  const effective = strict ? strictSchema(rest) : rest;
  const key = JSON.stringify(effective);
  const cached = compiled.get(key);
  if (cached) {
    compiled.delete(key);
    compiled.set(key, cached);
    return cached.validate;
  }
  try {
    const validate = ajv.compile(effective);
    compiled.set(key, { validate, schema: effective });
    if (compiled.size > COMPILED_ENTRIES) {
      const [oldestKey, oldest] = compiled.entries().next().value as [string, { schema: Record<string, unknown> }];
      compiled.delete(oldestKey);
      ajv.removeSchema(oldest.schema);
    }
    return validate;
  } catch {
    return null;
  }
}

/** Parts of a schema that are unsafe or unsupported for answers: size, depth, remote `$ref`, unsafe patterns, unknown formats. */
export function outputSchemaSafetyIssues(schema: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const text = JSON.stringify(schema);
  if (new TextEncoder().encode(text).length > MAX_SCHEMA_BYTES) return [`The schema is larger than ${MAX_SCHEMA_BYTES / 1024} KB`];
  const visit = (node: unknown, path: string, depth: number) => {
    if (issues.length >= 10) return;
    if (depth > MAX_SCHEMA_DEPTH) {
      issues.push(`${path || "(schema)"}: nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const at = path ? `${path}.${key}` : key;
      if ((key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") && typeof value === "string" && !value.startsWith("#")) {
        issues.push(`${at}: only references inside the schema (starting with #) are allowed`);
      } else if (key === "$id" && depth > 0) {
        issues.push(`${at}: nested $id is not allowed`);
      } else if (key === "pattern" && typeof value === "string") {
        const issue = unsafeSchemaPattern(value);
        if (issue) issues.push(`${at}: ${issue}`);
      } else if (key === "patternProperties" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const pattern of Object.keys(value)) {
          const issue = unsafeSchemaPattern(pattern);
          if (issue) issues.push(`${at}.${pattern}: ${issue}`);
        }
      } else if (key === "format" && typeof value === "string" && !KNOWN_FORMATS.has(value)) {
        issues.push(`${at}: unknown format '${value}' (known: ${[...KNOWN_FORMATS].join(", ")})`);
      }
      if (key === "properties" || key === "patternProperties" || key === "$defs" || key === "definitions" || key === "dependentSchemas") {
        if (value && typeof value === "object" && !Array.isArray(value)) for (const [name, inner] of Object.entries(value)) visit(inner, `${at}.${name}`, depth + 1);
      } else if (key !== "enum" && key !== "const" && key !== "examples" && key !== "default") {
        visit(value, at, depth + 1);
      }
    }
  };
  visit(schema, "", 0);
  return issues;
}

function hasPattern(schema: Record<string, unknown>): boolean {
  return /"(?:pattern|patternProperties)"\s*:/.test(JSON.stringify(schema));
}

/** Why an `output.schema` options object is unusable, keyed by option; empty when fine. */
export function outputSchemaOptionIssues(options: Record<string, unknown>): Array<{ option: string; message: string }> {
  const issues: Array<{ option: string; message: string }> = [];
  const schema = options.schema;
  if (schema !== undefined) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) issues.push({ option: "schema", message: "Must be a JSON Schema object" });
    else {
      const unsafe = outputSchemaSafetyIssues(schema as Record<string, unknown>);
      if (unsafe.length > 0) issues.push({ option: "schema", message: unsafe.join("; ") });
      else if (!compileOutputSchema(schema as Record<string, unknown>, options.strict === true)) issues.push({ option: "schema", message: "The JSON Schema could not be compiled" });
    }
  }
  if (options.strict !== undefined && typeof options.strict !== "boolean") issues.push({ option: "strict", message: "Must be true or false" });
  if (options.extract !== undefined && typeof options.extract !== "boolean") issues.push({ option: "extract", message: "Must be true or false" });
  return issues;
}

/** The JSON an answer holds, and where in the text it sits. Undefined when the text holds none. */
export function extractAnswerJson(text: string, extract = true): { value: unknown; span: GuardSpan } | undefined {
  const trimmed = text.trim();
  const whole = tryParse(trimmed);
  if (whole.ok) return { value: whole.value, span: { start: 0, end: text.length } };
  if (!extract) return undefined;
  const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
  if (fence?.[1] !== undefined) {
    const inner = tryParse(fence[1].trim());
    if (inner.ok) {
      const start = fence.index + fence[0].indexOf(fence[1]);
      return { value: inner.value, span: { start, end: start + fence[1].length } };
    }
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    const candidate = tryParse(text.slice(start, end + 1));
    if (candidate.ok) return { value: candidate.value, span: { start, end: end + 1 } };
  }
  return undefined;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Validate an answer (text or a JSON value) against a schema. Empty when it conforms. */
export function validateOutputSchema(
  content: unknown,
  text: string,
  options: { schema?: Record<string, unknown>; strict?: boolean; extract?: boolean; maxBytes?: number }
): { issues: OutputSchemaIssue[]; span: GuardSpan } {
  const whole = { start: 0, end: text.length };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) return { issues: [{ code: "too_large", path: "", message: `The answer is ${bytes} bytes; the schema check reads at most ${maxBytes}` }], span: whole };
  let value: unknown;
  let span = whole;
  if (typeof content === "string") {
    const found = extractAnswerJson(content, options.extract !== false);
    if (!found) return { issues: [{ code: "not_json", path: "", message: "The answer holds no JSON" }], span: whole };
    value = found.value;
    span = found.span;
  } else {
    value = content;
  }
  if (!options.schema) return { issues: [], span };
  const limits = hasPattern(options.schema) ? { ...ANSWER_LIMITS, maxStringLength: MAX_PATTERNED_STRING } : ANSWER_LIMITS;
  const limited = jsonLimitIssues(value, limits);
  if (limited.length > 0) {
    return { issues: limited.slice(0, 5).map((issue) => ({ code: "too_large" as const, path: issue.path, message: `${issue.path || "answer"}: ${issue.message}` })), span };
  }
  const validate = compileOutputSchema(options.schema, options.strict === true);
  if (!validate) return { issues: [{ code: "schema_invalid", path: "", message: "The rule's JSON Schema could not be compiled; the answer is refused" }], span };
  if (validate(value)) return { issues: [], span };
  const issues = ((validate.errors ?? []) as ErrorObject[]).map<OutputSchemaIssue>((error) => {
    const extra = error.keyword === "additionalProperties" ? ` ('${String((error.params as { additionalProperty?: string }).additionalProperty)}')` : "";
    return {
      code: "schema",
      path: error.instancePath.replace(/^\//, "").replace(/\//g, "."),
      message: `${error.instancePath || "answer"} ${error.message ?? "is invalid"}${extra}`
    };
  });
  return { issues, span };
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function createOutputSchemaDetector(): GuardDetector {
  return {
    id: OUTPUT_SCHEMA_DETECTOR_ID,
    tier: "parser",
    description: "Schema conformance: the answer must be JSON that matches the JSON Schema in the rule's options.",
    channels: ["model_output", "final_output", "response"],
    categories: ["schema_violation"],
    wholeAnswer: true,
    detect(input: GuardInput, context: DetectorContext) {
      const options = context.options;
      const schema = options.schema && typeof options.schema === "object" && !Array.isArray(options.schema) ? (options.schema as Record<string, unknown>) : undefined;
      if (options.schema !== undefined && !schema) throw new Error(`${OUTPUT_SCHEMA_DETECTOR_ID}: options.schema must be a JSON Schema object`);
      const { issues, span } = validateOutputSchema(input.content, context.text, {
        ...(schema ? { schema } : {}),
        strict: options.strict === true,
        extract: options.extract !== false,
        maxBytes: positiveNumber(options.maxBytes, DEFAULT_MAX_BYTES)
      });
      const maxFindings = Math.floor(positiveNumber(options.maxFindings, 20));
      const parsed = typeof input.content === "string" ? extractAnswerJson(input.content, options.extract !== false)?.value : input.content;
      return issues.slice(0, maxFindings).map<GuardFinding>((issue) => {
        const value = issue.path ? valueAt(parsed, issue.path) : undefined;
        const located = typeof value === "string" && value.length > 0 && value.length < 2000 ? locateValue(context.text, value) : span;
        return {
          detectorId: OUTPUT_SCHEMA_DETECTOR_ID,
          category: "schema_violation",
          score: 1,
          spans: [located],
          // The path only: the value itself may be sensitive.
          evidence: issue.path || "(answer)",
          message: issue.message,
          metadata: { code: issue.code, path: issue.path }
        };
      });
    }
  };
}
