/**
 * Phase 10.6 — import MCP client config files into the server registry.
 *
 * Pure conversion: parse a client config (JSON with comments allowed), map
 * every server entry to a registry server (adapter, connection, name), pull
 * credentials out into value slots, detect entries that match a server that
 * is already registered, and report per field what was mapped, approximated
 * or skipped. Nothing here touches the store or SecretService; the route
 * turns a plan into servers and secrets.
 *
 * Credentials never reach the connection: env values and headers that look
 * like credentials, `${input:…}` placeholders marked as passwords and
 * `${env:…}` references become `secret` slots. A server with one secret uses
 * the existing single-secret wiring (`secretEnvVar` for stdio, bearer auth
 * for http); with several, one JSON secret bundle holds them all and the
 * connection lists only their names (`secretEnvVars` / `secretHeaders`).
 */

import { CREDENTIAL_NAME_PATTERN } from "@ai-orchestrator/mcp-sdk";
import type {
  McpConfigImportFormat,
  McpImportDecision,
  McpImportDuplicate,
  McpImportEntryView,
  McpImportItemStatus,
  McpImportReportItem,
  McpImportValueSlot
} from "@ai-orchestrator/shared";

export class McpConfigImportError extends Error {}

export interface ExistingServerRef {
  id: string;
  name: string;
  adapterId: string;
  connection: Record<string, unknown>;
}

interface InputDefinition {
  id: string;
  description?: string;
  password: boolean;
  options?: string[];
  defaultValue?: string;
}

interface RawEntry {
  key: string;
  /** Where the entry sits in the file, for messages. */
  path: string;
  value: Record<string, unknown>;
}

export interface ParsedMcpClientConfig {
  format: McpConfigImportFormat;
  entries: RawEntry[];
  inputs: Map<string, InputDefinition>;
  warnings: string[];
}

interface SlotPlan {
  slot: McpImportValueSlot;
  /** Value from the file, for literal slots. Never serialised. */
  literal?: string;
  /** Text around the placeholder, e.g. `Bearer ` before `${input:token}`. */
  prefix: string;
  suffix: string;
}

export interface PlannedImportEntry {
  view: McpImportEntryView;
  slots: SlotPlan[];
  /** Connection without slot values (plain env and headers only). */
  baseConnection: Record<string, unknown>;
}

export interface McpImportPlan {
  format: McpConfigImportFormat;
  entries: PlannedImportEntry[];
  warnings: string[];
}

export interface MaterializedEntry {
  connection: Record<string, unknown>;
  /** The one secret to store for the server, or null when it needs none. */
  secret: { value: string; names: string[] } | null;
  missing: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strip `//` and block comments and trailing commas, leaving string contents alone. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  // Trailing commas before } or ] (outside strings, which the pass above kept intact).
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let look = index + 1;
      while (look < text.length && /\s/.test(text[look]!)) look += 1;
      if (text[look] === "}" || text[look] === "]") continue;
    }
    out += char;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordEntries(value: unknown, path: string): RawEntry[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, entry]) => isRecord(entry))
    .map(([key, entry]) => ({ key, path: `${path}.${key}`, value: entry as Record<string, unknown> }));
}

function parseInputs(raw: unknown): Map<string, InputDefinition> {
  const inputs = new Map<string, InputDefinition>();
  if (!Array.isArray(raw)) return inputs;
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    inputs.set(item.id, {
      id: item.id,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      password: item.password === true,
      ...(Array.isArray(item.options)
        ? { options: item.options.filter((option): option is string => typeof option === "string") }
        : {}),
      ...(typeof item.default === "string" ? { defaultValue: item.default } : {})
    });
  }
  return inputs;
}

function looksLikeTypedMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every((entry) => isRecord(entry) && (entry.type === "local" || entry.type === "remote" || Array.isArray(entry.command)))
  );
}

/** Parse a client config file. Throws McpConfigImportError with a user-facing message. */
export function parseMcpClientConfig(content: string | Record<string, unknown>): ParsedMcpClientConfig {
  let doc: unknown = content;
  if (typeof content === "string") {
    try {
      doc = JSON.parse(stripJsonComments(content.replace(/^﻿/, "")));
    } catch (error) {
      throw new McpConfigImportError(`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(doc)) {
    throw new McpConfigImportError("The file must be a JSON object.");
  }
  const warnings: string[] = [];

  if (isRecord(doc.mcpServers) || isRecord(doc.projects)) {
    const entries = recordEntries(doc.mcpServers, "mcpServers");
    if (isRecord(doc.projects)) {
      for (const [projectPath, project] of Object.entries(doc.projects)) {
        if (!isRecord(project)) continue;
        const nested = recordEntries(project.mcpServers, `projects.${projectPath}.mcpServers`);
        for (const entry of nested) {
          if (entries.some((existing) => existing.key === entry.key)) {
            entry.key = `${entry.key} (${projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "project"})`;
          }
          entries.push(entry);
        }
      }
    }
    if (entries.length > 0) {
      return { format: "mcp_servers", entries, inputs: parseInputs(doc.inputs), warnings };
    }
  }
  if (isRecord(doc.servers)) {
    return { format: "servers_inputs", entries: recordEntries(doc.servers, "servers"), inputs: parseInputs(doc.inputs), warnings };
  }
  if (isRecord(doc.mcp) && isRecord(doc.mcp.servers)) {
    return {
      format: "settings_mcp_servers",
      entries: recordEntries(doc.mcp.servers, "mcp.servers"),
      inputs: parseInputs(doc.mcp.inputs),
      warnings
    };
  }
  if (isRecord(doc.context_servers)) {
    return { format: "context_servers", entries: recordEntries(doc.context_servers, "context_servers"), inputs: new Map(), warnings };
  }
  if (looksLikeTypedMap(doc.mcp)) {
    return { format: "mcp_typed_map", entries: recordEntries(doc.mcp, "mcp"), inputs: new Map(), warnings };
  }
  throw new McpConfigImportError(
    'No MCP servers found. Expected a top-level "mcpServers", "servers", "mcp" or "context_servers" object.'
  );
}

// ---------------------------------------------------------------------------
// Values, placeholders and credentials
// ---------------------------------------------------------------------------

// The same heuristic refuses elicitation schemas that ask for credentials (mcp-sdk client-features).
const SECRET_NAME_PATTERN = CREDENTIAL_NAME_PATTERN;
const SECRET_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie)$/i;

/** Env var or header names whose values are treated as credentials. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name) || SECRET_HEADER_PATTERN.test(name);
}

/** Variables a client expands on its own machine (workspace paths and the like). */
const CLIENT_VARIABLES = new Set([
  "workspaceFolder",
  "workspaceFolderBasename",
  "workspaceRoot",
  "userHome",
  "cwd",
  "file",
  "fileDirname",
  "fileBasename",
  "relativeFile",
  "pathSeparator",
  "execPath",
  "HOME"
]);

type Placeholder =
  | { kind: "input"; id: string; raw: string; start: number; end: number }
  | { kind: "env"; name: string; raw: string; start: number; end: number }
  | { kind: "client"; name: string; raw: string; start: number; end: number };

function findPlaceholders(value: string): Placeholder[] {
  const out: Placeholder[] = [];
  const pattern = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    const inner = match[1]!.trim();
    const base = { raw: match[0], start: match.index, end: match.index + match[0].length };
    if (inner.startsWith("input:")) {
      out.push({ kind: "input", id: inner.slice(6).trim(), ...base });
    } else if (inner.startsWith("env:")) {
      out.push({ kind: "env", name: inner.slice(4).trim(), ...base });
    } else {
      const name = inner.split(/:-|:/)[0]!.trim();
      if (CLIENT_VARIABLES.has(name) || name.includes(".") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        out.push({ kind: "client", name, ...base });
      } else {
        out.push({ kind: "env", name, ...base });
      }
    }
  }
  return out;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") out[key] = String(entry);
  }
  return out;
}

const CREDENTIAL_ARG_PATTERNS = [/:\/\/[^/\s:@]+:[^/\s@]+@/, /^--?(api[-_]?key|token|password|secret|auth)[=]/i];
const CREDENTIAL_FLAG_PATTERN = /^--?(api[-_]?key|token|password|secret|auth|access[-_]?token)$/i;

/** Mask credential-looking command arguments for display. */
export function maskCredentialArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    if (CREDENTIAL_ARG_PATTERNS[0]!.test(arg)) return arg.replace(/(:\/\/[^/\s:@]+:)[^/\s@]+@/, "$1••••@");
    if (CREDENTIAL_ARG_PATTERNS[1]!.test(arg)) return arg.replace(/=.*/, "=••••");
    if (index > 0 && CREDENTIAL_FLAG_PATTERN.test(args[index - 1]!) && !findPlaceholders(arg).length) return "••••";
    return arg;
  });
}

function hasCredentialArg(args: string[]): boolean {
  return args.some(
    (arg, index) =>
      CREDENTIAL_ARG_PATTERNS.some((pattern) => pattern.test(arg)) ||
      (index > 0 && CREDENTIAL_FLAG_PATTERN.test(args[index - 1]!) && !findPlaceholders(arg).length)
  );
}

// ---------------------------------------------------------------------------
// Entry conversion
// ---------------------------------------------------------------------------

const HANDLED_FIELDS = new Set([
  "type",
  "transport",
  "command",
  "args",
  "env",
  "environment",
  "cwd",
  "url",
  "serverUrl",
  "httpUrl",
  "endpoint",
  "headers",
  "timeout",
  "disabled",
  "enabled",
  "description",
  "source",
  "settings"
]);

const UNSUPPORTED_FIELD_MESSAGES: Record<string, string> = {
  autoApprove: "Tool auto-approval is not imported; L2M decides tool access through tool policies (Policies tab).",
  alwaysAllow: "Tool auto-approval is not imported; L2M decides tool access through tool policies (Policies tab).",
  trust: "Trust settings are not imported; use tool policies and read-only classification instead.",
  includeTools: "Tool filters are not imported; express them as tool policy rules for this server.",
  excludeTools: "Tool filters are not imported; express them as tool policy rules for this server.",
  tools: "Tool filters are not imported; express them as tool policy rules for this server.",
  envFile: "Env files are read on the client machine; add the values as env vars or secrets after import.",
  oauth: "OAuth sign-in is not imported; configure authentication on the registered server.",
  auth: "Client-side auth settings are not imported; configure authentication on the registered server.",
  dev: "Development watch settings have no equivalent in L2M.",
  gallery: "Gallery metadata is not used by L2M.",
  version: "The entry's version marker is not used; pin versions in the command arguments instead."
};

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return raw.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function sameArgs(left: unknown, right: unknown): boolean {
  const a = Array.isArray(left) ? left.map(String) : [];
  const b = Array.isArray(right) ? right.map(String) : [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function findDuplicateServer(
  adapterId: string,
  connection: Record<string, unknown>,
  existing: ExistingServerRef[]
): McpImportDuplicate | null {
  for (const server of existing) {
    if (server.adapterId !== adapterId) continue;
    if (adapterId === "stdio_mcp") {
      if (
        String(server.connection.command ?? "").trim() === String(connection.command ?? "").trim() &&
        sameArgs(server.connection.args, connection.args)
      ) {
        return { serverId: server.id, serverName: server.name, match: "command" };
      }
    } else if (
      typeof server.connection.endpoint === "string" &&
      typeof connection.endpoint === "string" &&
      normalizeUrl(server.connection.endpoint) === normalizeUrl(connection.endpoint)
    ) {
      return { serverId: server.id, serverName: server.name, match: "url" };
    }
  }
  return null;
}

function uniqueName(base: string, taken: Set<string>): string {
  const trimmed = base.trim().slice(0, 100) || "Imported server";
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? `${trimmed} (imported)` : `${trimmed} (imported ${index})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${trimmed} (${Date.now()})`;
}

interface Transport {
  kind: "stdio" | "http" | "sse" | null;
  command?: string;
  args: string[];
  url?: string;
  approximations: McpImportReportItem[];
}

function readTransport(raw: Record<string, unknown>): Transport {
  const approximations: McpImportReportItem[] = [];
  const type = String(raw.type ?? raw.transport ?? "").trim().toLowerCase().replace(/[_-]/g, "");
  let command: string | undefined;
  let args: string[] = Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : [];
  if (typeof raw.command === "string" && raw.command.trim()) {
    command = raw.command.trim();
  } else if (Array.isArray(raw.command) && raw.command.length > 0) {
    const parts = raw.command.map((part) => String(part));
    command = parts[0];
    args = [...parts.slice(1), ...args];
  } else if (isRecord(raw.command) && typeof raw.command.path === "string") {
    command = raw.command.path;
    if (Array.isArray(raw.command.args)) args = raw.command.args.map((arg) => String(arg));
  }
  // A shell one-liner in `command` ("npx -y pkg") with no args list.
  if (command && args.length === 0 && /\s/.test(command) && !/^["']/.test(command) && !/^[A-Za-z]:\\/.test(command)) {
    const parts = command.split(/\s+/).filter(Boolean);
    command = parts[0];
    args = parts.slice(1);
    approximations.push({
      field: "command",
      status: "approximated",
      message: "The command string was split on spaces into a command and arguments; check quoting."
    });
  }
  const httpUrl = typeof raw.httpUrl === "string" ? raw.httpUrl : undefined;
  const url =
    httpUrl ??
    (typeof raw.url === "string" ? raw.url : undefined) ??
    (typeof raw.serverUrl === "string" ? raw.serverUrl : undefined) ??
    (typeof raw.endpoint === "string" ? raw.endpoint : undefined);

  let kind: Transport["kind"] = null;
  if (type === "stdio" || type === "local") kind = "stdio";
  else if (type === "sse") kind = "sse";
  else if (["http", "streamablehttp", "streamable", "remote", "httpstreamable"].includes(type)) kind = "http";
  else if (command) kind = "stdio";
  else if (url) kind = httpUrl ? "http" : /\/sse\/?(\?|$)/i.test(url) ? "sse" : "http";

  if (kind === "stdio" && !command) kind = url ? "http" : null;
  if ((kind === "http" || kind === "sse") && !url) kind = command ? "stdio" : null;
  return { kind, command, args, url, approximations };
}

/** One env var or header: plain, or a slot. */
function classifyValue(
  target: "env" | "header",
  name: string,
  value: string,
  inputs: Map<string, InputDefinition>,
  report: McpImportReportItem[]
): { plain: string } | { slot: SlotPlan } | { skip: true } {
  const field = `${target === "env" ? "env" : "headers"}.${name}`;
  const placeholders = findPlaceholders(value);
  const dynamic = placeholders.filter((entry) => entry.kind !== "client");
  const clientVars = placeholders.filter((entry) => entry.kind === "client");
  const secretByName = isSecretName(name);

  if (dynamic.length > 1) {
    report.push({
      field,
      status: "skipped",
      message: `The value combines ${dynamic.length} placeholders; L2M cannot fill more than one per value. Add it on the server after import.`
    });
    return { skip: true };
  }

  if (dynamic.length === 1) {
    const placeholder = dynamic[0]!;
    const prefix = value.slice(0, placeholder.start);
    const suffix = value.slice(placeholder.end);
    if (placeholder.kind === "input") {
      const input = inputs.get(placeholder.id);
      const kind = input?.password || secretByName ? "secret" : "prompt";
      report.push({
        field,
        status: "mapped",
        message:
          kind === "secret"
            ? `Prompted value ${placeholder.raw} becomes a secret; enter it below.`
            : `Prompted value ${placeholder.raw} is asked for now and kept in the connection.`
      });
      if (!input) {
        report.push({
          field,
          status: "approximated",
          message: `The file declares no input '${placeholder.id}'; it is treated as ${kind === "secret" ? "a secret" : "a plain value"}.`
        });
      }
      return {
        slot: {
          slot: {
            id: `${target}:${name}`,
            kind,
            target,
            name,
            origin: "input",
            inputId: placeholder.id,
            ...(input?.description ? { description: input.description } : {}),
            ...(input?.options?.length ? { options: input.options } : {}),
            ...(kind === "prompt" && input?.defaultValue !== undefined ? { defaultValue: input.defaultValue } : {}),
            needsValue: true,
            provided: false
          },
          prefix,
          suffix
        }
      };
    }
    const placeholderName = placeholder.kind === "env" ? placeholder.name : "";
    const kind = secretByName || isSecretName(placeholderName) ? "secret" : "prompt";
    report.push({
      field,
      status: "mapped",
      message: `Reference to ${placeholderName} on the client machine; enter its value below${kind === "secret" ? " (stored as a secret)" : ""}.`
    });
    return {
      slot: {
        slot: {
          id: `${target}:${name}`,
          kind,
          target,
          name,
          origin: "env_ref",
          envRef: placeholderName,
          needsValue: true,
          provided: false
        },
        prefix,
        suffix
      }
    };
  }

  if (clientVars.length > 0) {
    report.push({
      field,
      status: "approximated",
      message: `${clientVars.map((entry) => entry.raw).join(", ")} is expanded by the client on its own machine; kept verbatim, adjust it for the L2M host.`
    });
  }

  if (secretByName && value.trim()) {
    report.push({ field, status: "mapped", message: "Credential moved to a secret; the value is not kept in the connection." });
    return {
      slot: {
        slot: { id: `${target}:${name}`, kind: "secret", target, name, origin: "literal", needsValue: false, provided: false },
        literal: value,
        prefix: "",
        suffix: ""
      }
    };
  }
  if (clientVars.length === 0) {
    report.push({ field, status: "mapped", message: "Kept in the connection." });
  }
  return { plain: value };
}

function reportStringPlaceholders(field: string, value: string, inputs: Map<string, InputDefinition>, report: McpImportReportItem[]) {
  for (const placeholder of findPlaceholders(value)) {
    if (placeholder.kind === "client") {
      report.push({
        field,
        status: "approximated",
        message: `${placeholder.raw} is expanded by the client on its own machine; kept verbatim, adjust it for the L2M host.`
      });
    } else if (placeholder.kind === "input" && inputs.get(placeholder.id)?.password) {
      report.push({
        field,
        status: "approximated",
        message: `${placeholder.raw} is a secret in ${field}; L2M stores secrets only as env vars or headers. Replace it after import, ideally by passing the secret through an env var.`
      });
    } else {
      report.push({
        field,
        status: "approximated",
        message: `${placeholder.raw} is left verbatim in ${field}; replace it with a value after import.`
      });
    }
  }
}

/** Single secret wiring is enough: stdio with one env secret, http with one bearer Authorization header. */
function secretModeFor(adapterId: "stdio_mcp" | "http_mcp", slots: SlotPlan[]): "none" | "single" | "bundle" {
  const secrets = slots.filter((entry) => entry.slot.kind === "secret");
  if (secrets.length === 0) return "none";
  if (secrets.length > 1) return "bundle";
  const only = secrets[0]!;
  if (adapterId === "stdio_mcp") return "single";
  return only.slot.name.toLowerCase() === "authorization" && isBearerShaped(only) ? "single" : "bundle";
}

function isBearerShaped(entry: SlotPlan): boolean {
  if (entry.literal !== undefined) return /^bearer\s+\S/i.test(entry.literal);
  return /^bearer\s+$/i.test(entry.prefix) && entry.suffix === "";
}

function convertEntry(
  raw: RawEntry,
  inputs: Map<string, InputDefinition>
): Omit<PlannedImportEntry, "view"> & {
  view: Omit<McpImportEntryView, "duplicate" | "decision" | "blockedReason" | "name"> & { blockedReason: string | null };
} {
  const report: McpImportReportItem[] = [];
  const value = raw.value;
  const transport = readTransport(value);
  report.push(...transport.approximations);
  const slots: SlotPlan[] = [];
  const disabled = value.disabled === true || value.enabled === false;

  for (const field of Object.keys(value)) {
    if (HANDLED_FIELDS.has(field)) continue;
    report.push({
      field,
      status: "skipped",
      message: UNSUPPORTED_FIELD_MESSAGES[field] ?? `'${field}' has no equivalent in the L2M registry and is not imported.`
    });
  }
  if (isRecord(value.settings) && Object.keys(value.settings).length > 0) {
    report.push({ field: "settings", status: "skipped", message: "Server-specific settings blocks are not imported." });
  }

  if (!transport.kind) {
    report.push({ field: "command", status: "skipped", message: "The entry has neither a command nor a URL." });
    return {
      slots,
      baseConnection: {},
      view: {
        key: raw.key,
        adapterId: "stdio_mcp",
        transport: "stdio",
        connection: {},
        secretMode: "none",
        slots: [],
        report,
        status: "skipped",
        disabledInSource: disabled,
        blockedReason: "The entry has neither a command nor a URL, so there is nothing to register."
      }
    };
  }

  const timeoutRaw = typeof value.timeout === "number" ? value.timeout : Number.NaN;
  let timeoutMs: number | undefined;
  if (Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    if (timeoutRaw >= 1000) {
      timeoutMs = Math.floor(timeoutRaw);
      report.push({ field: "timeout", status: "mapped", message: `Timeout ${timeoutMs} ms.` });
    } else {
      timeoutMs = Math.floor(timeoutRaw * 1000);
      report.push({ field: "timeout", status: "approximated", message: `Read ${timeoutRaw} as seconds (${timeoutMs} ms).` });
    }
  }

  if (disabled) {
    report.push({
      field: value.disabled === true ? "disabled" : "enabled",
      status: "approximated",
      message: "The server is turned off in the file; it is imported with probing off."
    });
  }

  let adapterId: "stdio_mcp" | "http_mcp";
  const connection: Record<string, unknown> = {};
  let displayConnection: Record<string, unknown>;

  if (transport.kind === "stdio") {
    adapterId = "stdio_mcp";
    connection.command = transport.command;
    connection.args = transport.args;
    report.push({ field: "command", status: "mapped", message: [transport.command, ...maskCredentialArgs(transport.args)].join(" ") });
    reportStringPlaceholders("command", transport.command ?? "", inputs, report);
    transport.args.forEach((arg, index) => reportStringPlaceholders(`args[${index}]`, arg, inputs, report));
    if (hasCredentialArg(transport.args)) {
      report.push({
        field: "args",
        status: "approximated",
        message: "An argument looks like a credential. It stays in the plain connection; move it to an env var so it can be a secret."
      });
    }
    const env: Record<string, string> = {};
    const rawEnv = stringRecord(value.env ?? value.environment);
    for (const [name, envValue] of Object.entries(rawEnv)) {
      const classified = classifyValue("env", name, envValue, inputs, report);
      if ("plain" in classified) env[name] = classified.plain;
      else if ("slot" in classified) slots.push(classified.slot);
    }
    if (Object.keys(env).length > 0) connection.env = env;
    const cwd = typeof value.cwd === "string" ? value.cwd : isRecord(value.command) && typeof value.command.cwd === "string" ? value.command.cwd : undefined;
    if (cwd) {
      connection.cwd = cwd;
      report.push({ field: "cwd", status: "mapped", message: "Working directory kept; it must exist on the L2M host." });
      reportStringPlaceholders("cwd", cwd, inputs, report);
    }
    if (isRecord(value.headers) && Object.keys(value.headers).length > 0) {
      report.push({ field: "headers", status: "skipped", message: "Headers apply to remote servers only." });
    }
    displayConnection = { ...connection, args: maskCredentialArgs(transport.args) };
  } else {
    adapterId = "http_mcp";
    connection.endpoint = transport.url;
    connection.transport = "http_streamable";
    report.push({ field: "url", status: "mapped", message: transport.url ?? "" });
    reportStringPlaceholders("url", transport.url ?? "", inputs, report);
    if (transport.kind === "sse") {
      report.push({
        field: "type",
        status: "approximated",
        message: "Registered as Streamable HTTP. A server that only offers the legacy SSE transport fails its first probe; point it at the server's Streamable HTTP endpoint."
      });
    }
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(stringRecord(value.headers))) {
      const classified = classifyValue("header", name, headerValue, inputs, report);
      if ("plain" in classified) headers[name] = classified.plain;
      else if ("slot" in classified) slots.push(classified.slot);
    }
    if (Object.keys(headers).length > 0) connection.headers = headers;
    if (isRecord(value.env ?? value.environment) && Object.keys(value.env ?? value.environment ?? {}).length > 0) {
      report.push({ field: "env", status: "skipped", message: "Env vars apply to local (stdio) servers only." });
    }
    if (Array.isArray(value.args) && value.args.length > 0) {
      report.push({ field: "args", status: "skipped", message: "Arguments apply to local (stdio) servers only." });
    }
    displayConnection = { ...connection };
  }
  if (timeoutMs !== undefined) {
    connection.timeoutMs = timeoutMs;
    displayConnection.timeoutMs = timeoutMs;
  }

  const secretMode = secretModeFor(adapterId, slots);
  if (secretMode === "bundle") {
    const names = slots.filter((entry) => entry.slot.kind === "secret").map((entry) => entry.slot.name);
    report.push({
      field: adapterId === "stdio_mcp" ? "env" : "headers",
      status: "mapped",
      message: `${names.length} credential${names.length === 1 ? "" : "s"} (${names.join(", ")}) are stored together as one secret bundle.`
    });
    displayConnection[adapterId === "stdio_mcp" ? "secretEnvVars" : "secretHeaders"] = names;
  } else if (secretMode === "single") {
    const only = slots.find((entry) => entry.slot.kind === "secret")!;
    if (adapterId === "stdio_mcp") displayConnection.secretEnvVar = only.slot.name;
    else displayConnection.authType = "bearer";
  }

  const status: McpImportItemStatus = report.some((item) => item.status !== "mapped") ? "approximated" : "mapped";
  return {
    slots,
    baseConnection: connection,
    view: {
      key: raw.key,
      adapterId,
      transport: transport.kind,
      connection: displayConnection,
      secretMode,
      slots: slots.map((entry) => entry.slot),
      report,
      status,
      disabledInSource: disabled,
      blockedReason: null
    }
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface McpImportEntryOptions {
  decision?: McpImportDecision;
  name?: string;
  values?: Record<string, string>;
}

export interface PlanOptions {
  existing: ExistingServerRef[];
  entries?: Record<string, McpImportEntryOptions>;
  /** Returns why a stdio command may not be registered (catalog enforcement), or null. */
  checkStdioCommand?: (command: string, args: string[]) => string | null;
}

export function planMcpConfigImport(parsed: ParsedMcpClientConfig, options: PlanOptions): McpImportPlan {
  const warnings = [...parsed.warnings];
  const taken = new Set(options.existing.map((server) => server.name.toLowerCase()));
  const entries: PlannedImportEntry[] = [];
  if (parsed.entries.length === 0) warnings.push("The file lists no servers.");

  for (const raw of parsed.entries) {
    const converted = convertEntry(raw, parsed.inputs);
    const requested = options.entries?.[raw.key] ?? {};
    const duplicate =
      converted.view.status === "skipped" ? null : findDuplicateServer(converted.view.adapterId, converted.baseConnection, options.existing);
    let decision: McpImportDecision = requested.decision ?? (duplicate ? "skip" : "create");
    if (converted.view.status === "skipped") decision = "skip";
    if (decision === "update" && !duplicate) {
      decision = "create";
      warnings.push(`'${raw.key}' matches no registered server, so it is created instead of updated.`);
    }
    const values = requested.values ?? {};
    const slots = converted.slots.map((entry) => ({
      ...entry,
      slot: { ...entry.slot, provided: typeof values[entry.slot.id] === "string" && values[entry.slot.id]!.length > 0 }
    }));

    const baseName = requested.name?.trim() || raw.key;
    let name: string;
    if (decision === "update" && duplicate) {
      name = duplicate.serverName;
    } else if (decision === "copy" || (decision === "create" && taken.has(baseName.toLowerCase()))) {
      name = uniqueName(baseName, taken);
    } else {
      name = baseName.slice(0, 120);
    }
    if (decision === "create" || decision === "copy") taken.add(name.toLowerCase());

    let blockedReason = converted.view.blockedReason;
    if (!blockedReason && decision !== "skip" && converted.view.adapterId === "stdio_mcp" && options.checkStdioCommand) {
      blockedReason = options.checkStdioCommand(
        String(converted.baseConnection.command ?? ""),
        Array.isArray(converted.baseConnection.args) ? converted.baseConnection.args.map(String) : []
      );
    }
    if (!blockedReason && decision !== "skip") {
      const missing = slots.filter((entry) => entry.slot.needsValue && !entry.slot.provided).map((entry) => entry.slot.name);
      if (missing.length > 0) blockedReason = `Values needed: ${missing.join(", ")}.`;
    }

    entries.push({
      slots,
      baseConnection: converted.baseConnection,
      view: {
        ...converted.view,
        name,
        slots: slots.map((entry) => entry.slot),
        duplicate,
        decision,
        blockedReason
      }
    });
  }
  return { format: parsed.format, entries, warnings };
}

/** Turn a planned entry plus the user's values into a stored connection and its one secret. */
export function materializeImportEntry(entry: PlannedImportEntry, values: Record<string, string> = {}): MaterializedEntry {
  const connection: Record<string, unknown> = JSON.parse(JSON.stringify(entry.baseConnection)) as Record<string, unknown>;
  const missing: string[] = [];
  const secrets: Array<{ slot: McpImportValueSlot; value: string }> = [];
  for (const plan of entry.slots) {
    const supplied = values[plan.slot.id];
    const core = typeof supplied === "string" && supplied.length > 0 ? supplied : plan.literal;
    if (core === undefined) {
      missing.push(plan.slot.name);
      continue;
    }
    const full = plan.literal !== undefined && core === plan.literal ? core : `${plan.prefix}${core}${plan.suffix}`;
    if (plan.slot.kind === "prompt") {
      const key = plan.slot.target === "env" ? "env" : "headers";
      connection[key] = { ...((connection[key] as Record<string, string> | undefined) ?? {}), [plan.slot.name]: full };
    } else {
      secrets.push({ slot: plan.slot, value: full });
    }
  }
  if (secrets.length === 0) return { connection, secret: null, missing };
  const mode = entry.view.secretMode;
  const names = secrets.map((entry) => entry.slot.name);
  if (mode === "single" && secrets.length === 1) {
    const only = secrets[0]!;
    if (entry.view.adapterId === "stdio_mcp") {
      connection.secretEnvVar = only.slot.name;
      return { connection, secret: { value: only.value, names }, missing };
    }
    connection.authType = "bearer";
    return { connection, secret: { value: only.value.replace(/^bearer\s+/i, ""), names }, missing };
  }
  const bundle: Record<string, string> = {};
  for (const secret of secrets) bundle[secret.slot.name] = secret.value;
  connection[entry.view.adapterId === "stdio_mcp" ? "secretEnvVars" : "secretHeaders"] = names;
  return { connection, secret: { value: JSON.stringify(bundle), names }, missing };
}

export function summarizeImportEntries(entries: McpImportEntryView[]) {
  const count = (predicate: (entry: McpImportEntryView) => boolean) => entries.filter(predicate).length;
  return {
    total: entries.length,
    mapped: count((entry) => entry.status === "mapped"),
    approximated: count((entry) => entry.status === "approximated"),
    skipped: count((entry) => entry.status === "skipped"),
    create: count((entry) => entry.decision === "create" && !entry.blockedReason),
    update: count((entry) => entry.decision === "update" && !entry.blockedReason),
    copy: count((entry) => entry.decision === "copy" && !entry.blockedReason),
    skip: count((entry) => entry.decision === "skip"),
    blocked: count((entry) => entry.decision !== "skip" && Boolean(entry.blockedReason))
  };
}
