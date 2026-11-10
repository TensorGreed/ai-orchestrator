import type { ErrorObject } from "ajv";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { compileJsonSchema } from "./argument-validation";
import { positiveNumber } from "./output-model";
import { locateValue } from "./path-guard";

export const OUTPUT_SCHEMA_DETECTOR_ID = "output.schema";

/**
 * Phase 12 coverage — schema conformance of an answer. The answer is read as
 * JSON (the whole text, else a fenced ```json block, else the outermost
 * object or array in the text) and validated with Ajv against the JSON
 * Schema in `options.schema`; schemas are compiled once per schema text, with
 * the cache the tool argument check uses. Without a schema the check only
 * asks for JSON. It judges a complete answer, so a partial stream check
 * skips it.
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

/** Why an `output.schema` options object is unusable, keyed by option; empty when fine. */
export function outputSchemaOptionIssues(options: Record<string, unknown>): Array<{ option: string; message: string }> {
  const issues: Array<{ option: string; message: string }> = [];
  const schema = options.schema;
  if (schema !== undefined) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) issues.push({ option: "schema", message: "Must be a JSON Schema object" });
    else if (!compileJsonSchema(schema as Record<string, unknown>, options.strict === true)) issues.push({ option: "schema", message: "The JSON Schema could not be compiled" });
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
  const validate = compileJsonSchema(options.schema, options.strict === true);
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
