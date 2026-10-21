import { Ajv, type ValidateFunction } from "ajv";
import {
  mcpCassetteSchema,
  mcpSnapshotFileSchema,
  type McpCassette,
  type McpCassetteEntry,
  type McpPrompt,
  type McpPromptGetResult,
  type McpResource,
  type McpResourceReadResult,
  type McpResourceTemplate,
  type McpServerCapabilities,
  type MCPServerConfig,
  type McpSnapshotFile,
  type McpSnapshotFileTool,
  type MCPToolDefinition,
  type MCPToolResult
} from "@ai-orchestrator/shared";
import { canonicalJson, hashCassetteArgs, scrubForCassette } from "./cassette";
import {
  JSON_RPC_INVALID_PARAMS,
  normalizePromptGetResult,
  normalizePrompts,
  normalizeResourceReadResult,
  normalizeResources,
  normalizeResourceTemplates
} from "./client-features";
import { buildToolCallResult } from "./structured-output";
import { normalizeToolAnnotations } from "./tool-annotations";
import type { MCPExecutionContext, MCPServerAdapter, McpReadResourceOptions } from "./types";

/**
 * Phase 10.8 — a stub MCP server generated from a schema snapshot.
 *
 * `SnapshotMockServer` serves the snapshot's tools (input and output schemas,
 * annotations), resources, resource templates and prompts. A tool call is
 * answered, in this order, by:
 *   1. a cassette entry for the same tool and arguments (in recorded order),
 *   2. any cassette entry for the same tool,
 *   3. a deterministic example built from the tool's `outputSchema`,
 *   4. a fixed text result.
 * Resource reads and prompt gets follow the same order, with a short
 * placeholder text instead of an example.
 *
 * The same server backs the `snapshot_mock` registry adapter (offline demos
 * and tests inside L2M) and the stdio process `l2m mcp mock` starts for
 * external MCP clients.
 */

export const SNAPSHOT_MOCK_ADAPTER_ID = "snapshot_mock";

/** JSON-RPC code for an unknown resource, as MCP servers commonly use it. */
export const JSON_RPC_RESOURCE_NOT_FOUND = -32002;

export class SnapshotMockError extends Error {
  constructor(
    message: string,
    readonly code: number = JSON_RPC_INVALID_PARAMS
  ) {
    super(message);
    this.name = "SnapshotMockError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issuesText(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Parse an exported snapshot file; throws with the first problems when it is not one. */
export function parseSnapshotFile(raw: unknown): McpSnapshotFile {
  const parsed = mcpSnapshotFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Not an L2M MCP snapshot file: ${issuesText(parsed.error)}`);
  return parsed.data as McpSnapshotFile;
}

/** Parse a cassette file; throws with the first problems when it is not one. */
export function parseCassette(raw: unknown): McpCassette {
  const parsed = mcpCassetteSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Not an L2M MCP cassette: ${issuesText(parsed.error)}`);
  return parsed.data as McpCassette;
}

// ---------------------------------------------------------------------------
// Deterministic examples from JSON Schema
// ---------------------------------------------------------------------------

const STRING_FORMATS: Record<string, string> = {
  "date-time": "2025-01-01T00:00:00Z",
  date: "2025-01-01",
  time: "00:00:00Z",
  email: "user@example.com",
  uri: "https://example.com/",
  url: "https://example.com/",
  "uri-reference": "https://example.com/",
  uuid: "00000000-0000-4000-8000-000000000000",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1"
};

const MAX_EXAMPLE_DEPTH = 12;

function resolveRef(ref: string, root: unknown): unknown {
  if (!ref.startsWith("#")) return {};
  const parts = ref
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~")));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current)) return {};
    current = current[part];
  }
  return current ?? {};
}

function firstType(type: unknown): string | undefined {
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((entry) => typeof entry === "string" && entry !== "null") ?? type[0];
  return undefined;
}

function numberExample(schema: Record<string, unknown>, integer: boolean): number {
  let low = typeof schema.minimum === "number" ? schema.minimum : undefined;
  if (typeof schema.exclusiveMinimum === "number") low = schema.exclusiveMinimum + (integer ? 1 : 0.5);
  let high = typeof schema.maximum === "number" ? schema.maximum : undefined;
  if (typeof schema.exclusiveMaximum === "number") high = schema.exclusiveMaximum - (integer ? 1 : 0.5);
  let value = low ?? (high !== undefined && high < 0 ? high : 0);
  if (integer) value = Math.ceil(value);
  const step = typeof schema.multipleOf === "number" && schema.multipleOf > 0 ? schema.multipleOf : undefined;
  if (step) value = Math.ceil(value / step) * step;
  if (high !== undefined && value > high) value = integer ? Math.floor(high) : high;
  return value;
}

function stringExample(schema: Record<string, unknown>): string {
  let value = (typeof schema.format === "string" && STRING_FORMATS[schema.format]) || "example";
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  if (value.length < min) value = value + "x".repeat(min - value.length);
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
  return value;
}

/**
 * A value that conforms to `schema`, the same every time. Handles the
 * subset tool output schemas use: types, `properties`/`required`, `items`,
 * `enum`/`const`/`default`/`examples`, local `$ref`s, `allOf`, `anyOf`/
 * `oneOf` (first option), string formats and lengths, numeric bounds.
 */
export function exampleFromSchema(schema: unknown, root: unknown = schema, depth = 0): unknown {
  if (schema === true || schema === undefined) return "example";
  if (!isRecord(schema) || depth > MAX_EXAMPLE_DEPTH) return null;
  if (typeof schema.$ref === "string") return exampleFromSchema(resolveRef(schema.$ref, root), root, depth + 1);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = { ...schema, allOf: undefined };
    const properties: Record<string, unknown> = { ...(isRecord(schema.properties) ? schema.properties : {}) };
    const required = new Set<string>(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const part of schema.allOf) {
      const resolved = isRecord(part) && typeof part.$ref === "string" ? resolveRef(part.$ref, root) : part;
      if (!isRecord(resolved)) continue;
      if (resolved.type && !merged.type) merged.type = resolved.type;
      if (isRecord(resolved.properties)) Object.assign(properties, resolved.properties);
      if (Array.isArray(resolved.required)) for (const name of resolved.required) required.add(String(name));
    }
    delete merged.allOf;
    return exampleFromSchema({ ...merged, properties, required: [...required] }, root, depth + 1);
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) {
      const preferred = options.find((option) => !(isRecord(option) && option.type === "null")) ?? options[0];
      return exampleFromSchema(preferred, root, depth + 1);
    }
  }

  const type = firstType(schema.type) ?? (isRecord(schema.properties) ? "object" : schema.items !== undefined ? "array" : undefined);
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = isRecord(schema.properties) ? schema.properties : {};
      for (const [name, property] of Object.entries(properties)) out[name] = exampleFromSchema(property, root, depth + 1);
      for (const name of Array.isArray(schema.required) ? schema.required : []) {
        if (typeof name === "string" && !(name in out)) {
          out[name] = isRecord(schema.additionalProperties) ? exampleFromSchema(schema.additionalProperties, root, depth + 1) : "example";
        }
      }
      return out;
    }
    case "array": {
      if (Array.isArray(schema.prefixItems)) return schema.prefixItems.map((item) => exampleFromSchema(item, root, depth + 1));
      if (Array.isArray(schema.items)) return schema.items.map((item) => exampleFromSchema(item, root, depth + 1));
      const max = typeof schema.maxItems === "number" ? schema.maxItems : Number.POSITIVE_INFINITY;
      const count = Math.min(max, Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 1));
      return Array.from({ length: count }, () => exampleFromSchema(schema.items ?? {}, root, depth + 1));
    }
    case "string":
      return stringExample(schema);
    case "integer":
      return numberExample(schema, true);
    case "number":
      return numberExample(schema, false);
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "example";
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false, allowUnionTypes: true });

function compile(schema: Record<string, unknown>): ValidateFunction | null {
  try {
    const { $schema: _schema, $id: _id, ...rest } = schema;
    return ajv.compile(rest);
  } catch {
    return null;
  }
}

/** A `tools/call` result in MCP wire format. */
export interface WireToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface SnapshotMockServerOptions {
  cassette?: McpCassette;
  /** Text result for tools without an outputSchema or recording. */
  fixedText?: string;
}

function templateRegex(uriTemplate: string): RegExp {
  const escaped = uriTemplate.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "{" || char === "}" ? char : `\\${char}`));
  return new RegExp(`^${escaped.replace(/\{[^}]+\}/g, "[^/]+")}$`);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A recorded MCPToolResult turned back into wire format. */
function wireFromRecorded(result: unknown): WireToolResult {
  const record = isRecord(result) ? (result as Partial<MCPToolResult>) : {};
  const blocks = (value: unknown): WireToolResult["content"] =>
    Array.isArray(value) ? value.map((entry) => ({ type: "text", text: textOf(entry) })) : [{ type: "text", text: textOf(value) }];
  if (record.ok === false) {
    return { content: [{ type: "text", text: record.error ?? "The recorded call failed." }], isError: true };
  }
  if (isRecord(record.structured)) {
    return {
      structuredContent: record.structured,
      content: record.content !== undefined ? blocks(record.content) : [{ type: "text", text: JSON.stringify(record.structured) }]
    };
  }
  return { content: blocks(record.content !== undefined ? record.content : (record.output ?? "")) };
}

export class SnapshotMockServer {
  readonly tools: McpSnapshotFileTool[];
  readonly resources: McpResource[];
  readonly resourceTemplates: McpResourceTemplate[];
  readonly prompts: McpPrompt[];
  private readonly cursor = new Map<string, number>();
  private readonly validators = new Map<string, ValidateFunction | null>();

  constructor(
    readonly snapshot: McpSnapshotFile,
    private readonly options: SnapshotMockServerOptions = {}
  ) {
    this.tools = [...snapshot.snapshot.tools].sort((a, b) => a.name.localeCompare(b.name));
    this.resources = normalizeResources(snapshot.catalog?.resources ?? []);
    this.resourceTemplates = normalizeResourceTemplates(snapshot.catalog?.resourceTemplates ?? []);
    this.prompts = normalizePrompts(snapshot.catalog?.prompts ?? []);
  }

  get name(): string {
    return this.snapshot.server.name || this.snapshot.server.id;
  }

  capabilities(): McpServerCapabilities {
    return {
      tools: { listChanged: false },
      ...(this.resources.length > 0 || this.resourceTemplates.length > 0 ? { resources: { listChanged: false } } : {}),
      ...(this.prompts.length > 0 ? { prompts: { listChanged: false } } : {})
    };
  }

  /** `tools/list` entries in wire format. */
  listTools(): Array<Record<string, unknown>> {
    return this.tools.map((tool) => {
      const annotations = normalizeToolAnnotations(tool.annotations);
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema && Object.keys(tool.inputSchema).length > 0 ? tool.inputSchema : { type: "object" },
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(annotations ? { annotations } : {})
      };
    });
  }

  private recorded(method: McpCassetteEntry["method"], name: string, args: unknown): McpCassetteEntry | undefined {
    const cassette = this.options.cassette;
    if (!cassette) return undefined;
    const ownKey = `registry:${this.snapshot.server.id}`;
    const ours = cassette.servers.some((server) => server.key === ownKey);
    const candidates = cassette.entries
      .filter((entry) => entry.method === method && entry.name === name && (!ours || entry.server === ownKey))
      .sort((a, b) => a.seq - b.seq);
    if (candidates.length === 0) return undefined;
    const argsHash = hashCassetteArgs(args === undefined ? undefined : canonicalJson(scrubForCassette(args)));
    const exact = candidates.filter((entry) => entry.argsHash === argsHash);
    if (exact.length > 0) {
      const key = `${method}\u0000${name}\u0000${argsHash}`;
      const position = this.cursor.get(key) ?? 0;
      this.cursor.set(key, position + 1);
      return exact[Math.min(position, exact.length - 1)];
    }
    return candidates[0];
  }

  private validatorFor(tool: McpSnapshotFileTool): ValidateFunction | null {
    if (!this.validators.has(tool.name)) {
      const schema = tool.inputSchema && Object.keys(tool.inputSchema).length > 0 ? tool.inputSchema : null;
      this.validators.set(tool.name, schema ? compile(schema) : null);
    }
    return this.validators.get(tool.name) ?? null;
  }

  callTool(name: string, args: Record<string, unknown> = {}): WireToolResult {
    const tool = this.tools.find((entry) => entry.name === name);
    if (!tool) throw new SnapshotMockError(`Unknown tool: ${name}`);
    const validate = this.validatorFor(tool);
    if (validate && !validate(args)) {
      const details = (validate.errors ?? [])
        .slice(0, 5)
        .map((entry) => `${entry.instancePath || "(root)"} ${entry.message ?? "is invalid"}`)
        .join("; ");
      return { content: [{ type: "text", text: `Invalid arguments for ${name}: ${details}` }], isError: true };
    }
    const recorded = this.recorded("tools/call", name, args);
    if (recorded) {
      if (recorded.error !== undefined) return { content: [{ type: "text", text: recorded.error }], isError: true };
      return wireFromRecorded(recorded.result);
    }
    if (tool.outputSchema) {
      const example = exampleFromSchema(tool.outputSchema);
      const structured = isRecord(example) ? example : { value: example };
      return { structuredContent: structured, content: [{ type: "text", text: JSON.stringify(structured) }] };
    }
    const text = this.options.fixedText ?? `Mock response from '${name}' (snapshot ${this.snapshot.snapshot.hash.slice(0, 12)}).`;
    return { content: [{ type: "text", text }] };
  }

  /** `resources/read` result in wire format: `{ contents }`. */
  readResource(uri: string): { contents: Array<Record<string, unknown>> } {
    const recorded = this.recorded("resources/read", uri, undefined);
    if (recorded && recorded.error === undefined && isRecord(recorded.result) && Array.isArray(recorded.result.contents)) {
      return { contents: recorded.result.contents as Array<Record<string, unknown>> };
    }
    const resource = this.resources.find((entry) => entry.uri === uri);
    const template = resource ? undefined : this.resourceTemplates.find((entry) => templateRegex(entry.uriTemplate).test(uri));
    if (!resource && !template) throw new SnapshotMockError(`Resource not found: ${uri}`, JSON_RPC_RESOURCE_NOT_FOUND);
    const mimeType = resource?.mimeType ?? template?.mimeType;
    return {
      contents: [{ uri, ...(mimeType && mimeType.startsWith("text/") ? { mimeType } : { mimeType: "text/plain" }), text: `Mock content for ${uri}.` }]
    };
  }

  /** `prompts/get` result in wire format. */
  getPrompt(name: string, args: Record<string, string> = {}): { description?: string; messages: Array<Record<string, unknown>> } {
    const prompt = this.prompts.find((entry) => entry.name === name);
    if (!prompt) throw new SnapshotMockError(`Prompt not found: ${name}`);
    const missing = (prompt.arguments ?? []).filter((argument) => argument.required && !String(args[argument.name] ?? "").trim());
    if (missing.length > 0) {
      throw new SnapshotMockError(`Prompt '${name}' requires: ${missing.map((argument) => argument.name).join(", ")}`);
    }
    const recorded = this.recorded("prompts/get", name, args);
    if (recorded && recorded.error === undefined && isRecord(recorded.result) && Array.isArray(recorded.result.messages)) {
      const description = typeof recorded.result.description === "string" ? recorded.result.description : undefined;
      return { ...(description ? { description } : {}), messages: recorded.result.messages as Array<Record<string, unknown>> };
    }
    return {
      ...(prompt.description ? { description: prompt.description } : {}),
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Mock prompt '${name}'. Arguments: ${JSON.stringify(canonicalJson(args))}` }
        }
      ]
    };
  }
}

// ---------------------------------------------------------------------------
// Registry adapter (`snapshot_mock`)
// ---------------------------------------------------------------------------

/** Where the adapter finds snapshots and cassettes referenced by id. The API implements it over its store. */
export interface McpSnapshotSource {
  /** The accepted snapshot of a registry server, as an export file. */
  loadSnapshot(sourceServerId: string): Promise<McpSnapshotFile> | McpSnapshotFile;
  loadCassette?(cassetteId: string): Promise<McpCassette | null> | McpCassette | null;
}

const RUNTIME_KEY_PREFIX = "snapshot_mock:";

export class SnapshotMockMCPServerAdapter implements MCPServerAdapter {
  private readonly fallbackCache = new Map<string, unknown>();

  readonly definition = {
    id: SNAPSHOT_MOCK_ADAPTER_ID,
    label: "Snapshot mock server",
    description:
      "Offline stub generated from a registry server's accepted schema snapshot. Answers from a cassette when one is set, else from each tool's outputSchema.",
    configSchema: {
      type: "object",
      properties: {
        sourceServerId: { type: "string", description: "Registry server whose accepted snapshot the mock serves." },
        snapshot: { type: "object", description: "An exported snapshot file, inline, instead of sourceServerId." },
        cassetteId: { type: "string", description: "Optional cassette the mock answers tool calls from." },
        fixedText: { type: "string", description: "Text result for tools with no outputSchema and no recording." }
      }
    },
    authSchema: { type: "object", properties: {} }
  };

  constructor(private readonly source?: McpSnapshotSource) {}

  private cache(context: MCPExecutionContext): Map<string, unknown> {
    return context.runtimeState ?? this.fallbackCache;
  }

  private async serverFor(config: MCPServerConfig, context: MCPExecutionContext): Promise<SnapshotMockServer> {
    const connection = isRecord(config.connection) ? config.connection : {};
    const sourceServerId = typeof connection.sourceServerId === "string" ? connection.sourceServerId.trim() : "";
    const cassetteId = typeof connection.cassetteId === "string" ? connection.cassetteId.trim() : "";
    const fixedText = typeof connection.fixedText === "string" && connection.fixedText.trim() ? connection.fixedText : undefined;
    const cacheKey = `${RUNTIME_KEY_PREFIX}${config.registryServerId ?? ""}:${sourceServerId}:${cassetteId}`;
    const cache = this.cache(context);
    const cached = connection.snapshot === undefined ? (cache.get(cacheKey) as SnapshotMockServer | undefined) : undefined;
    if (cached) return cached;

    let snapshot: McpSnapshotFile;
    if (connection.snapshot !== undefined) {
      snapshot = parseSnapshotFile(connection.snapshot);
    } else if (sourceServerId) {
      if (!this.source) throw new Error("This deployment cannot load snapshots for mock servers.");
      snapshot = parseSnapshotFile(await this.source.loadSnapshot(sourceServerId));
    } else {
      throw new Error(`Mock server '${config.label ?? config.serverId}' needs a source server or an inline snapshot.`);
    }
    let cassette: McpCassette | undefined;
    if (cassetteId) {
      const loaded = this.source?.loadCassette ? await this.source.loadCassette(cassetteId) : null;
      if (!loaded) throw new Error(`Cassette not found for mock server: ${cassetteId}`);
      cassette = loaded;
    }
    const server = new SnapshotMockServer(snapshot, { ...(cassette ? { cassette } : {}), ...(fixedText ? { fixedText } : {}) });
    if (connection.snapshot === undefined) cache.set(cacheKey, server);
    return server;
  }

  async closeSessions(context: MCPExecutionContext): Promise<void> {
    const cache = this.cache(context);
    for (const key of [...cache.keys()]) {
      if (key.startsWith(RUNTIME_KEY_PREFIX)) cache.delete(key);
    }
  }

  async discoverTools(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolDefinition[]> {
    const server = await this.serverFor(config, context);
    return server.listTools().map((tool) => ({
      serverId: this.definition.id,
      serverLabel: config.label ?? server.name,
      name: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
      ...(tool.annotations ? { annotations: tool.annotations as MCPToolDefinition["annotations"] } : {})
    }));
  }

  async invokeTool(toolName: string, args: Record<string, unknown>, config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPToolResult> {
    try {
      const server = await this.serverFor(config, context);
      const tool = server.tools.find((entry) => entry.name === toolName);
      return buildToolCallResult(toolName, server.callTool(toolName, args), tool?.outputSchema);
    } catch (error) {
      return { ok: false, output: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async describeServer(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpServerCapabilities> {
    return (await this.serverFor(config, context)).capabilities();
  }

  async listResources(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResource[]> {
    return (await this.serverFor(config, context)).resources;
  }

  async listResourceTemplates(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpResourceTemplate[]> {
    return (await this.serverFor(config, context)).resourceTemplates;
  }

  async readResource(
    uri: string,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    options: McpReadResourceOptions = {}
  ): Promise<McpResourceReadResult> {
    const server = await this.serverFor(config, context);
    return normalizeResourceReadResult(uri, server.readResource(uri), options.maxBytes);
  }

  async listPrompts(config: MCPServerConfig, context: MCPExecutionContext): Promise<McpPrompt[]> {
    return (await this.serverFor(config, context)).prompts;
  }

  async getPrompt(name: string, args: Record<string, string>, config: MCPServerConfig, context: MCPExecutionContext): Promise<McpPromptGetResult> {
    const server = await this.serverFor(config, context);
    return normalizePromptGetResult(name, server.getPrompt(name, args));
  }
}
