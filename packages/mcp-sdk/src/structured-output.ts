import { Ajv, type ValidateFunction } from "ajv";
import type { MCPToolResult } from "@ai-orchestrator/shared";

/**
 * Phase 10.5 — structured tool output (`outputSchema` / `structuredContent`).
 *
 * Per the MCP spec, a tool that declares an `outputSchema` must return
 * `structuredContent` that conforms to it, and clients should validate it.
 * L2M treats a missing or non-conforming result as a tool error with a clear
 * message, so a downstream node never reads data of the wrong shape.
 */

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false, allowUnionTypes: true });
const validatorCache = new Map<string, ValidateFunction | null>();
const MAX_CACHED_VALIDATORS = 500;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The `outputSchema` from a `tools/list` entry, when it is a JSON object. */
export function normalizeOutputSchema(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/** Spread helper for adapters: `{ outputSchema }` when the server declared one, else `{}`. */
export function withOutputSchema(raw: unknown): { outputSchema?: Record<string, unknown> } {
  const outputSchema = normalizeOutputSchema(raw);
  return outputSchema ? { outputSchema } : {};
}

function compile(schema: Record<string, unknown>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  if (validatorCache.has(key)) return validatorCache.get(key) ?? null;
  let validate: ValidateFunction | null = null;
  try {
    // `$schema` / `$id` would make Ajv look up meta-schemas or register ids
    // globally; neither is needed to check one result.
    const { $schema: _schema, $id: _id, ...rest } = schema;
    validate = ajv.compile(rest);
  } catch {
    validate = null;
  }
  if (validatorCache.size >= MAX_CACHED_VALIDATORS) {
    const oldest = validatorCache.keys().next().value;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  validatorCache.set(key, validate);
  return validate;
}

export type StructuredContentCheck =
  | { ok: true; structured?: Record<string, unknown>; warning?: string }
  | { ok: false; error: string };

/**
 * Check a `tools/call` result's `structuredContent` against the tool's
 * `outputSchema`. Without a schema any object is accepted. With one, a
 * missing or non-conforming object is an error. A schema Ajv cannot compile
 * is skipped with a warning rather than failing every call.
 */
export function checkStructuredContent(
  toolName: string,
  outputSchema: Record<string, unknown> | undefined,
  structured: unknown
): StructuredContentCheck {
  const present = structured !== undefined && structured !== null;
  if (present && (typeof structured !== "object" || Array.isArray(structured))) {
    return { ok: false, error: `MCP tool '${toolName}' returned structuredContent that is not a JSON object.` };
  }
  if (!outputSchema) {
    return present ? { ok: true, structured: structured as Record<string, unknown> } : { ok: true };
  }
  if (!present) {
    return {
      ok: false,
      error: `MCP tool '${toolName}' declares an outputSchema but returned no structuredContent.`
    };
  }
  const validate = compile(outputSchema);
  if (!validate) {
    return {
      ok: true,
      structured: structured as Record<string, unknown>,
      warning: `outputSchema of MCP tool '${toolName}' could not be compiled; structuredContent was not validated.`
    };
  }
  if (validate(structured)) {
    return { ok: true, structured: structured as Record<string, unknown> };
  }
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((entry) => `${entry.instancePath || "(root)"} ${entry.message ?? "is invalid"}`)
    .join("; ");
  return {
    ok: false,
    error: `MCP tool '${toolName}' returned structuredContent that does not match its outputSchema: ${details || "validation failed"}.`
  };
}

/** Text of the content blocks: one string for a single block, an array for several. */
export function normalizeToolContent(rawContent: unknown): unknown {
  if (!Array.isArray(rawContent)) return undefined;
  const normalized = rawContent.map((entry) => {
    const row = toRecord(entry);
    if (typeof row.text === "string") return row.text;
    if (row.json !== undefined) return row.json;
    return row;
  });
  return normalized.length === 1 ? normalized[0] : normalized;
}

/**
 * Turn a raw `tools/call` result into an MCPToolResult: `isError`,
 * structured content (validated when the tool has an outputSchema) and the
 * text content. `output` keeps the shape callers have always seen:
 * structured content when present, otherwise the text.
 */
export function buildToolCallResult(
  toolName: string,
  rawResult: unknown,
  outputSchema?: Record<string, unknown>
): MCPToolResult {
  const result = toRecord(rawResult);
  const content = normalizeToolContent(result.content);
  const rawStructured = result.structuredContent ?? result.structured_content;
  const fallbackOutput = content !== undefined ? content : rawResult;
  if (result.isError === true) {
    // Error results are not held to the outputSchema (the spec only requires conforming success results).
    const output = rawStructured !== undefined ? rawStructured : fallbackOutput;
    return {
      ok: false,
      output,
      ...(content !== undefined ? { content } : {}),
      error: typeof content === "string" && content.trim() ? content : `MCP tool '${toolName}' reported an error.`,
      errorKind: "tool"
    };
  }
  const check = checkStructuredContent(toolName, outputSchema, rawStructured);
  if (!check.ok) {
    return { ok: false, output: fallbackOutput, ...(content !== undefined ? { content } : {}), error: check.error, errorKind: "output_validation" };
  }
  return {
    ok: true,
    output: check.structured ?? fallbackOutput,
    ...(check.structured ? { structured: check.structured } : {}),
    ...(content !== undefined ? { content } : {})
  };
}

function sameJson(text: string, structured: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(structured);
  } catch {
    return false;
  }
}

/**
 * What an agent's model sees for a tool result. The spec recommends that a
 * tool with structured output also returns it serialized as JSON in a text
 * block; models read that text. When the text is just that serialization,
 * the structured object is passed once. When the server sent other text as
 * well, both are kept: `{ content, structuredContent }`.
 */
export function toAgentToolOutput(result: MCPToolResult): unknown {
  if (!result.structured) return result.output;
  const content = result.content;
  if (content === undefined || content === null || content === "") return result.structured;
  if (typeof content === "string" && sameJson(content, result.structured)) return result.structured;
  return { content, structuredContent: result.structured };
}
