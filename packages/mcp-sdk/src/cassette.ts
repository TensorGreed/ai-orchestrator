import { createHash } from "node:crypto";
import {
  MCP_CASSETTE_FORMAT,
  MCP_CASSETTE_VERSION,
  type McpCassette,
  type McpCassetteEntry,
  type McpCassetteExchange,
  type McpCassetteMethod,
  type McpCassetteServer,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpReplayMode,
  type McpReplayReport,
  type MCPServerConfig,
  type MCPServerDefinition
} from "@ai-orchestrator/shared";
import { CREDENTIAL_NAME_PATTERN } from "./client-features";
import { MCPRegistry } from "./registry";
import { secretValuesForScrub } from "./secret-bundle";
import type { MCPExecutionContext, MCPServerAdapter, McpReadResourceOptions } from "./types";

/**
 * Phase 10.8 — record and replay of MCP traffic.
 *
 * Recording wraps every adapter of a registry so each request a run makes
 * (tools/list, tools/call, resources/*, prompts/*, plus the sampling and
 * elicitation exchanges a call triggers) lands in a cassette, in order, with
 * the server's identity and timing. Everything is scrubbed before it is
 * kept: the values of the server's secret, credential-like headers and env,
 * credential-named keys, and token-shaped strings become `[REDACTED]`.
 * Connection details are never recorded.
 *
 * Replay builds a registry whose adapters answer from a cassette instead of
 * a server. Calls are matched by server + method + name + the hash of the
 * canonical scrubbed arguments; repeated identical calls get their answers
 * in recorded order. Calls with different keys may interleave freely, since
 * DAG branches run in parallel. See `McpReplayMode` for what happens to a
 * call the cassette has no answer for.
 */

export const CASSETTE_REDACTED = "[REDACTED]";
export const DEFAULT_CASSETTE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_CASSETTE_MAX_ENTRIES = 5_000;

/** Object keys whose values are always dropped from a cassette. */
const SECRET_KEY_PATTERN =
  /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|pwd|secret|client[-_]?secret|api[-_]?key|apikey|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|auth[-_]?token|session[-_]?token|private[-_]?key|token|credentials?)$/i;

/** Token shapes replaced inside any string. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpas]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,})/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];

/** Keys that carry base64 payloads; the caller's value redactor is not applied to them (token shapes still are). */
const BINARY_KEYS = new Set(["blob", "data"]);

const MAX_SCRUB_DEPTH = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface CassetteScrubOptions {
  /** Exact values to remove wherever they appear (resolved secrets and the like). */
  secrets?: string[];
  /**
   * Extra value-level redaction for strings, such as the API's secret
   * redactor. Not applied to base64 payload fields (`blob`, `data`).
   */
  redact?: (value: string) => string;
}

function scrubString(value: string, options: CassetteScrubOptions, binary: boolean): string {
  let out = value;
  for (const secret of options.secrets ?? []) {
    if (secret && out.includes(secret)) out = out.split(secret).join(CASSETTE_REDACTED);
  }
  // Token shapes are removed everywhere, base64 payload fields included (`data` is a common key in outputs and configs).
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match) => (/^bearer\s/i.test(match) ? `Bearer ${CASSETTE_REDACTED}` : CASSETTE_REDACTED));
  }
  // The caller's redactor could blank a long base64 payload, so it skips those fields.
  if (binary) return out;
  return options.redact ? options.redact(out) : out;
}

/** A scrubbed deep copy: secret values, credential keys and token shapes removed. */
export function scrubForCassette(value: unknown, options: CassetteScrubOptions = {}, depth = 0, key?: string): unknown {
  if (depth > MAX_SCRUB_DEPTH) return CASSETTE_REDACTED;
  if (typeof value === "string") return scrubString(value, options, key !== undefined && BINARY_KEYS.has(key));
  if (Array.isArray(value)) return value.map((entry) => scrubForCassette(entry, options, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [name, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      out[name] = SECRET_KEY_PATTERN.test(name) ? CASSETTE_REDACTED : scrubForCassette(nested, options, depth + 1, name);
    }
    return out;
  }
  return value;
}

/** Sorted keys, `undefined` dropped: two equal argument objects serialize the same. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalJson(value[key]);
    }
    return out;
  }
  return value;
}

export function hashCassetteArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(args ?? null))).digest("hex");
}

/**
 * The identity a cassette files a server under: the registry id when there
 * is one, else the adapter plus a hash of the endpoint or command (the raw
 * values are not kept, since URLs can carry credentials).
 */
export function cassetteServerKey(config: MCPServerConfig): string {
  if (config.registryServerId) return `registry:${config.registryServerId}`;
  const connection = isRecord(config.connection) ? config.connection : {};
  const identity = JSON.stringify(
    canonicalJson({
      endpoint: connection.endpoint ?? connection.url ?? null,
      command: connection.command ?? null,
      args: connection.args ?? null
    })
  );
  return `inline:${config.serverId}:${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

/** Values of a config that must never reach a cassette: its secret, credential-like headers and env. */
export async function cassetteSecretsFor(config: MCPServerConfig, context: Pick<MCPExecutionContext, "resolveSecret">): Promise<string[]> {
  const out: string[] = [];
  if (config.secretRef) {
    try {
      out.push(...secretValuesForScrub(await context.resolveSecret(config.secretRef)));
    } catch {
      // A secret that cannot be resolved cannot leak either.
    }
  }
  const connection = isRecord(config.connection) ? config.connection : {};
  for (const group of [connection.headers, connection.env]) {
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) {
      if (typeof value === "string" && value.length >= 4 && CREDENTIAL_NAME_PATTERN.test(name)) out.push(value);
    }
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Elicitation answer fields that are never recorded, whatever the server called them. */
function isSensitiveElicitationField(name: string, property: unknown): boolean {
  if (CREDENTIAL_NAME_PATTERN.test(name)) return true;
  if (!isRecord(property)) return false;
  return property.format === "password" || property.writeOnly === true || property.sensitive === true || property["x-sensitive"] === true;
}

/** An elicitation answer as a cassette keeps it: sensitive fields redacted. */
export function scrubElicitationResult(request: McpElicitationRequest, result: McpElicitationResult): McpElicitationResult {
  if (!result.content) return { action: result.action };
  const content: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(result.content)) {
    content[name] = isSensitiveElicitationField(name, request.requestedSchema.properties[name]) ? CASSETTE_REDACTED : value;
  }
  return { action: result.action, content };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface McpCassetteRecorderOptions {
  /** Size budget for the serialized entries; later entries are dropped and the cassette marked truncated. */
  maxBytes?: number;
  maxEntries?: number;
  /** Extra string redaction (the API passes its secret redactor). */
  redact?: (value: string) => string;
  /** Accepted snapshot hash of a registry server, recorded with its identity. */
  snapshotHashFor?: (registryServerId: string) => string | null | undefined | Promise<string | null | undefined>;
  now?: () => number;
}

export class McpCassetteRecorder {
  private readonly entries: McpCassetteEntry[] = [];
  private readonly servers = new Map<string, McpCassetteServer>();
  private readonly startedAt: number;
  private readonly recordedAt: string;
  private bytes = 0;
  private truncated = false;
  private seq = 0;

  constructor(private readonly options: McpCassetteRecorderOptions = {}) {
    this.startedAt = this.now();
    this.recordedAt = new Date().toISOString();
  }

  private now(): number {
    return this.options.now ? this.options.now() : performance.now();
  }

  elapsed(): number {
    return Math.max(0, Math.round(this.now() - this.startedAt));
  }

  /**
   * Registers the server on first sight and returns its key. Servers keep
   * the order they were first seen in, even while a snapshot hash is looked up.
   */
  async serverFor(config: MCPServerConfig): Promise<string> {
    const key = cassetteServerKey(config);
    if (!this.servers.has(key)) {
      const server: McpCassetteServer = {
        key,
        adapterId: config.serverId,
        ...(config.registryServerId ? { registryServerId: config.registryServerId } : {}),
        ...(config.label ? { label: config.label } : {})
      };
      this.servers.set(key, server);
      const snapshotHash = config.registryServerId ? await this.options.snapshotHashFor?.(config.registryServerId) : undefined;
      if (snapshotHash !== undefined) this.servers.set(key, { ...server, snapshotHash });
    }
    return key;
  }

  scrubOptions(secrets: string[]): CassetteScrubOptions {
    return { secrets, ...(this.options.redact ? { redact: this.options.redact } : {}) };
  }

  /** Adds an entry unless the size budget is spent. Returns false when it was dropped. */
  push(entry: Omit<McpCassetteEntry, "seq">): boolean {
    const maxEntries = this.options.maxEntries ?? DEFAULT_CASSETTE_MAX_ENTRIES;
    const maxBytes = this.options.maxBytes ?? DEFAULT_CASSETTE_MAX_BYTES;
    if (this.truncated) return false;
    const full: McpCassetteEntry = { seq: this.seq + 1, ...entry };
    const size = Buffer.byteLength(JSON.stringify(full), "utf8");
    if (this.entries.length >= maxEntries || this.bytes + size > maxBytes) {
      this.truncated = true;
      return false;
    }
    this.seq += 1;
    this.bytes += size;
    this.entries.push(full);
    return true;
  }

  get callCount(): number {
    return this.entries.length;
  }

  toCassette(): McpCassette {
    return {
      format: MCP_CASSETTE_FORMAT,
      version: MCP_CASSETTE_VERSION,
      recordedAt: this.recordedAt,
      servers: [...this.servers.values()],
      entries: this.entries.map((entry) => ({ ...entry })),
      truncated: this.truncated,
      bytes: this.bytes,
      llm: "not_recorded"
    };
  }
}

type ExchangeSink = McpCassetteExchange[];

/** A context whose sampling and elicitation handlers also write to `sink`. */
function capturingContext(
  context: MCPExecutionContext,
  recorder: McpCassetteRecorder,
  scrub: (value: unknown) => unknown,
  sink: ExchangeSink
): MCPExecutionContext {
  const next: MCPExecutionContext = { ...context };
  if (context.onSampling) {
    const inner = context.onSampling;
    next.onSampling = async (request, origin) => {
      const at = recorder.elapsed();
      try {
        const response = await inner(request, origin);
        sink.push({ kind: "sampling", at, request: scrub(request), response: scrub(response) });
        return response;
      } catch (error) {
        sink.push({ kind: "sampling", at, request: scrub(request), error: String(scrub(errorMessage(error))) });
        throw error;
      }
    };
  }
  if (context.onElicitation) {
    const inner = context.onElicitation;
    next.onElicitation = async (request, origin) => {
      const at = recorder.elapsed();
      try {
        const response = await inner(request, origin);
        sink.push({ kind: "elicitation", at, request: scrub(request), response: scrub(scrubElicitationResult(request, response)) });
        return response;
      } catch (error) {
        sink.push({ kind: "elicitation", at, request: scrub(request), error: String(scrub(errorMessage(error))) });
        throw error;
      }
    };
  }
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wrap one adapter so every call it serves is written to `recorder`. */
export function recordingAdapter(adapter: MCPServerAdapter, recorder: McpCassetteRecorder): MCPServerAdapter {
  const record = async <T>(
    method: McpCassetteMethod,
    config: MCPServerConfig,
    context: MCPExecutionContext,
    name: string | undefined,
    args: unknown,
    run: (context: MCPExecutionContext) => Promise<T>
  ): Promise<T> => {
    const server = await recorder.serverFor(config);
    const secrets = await cassetteSecretsFor(config, context);
    const scrubOptions = recorder.scrubOptions(secrets);
    const scrub = (value: unknown) => scrubForCassette(value, scrubOptions);
    const scrubbedArgs = args === undefined ? undefined : canonicalJson(scrub(args));
    const exchanges: ExchangeSink = [];
    const at = recorder.elapsed();
    const started = performance.now();
    const base = {
      server,
      method,
      ...(name !== undefined ? { name: String(scrub(name)) } : {}),
      ...(scrubbedArgs !== undefined ? { args: scrubbedArgs } : {}),
      argsHash: hashCassetteArgs(scrubbedArgs)
    };
    try {
      const result = await run(method === "tools/call" ? capturingContext(context, recorder, scrub, exchanges) : context);
      recorder.push({
        ...base,
        result: scrub(result),
        at,
        durationMs: Math.round(performance.now() - started),
        ...(exchanges.length > 0 ? { exchanges } : {})
      });
      return result;
    } catch (error) {
      recorder.push({
        ...base,
        error: String(scrub(errorMessage(error))),
        at,
        durationMs: Math.round(performance.now() - started),
        ...(exchanges.length > 0 ? { exchanges } : {})
      });
      throw error;
    }
  };

  const wrapped: MCPServerAdapter = {
    definition: adapter.definition,
    discoverTools: (config, context) =>
      record("tools/list", config, context, undefined, undefined, (ctx) => adapter.discoverTools(config, ctx)),
    invokeTool: (toolName, args, config, context) =>
      record("tools/call", config, context, toolName, args, (ctx) => adapter.invokeTool(toolName, args, config, ctx)),
    ...(adapter.closeSessions ? { closeSessions: (context: MCPExecutionContext) => adapter.closeSessions!(context) } : {})
  };
  if (adapter.describeServer) {
    wrapped.describeServer = (config, context) =>
      record("server/describe", config, context, undefined, undefined, (ctx) => adapter.describeServer!(config, ctx));
  }
  if (adapter.listResources) {
    wrapped.listResources = (config, context) =>
      record("resources/list", config, context, undefined, undefined, (ctx) => adapter.listResources!(config, ctx));
  }
  if (adapter.listResourceTemplates) {
    wrapped.listResourceTemplates = (config, context) =>
      record("resources/templates/list", config, context, undefined, undefined, (ctx) => adapter.listResourceTemplates!(config, ctx));
  }
  if (adapter.readResource) {
    wrapped.readResource = (uri: string, config: MCPServerConfig, context: MCPExecutionContext, options?: McpReadResourceOptions) =>
      record("resources/read", config, context, uri, undefined, (ctx) => adapter.readResource!(uri, config, ctx, options));
  }
  if (adapter.listPrompts) {
    wrapped.listPrompts = (config, context) =>
      record("prompts/list", config, context, undefined, undefined, (ctx) => adapter.listPrompts!(config, ctx));
  }
  if (adapter.getPrompt) {
    wrapped.getPrompt = (name, args, config, context) =>
      record("prompts/get", config, context, name, args, (ctx) => adapter.getPrompt!(name, args, config, ctx));
  }
  return wrapped;
}

/** A registry with every adapter of `base` wrapped for recording. `base` is left untouched. */
export function createRecordingRegistry(base: MCPRegistry, recorder: McpCassetteRecorder): MCPRegistry {
  const registry = new MCPRegistry();
  for (const adapter of base.list()) registry.register(recordingAdapter(adapter, recorder));
  return registry;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Thrown for a call the cassette cannot answer in strict mode (or lenient without a live server). */
export class McpCassetteMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCassetteMissError";
  }
}

/** Methods whose answers are reads of the server's catalog; repeating them is always safe. */
const LIST_METHODS = new Set<McpCassetteMethod>([
  "server/describe",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list"
]);

/** Phase 15.3 — how one server's calls are answered; `live_read_only` sends read-only tool calls and reads to the live server. */
export type McpCassetteServerMode = McpReplayMode | "live_read_only";

export interface McpCassettePlayerOptions {
  mode?: McpReplayMode;
  /** Registry for calls the cassette never saw. Used in lenient mode only; omit it to keep replay offline. */
  live?: MCPRegistry;
  redact?: (value: string) => string;
  /**
   * Phase 15.3 — per-server modes, keyed by registry server id (else the
   * adapter id of an inline server). A `live_read_only` server answers
   * tools/call of read-only tools, resources/read and prompts/get from
   * `liveReads` (the live server), every other tool call from the cassette
   * (strict), and catalog lists from the cassette with the live server as
   * the fallback.
   */
  serverModes?: Record<string, McpCassetteServerMode>;
  /** Registry for `live_read_only` servers' live calls. */
  liveReads?: MCPRegistry;
  /** Is this tool read-only? Unknown tools are writes. Without it no tool call goes live. */
  isReadOnlyTool?: (input: { config: MCPServerConfig; toolName: string; annotations?: Record<string, unknown> }) => boolean | Promise<boolean>;
}

function matchKey(server: string, method: McpCassetteMethod, name: string | undefined, argsHash: string): string {
  return JSON.stringify([server, method, name ?? null, argsHash]);
}

export class McpCassettePlayer {
  readonly mode: McpReplayMode;
  private readonly byKey = new Map<string, McpCassetteEntry[]>();
  private readonly cursor = new Map<string, number>();
  private matched = 0;
  private reused = 0;
  private live = 0;
  private liveRead = 0;
  private readonly unmatched: McpReplayReport["unmatched"] = [];

  constructor(
    readonly cassette: McpCassette,
    private readonly options: McpCassettePlayerOptions = {}
  ) {
    this.mode = options.mode ?? "strict";
    for (const entry of [...cassette.entries].sort((a, b) => a.seq - b.seq)) {
      const key = matchKey(entry.server, entry.method, entry.name, entry.argsHash);
      const list = this.byKey.get(key) ?? [];
      list.push(entry);
      this.byKey.set(key, list);
    }
  }

  /** The live registry lenient replays fall through to; never set in strict mode. */
  get liveRegistry(): MCPRegistry | undefined {
    return this.mode === "lenient" ? this.options.live : undefined;
  }

  /** Phase 15.3 — the registry `live_read_only` servers read from. */
  get liveReadRegistry(): MCPRegistry | undefined {
    return this.options.liveReads;
  }

  /** The mode of the server a call goes to (Phase 15.3 per-server modes), else the player's. */
  modeFor(config: MCPServerConfig): McpCassetteServerMode {
    const modes = this.options.serverModes;
    if (!modes) return this.mode;
    const byRegistry = config.registryServerId ? modes[config.registryServerId] : undefined;
    return byRegistry ?? modes[config.serverId] ?? this.mode;
  }

  /** The recorded annotations of a tool, from the server's recorded tools/list answer. */
  private recordedAnnotations(server: string, toolName: string): Record<string, unknown> | undefined {
    for (const entry of this.cassette.entries) {
      if (entry.server !== server || entry.method !== "tools/list" || !Array.isArray(entry.result)) continue;
      const tool = (entry.result as Array<Record<string, unknown>>).find((candidate) => candidate && candidate.name === toolName);
      if (tool && tool.annotations && typeof tool.annotations === "object") return tool.annotations as Record<string, unknown>;
    }
    return undefined;
  }

  /** A `live_read_only` server's call that goes to the live server: a read-only tool call or a read. */
  private async goesLive(method: McpCassetteMethod, server: string, config: MCPServerConfig, name: string | undefined): Promise<boolean> {
    if (method === "resources/read" || method === "prompts/get") return true;
    if (method !== "tools/call" || name === undefined || !this.options.isReadOnlyTool) return false;
    try {
      return (await this.options.isReadOnlyTool({ config, toolName: name, annotations: this.recordedAnnotations(server, name) })) === true;
    } catch {
      return false;
    }
  }

  /** The cassette's answer for a call, or the live server's in lenient mode. */
  async answer<T>(input: {
    method: McpCassetteMethod;
    config: MCPServerConfig;
    context: MCPExecutionContext;
    name?: string;
    args?: unknown;
    live?: (adapter: MCPServerAdapter) => Promise<T>;
  }): Promise<T> {
    const server = cassetteServerKey(input.config);
    const secrets = await cassetteSecretsFor(input.config, input.context);
    const scrubOptions: CassetteScrubOptions = { secrets, ...(this.options.redact ? { redact: this.options.redact } : {}) };
    const scrubbedArgs = input.args === undefined ? undefined : canonicalJson(scrubForCassette(input.args, scrubOptions));
    const name = input.name === undefined ? undefined : String(scrubForCassette(input.name, scrubOptions));
    const key = matchKey(server, input.method, name, hashCassetteArgs(scrubbedArgs));
    const mode = this.modeFor(input.config);

    if (mode === "live_read_only" && input.live && (await this.goesLive(input.method, server, input.config, name))) {
      const readAdapter = this.options.liveReads?.tryGet(input.config.serverId);
      if (readAdapter) {
        this.liveRead += 1;
        return input.live(readAdapter);
      }
    }

    // Read the cursor only after the last await, so concurrent calls never take the same entry.
    const candidates = this.byKey.get(key) ?? [];
    const position = this.cursor.get(key) ?? 0;

    let entry: McpCassetteEntry | undefined;
    if (position < candidates.length) {
      entry = candidates[position];
      this.cursor.set(key, position + 1);
      this.matched += 1;
    } else if (candidates.length > 0 && (LIST_METHODS.has(input.method) || mode === "lenient")) {
      entry = candidates[candidates.length - 1];
      if (LIST_METHODS.has(input.method)) this.matched += 1;
      else this.reused += 1;
    }

    if (entry) {
      if (entry.error !== undefined) throw new Error(entry.error);
      return structuredClone(entry.result) as T;
    }

    if (mode === "live_read_only" && input.live && LIST_METHODS.has(input.method)) {
      // A catalog the cassette never saw is a read: the live server answers it.
      const readAdapter = this.options.liveReads?.tryGet(input.config.serverId);
      if (readAdapter) {
        this.liveRead += 1;
        return input.live(readAdapter);
      }
    }

    const reason = this.describeMiss(server, input.method, name, candidates.length);
    const liveAdapter = mode === "lenient" ? this.liveRegistry?.tryGet(input.config.serverId) : undefined;
    if (liveAdapter && input.live) {
      this.live += 1;
      return input.live(liveAdapter);
    }
    this.unmatched.push({ server, method: input.method, ...(name !== undefined ? { name } : {}), reason });
    throw new McpCassetteMissError(`Cassette replay (${this.mode}): ${reason}`);
  }

  private describeMiss(server: string, method: McpCassetteMethod, name: string | undefined, exhausted: number): string {
    const target = `${method}${name !== undefined ? ` '${name}'` : ""} on ${server}`;
    if (exhausted > 0) {
      return `${target} was called more often than recorded (${exhausted} recorded). Re-record the cassette or replay in lenient mode.`;
    }
    const sameName = this.cassette.entries.filter((entry) => entry.server === server && entry.method === method && entry.name === name).length;
    if (sameName > 0) {
      return `no recorded ${target} with these arguments (${sameName} recorded with different arguments). Re-record the cassette or replay in lenient mode.`;
    }
    const knownServer = this.cassette.servers.some((entry) => entry.key === server);
    return knownServer
      ? `no recorded ${target}. Re-record the cassette or replay in lenient mode.`
      : `the cassette has no calls to server ${server}. Re-record the cassette or replay in lenient mode.`;
  }

  report(cassetteId: string): McpReplayReport {
    return {
      cassetteId,
      mode: this.mode,
      matched: this.matched,
      reused: this.reused,
      live: this.live,
      ...(this.liveRead > 0 ? { liveRead: this.liveRead } : {}),
      unmatched: [...this.unmatched]
    };
  }
}

function replayDefinition(adapterId: string, base?: MCPServerDefinition): MCPServerDefinition {
  return (
    base ?? {
      id: adapterId,
      label: `Replay of ${adapterId}`,
      description: "Answers from a recorded cassette.",
      configSchema: { type: "object", properties: {} },
      authSchema: { type: "object", properties: {} }
    }
  );
}

function replayAdapter(definition: MCPServerDefinition, player: McpCassettePlayer): MCPServerAdapter {
  return {
    definition,
    discoverTools: (config, context) =>
      player.answer({ method: "tools/list", config, context, live: (adapter) => adapter.discoverTools(config, context) }),
    invokeTool: (toolName, args, config, context) =>
      player.answer({
        method: "tools/call",
        config,
        context,
        name: toolName,
        args,
        live: (adapter) => adapter.invokeTool(toolName, args, config, context)
      }),
    describeServer: (config, context) =>
      player.answer({ method: "server/describe", config, context, live: async (adapter) => (await adapter.describeServer?.(config, context)) ?? {} }),
    listResources: (config, context) =>
      player.answer({ method: "resources/list", config, context, live: async (adapter) => (await adapter.listResources?.(config, context)) ?? [] }),
    listResourceTemplates: (config, context) =>
      player.answer({
        method: "resources/templates/list",
        config,
        context,
        live: async (adapter) => (await adapter.listResourceTemplates?.(config, context)) ?? []
      }),
    readResource: (uri, config, context, options) =>
      player.answer({
        method: "resources/read",
        config,
        context,
        name: uri,
        live: (adapter) => {
          if (!adapter.readResource) throw new Error(`MCP adapter '${config.serverId}' cannot read resources.`);
          return adapter.readResource(uri, config, context, options);
        }
      }),
    listPrompts: (config, context) =>
      player.answer({ method: "prompts/list", config, context, live: async (adapter) => (await adapter.listPrompts?.(config, context)) ?? [] }),
    getPrompt: (name, args, config, context) =>
      player.answer({
        method: "prompts/get",
        config,
        context,
        name,
        args,
        live: (adapter) => {
          if (!adapter.getPrompt) throw new Error(`MCP adapter '${config.serverId}' has no prompts.`);
          return adapter.getPrompt(name, args, config, context);
        }
      }),
    closeSessions: async (context) => {
      // Lenient and live-read replays may have opened live sessions in this context.
      await player.liveRegistry?.tryGet(definition.id)?.closeSessions?.(context);
      await player.liveReadRegistry?.tryGet(definition.id)?.closeSessions?.(context);
    }
  };
}

/**
 * A registry that answers every MCP call from `cassette`. Adapter ids come
 * from the live registry (when given) and from the cassette's servers, so a
 * replay works even where the original adapter is not installed.
 */
export function createReplayRegistry(
  cassette: McpCassette,
  options: McpCassettePlayerOptions = {}
): { registry: MCPRegistry; player: McpCassettePlayer } {
  const player = new McpCassettePlayer(cassette, options);
  const registry = new MCPRegistry();
  const ids = new Set<string>([
    ...(options.live?.list().map((adapter) => adapter.definition.id) ?? []),
    ...(options.liveReads?.list().map((adapter) => adapter.definition.id) ?? []),
    ...cassette.servers.map((server) => server.adapterId)
  ]);
  for (const id of ids) {
    registry.register(replayAdapter(replayDefinition(id, options.live?.tryGet(id)?.definition ?? options.liveReads?.tryGet(id)?.definition), player));
  }
  return { registry, player };
}
