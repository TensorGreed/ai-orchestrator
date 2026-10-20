import type {
  McpElicitationPropertySchema,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationSchema,
  McpListChangedKind,
  McpPrompt,
  McpPromptArgument,
  McpPromptContent,
  McpPromptGetResult,
  McpPromptMessage,
  McpResource,
  McpResourceAnnotations,
  McpResourceContent,
  McpResourceReadResult,
  McpResourceTemplate,
  McpSamplingMessage,
  McpSamplingRequest,
  McpSamplingResult,
  McpServerCapabilities
} from "@ai-orchestrator/shared";
import type { MCPExecutionContext, McpServerRequestOrigin } from "./types";

/**
 * Phase 10.5 — client-side pieces shared by the HTTP and stdio adapters for
 * the parts of MCP beyond tools: the client capabilities L2M advertises,
 * resources and prompts normalization, `list_changed` notifications, and the
 * server-initiated requests `elicitation/create` and `sampling/createMessage`.
 */

/** Default decoded size limit for `resources/read` (5 MiB). */
export const DEFAULT_RESOURCE_MAX_BYTES = 5 * 1024 * 1024;

/** How many pages of a paginated list are followed before giving up. */
export const MAX_LIST_PAGES = 20;

/** JSON-RPC error codes used for refused server requests. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
/** Implementation-defined: the request was understood but is not allowed for this call. */
export const JSON_RPC_REQUEST_REFUSED = -32001;

/**
 * Property names that look like credentials. Elicitation schemas with such a
 * property are refused: answers travel through traces and audit rows, which
 * must never carry a secret. Mirrors the heuristic the config import uses.
 */
export const CREDENTIAL_NAME_PATTERN = /(token|key|secret|passw|pwd|auth|credential|cookie|(^|[-_])pat($|[-_]))/i;

export function isCredentialLikeName(name: string): boolean {
  return CREDENTIAL_NAME_PATTERN.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, max = 4000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

/** The `capabilities` L2M sends in `initialize` for a context. */
export function buildClientCapabilities(context: Partial<Pick<MCPExecutionContext, "onSampling">>): Record<string, unknown> {
  return {
    elicitation: {},
    ...(context.onSampling ? { sampling: {} } : {})
  };
}

export function normalizeServerCapabilities(raw: unknown): McpServerCapabilities {
  const record = isRecord(raw) ? raw : {};
  const out: McpServerCapabilities = {};
  const flag = (value: unknown, key: string): boolean | undefined =>
    isRecord(value) && typeof value[key] === "boolean" ? (value[key] as boolean) : undefined;
  if (isRecord(record.tools)) {
    const listChanged = flag(record.tools, "listChanged");
    out.tools = listChanged === undefined ? {} : { listChanged };
  }
  if (isRecord(record.resources)) {
    const subscribe = flag(record.resources, "subscribe");
    const listChanged = flag(record.resources, "listChanged");
    out.resources = { ...(subscribe === undefined ? {} : { subscribe }), ...(listChanged === undefined ? {} : { listChanged }) };
  }
  if (isRecord(record.prompts)) {
    const listChanged = flag(record.prompts, "listChanged");
    out.prompts = listChanged === undefined ? {} : { listChanged };
  }
  if (isRecord(record.logging)) out.logging = {};
  if (isRecord(record.completions)) out.completions = {};
  return out;
}

const LIST_CHANGED_METHODS: Record<string, McpListChangedKind> = {
  "notifications/tools/list_changed": "tools",
  "notifications/resources/list_changed": "resources",
  "notifications/prompts/list_changed": "prompts"
};

/** The kind of a `notifications/<kind>/list_changed` message, or null when `message` is not one. */
export function parseListChangedNotification(message: unknown): McpListChangedKind | null {
  if (!isRecord(message) || typeof message.method !== "string" || "id" in message) return null;
  return LIST_CHANGED_METHODS[message.method] ?? null;
}

// Resources -----------------------------------------------------------------

function normalizeResourceAnnotations(raw: unknown): McpResourceAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const out: McpResourceAnnotations = {};
  if (Array.isArray(raw.audience)) {
    const audience = raw.audience.filter((entry): entry is "user" | "assistant" => entry === "user" || entry === "assistant");
    if (audience.length > 0) out.audience = audience;
  }
  if (typeof raw.priority === "number" && Number.isFinite(raw.priority)) out.priority = raw.priority;
  if (typeof raw.lastModified === "string") out.lastModified = raw.lastModified;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeResources(raw: unknown): McpResource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .filter((item) => typeof item.uri === "string" && item.uri.trim())
    .map((item) => {
      const uri = String(item.uri);
      const title = optionalString(item.title, 500);
      const description = optionalString(item.description, 4000);
      const mimeType = optionalString(item.mimeType, 200);
      const annotations = normalizeResourceAnnotations(item.annotations);
      return {
        uri,
        name: optionalString(item.name, 500) ?? uri,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0 ? { size: Math.floor(item.size) } : {}),
        ...(annotations ? { annotations } : {})
      };
    });
}

export function normalizeResourceTemplates(raw: unknown): McpResourceTemplate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .filter((item) => typeof item.uriTemplate === "string" && item.uriTemplate.trim())
    .map((item) => {
      const uriTemplate = String(item.uriTemplate);
      const title = optionalString(item.title, 500);
      const description = optionalString(item.description, 4000);
      const mimeType = optionalString(item.mimeType, 200);
      const annotations = normalizeResourceAnnotations(item.annotations);
      return {
        uriTemplate,
        name: optionalString(item.name, 500) ?? uriTemplate,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(annotations ? { annotations } : {})
      };
    });
}

/** Decoded byte size of one content item (UTF-8 for text, base64 for blobs). */
export function resourceContentBytes(content: McpResourceContent): number {
  if ("text" in content) return Buffer.byteLength(content.text, "utf-8");
  const blob = content.blob.replace(/\s+/g, "");
  const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((blob.length * 3) / 4) - padding);
}

/**
 * Normalize a `resources/read` result and enforce the size limit. Items
 * without text or blob are dropped; a result over the limit throws.
 */
export function normalizeResourceReadResult(uri: string, raw: unknown, maxBytes = DEFAULT_RESOURCE_MAX_BYTES): McpResourceReadResult {
  const record = isRecord(raw) ? raw : {};
  const items = Array.isArray(record.contents) ? record.contents : [];
  const contents: McpResourceContent[] = [];
  let bytes = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const itemUri = typeof item.uri === "string" && item.uri ? item.uri : uri;
    const mimeType = optionalString(item.mimeType, 200);
    let content: McpResourceContent;
    if (typeof item.text === "string") {
      content = { uri: itemUri, ...(mimeType ? { mimeType } : {}), text: item.text };
    } else if (typeof item.blob === "string") {
      content = { uri: itemUri, ...(mimeType ? { mimeType } : {}), blob: item.blob };
    } else {
      continue;
    }
    bytes += resourceContentBytes(content);
    if (bytes > maxBytes) {
      throw new Error(`Resource '${uri}' is larger than the ${formatBytes(maxBytes)} read limit.`);
    }
    contents.push(content);
  }
  return { uri, contents, bytes };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
  return `${bytes} B`;
}

// Prompts -------------------------------------------------------------------

function normalizePromptArguments(raw: unknown): McpPromptArgument[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter(isRecord)
    .filter((item) => typeof item.name === "string" && item.name.trim())
    .map((item) => {
      const title = optionalString(item.title, 500);
      const description = optionalString(item.description, 4000);
      return {
        name: String(item.name),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(item.required === true ? { required: true } : {})
      };
    });
  return out.length > 0 ? out : undefined;
}

export function normalizePrompts(raw: unknown): McpPrompt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .filter((item) => typeof item.name === "string" && item.name.trim())
    .map((item) => {
      const title = optionalString(item.title, 500);
      const description = optionalString(item.description, 4000);
      const args = normalizePromptArguments(item.arguments);
      return {
        name: String(item.name),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(args ? { arguments: args } : {})
      };
    });
}

function normalizePromptContent(raw: unknown): McpPromptContent | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "text" && typeof raw.text === "string") return { type: "text", text: raw.text };
  if ((raw.type === "image" || raw.type === "audio") && typeof raw.data === "string" && typeof raw.mimeType === "string") {
    return { type: raw.type, data: raw.data, mimeType: raw.mimeType };
  }
  if (raw.type === "resource" && isRecord(raw.resource) && typeof raw.resource.uri === "string") {
    const resource = raw.resource;
    const uri = String(resource.uri);
    const mimeType = optionalString(resource.mimeType, 200);
    if (typeof resource.text === "string") {
      return { type: "resource", resource: { uri, ...(mimeType ? { mimeType } : {}), text: resource.text } };
    }
    if (typeof resource.blob === "string") {
      return { type: "resource", resource: { uri, ...(mimeType ? { mimeType } : {}), blob: resource.blob } };
    }
    return null;
  }
  if (raw.type === "resource_link" && typeof raw.uri === "string") {
    const name = optionalString(raw.name, 500);
    const mimeType = optionalString(raw.mimeType, 200);
    return { type: "resource_link", uri: raw.uri, ...(name ? { name } : {}), ...(mimeType ? { mimeType } : {}) };
  }
  return null;
}

export function normalizePromptGetResult(name: string, raw: unknown): McpPromptGetResult {
  const record = isRecord(raw) ? raw : {};
  const messages: McpPromptMessage[] = [];
  for (const item of Array.isArray(record.messages) ? record.messages : []) {
    if (!isRecord(item)) continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const content = normalizePromptContent(item.content);
    if (content) messages.push({ role, content });
  }
  const description = optionalString(record.description, 4000);
  return { name, ...(description ? { description } : {}), messages };
}

/**
 * The text of a prompt's messages, for use as a system or user prompt. User
 * text is taken as is; assistant turns and non-text parts are labelled so
 * the model can tell them apart.
 */
export function promptMessagesToText(messages: McpPromptMessage[]): string {
  const parts: string[] = [];
  const hasAssistant = messages.some((message) => message.role === "assistant");
  for (const message of messages) {
    const content = message.content;
    let text: string;
    if (content.type === "text") text = content.text;
    else if (content.type === "resource") text = "text" in content.resource ? content.resource.text : `[binary resource ${content.resource.uri}]`;
    else if (content.type === "resource_link") text = `[resource ${content.uri}]`;
    else text = `[${content.type} ${content.mimeType}]`;
    parts.push(hasAssistant ? `${message.role === "assistant" ? "Assistant" : "User"}: ${text}` : text);
  }
  return parts.join("\n\n");
}

// Elicitation ---------------------------------------------------------------

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);
const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);
const MAX_ELICITATION_PROPERTIES = 30;

function normalizeElicitationProperty(name: string, raw: unknown): McpElicitationPropertySchema {
  if (!isRecord(raw)) throw new Error(`Elicitation property '${name}' must be an object schema.`);
  const type = raw.type;
  if (typeof type !== "string" || !PRIMITIVE_TYPES.has(type)) {
    throw new Error(`Elicitation property '${name}' must be a string, number, integer or boolean; nested schemas are not allowed.`);
  }
  const out: McpElicitationPropertySchema = { type: type as McpElicitationPropertySchema["type"] };
  const title = optionalString(raw.title, 200);
  const description = optionalString(raw.description, 2000);
  if (title) out.title = title;
  if (description) out.description = description;
  if (type === "string") {
    if (typeof raw.format === "string" && STRING_FORMATS.has(raw.format)) out.format = raw.format as McpElicitationPropertySchema["format"];
    if (Array.isArray(raw.enum)) {
      const values = raw.enum.filter((entry): entry is string => typeof entry === "string");
      if (values.length > 0) out.enum = values;
      if (Array.isArray(raw.enumNames)) {
        const names = raw.enumNames.filter((entry): entry is string => typeof entry === "string");
        if (names.length === values.length) out.enumNames = names;
      }
    }
    if (typeof raw.minLength === "number") out.minLength = raw.minLength;
    if (typeof raw.maxLength === "number") out.maxLength = raw.maxLength;
    if (typeof raw.default === "string") out.default = raw.default;
  } else if (type === "boolean") {
    if (typeof raw.default === "boolean") out.default = raw.default;
  } else {
    if (typeof raw.minimum === "number") out.minimum = raw.minimum;
    if (typeof raw.maximum === "number") out.maximum = raw.maximum;
    if (typeof raw.default === "number") out.default = raw.default;
  }
  return out;
}

/**
 * Validate `elicitation/create` params against what the spec allows: a flat
 * object of primitive properties. Property names that look like credentials
 * are refused, so a server cannot collect secrets through the form.
 */
export function validateElicitationRequest(params: unknown): McpElicitationRequest {
  if (!isRecord(params)) throw new Error("elicitation/create params must be an object.");
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new Error("elicitation/create needs a message.");
  const schema = params.requestedSchema;
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    throw new Error("elicitation/create needs a requestedSchema of type object with properties.");
  }
  const names = Object.keys(schema.properties);
  if (names.length === 0) throw new Error("elicitation/create requestedSchema has no properties.");
  if (names.length > MAX_ELICITATION_PROPERTIES) {
    throw new Error(`elicitation/create requestedSchema has more than ${MAX_ELICITATION_PROPERTIES} properties.`);
  }
  const credentialLike = names.filter(isCredentialLikeName);
  if (credentialLike.length > 0) {
    throw new Error(
      `Elicitation refused: the requested fields look like credentials (${credentialLike.join(", ")}). Secrets are never collected through elicitation; store them as secrets on the server instead.`
    );
  }
  const properties: McpElicitationSchema["properties"] = {};
  for (const name of names) properties[name] = normalizeElicitationProperty(name, schema.properties[name]);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string" && entry in properties)
    : [];
  return {
    message: message.slice(0, 4000),
    requestedSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) }
  };
}

/** Field-level problems of an accepted elicitation answer; empty when it is valid. */
export function validateElicitationContent(
  schema: McpElicitationSchema,
  content: unknown
): { errors: Record<string, string>; content: Record<string, string | number | boolean> } {
  const errors: Record<string, string> = {};
  const out: Record<string, string | number | boolean> = {};
  const record = isRecord(content) ? content : {};
  const required = new Set(schema.required ?? []);
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = record[name];
    const missing = value === undefined || value === null || value === "";
    if (missing) {
      if (required.has(name)) errors[name] = "Required";
      continue;
    }
    switch (property.type) {
      case "string": {
        if (typeof value !== "string") {
          errors[name] = "Must be text";
          break;
        }
        if (property.enum && !property.enum.includes(value)) errors[name] = "Pick one of the listed values";
        else if (property.minLength !== undefined && value.length < property.minLength) errors[name] = `At least ${property.minLength} characters`;
        else if (property.maxLength !== undefined && value.length > property.maxLength) errors[name] = `At most ${property.maxLength} characters`;
        else if (property.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[name] = "Must be an email address";
        else if (property.format === "uri" && !/^[a-z][a-z0-9+.-]*:/i.test(value)) errors[name] = "Must be a URI";
        else if (property.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors[name] = "Must be a date (YYYY-MM-DD)";
        else if (property.format === "date-time" && Number.isNaN(Date.parse(value))) errors[name] = "Must be a date and time";
        else out[name] = value;
        break;
      }
      case "boolean": {
        if (typeof value === "boolean") out[name] = value;
        else if (value === "true" || value === "false") out[name] = value === "true";
        else errors[name] = "Must be true or false";
        break;
      }
      case "number":
      case "integer": {
        const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
        if (!Number.isFinite(parsed)) errors[name] = "Must be a number";
        else if (property.type === "integer" && !Number.isInteger(parsed)) errors[name] = "Must be a whole number";
        else if (property.minimum !== undefined && parsed < property.minimum) errors[name] = `At least ${property.minimum}`;
        else if (property.maximum !== undefined && parsed > property.maximum) errors[name] = `At most ${property.maximum}`;
        else out[name] = parsed;
        break;
      }
    }
  }
  for (const name of Object.keys(record)) {
    if (!(name in schema.properties)) errors[name] = "Not part of the requested schema";
  }
  return { errors, content: out };
}

/** The result an unattended caller sends back: a decline, never an answer. */
export function declinedElicitation(): McpElicitationResult {
  return { action: "decline" };
}

// Sampling ------------------------------------------------------------------

const MAX_SAMPLING_MESSAGES = 50;
const MAX_SAMPLING_CHARS = 200_000;

function normalizeSamplingMessage(raw: unknown): McpSamplingMessage | null {
  if (!isRecord(raw)) return null;
  const role = raw.role === "assistant" ? "assistant" : raw.role === "user" ? "user" : null;
  if (!role || !isRecord(raw.content)) return null;
  const content = raw.content;
  if (content.type === "text" && typeof content.text === "string") return { role, content: { type: "text", text: content.text } };
  if ((content.type === "image" || content.type === "audio") && typeof content.data === "string" && typeof content.mimeType === "string") {
    return { role, content: { type: content.type, data: content.data, mimeType: content.mimeType } };
  }
  return null;
}

/** Validate `sampling/createMessage` params. */
export function validateSamplingRequest(params: unknown): McpSamplingRequest {
  if (!isRecord(params)) throw new Error("sampling/createMessage params must be an object.");
  const rawMessages = Array.isArray(params.messages) ? params.messages : [];
  const messages = rawMessages.map(normalizeSamplingMessage).filter((message): message is McpSamplingMessage => message !== null);
  if (messages.length === 0) throw new Error("sampling/createMessage needs at least one message.");
  if (messages.length > MAX_SAMPLING_MESSAGES) throw new Error(`sampling/createMessage has more than ${MAX_SAMPLING_MESSAGES} messages.`);
  const chars = messages.reduce((sum, message) => sum + (message.content.type === "text" ? message.content.text.length : message.content.data.length), 0);
  if (chars > MAX_SAMPLING_CHARS) throw new Error("sampling/createMessage prompt is too large.");
  const maxTokens = Number(params.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) throw new Error("sampling/createMessage needs a positive maxTokens.");
  const out: McpSamplingRequest = { messages, maxTokens: Math.floor(maxTokens) };
  if (isRecord(params.modelPreferences)) {
    const prefs = params.modelPreferences;
    const hints = Array.isArray(prefs.hints)
      ? prefs.hints.filter(isRecord).map((hint) => (typeof hint.name === "string" ? { name: hint.name } : {}))
      : undefined;
    out.modelPreferences = {
      ...(hints && hints.length > 0 ? { hints } : {}),
      ...(typeof prefs.costPriority === "number" ? { costPriority: prefs.costPriority } : {}),
      ...(typeof prefs.speedPriority === "number" ? { speedPriority: prefs.speedPriority } : {}),
      ...(typeof prefs.intelligencePriority === "number" ? { intelligencePriority: prefs.intelligencePriority } : {})
    };
  }
  if (typeof params.systemPrompt === "string" && params.systemPrompt.trim()) out.systemPrompt = params.systemPrompt.slice(0, MAX_SAMPLING_CHARS);
  if (typeof params.temperature === "number" && Number.isFinite(params.temperature)) out.temperature = params.temperature;
  if (Array.isArray(params.stopSequences)) {
    const stops = params.stopSequences.filter((entry): entry is string => typeof entry === "string");
    if (stops.length > 0) out.stopSequences = stops.slice(0, 10);
  }
  if (params.includeContext === "none" || params.includeContext === "thisServer" || params.includeContext === "allServers") {
    out.includeContext = params.includeContext;
  }
  if (isRecord(params.metadata)) out.metadata = params.metadata;
  return out;
}

/** Model names a sampling request asked for, in preference order. */
export function requestedSamplingModels(request: Pick<McpSamplingRequest, "modelPreferences">): string[] {
  return (request.modelPreferences?.hints ?? [])
    .map((hint) => (typeof hint.name === "string" ? hint.name.trim() : ""))
    .filter(Boolean);
}

// Server-initiated requests -------------------------------------------------

export interface JsonRpcServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

/** Thrown by `answerServerRequest` handlers to produce a JSON-RPC error with a specific code. */
export class McpServerRequestError extends Error {
  constructor(
    message: string,
    readonly code: number = JSON_RPC_REQUEST_REFUSED
  ) {
    super(message);
    this.name = "McpServerRequestError";
  }
}

export function isServerRequest(message: unknown): message is JsonRpcServerRequest {
  return (
    isRecord(message) &&
    typeof message.method === "string" &&
    (typeof message.id === "string" || typeof message.id === "number")
  );
}

/**
 * Build the JSON-RPC response to a request the server sent on a session:
 * `ping` is answered, `elicitation/create` and `sampling/createMessage` go
 * to the context handlers (declined / refused without one), everything else
 * is "method not found".
 */
export async function answerServerRequest(
  request: JsonRpcServerRequest,
  context: MCPExecutionContext,
  origin: McpServerRequestOrigin
): Promise<Record<string, unknown>> {
  const respond = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  try {
    switch (request.method) {
      case "ping":
        return respond({});
      case "elicitation/create": {
        let parsed: McpElicitationRequest;
        try {
          parsed = validateElicitationRequest(request.params);
        } catch (error) {
          return fail(JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : "Invalid elicitation request.");
        }
        if (!context.onElicitation) return respond(declinedElicitation());
        const result = await context.onElicitation(parsed, origin);
        return respond(result.action === "accept" ? { action: "accept", content: result.content ?? {} } : { action: result.action });
      }
      case "sampling/createMessage": {
        let parsed: McpSamplingRequest;
        try {
          parsed = validateSamplingRequest(request.params);
        } catch (error) {
          return fail(JSON_RPC_INVALID_PARAMS, error instanceof Error ? error.message : "Invalid sampling request.");
        }
        if (!context.onSampling) {
          return fail(JSON_RPC_REQUEST_REFUSED, "Sampling is not available for this call: no model is attached to it.");
        }
        const result: McpSamplingResult = await context.onSampling(parsed, origin);
        return respond({ role: "assistant", content: result.content, model: result.model, ...(result.stopReason ? { stopReason: result.stopReason } : {}) });
      }
      default:
        return fail(JSON_RPC_METHOD_NOT_FOUND, `Method not supported by this client: ${request.method}`);
    }
  } catch (error) {
    if (error instanceof McpServerRequestError) return fail(error.code, error.message);
    return fail(JSON_RPC_REQUEST_REFUSED, error instanceof Error ? error.message : "The request could not be answered.");
  }
}
