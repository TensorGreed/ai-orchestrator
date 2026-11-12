import {
  MCP_ERROR_HEADER_MISMATCH,
  MCP_HEADER_ANNOTATION,
  MCP_HEADER_METHOD,
  MCP_HEADER_NAME,
  MCP_HEADER_PARAM_PREFIX,
  MCP_HEADER_PROTOCOL_VERSION,
  MCP_META_PROTOCOL_VERSION
} from "./constants";

/**
 * MCP 2026-07-28 — the HTTP headers a modern Streamable HTTP request carries:
 * `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and one
 * `Mcp-Param-{Name}` per `x-mcp-header` annotation in the called tool's
 * `inputSchema`. Values that are not plain header-safe ASCII travel in the
 * Base64 sentinel form `=?base64?...?=`.
 *
 * Header values can show up in proxy and access logs. Callers build them
 * from the arguments after content rules and redaction have run, and never
 * log them.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Value encoding --------------------------------------------------------------

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";
/** Printable ASCII and space: what a header value may carry without encoding. */
const PLAIN_HEADER_VALUE = /^[\x20-\x7e]*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function looksLikeSentinel(value: string): boolean {
  return value.length >= SENTINEL_PREFIX.length + SENTINEL_SUFFIX.length && value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX);
}

/**
 * The header form of a value: as is when it is printable ASCII without
 * leading or trailing whitespace, otherwise the Base64 of its UTF-8 bytes in
 * the sentinel form. A plain value that itself looks like the sentinel is
 * encoded too, so it cannot be mistaken for an encoded one.
 */
export function encodeMcpHeaderValue(value: string): string {
  const plain = PLAIN_HEADER_VALUE.test(value) && value === value.trim() && !looksLikeSentinel(value);
  if (plain) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, "utf-8").toString("base64")}${SENTINEL_SUFFIX}`;
}

export type DecodedMcpHeaderValue = { ok: true; value: string; encoded: boolean } | { ok: false; reason: string };

/**
 * Decode a header value written with `encodeMcpHeaderValue`. Plain values
 * must be printable ASCII; encoded ones must be valid Base64 of valid UTF-8.
 * Header parsers strip surrounding whitespace, so it is ignored here.
 */
export function decodeMcpHeaderValue(raw: string): DecodedMcpHeaderValue {
  const value = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!looksLikeSentinel(value)) {
    if (!PLAIN_HEADER_VALUE.test(value)) return { ok: false, reason: "contains characters that are not allowed in a header value" };
    return { ok: true, value, encoded: false };
  }
  const payload = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length);
  if (!BASE64.test(payload)) return { ok: false, reason: "is not valid Base64" };
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64"));
    return { ok: true, value: decoded, encoded: true };
  } catch {
    return { ok: false, reason: "is not valid UTF-8" };
  }
}

// Standard headers ------------------------------------------------------------

/** The body field `Mcp-Name` mirrors, for the methods that need it. */
export function mcpNameSourceField(method: string): "name" | "uri" | undefined {
  if (method === "tools/call" || method === "prompts/get") return "name";
  if (method === "resources/read") return "uri";
  return undefined;
}

/**
 * `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`,
 * `resources/read` and `prompts/get`, `Mcp-Name`. The version must be the
 * one in the request's `_meta`.
 */
export function buildMcpStandardHeaders(protocolVersion: string, method: string, params?: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    [MCP_HEADER_PROTOCOL_VERSION]: protocolVersion,
    [MCP_HEADER_METHOD]: method
  };
  const field = mcpNameSourceField(method);
  const name = field ? params?.[field] : undefined;
  if (typeof name === "string") headers[MCP_HEADER_NAME] = encodeMcpHeaderValue(name);
  return headers;
}

// x-mcp-header ----------------------------------------------------------------

/** One `Mcp-Param-*` header a tool asks for. */
export interface McpParamHeaderSpec {
  /** The annotation value; the header is `Mcp-Param-{name}`. */
  name: string;
  /** The chain of `properties` keys from the schema root to the annotated property. */
  path: string[];
  type: "string" | "integer" | "boolean";
}

export type McpHeaderAnnotationAnalysis = { ok: true; headers: McpParamHeaderSpec[] } | { ok: false; reason: string };

/** RFC 9110 `token` (1*tchar). */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Keywords whose value is instance data, never a schema: an `x-mcp-header` key inside is data. */
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose value maps names to schemas: the names are not keywords. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const ALLOWED_HEADER_TYPES = new Set(["string", "integer", "boolean"]);

/** The single primitive type of an annotated property; `null` may be listed alongside it. */
function headerPropertyType(schema: Record<string, unknown>): McpParamHeaderSpec["type"] | undefined {
  const raw = schema.type;
  const types = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const nonNull = types.filter((entry) => entry !== "null");
  if (nonNull.length !== 1 || typeof nonNull[0] !== "string" || !ALLOWED_HEADER_TYPES.has(nonNull[0])) return undefined;
  return nonNull[0] as McpParamHeaderSpec["type"];
}

/** Where a schema sits: `reachable` is the `properties` chain when every step so far was one. */
interface SchemaPosition {
  reachable: string[] | null;
  where: string;
}

/**
 * Check a tool's `x-mcp-header` annotations against the rules of the
 * Streamable HTTP binding and return the headers it asks for. An annotation
 * is valid only on a property reached from the root through `properties`
 * keys alone (never through `items`, composition, conditionals, `$ref` or
 * definitions), whose type is `string`, `integer` or `boolean` (`number` is
 * not allowed), with a non-empty HTTP token as its value that no other
 * annotation in the schema repeats, ignoring case. Any violation makes the
 * whole tool definition invalid: the client must leave the tool out of its
 * tool list.
 */
export function analyzeMcpHeaderAnnotations(inputSchema: unknown): McpHeaderAnnotationAnalysis {
  const headers: McpParamHeaderSpec[] = [];
  const seen = new Map<string, string>();
  let failure: string | undefined;

  const visit = (node: unknown, position: SchemaPosition): void => {
    if (failure) return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, { reachable: null, where: `${position.where}[${index}]` }));
      return;
    }
    if (!isRecord(node)) return;
    if (MCP_HEADER_ANNOTATION in node) {
      const annotation = node[MCP_HEADER_ANNOTATION];
      const where = position.where || "the schema root";
      if (!position.reachable || position.reachable.length === 0) {
        failure = `${MCP_HEADER_ANNOTATION} at ${where} is not on a property reachable through 'properties' alone`;
        return;
      }
      if (typeof annotation !== "string" || annotation.length === 0) {
        failure = `${MCP_HEADER_ANNOTATION} at ${where} must be a non-empty string`;
        return;
      }
      if (!HTTP_TOKEN.test(annotation)) {
        failure = `${MCP_HEADER_ANNOTATION} '${annotation}' at ${where} is not a valid HTTP header name token`;
        return;
      }
      const type = headerPropertyType(node);
      if (!type) {
        failure = `${MCP_HEADER_ANNOTATION} '${annotation}' at ${where} must be on a string, integer or boolean property`;
        return;
      }
      const folded = annotation.toLowerCase();
      const previous = seen.get(folded);
      if (previous !== undefined) {
        failure = `${MCP_HEADER_ANNOTATION} '${annotation}' at ${where} repeats '${previous}' (names are compared ignoring case)`;
        return;
      }
      seen.set(folded, annotation);
      headers.push({ name: annotation, path: [...position.reachable], type });
    }
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === MCP_HEADER_ANNOTATION || DATA_KEYWORDS.has(keyword)) continue;
      if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(value)) {
        for (const [name, child] of Object.entries(value)) {
          const reachable = keyword === "properties" && position.reachable ? [...position.reachable, name] : null;
          visit(child, { reachable, where: `${position.where}/${keyword}/${name}` });
        }
        continue;
      }
      visit(value, { reachable: null, where: `${position.where}/${keyword}` });
    }
  };

  if (isRecord(inputSchema)) visit(inputSchema, { reachable: [], where: "" });
  return failure ? { ok: false, reason: failure } : { ok: true, headers };
}

/**
 * Remove every `x-mcp-header` annotation from a schema (a deep copy; the
 * input is not modified). Property names and instance data that happen to
 * be called `x-mcp-header` are kept.
 */
export function stripMcpHeaderAnnotations<T>(schema: T): T {
  const strip = (node: unknown, inData: boolean): unknown => {
    if (Array.isArray(node)) return node.map((entry) => strip(entry, inData));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (inData) {
        out[key] = strip(value, true);
      } else if (key === MCP_HEADER_ANNOTATION) {
        continue;
      } else if (DATA_KEYWORDS.has(key)) {
        out[key] = strip(value, true);
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strip(child, false)]));
      } else {
        out[key] = strip(value, false);
      }
    }
    return out;
  };
  return strip(schema, false) as T;
}

/** An argument cannot be carried in its `Mcp-Param-*` header (wrong type, or an integer beyond the safe range). */
export class McpHeaderValueError extends Error {
  constructor(
    message: string,
    readonly header: string
  ) {
    super(message);
    this.name = "McpHeaderValueError";
  }
}

function valueAtPath(args: unknown, path: string[]): unknown {
  let current: unknown = args;
  for (const key of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** The text form of a header value: strings as is, integers in decimal, booleans as `true`/`false`. */
function headerText(spec: McpParamHeaderSpec, value: unknown): string {
  const header = `${MCP_HEADER_PARAM_PREFIX}${spec.name}`;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new McpHeaderValueError(`The value for ${header} is not a finite number.`, header);
    if (spec.type === "integer" && !Number.isSafeInteger(value)) {
      throw new McpHeaderValueError(`The value for ${header} is outside the safe integer range.`, header);
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  throw new McpHeaderValueError(`The value for ${header} must be a string, integer or boolean.`, header);
}

/**
 * The `Mcp-Param-*` headers for one call: the value at each annotated
 * property's exact path, encoded. A missing or `null` value leaves its
 * header out. Throws `McpHeaderValueError` for a value that cannot be
 * mirrored (an object, an array, a non-finite number, an unsafe integer).
 */
export function buildMcpParamHeaders(specs: readonly McpParamHeaderSpec[], args: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const spec of specs) {
    const value = valueAtPath(args, spec.path);
    if (value === undefined || value === null) continue;
    headers[`${MCP_HEADER_PARAM_PREFIX}${spec.name}`] = encodeMcpHeaderValue(headerText(spec, value));
  }
  return headers;
}

// Server-side validation --------------------------------------------------------

/** Reads a request header by name, ignoring case (for example Fastify's lowercased `request.headers`). */
export type McpHeaderLookup = (name: string) => string | undefined;

/** Look up headers in a plain record, ignoring case. Repeated headers (arrays) are treated as malformed. */
export function headerLookupFrom(headers: Record<string, string | string[] | undefined>): McpHeaderLookup {
  const folded = new Map<string, string | string[] | undefined>();
  for (const [key, value] of Object.entries(headers)) folded.set(key.toLowerCase(), value);
  return (name) => {
    const value = folded.get(name.toLowerCase());
    if (Array.isArray(value)) return value.length === 1 ? value[0] : "\u0000";
    return value;
  };
}

export interface McpHeaderMismatch {
  code: typeof MCP_ERROR_HEADER_MISMATCH;
  message: string;
}

function mismatch(message: string): McpHeaderMismatch {
  return { code: MCP_ERROR_HEADER_MISMATCH, message: `Header mismatch: ${message}` };
}

function headerMatchesBody(spec: McpParamHeaderSpec, decoded: string, body: unknown): boolean {
  if (spec.type === "integer") {
    if (typeof body !== "number" || decoded.trim() === "") return false;
    const parsed = Number(decoded);
    return Number.isFinite(parsed) && parsed === body;
  }
  if (spec.type === "boolean") return typeof body === "boolean" && decoded === (body ? "true" : "false");
  return typeof body === "string" && decoded === body;
}

/**
 * The checks a server that reads the body makes on a modern request's
 * headers: `MCP-Protocol-Version` present and equal to the `_meta` version,
 * `Mcp-Method` equal to `method`, `Mcp-Name` present and equal (after
 * decoding) for the methods that need it, and, when `paramHeaders` is given,
 * every `Mcp-Param-*` header present exactly when the body has a value and
 * equal to it (integers compared as numbers). Returns null when everything
 * matches, otherwise the -32020 error to answer with HTTP 400.
 */
export function verifyMcpRequestHeaders(
  lookup: McpHeaderLookup,
  message: { method: string; params?: Record<string, unknown> },
  paramHeaders?: readonly McpParamHeaderSpec[]
): McpHeaderMismatch | null {
  const params = message.params ?? {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const version = lookup(MCP_HEADER_PROTOCOL_VERSION);
  if (version === undefined) return mismatch(`${MCP_HEADER_PROTOCOL_VERSION} header is required`);
  if (version.trim() !== meta[MCP_META_PROTOCOL_VERSION]) {
    return mismatch(`${MCP_HEADER_PROTOCOL_VERSION} header does not match the protocol version in _meta`);
  }
  const method = lookup(MCP_HEADER_METHOD);
  if (method === undefined) return mismatch(`${MCP_HEADER_METHOD} header is required`);
  if (method.trim() !== message.method) return mismatch(`${MCP_HEADER_METHOD} header does not match the request method`);
  const field = mcpNameSourceField(message.method);
  if (field) {
    const raw = lookup(MCP_HEADER_NAME);
    if (raw === undefined) return mismatch(`${MCP_HEADER_NAME} header is required for ${message.method}`);
    const decoded = decodeMcpHeaderValue(raw);
    if (!decoded.ok) return mismatch(`${MCP_HEADER_NAME} header ${decoded.reason}`);
    if (decoded.value !== params[field]) return mismatch(`${MCP_HEADER_NAME} header does not match params.${field}`);
  }
  for (const spec of paramHeaders ?? []) {
    const header = `${MCP_HEADER_PARAM_PREFIX}${spec.name}`;
    const body = valueAtPath(isRecord(params.arguments) ? params.arguments : {}, spec.path);
    const raw = lookup(header);
    if (body === undefined || body === null) {
      if (raw !== undefined) return mismatch(`${header} header is set but the argument has no value`);
      continue;
    }
    if (raw === undefined) return mismatch(`${header} header is required because the argument has a value`);
    const decoded = decodeMcpHeaderValue(raw);
    if (!decoded.ok) return mismatch(`${header} header ${decoded.reason}`);
    if (!headerMatchesBody(spec, decoded.value, body)) return mismatch(`${header} header does not match the argument`);
  }
  return null;
}
