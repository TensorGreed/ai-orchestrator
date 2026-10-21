import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput } from "../types";
import { locateValue } from "./path-guard";

export const ARGUMENT_VALIDATION_DETECTOR_ID = "tool.arguments";

/**
 * Phase 12.3 — strict argument validation against the tool's JSON Schema,
 * with size and depth limits applied before validation so a huge or deeply
 * nested payload never reaches the validator. Same Ajv major as mcp-sdk;
 * schemas are compiled once per schema text.
 */

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false, allowUnionTypes: true });
const cache = new Map<string, ValidateFunction>();

export interface ArgumentLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
  maxProperties?: number;
  /** Reject properties the schema does not declare (default true). */
  rejectAdditional?: boolean;
}

export const DEFAULT_ARGUMENT_LIMITS: Required<ArgumentLimits> = {
  maxBytes: 1_000_000,
  maxDepth: 32,
  maxStringLength: 200_000,
  maxArrayLength: 10_000,
  maxProperties: 1_000,
  rejectAdditional: true
};

export interface ArgumentIssue {
  code: "too_large" | "too_deep" | "string_too_long" | "array_too_long" | "too_many_properties" | "schema" | "schema_invalid" | "not_an_object";
  path: string;
  message: string;
}

function limitIssues(value: unknown, limits: Required<ArgumentLimits>, path: string, depth: number, out: ArgumentIssue[]): void {
  if (depth > limits.maxDepth) {
    out.push({ code: "too_deep", path, message: `Nesting deeper than ${limits.maxDepth}` });
    return;
  }
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) out.push({ code: "string_too_long", path, message: `String longer than ${limits.maxStringLength} characters` });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) out.push({ code: "array_too_long", path, message: `Array longer than ${limits.maxArrayLength}` });
    value.forEach((item, index) => limitIssues(item, limits, `${path}[${index}]`, depth + 1, out));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > limits.maxProperties) out.push({ code: "too_many_properties", path, message: `More than ${limits.maxProperties} properties` });
    for (const [key, inner] of entries) limitIssues(inner, limits, path ? `${path}.${key}` : key, depth + 1, out);
  }
}

/** Add `additionalProperties: false` to every object schema that does not say otherwise. */
export function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      copy[key] = key === "properties" || key === "definitions" || key === "$defs" || key === "patternProperties" ? mapValues(value, visit) : visit(value);
    }
    const isObject = copy.type === "object" || (Array.isArray(copy.type) && copy.type.includes("object")) || ("properties" in copy && !("type" in copy));
    if (isObject && copy.additionalProperties === undefined && !copy.patternProperties) copy.additionalProperties = false;
    return copy;
  };
  return visit(schema) as Record<string, unknown>;
}

function mapValues(value: unknown, fn: (v: unknown) => unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fn(v);
  return out;
}

function compile(schema: Record<string, unknown>, strict: boolean): ValidateFunction | null {
  const { $schema: _s, $id: _i, ...rest } = schema;
  const effective = strict ? strictSchema(rest) : rest;
  const key = JSON.stringify(effective);
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const validate = ajv.compile(effective);
    cache.set(key, validate);
    return validate;
  } catch {
    return null;
  }
}

export function validateToolArguments(args: unknown, schema: Record<string, unknown> | undefined, limits: ArgumentLimits = {}): ArgumentIssue[] {
  const effectiveLimits = { ...DEFAULT_ARGUMENT_LIMITS, ...limits };
  const issues: ArgumentIssue[] = [];
  const bytes = Buffer.byteLength(JSON.stringify(args ?? null), "utf8");
  if (bytes > effectiveLimits.maxBytes) {
    issues.push({ code: "too_large", path: "", message: `Arguments are ${bytes} bytes; the limit is ${effectiveLimits.maxBytes}` });
    return issues;
  }
  limitIssues(args, effectiveLimits, "", 0, issues);
  if (issues.length > 0) return issues;
  if (!schema) return issues;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    if (schema.type === "object" || "properties" in schema) {
      issues.push({ code: "not_an_object", path: "", message: "Arguments must be an object" });
      return issues;
    }
  }
  const validate = compile(schema, effectiveLimits.rejectAdditional);
  if (!validate) {
    issues.push({ code: "schema_invalid", path: "", message: "The tool's input schema could not be compiled; arguments are refused" });
    return issues;
  }
  if (!validate(args)) {
    for (const error of (validate.errors ?? []) as ErrorObject[]) {
      const extra = error.keyword === "additionalProperties" ? ` ('${String((error.params as { additionalProperty?: string }).additionalProperty)}')` : "";
      issues.push({ code: "schema", path: error.instancePath.replace(/^\//, "").replace(/\//g, "."), message: `${error.instancePath || "arguments"} ${error.message ?? "is invalid"}${extra}` });
    }
  }
  return issues;
}

export function createArgumentValidationDetector(): GuardDetector {
  return {
    id: ARGUMENT_VALIDATION_DETECTOR_ID,
    tier: "rule",
    description: "Strict validation of tool arguments against the tool's input schema, with size and depth limits.",
    channels: ["tool_arguments"],
    categories: ["schema_violation"],
    detect(input: GuardInput, context: DetectorContext) {
      const schema = (context.options.schema as Record<string, unknown> | undefined) ?? input.tool?.inputSchema;
      const limits: ArgumentLimits = {
        maxBytes: numberOption(context.options.maxBytes),
        maxDepth: numberOption(context.options.maxDepth),
        maxStringLength: numberOption(context.options.maxStringLength),
        maxArrayLength: numberOption(context.options.maxArrayLength),
        maxProperties: numberOption(context.options.maxProperties),
        rejectAdditional: context.options.rejectAdditional !== false
      };
      const content = typeof input.content === "string" ? tryParse(input.content) : input.content;
      return validateToolArguments(content, schema, limits).map<GuardFinding>((issue) => {
        const value = issue.path ? valueAt(content, issue.path) : undefined;
        const span = typeof value === "string" && value.length < 2000 ? locateValue(context.text, value) : { start: 0, end: Math.min(context.text.length, 200) };
        return {
          detectorId: ARGUMENT_VALIDATION_DETECTOR_ID,
          category: "schema_violation",
          score: 1,
          spans: [span],
          evidence: issue.path || "(arguments)",
          message: issue.message,
          metadata: { code: issue.code, path: issue.path }
        };
      });
    }
  };
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(/[.[\]]/).filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
