/**
 * Integration catalog: MCP server tools and OpenAPI operations offered as palette entries.
 *
 * - An MCP entry is an MCP Tool node bound to one registered server and one tool; its form comes from the tool's
 *   input JSON Schema and writes the node's `argsTemplate`.
 * - An OpenAPI entry is an HTTP Request node with a stored operation reference (`openapiOperation`); its form comes
 *   from the operation's parameters and request body and writes the node's method, URL, headers and body templates.
 *
 * Nothing here runs a request: both entries execute through the existing MCP Tool and HTTP Request nodes.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------------

/** Largest spec body accepted (upload or URL), in bytes. */
export const OPENAPI_SPEC_MAX_BYTES = 2 * 1024 * 1024;
/** Most operations kept from one spec; the rest are dropped with a warning. */
export const OPENAPI_MAX_OPERATIONS = 500;
const MAX_REF_DEPTH = 24;
/**
 * Most schema nodes one spec may expand to once its `$ref`s are inlined, and the largest stored catalog. A small spec
 * whose schemas each reference the next one many times would otherwise grow exponentially.
 */
const MAX_RESOLVED_NODES = 500_000;
export const OPENAPI_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
const EXPANDS_TOO_FAR = "The spec's schemas expand too far once their references are filled in. Split the spec or simplify its schemas.";
/** Nodes left to expand in the parse under way (parsing is synchronous). */
let resolveBudget = Number.POSITIVE_INFINITY;
const MAX_WARNINGS = 20;

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export const OPENAPI_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type OpenApiHttpMethod = (typeof OPENAPI_HTTP_METHODS)[number];

/**
 * How an HTTP Request node sends its secret. Unset on a node means `Authorization: Bearer <secret>`.
 *
 * `connected`: the secret is a connected account; its current access token goes as a bearer token (refreshed when
 * due, and once more when the server answers 401). `oauth2_client_credentials`: the secret is the client secret; the
 * node gets an access token from `tokenUrl` (client credentials grant, cached until it expires) and sends that as a
 * bearer token. `clientAuth` says where the client id and secret go on the token request (`body`, the default, or a
 * `basic` Authorization header).
 */
export type HttpSecretAuth =
  | { type: "bearer" }
  | { type: "basic" }
  | { type: "header"; name: string }
  | { type: "query"; name: string }
  | { type: "connected" }
  | { type: "oauth2_client_credentials"; tokenUrl: string; clientId: string; scope?: string; clientAuth: "body" | "basic" };

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  /** The parameter's JSON Schema with local `$ref`s resolved. */
  schema: Record<string, unknown>;
}

export interface OpenApiRequestBody {
  /** `application/json` (or a `+json` type): the body is built from `schema`; anything else is one text field. */
  contentType: string;
  json: boolean;
  required: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

export interface OpenApiOperation {
  /** The spec's `operationId`, else `<method>_<path>` made safe; unique in the spec. */
  id: string;
  method: OpenApiHttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  /** How the operation wants a credential, when the spec says and the HTTP Request node can send it. */
  auth: HttpSecretAuth | null;
}

export interface OpenApiCatalog {
  title: string;
  version: string;
  description?: string;
  /** The first server URL, made absolute against the spec's own URL; empty when the spec names none usable. */
  baseUrl: string;
  operations: OpenApiOperation[];
  /** Things left out (Swagger 2 bits, cookie parameters, unsupported auth, too many operations). */
  warnings: string[];
}

export class OpenApiSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiSpecError";
  }
}

/** The stored reference an HTTP Request node keeps to the operation it was made from. */
export interface OpenApiOperationRef {
  specId: string;
  operationId: string;
  method: string;
  path: string;
  /**
   * The base URL the node sends to. The form keeps it when the API's base URL changes later, so the node's secret is
   * not sent to a new host without someone choosing it. Empty until the API has one.
   */
  baseUrl: string;
}

/** One palette entry of the catalog, as `GET /api/catalog` lists it. */
export interface CatalogPaletteEntry {
  /** Unique palette key: `mcp:<serverId>:<tool>` or `openapi:<specId>:<operationId>`. */
  key: string;
  kind: "mcp_tool" | "openapi_operation";
  /** `<server> · <tool>` or `<spec> · <operation>`. */
  label: string;
  description: string;
  /** Server or spec name, for grouping. */
  sourceName: string;
  sourceId: string;
  /** Tool name or operation id. */
  itemId: string;
  /** The node the entry adds and its starting configuration (see catalogNodeConfig). */
  nodeType: "mcp_tool" | "http_request";
  nodeConfig: Record<string, unknown>;
}

export interface CatalogSourceSummary {
  kind: "mcp_server" | "openapi_spec";
  id: string;
  name: string;
  itemCount: number;
  /** When the tools were last listed (probe) or the spec last read; null when never. */
  refreshedAt: string | null;
  /** OpenAPI only: the spec URL the spec was read from (null for an upload). */
  sourceUrl?: string | null;
  projectId?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAPI parsing
// ---------------------------------------------------------------------------------------------------------------------

/**
 * True when a name or a default from a spec or a tool schema holds `{{` or `}}`. Such text would become an expression
 * in the node's request templates (and could read the run's data), so names are left out and defaults not offered.
 */
export function hasTemplateMarks(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

const LEFT_OUT_NAMES = "Names with {{ or }} were left out: they would be read as expressions.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolves one local `$ref` (`#/components/...`); null when it points nowhere. */
function lookupRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return null;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/").map(decodePointerToken)) {
    if (!isRecord(current) && !Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[token];
    if (current === undefined) return null;
  }
  return current;
}

/**
 * A copy of `value` with local `$ref`s replaced by what they point at. A cycle, a remote ref or a chain deeper than
 * the limit becomes `{}` (any value), so a form shows a JSON field there.
 */
function resolveRefs(root: Record<string, unknown>, value: unknown, seen: readonly string[] = [], depth = 0): unknown {
  if (depth > MAX_REF_DEPTH) return {};
  if (--resolveBudget < 0) throw new OpenApiSpecError(EXPANDS_TOO_FAR);
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(root, entry, seen, depth + 1));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === "string") {
    const ref = value.$ref;
    if (seen.includes(ref)) return {};
    const target = lookupRef(root, ref);
    if (target === null) return {};
    const { $ref: _ref, ...siblings } = value;
    const resolved = resolveRefs(root, target, [...seen, ref], depth + 1);
    return isRecord(resolved) && Object.keys(siblings).length ? { ...resolved, ...(resolveRefs(root, siblings, seen, depth + 1) as object) } : resolved;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = resolveRefs(root, entry, seen, depth + 1);
  return out;
}

/** `GET /users/{id}` → `get_users_id`. */
function derivedOperationId(method: string, path: string): string {
  const slug = path
    .replace(/[{}]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .join("_");
  return `${method.toLowerCase()}_${slug || "root"}`;
}

function serverBaseUrl(doc: Record<string, unknown>, sourceUrl: string | undefined, warnings: string[]): string {
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isRecord) : [];
  for (const server of servers) {
    let url = text(server.url);
    if (!url) continue;
    // Server variables take their default values.
    const variables = isRecord(server.variables) ? server.variables : {};
    url = url.replace(/\{([^}]+)\}/g, (match, name: string) => {
      const variable = variables[name];
      return isRecord(variable) && variable.default !== undefined ? String(variable.default) : match;
    });
    if (/\{[^}]+\}/.test(url)) continue;
    try {
      const absolute = sourceUrl ? new URL(url, sourceUrl) : new URL(url);
      if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
      absolute.search = "";
      absolute.hash = "";
      if (absolute.username || absolute.password) {
        warnings.push("A server URL with a user name or password was left out.");
        continue;
      }
      return absolute.toString().replace(/\/+$/, "");
    } catch {
      continue;
    }
  }
  return "";
}

interface SecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
}

function authFromRequirements(
  requirements: unknown,
  schemes: Record<string, unknown>
): { auth: HttpSecretAuth | null; unsupported: string | null } {
  if (!Array.isArray(requirements) || requirements.length === 0) return { auth: null, unsupported: null };
  let unsupported: string | null = null;
  for (const requirement of requirements) {
    if (!isRecord(requirement)) continue;
    const names = Object.keys(requirement);
    // `{}` means the operation may also be called without a credential.
    if (names.length === 0) return { auth: null, unsupported: null };
    // The node sends one secret: only a requirement with one scheme fits.
    if (names.length !== 1) {
      unsupported = names.join(" + ");
      continue;
    }
    const raw = schemes[names[0]!];
    if (!isRecord(raw)) continue;
    const scheme = raw as unknown as SecurityScheme;
    const type = text(scheme.type).toLowerCase();
    if (type === "http") {
      const httpScheme = text(scheme.scheme).toLowerCase();
      if (httpScheme === "bearer") return { auth: { type: "bearer" }, unsupported: null };
      if (httpScheme === "basic") return { auth: { type: "basic" }, unsupported: null };
      unsupported = `HTTP ${httpScheme || "auth"}`;
      continue;
    }
    if (type === "apikey") {
      const name = text(scheme.name);
      const location = text(scheme.in).toLowerCase();
      if (name && location === "header" && isHeaderName(name)) return { auth: { type: "header", name }, unsupported: null };
      if (name && location === "query") return { auth: { type: "query", name }, unsupported: null };
      unsupported = `API key in ${location || "an unknown place"}`;
      continue;
    }
    // OAuth 2 and OpenID Connect send an access token as a bearer token; the secret holds the token.
    if (type === "oauth2" || type === "openidconnect") return { auth: { type: "bearer" }, unsupported: null };
    unsupported = type || "unknown";
  }
  return { auth: null, unsupported };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export function isHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && HEADER_NAME.test(name);
}

/** Header parameters the HTTP Request node always sets itself, or that a form must never set. */
const RESERVED_HEADERS = new Set(["authorization", "content-type", "content-length", "host", "cookie", "accept-encoding", "connection", "transfer-encoding"]);

function readParameters(
  raw: unknown,
  root: Record<string, unknown>,
  warnings: Set<string>
): Map<string, OpenApiParameter> {
  const out = new Map<string, OpenApiParameter>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const parameter = resolveRefs(root, entry);
    if (!isRecord(parameter)) continue;
    const name = text(parameter.name);
    const location = text(parameter.in).toLowerCase();
    if (!name) continue;
    if (hasTemplateMarks(name)) {
      warnings.add(LEFT_OUT_NAMES);
      continue;
    }
    if (location === "cookie") {
      warnings.add("Cookie parameters are not supported and were left out.");
      continue;
    }
    if (location !== "path" && location !== "query" && location !== "header") continue;
    if (location === "header" && (!isHeaderName(name) || RESERVED_HEADERS.has(name.toLowerCase()))) continue;
    const schema = isRecord(parameter.schema) ? parameter.schema : isRecord(parameter.content) ? firstContentSchema(parameter.content) : {};
    out.set(`${location}:${name}`, {
      name,
      in: location,
      required: location === "path" ? true : parameter.required === true,
      ...(text(parameter.description) ? { description: text(parameter.description) } : {}),
      schema
    });
  }
  return out;
}

function firstContentSchema(content: Record<string, unknown>): Record<string, unknown> {
  for (const media of Object.values(content)) {
    if (isRecord(media) && isRecord(media.schema)) return media.schema;
  }
  return {};
}

function isJsonMediaType(type: string): boolean {
  const base = type.split(";")[0]!.trim().toLowerCase();
  return base === "application/json" || base.endsWith("+json") || base === "*/*";
}

function readRequestBody(raw: unknown, root: Record<string, unknown>): OpenApiRequestBody | undefined {
  const body = resolveRefs(root, raw);
  if (!isRecord(body) || !isRecord(body.content)) return undefined;
  const entries = Object.entries(body.content);
  if (entries.length === 0) return undefined;
  const json = entries.find(([type]) => isJsonMediaType(type));
  const [contentType, media] = json ?? entries[0]!;
  return {
    contentType: json && contentType === "*/*" ? "application/json" : contentType,
    json: Boolean(json),
    required: body.required === true,
    ...(text(body.description) ? { description: text(body.description) } : {}),
    schema: isRecord(media) && isRecord(media.schema) ? media.schema : {}
  };
}

/**
 * Reads an OpenAPI 3.x document (already parsed from JSON or YAML) into a catalog of operations. Throws
 * `OpenApiSpecError` when the document is not OpenAPI 3.x or has no operations the HTTP Request node can call.
 */
export function parseOpenApiDocument(document: unknown, options: { sourceUrl?: string } = {}): OpenApiCatalog {
  resolveBudget = MAX_RESOLVED_NODES;
  try {
    const catalog = parseDocument(document, options);
    if (JSON.stringify(catalog).length > OPENAPI_CATALOG_MAX_BYTES) throw new OpenApiSpecError(EXPANDS_TOO_FAR);
    return catalog;
  } finally {
    resolveBudget = Number.POSITIVE_INFINITY;
  }
}

function parseDocument(document: unknown, options: { sourceUrl?: string }): OpenApiCatalog {
  if (!isRecord(document)) throw new OpenApiSpecError("The spec is not a JSON or YAML object.");
  const version = text(document.openapi);
  if (!version) {
    if (text(document.swagger)) throw new OpenApiSpecError("This is a Swagger 2.0 spec. Only OpenAPI 3.x specs are supported.");
    throw new OpenApiSpecError("The spec has no `openapi` version field. Only OpenAPI 3.x specs are supported.");
  }
  if (!/^3\.\d+/.test(version)) throw new OpenApiSpecError(`OpenAPI ${version} is not supported. Only OpenAPI 3.x specs are supported.`);
  const info = isRecord(document.info) ? document.info : {};
  const paths = isRecord(document.paths) ? document.paths : {};
  const components = isRecord(document.components) ? document.components : {};
  const securitySchemes = isRecord(components.securitySchemes)
    ? (resolveRefs(document, components.securitySchemes) as Record<string, unknown>)
    : {};
  const warnings = new Set<string>();
  const baseWarnings: string[] = [];
  const baseUrl = serverBaseUrl(document, options.sourceUrl, baseWarnings);
  for (const warning of baseWarnings) warnings.add(warning);

  const operations: OpenApiOperation[] = [];
  const usedIds = new Set<string>();
  let dropped = 0;
  for (const [path, rawItem] of Object.entries(paths)) {
    if (!path.startsWith("/")) continue;
    // A path is literal text in the request URL: no expressions, no query or fragment of its own.
    if (hasTemplateMarks(path) || path.includes("?") || path.includes("#")) {
      warnings.add("Paths with {{, }}, ? or # were left out.");
      continue;
    }
    const item = resolveRefs(document, rawItem);
    if (!isRecord(item)) continue;
    const shared = readParameters(item.parameters, document, warnings);
    for (const [methodKey, rawOperation] of Object.entries(item)) {
      const method = methodKey.toUpperCase();
      if (!(OPENAPI_HTTP_METHODS as readonly string[]).includes(method)) {
        if (["HEAD", "OPTIONS", "TRACE"].includes(method)) warnings.add(`${method} operations are not supported and were left out.`);
        continue;
      }
      if (!isRecord(rawOperation)) continue;
      if (operations.length >= OPENAPI_MAX_OPERATIONS) {
        dropped += 1;
        continue;
      }
      const own = readParameters(rawOperation.parameters, document, warnings);
      const merged = new Map([...shared, ...own]);
      // A `{name}` in the path with no declared parameter still needs a value.
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1]!;
        if (!merged.has(`path:${name}`)) merged.set(`path:${name}`, { name, in: "path", required: true, schema: { type: "string" } });
      }
      let id = text(rawOperation.operationId).replace(/[^A-Za-z0-9_.-]/g, "_") || derivedOperationId(method, path);
      if (usedIds.has(id)) {
        let suffix = 2;
        while (usedIds.has(`${id}_${suffix}`)) suffix += 1;
        id = `${id}_${suffix}`;
      }
      usedIds.add(id);
      const security = rawOperation.security !== undefined ? rawOperation.security : document.security;
      const { auth, unsupported } = authFromRequirements(security, securitySchemes);
      if (!auth && unsupported) warnings.add(`Some operations use ${unsupported} authentication, which is not supported; set the credential header yourself.`);
      const requestBody = rawOperation.requestBody !== undefined ? readRequestBody(rawOperation.requestBody, document) : undefined;
      const summary = text(rawOperation.summary);
      const description = text(rawOperation.description);
      operations.push({
        id,
        method: method as OpenApiHttpMethod,
        path,
        summary: summary || description.split(/\r?\n/)[0]!.slice(0, 120) || `${method} ${path}`,
        ...(description && description !== summary ? { description: description.slice(0, 2000) } : {}),
        tags: Array.isArray(rawOperation.tags) ? rawOperation.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 10) : [],
        deprecated: rawOperation.deprecated === true,
        parameters: [...merged.values()],
        ...(requestBody ? { requestBody } : {}),
        auth
      });
    }
  }
  if (dropped > 0) warnings.add(`The spec has more than ${OPENAPI_MAX_OPERATIONS} operations; ${dropped} were left out.`);
  if (operations.length === 0) throw new OpenApiSpecError("The spec has no GET, POST, PUT, PATCH or DELETE operations.");
  if (!baseUrl) warnings.add("The spec names no absolute server URL. Set the base URL.");
  return {
    title: text(info.title).slice(0, 200) || "API",
    version: text(info.version).slice(0, 60),
    ...(text(info.description) ? { description: text(info.description).slice(0, 2000) } : {}),
    baseUrl,
    operations,
    warnings: [...warnings].slice(0, MAX_WARNINGS)
  };
}

/** Checks a base URL a person typed: absolute http(s), no user name or password. Returns it without a trailing `/`. */
export function normalizeApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OpenApiSpecError("The base URL is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new OpenApiSpecError("The base URL must start with http:// or https://.");
  if (url.username || url.password) throw new OpenApiSpecError("The base URL must not contain a user name or password. Use a secret.");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------------------------------------------------
// Form values → templates
// ---------------------------------------------------------------------------------------------------------------------

/** A form value: text (also numbers and JSON), a boolean, or a list of item texts. */
export type CatalogFormValue = string | boolean | string[] | undefined;
export type CatalogFormValues = Record<string, CatalogFormValue>;

const TEMPLATE_TOKEN = /\{\{[\s\S]*?\}\}/;

/** Whether a value holds an expression (`{{ … }}`), which renders at run time. */
export function hasTemplate(value: string): boolean {
  return TEMPLATE_TOKEN.test(value);
}

/** `results.fetch.body.name`, `webhook.items[0]`: a plain path, safe to wrap in an encoding call. */
const PLAIN_PATH = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*|\[\d+\])*$/;

/** Splits text into literal pieces and `{{ }}` expressions (with the inner expression, trimmed). */
function templatePieces(value: string): Array<{ literal: string } | { token: string; expression: string }> {
  const pieces: Array<{ literal: string } | { token: string; expression: string }> = [];
  let last = 0;
  for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (match.index! > last) pieces.push({ literal: value.slice(last, match.index) });
    pieces.push({ token: match[0], expression: match[1]!.trim() });
    last = match.index! + match[0].length;
  }
  if (last < value.length) pieces.push({ literal: value.slice(last) });
  return pieces;
}

/**
 * Text as a JSON string in a template. Literal text is escaped; a plain-path expression renders escaped too
 * (`{{ JSON.stringify(String(x)).slice(1, -1) }}`), so a quote or a newline in the value cannot break the JSON or add
 * keys. Any other expression is kept as written: its author controls what it renders.
 */
export function jsonStringTemplate(value: string): string {
  let out = "";
  for (const piece of templatePieces(value)) {
    if ("literal" in piece) out += JSON.stringify(piece.literal).slice(1, -1);
    else out += PLAIN_PATH.test(piece.expression) ? `{{ JSON.stringify(String(${piece.expression})).slice(1, -1) }}` : piece.token;
  }
  return `"${out}"`;
}

function schemaTypeOf(schema: Record<string, unknown>): string | undefined {
  const raw = schema.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const types = raw.filter((entry): entry is string => typeof entry === "string" && entry !== "null");
    return types.length === 1 ? types[0] : undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const kinds = new Set(schema.enum.map((entry) => typeof entry));
    if (kinds.size === 1) return kinds.has("number") ? "number" : kinds.has("boolean") ? "boolean" : kinds.has("string") ? "string" : undefined;
  }
  return undefined;
}

function isEmptyValue(value: CatalogFormValue): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every((item) => item.trim() === "");
  return false;
}

/** One scalar as JSON template text: a literal is checked and encoded, an expression is kept as written. */
function scalarJson(kind: string | undefined, raw: string, path: string, errors: Record<string, string>): string | undefined {
  const trimmed = raw.trim();
  if (kind === "number" || kind === "integer") {
    if (hasTemplate(trimmed)) return trimmed;
    const number = Number(trimmed);
    if (!trimmed || !Number.isFinite(number)) {
      errors[path] = "Enter a number or an expression";
      return undefined;
    }
    if (kind === "integer" && !Number.isInteger(number)) {
      errors[path] = "Enter a whole number or an expression";
      return undefined;
    }
    return String(number);
  }
  if (kind === "boolean") {
    if (trimmed === "true" || trimmed === "false" || hasTemplate(trimmed)) return trimmed;
    errors[path] = "Use true, false or an expression";
    return undefined;
  }
  if (kind === "string" || kind === undefined) return jsonStringTemplate(raw);
  // Objects, arrays and anything else: JSON text or an expression, as written.
  if (hasTemplate(trimmed)) return trimmed;
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    errors[path] = "Not valid JSON";
    return undefined;
  }
}

/**
 * Whether an object at this nesting level (0: a property of the form's root) gets fields of its own. Matches the web
 * form generator (apps/web lib/mcp-schema-form.ts): deeper objects, and objects without properties or with
 * anyOf / oneOf / allOf, are one JSON field.
 */
function nestedFieldsUsable(schema: Record<string, unknown>, level: number): boolean {
  return level < 4 && isRecord(schema.properties) && Object.keys(schema.properties).length > 0 && !schema.anyOf && !schema.oneOf && !schema.allOf;
}

/**
 * Builds a JSON template for an object schema from form values keyed by field path (`a`, `a.b`). Empty optional
 * fields are left out; a required empty field is reported in `errors` (and left out). Strings are JSON-encoded with
 * any `{{ }}` kept inside the string; numbers and booleans may be an expression, which is written bare so it renders
 * as the value; objects and arrays are JSON text or an expression. Returns `"{}"` for no values.
 */
export function jsonTemplateFromForm(
  schema: unknown,
  values: CatalogFormValues,
  options: { prefix?: string; startLevel?: number } = {}
): { template: string; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const prefix = options.prefix ?? "";

  const build = (objectSchema: Record<string, unknown>, path: string, depth: number): { parts: string[]; touched: boolean } => {
    const properties = isRecord(objectSchema.properties) ? objectSchema.properties : {};
    const required = new Set(Array.isArray(objectSchema.required) ? objectSchema.required.filter((entry): entry is string => typeof entry === "string") : []);
    const parts: string[] = [];
    let touched = false;
    for (const [key, rawProperty] of Object.entries(properties)) {
      // A key from the schema with {{ or }} would be an expression in the template: never written.
      if (hasTemplateMarks(key)) continue;
      const property = isRecord(rawProperty) ? rawProperty : {};
      const fieldPath = path ? `${path}.${key}` : key;
      const kind = schemaTypeOf(property);
      if (kind === "object" && nestedFieldsUsable(property, depth)) {
        const nested = build(property, fieldPath, depth + 1);
        if (nested.touched || required.has(key)) {
          parts.push(`${JSON.stringify(key)}: {${nested.parts.join(", ")}}`);
          touched = true;
        }
        continue;
      }
      const value = values[`${prefix}${fieldPath}`];
      if (isEmptyValue(value) && typeof value !== "boolean") {
        if (required.has(key)) errors[`${prefix}${fieldPath}`] = "Required";
        continue;
      }
      let json: string | undefined;
      if (typeof value === "boolean") {
        json = String(value);
      } else if (Array.isArray(value)) {
        const items = isRecord(property.items) ? property.items : {};
        const itemKind = schemaTypeOf(items);
        const encoded: string[] = [];
        for (const item of value.filter((entry) => entry.trim() !== "")) {
          const one = scalarJson(itemKind ?? "string", item, `${prefix}${fieldPath}`, errors);
          if (one !== undefined) encoded.push(one);
        }
        json = `[${encoded.join(", ")}]`;
      } else {
        json = scalarJson(kind, String(value), `${prefix}${fieldPath}`, errors);
      }
      if (json === undefined) continue;
      parts.push(`${JSON.stringify(key)}: ${json}`);
      touched = true;
    }
    return { parts, touched };
  };

  const root = isRecord(schema) ? schema : {};
  const { parts } = build(root, "", options.startLevel ?? 0);
  return { template: parts.length ? `{\n  ${parts.join(",\n  ")}\n}` : "{}", errors };
}

/**
 * Literal text is percent-encoded; a plain-path expression is encoded when it renders (`encodeURIComponent`), so a
 * value cannot reach another path or add query parameters. Any other expression is kept as written.
 */
function encodeUrlPart(value: string): string {
  let out = "";
  for (const piece of templatePieces(value)) {
    if ("literal" in piece) out += encodeURIComponent(piece.literal);
    else out += PLAIN_PATH.test(piece.expression) ? `{{ encodeURIComponent(${piece.expression}) }}` : piece.token;
  }
  return out;
}

function formText(value: CatalogFormValue): string {
  if (Array.isArray(value)) return value.filter((item) => item.trim() !== "").join(",");
  if (typeof value === "boolean") return String(value);
  return value ?? "";
}

function bodyHasFields(body: OpenApiRequestBody): boolean {
  return body.json && schemaTypeOf(body.schema) !== "array" && nestedFieldsUsable(body.schema, 0);
}

/**
 * One object schema for an operation's whole form: `path`, `query` and `header` objects holding its parameters (as
 * text, so a value may be an expression), and `body`: the JSON body's own schema, or one text or JSON field. A form
 * generated from it keys its values as `buildOperationRequest` reads them (`path.id`, `body.title`).
 */
export function operationFormSchema(operation: OpenApiOperation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const group = (location: OpenApiParameter["in"], title: string) => {
    const parameters = operation.parameters.filter((parameter) => parameter.in === location);
    if (parameters.length === 0) return;
    const groupProperties: Record<string, unknown> = {};
    for (const parameter of parameters) {
      const schema = isRecord(parameter.schema) ? parameter.schema : {};
      const kind = schemaTypeOf(schema);
      // Parameters are sent as text: objects become a text field too.
      groupProperties[parameter.name] = {
        ...(kind === "array" ? { type: "array", items: isRecord(schema.items) ? schema.items : { type: "string" } } : kind === "object" || kind === undefined ? { type: "string" } : { type: kind }),
        ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
        ...(parameter.description ? { description: parameter.description } : {}),
        ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
        ...(schema.default !== undefined ? { default: schema.default } : {})
      };
    }
    const groupRequired = parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name);
    properties[location] = { type: "object", title, properties: groupProperties, ...(groupRequired.length ? { required: groupRequired } : {}) };
    if (groupRequired.length) required.push(location);
  };
  group("path", "Path");
  group("query", "Query");
  group("header", "Headers");
  const body = operation.requestBody;
  if (body && operation.method !== "GET" && operation.method !== "DELETE") {
    properties.body = bodyHasFields(body)
      ? { ...body.schema, type: "object", title: "Body" }
      : body.json
        ? { title: "Body (JSON)", description: body.description ?? "The request body as JSON; expressions are allowed." }
        : { type: "string", title: `Body (${body.contentType})`, ...(body.description ? { description: body.description } : {}) };
    if (body.required) required.push("body");
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

export interface OperationRequestTemplates {
  method: OpenApiHttpMethod;
  urlTemplate: string;
  headersTemplate: string;
  bodyTemplate: string;
  /** Field path → problem (`path.id`: Required). */
  errors: Record<string, string>;
}

/**
 * The HTTP Request node's templates for one operation from its form values. Values are keyed `path.<name>`,
 * `query.<name>`, `header.<name>`, and `body.<field path>` (a JSON body) or `body` (any other body). An array
 * query value is sent as one comma-separated value.
 */
export function buildOperationRequest(operation: OpenApiOperation, baseUrl: string, values: CatalogFormValues): OperationRequestTemplates {
  const errors: Record<string, string> = {};
  let path = operation.path;
  const query: string[] = [];
  const headers: Record<string, string> = {};
  for (const parameter of operation.parameters) {
    const key = `${parameter.in}.${parameter.name}`;
    const raw = formText(values[key]);
    if (!raw.trim()) {
      if (parameter.required) errors[key] = "Required";
      if (parameter.in === "path") path = path.split(`{${parameter.name}}`).join("");
      continue;
    }
    if (parameter.in === "path") path = path.split(`{${parameter.name}}`).join(encodeUrlPart(raw));
    else if (parameter.in === "query") query.push(`${encodeURIComponent(parameter.name)}=${encodeUrlPart(raw)}`);
    else headers[parameter.name] = raw;
  }
  let bodyTemplate = "";
  const body = operation.requestBody;
  if (body && operation.method !== "GET" && operation.method !== "DELETE") {
    if (bodyHasFields(body)) {
      // In the operation's form (operationFormSchema) the body's fields sit one level down.
      const built = jsonTemplateFromForm(body.schema, values, { prefix: "body.", startLevel: 1 });
      Object.assign(errors, built.errors);
      bodyTemplate = built.template === "{}" && !body.required ? "" : built.template;
    } else {
      bodyTemplate = formText(values.body);
      if (!bodyTemplate.trim() && body.required) errors.body = "Required";
    }
    if (bodyTemplate && !body.json) headers["Content-Type"] = body.contentType;
  }
  if (operation.method !== "GET" && operation.method !== "DELETE" && body?.json && bodyTemplate) headers["Content-Type"] = "application/json";
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "accept")) headers.Accept = "application/json";
  const base = baseUrl.replace(/\/+$/, "");
  return {
    method: operation.method,
    urlTemplate: `${base}${path}${query.length ? `?${query.join("&")}` : ""}`,
    headersTemplate: headersJsonTemplate(headers),
    bodyTemplate,
    errors
  };
}

/** Headers as a JSON template; values go through jsonStringTemplate. */
function headersJsonTemplate(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([name, value]) => `  ${JSON.stringify(name)}: ${jsonStringTemplate(value)}`).join(",\n")}\n}`;
}

/** The palette label of a catalog entry: `<source> · <item>`. */
export function catalogEntryLabel(sourceName: string, itemName: string): string {
  return `${sourceName.trim() || "Untitled"} · ${itemName.trim()}`;
}

/** Reads a stored `openapiOperation` reference from a node config; null when absent or malformed. */
export function readOpenApiOperationRef(config: Record<string, unknown>): OpenApiOperationRef | null {
  const ref = config.openapiOperation;
  if (!isRecord(ref)) return null;
  const specId = text(ref.specId);
  const operationId = text(ref.operationId);
  if (!specId || !operationId) return null;
  return { specId, operationId, method: text(ref.method).toUpperCase(), path: text(ref.path), baseUrl: text(ref.baseUrl) };
}

/** Reads a node's `secretAuth`; null when unset, an error string when malformed. */
export function readHttpSecretAuth(value: unknown): HttpSecretAuth | null | string {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return "secretAuth must be an object";
  const type = text(value.type);
  if (type === "bearer" || type === "basic" || type === "connected") return { type };
  if (type === "oauth2_client_credentials") {
    const tokenUrl = text(value.tokenUrl);
    if (!tokenUrl) return "secretAuth.tokenUrl is required for OAuth2 client credentials";
    let parsed: URL;
    try {
      parsed = new URL(tokenUrl);
    } catch {
      return "secretAuth.tokenUrl is not a valid URL";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "secretAuth.tokenUrl must be an http(s) URL";
    if (parsed.username || parsed.password) return "secretAuth.tokenUrl may not carry a user name or password";
    if (tokenUrl.length > 2048) return "secretAuth.tokenUrl is too long";
    const clientId = text(value.clientId);
    if (!clientId) return "secretAuth.clientId is required for OAuth2 client credentials";
    if (clientId.length > 512) return "secretAuth.clientId is too long";
    const scope = text(value.scope);
    if (scope.length > 2048) return "secretAuth.scope is too long";
    const clientAuth = value.clientAuth === undefined || value.clientAuth === null || value.clientAuth === "" ? "body" : value.clientAuth;
    if (clientAuth !== "body" && clientAuth !== "basic") return "secretAuth.clientAuth must be body or basic";
    return { type, tokenUrl, clientId, ...(scope ? { scope } : {}), clientAuth };
  }
  if (type === "header" || type === "query") {
    const name = text(value.name);
    if (!name) return `secretAuth.name is required for ${type}`;
    if (type === "header" && !isHeaderName(name)) return "secretAuth.name is not a valid header name";
    if (type === "header" && RESERVED_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "authorization") return `secretAuth.name may not be ${name}`;
    if (name.length > 128) return "secretAuth.name is too long";
    return { type, name };
  }
  return "secretAuth.type must be bearer, basic, header, query, connected or oauth2_client_credentials";
}

/** One line saying how a node sends its secret. */
export function describeHttpSecretAuth(auth: HttpSecretAuth | null): string {
  if (!auth || auth.type === "bearer") return "as a bearer token (Authorization: Bearer …)";
  if (auth.type === "basic") return "as basic auth (the secret holds user:password)";
  if (auth.type === "header") return `in the ${auth.name} header`;
  if (auth.type === "connected") return "as the connected account's access token (Authorization: Bearer …)";
  if (auth.type === "oauth2_client_credentials") {
    let host = auth.tokenUrl;
    try {
      host = new URL(auth.tokenUrl).host;
    } catch {
      // Shown as written.
    }
    return `as the client secret for an access token from ${host} (sent as Authorization: Bearer …)`;
  }
  return `as the ${auth.name} query parameter`;
}

/** A new MCP Tool node's configuration for one registered server's tool: the tool form starts empty. */
export function mcpToolNodeConfig(server: { id: string; adapterId: string }, toolName: string): Record<string, unknown> {
  return { registryServerId: server.id, serverId: server.adapterId, toolName, allowedTools: [toolName], argsTemplate: "{}", argValues: {} };
}

/** A new HTTP Request node's configuration for one operation: the form starts empty; the secret is picked on the node. */
export function openApiNodeConfig(specId: string, operation: OpenApiOperation, baseUrl: string): Record<string, unknown> {
  const request = buildOperationRequest(operation, baseUrl, {});
  return {
    method: request.method,
    urlTemplate: request.urlTemplate,
    headersTemplate: request.headersTemplate,
    bodyTemplate: request.bodyTemplate,
    responseType: "json",
    timeoutMs: 15000,
    failOnHttpError: true,
    openapiOperation: { specId, operationId: operation.id, method: operation.method, path: operation.path, baseUrl },
    operationValues: {},
    ...(operation.auth ? { secretAuth: operation.auth } : {})
  };
}
