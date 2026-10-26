/**
 * Phase 16 — outbound checks outside the agent loop: destination rules on
 * model calls (prompt) and MCP Tool nodes (tool arguments), and the `egress`
 * checkpoint on HTTP Request, Web Browse and connector nodes (Slack, email
 * and the other senders included).
 *
 * Nothing here runs unless a profile in the run's resolved stack opts in:
 * destination rules for model and MCP calls, the egress channel or
 * destination rules for egress. The built-in default profile has neither, so
 * a zero-config run makes one cheap `mayUseLabels` check and nothing else:
 * no destination lookup, no scan, no verdict.
 *
 * What is checked is what leaves: the rendered URL (and its query values),
 * header values, the body or the connector's rendered settings. Secrets
 * are resolved by the handlers, after the check; a secret value that shows
 * up in the content anyway is scanned in place (so it cannot split a finding
 * around it) and a finding entirely inside it is not counted. Destinations are resolved per run from the deployment's rows and
 * the built-ins (`resolveDestinationRefs`); an unknown host is public.
 *
 * In a replay the check runs just before the node's stub: nothing is sent
 * and nothing pauses; an approval the live run would wait for fails the node
 * as "would wait for approval".
 */

import {
  APPROVAL_DEFAULT_TIMEOUT_MINUTES,
  connectorDestinationRef,
  getNodeDefinition,
  mcpServerDestinationRef,
  networkDestinationRef,
  type DataLabels,
  type DestinationRef,
  type WorkflowNode
} from "@ai-orchestrator/shared";
import { profileChecksOutbound, profileHasDestinationRules, type GuardChannel } from "@ai-orchestrator/guard-sdk";
import { ApprovalHandoffSignal } from "./approval-handoff";
import {
  declassifiedClasses,
  describeGuardVerdict,
  GuardBlockedError,
  guardApprovalKey,
  guardMayUseLabels,
  needsApproval,
  resolveDestinationRefs,
  resolveGuardRun,
  runGuardCheck,
  type GuardCheckResult,
  type GuardEvalScope,
  type GuardRuntimeDependencies,
  type ResolvedGuardProfile
} from "./guard-runtime";
import { renderTemplate } from "./template";

/** Which profiles an outbound check evaluates: those with destination rules, or (egress) those that configure egress too. */
export type OutboundNeed = "destinations" | "egress";

/**
 * The profiles of the run's stack that check this kind of outbound call;
 * empty (nothing to do) when none does. A run whose guard dependencies say
 * no stored profile could opt in never resolves its stack here.
 */
export async function outboundProfilesFor(guard: GuardRuntimeDependencies | undefined, need: OutboundNeed): Promise<ResolvedGuardProfile[]> {
  if (!guard) return [];
  if (!await guardMayUseLabels(guard)) return [];
  const resolution = await resolveGuardRun(guard);
  const wanted = need === "egress" ? profileChecksOutbound : profileHasDestinationRules;
  return resolution.stack.filter((entry) => wanted(entry.profile));
}

export interface OutboundCheckInput {
  scope: GuardEvalScope;
  profiles: ResolvedGuardProfile[];
  channel: Extract<GuardChannel, "egress" | "prompt" | "tool_arguments">;
  content: unknown;
  /** Where the call goes; several for a redirect chain (judged by its strictest hop). */
  refs: DestinationRef[];
  /** The labels of what is sent (provenance and data classes). */
  dataLabels: DataLabels;
  /** Only destination rules (model and MCP calls: their channel's detectors belong to the agent loop). */
  destinationOnly?: boolean;
  /** Secret values the call carries: a finding entirely inside one is not counted, and evidence never shows one. */
  ignoredValues?: readonly string[];
  approvals?: ReadonlySet<string>;
  /** A replay: never pause; an approval fails the node as "would wait for approval". */
  replay: boolean;
  /** Plain words for messages: "HTTP Request to api.example.com". */
  what: string;
  /** Part of the approval key (the destination), so another destination needs its own approval. */
  approvalTag: string;
  timeoutMinutes?: number;
}

export interface OutboundCheckOutcome {
  content: unknown;
  transformed: boolean;
  /** Data classes the check rewrote out of the content. */
  declassified: string[];
  result: GuardCheckResult;
}

/**
 * One outbound check. A block throws `GuardBlockedError` with the plain
 * reason; an approval the run does not have pauses the run through the
 * approval inbox (`ApprovalHandoffSignal`, re-run on approval), or in a
 * replay fails as "would wait for approval". Otherwise the (possibly
 * rewritten) content is returned.
 */
export async function checkOutbound(input: OutboundCheckInput): Promise<OutboundCheckOutcome> {
  const destination = input.profiles.some((entry) => profileHasDestinationRules(entry.profile))
    ? await resolveDestinationRefs(input.scope.guard, input.refs)
    : undefined;
  const result = await runGuardCheck(
    input.scope,
    input.profiles,
    {
      content: input.content,
      channel: input.channel,
      labels: [...input.dataLabels.provenance],
      ...(input.destinationOnly ? { destinationOnly: true } : {}),
      ...(input.ignoredValues?.length ? { ignoredValues: input.ignoredValues } : {}),
      ...(destination ? { destination, dataLabels: input.dataLabels } : {})
    },
    // Only verdicts with a finding are recorded (shadow findings included): a clean outbound call writes no row.
    { ...(input.channel === "egress" || input.channel === "tool_arguments" ? { toolName: input.approvalTag } : {}), onlyFindings: true }
  );
  const reason = describeGuardVerdict(result);
  if (result.action === "block") throw new GuardBlockedError(`${input.what} was blocked by the guard: ${reason}`, result.verdicts);
  if (needsApproval(result.action)) {
    const key = guardApprovalKey(input.scope.nodeId, input.channel, result, input.approvalTag);
    if (!input.approvals?.has(key)) {
      if (input.replay) throw new GuardBlockedError(`${input.what} would wait for approval: ${reason}`, result.verdicts);
      throw new ApprovalHandoffSignal({
        message: `Guard approval needed before ${input.what}: ${reason}`,
        timeoutMinutes: input.timeoutMinutes ?? APPROVAL_DEFAULT_TIMEOUT_MINUTES,
        handoff: { kind: "rerun", source: "egress_guard", approvalKey: key },
        details: { channel: input.channel, verdicts: result.verdicts }
      });
    }
  }
  return {
    content: result.transformed ? result.content : input.content,
    transformed: result.transformed,
    declassified: declassifiedClasses(result),
    result
  };
}

// ---------------------------------------------------------------------------
// What an egress node sends
// ---------------------------------------------------------------------------

/**
 * What the handler sends: exactly what was checked (rendered once, by the
 * check), after any rewrite. Handlers never render a checked request again.
 */
export type EgressOverride =
  | { kind: "http"; url: string; headers: Record<string, string>; body: string }
  /** Connector handlers: each template text in the settings and its checked rendering. */
  | { kind: "renderings"; renderings: ReadonlyMap<string, string> }
  | { kind: "mcp_args"; args: unknown }
  | { kind: "browse"; url: string }
  /** RAG senders: the rendered query (the documents come from upstream data, never rendered). */
  | { kind: "rag"; query: string }
  /** Nothing is rendered by the handler: what it sends is its settings as they are. */
  | { kind: "none" };

export interface EgressRequest {
  refs: DestinationRef[];
  channel: "egress" | "tool_arguments";
  content: Record<string, unknown>;
  what: string;
  approvalTag: string;
  /** What the handler sends when the check changes nothing. */
  sent: EgressOverride;
  /** What the handler sends after a rewrite; null when this request cannot be rewritten safely (it is blocked instead). */
  apply(rewritten: unknown): EgressOverride | null;
  /** Secret values in the content: scanned in place, a finding entirely inside one is not counted. */
  ignoredValues?: readonly string[];
}

/** Node types that send requests the egress checkpoint sees, besides category `Connector` senders. */
const HTTP_EGRESS_TYPES = new Set(["http_request", "web_browse"]);
/** RAG nodes whose embedder, vector store or reranker can be a network service. */
const RAG_EGRESS_TYPES = new Set(["rag_retrieve", "embeddings_azure_openai", "rerank"]);
/** Connector nodes that hand their settings to a connector adapter as they are (no rendering). */
const UNRENDERED_CONNECTOR_TYPES = new Set([
  "connector_source",
  "google_drive_source",
  "azure_storage",
  "azure_cosmos_db",
  "azure_monitor_http",
  "azure_ai_search_vector_store",
  "qdrant_vector_store"
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A secret reference (`{ secretId }`): the id is never content. */
function isSecretReference(value: unknown): boolean {
  const entry = record(value);
  return typeof entry.secretId === "string" && Object.keys(entry).every((key) => key === "secretId" || key === "source" || key === "key");
}

/** Every secret reference in a node's settings (any depth). */
export function secretReferencesIn(value: unknown, out: Array<{ secretId: string }> = [], depth = 0): Array<{ secretId: string }> {
  if (depth > 16 || !value || typeof value !== "object") return out;
  if (isSecretReference(value)) {
    out.push({ secretId: (value as { secretId: string }).secretId });
    return out;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) secretReferencesIn(item, out, depth + 1);
  return out;
}

/**
 * Settings as checked content: every string rendered (as the handler renders
 * it) when `render` is given, secret references left out. Every rendering is
 * recorded under its template text.
 */
function settingsContent(value: unknown, render: ((text: string) => string) | null, renderings: Map<string, string>, depth = 0): unknown {
  if (depth > 16) return undefined;
  if (typeof value === "string") {
    if (!render || !value.includes("{{")) return value;
    if (renderings.has(value)) return renderings.get(value);
    const rendered = render(value);
    renderings.set(value, rendered);
    return rendered;
  }
  if (Array.isArray(value)) return value.map((item) => settingsContent(item, render, renderings, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretReference(item)) continue;
      out[key] = settingsContent(item, render, renderings, depth + 1);
    }
    return out;
  }
  return value;
}

/** True when any string in the content contains one of the values. */
function containsAny(value: unknown, values: readonly string[], depth = 0): boolean {
  if (values.length === 0 || depth > 16) return false;
  if (typeof value === "string") return values.some((entry) => value.includes(entry));
  if (Array.isArray(value)) return value.some((item) => containsAny(item, values, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => containsAny(key, values, depth + 1) || containsAny(item, values, depth + 1));
  }
  return false;
}

/** The URL's parts as checked content: the address without its query, and each query value apart. */
export function urlContent(url: string): { url: string; query: Record<string, string>; host: string | undefined } {
  try {
    const parsed = new URL(url);
    // No prototype: a key named `__proto__` is an ordinary key, checked like any other.
    const query: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of parsed.searchParams) query[key] = query[key] !== undefined ? `${query[key]} ${value}` : value;
    const bare = new URL(url);
    bare.search = "";
    // Percent-encoded path segments are checked as they read (`4111%201111…` is a card number).
    let path = bare.toString();
    try {
      path = decodeURI(path);
    } catch {
      // A malformed escape: checked as written.
    }
    return { url: path, query, host: parsed.hostname };
  } catch {
    return { url, query: {}, host: undefined };
  }
}

/**
 * The query string after a rewrite of the checked query record (`urlContent`),
 * rebuilt whole from the rewritten keys and values so no original key or
 * value is kept: `undefined` when nothing changed (the URL is sent as it
 * was), null when the rewrite cannot be mapped back (blocked): a key count
 * that changed (two keys rewritten into one, a key dropped) or a rewritten
 * value of a key given more than once (its values were joined for the check).
 */
function rebuiltQuery(url: URL, rewritten: Record<string, unknown>): string | null | undefined {
  const original = new Map<string, string[]>();
  for (const [key, value] of url.searchParams) {
    const values = original.get(key);
    if (values) values.push(value);
    else original.set(key, [value]);
  }
  // The checked record lists its keys in object order (integer-like keys first), so the original keys are
  // lined up the same way and each rewritten pair is matched to its original by name, then by position.
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of original.keys()) record[key] = "";
  const order = Object.keys(record);
  const next = Object.entries(rewritten).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)] as const);
  if (next.length !== order.length) return null;
  const sameAsOriginal = (key: string, value: string, index: number) => {
    const values = original.get(key);
    return key === order[index] && values !== undefined && value === values.join(" ");
  };
  if (next.every(([key, value], index) => sameAsOriginal(key, value, index))) return undefined;
  const params = new URLSearchParams();
  for (const [index, [key, value]] of next.entries()) {
    const values = original.get(order[index]!)!;
    if (key === order[index] && value === values.join(" ")) {
      for (const item of values) params.append(key, item);
    } else if (values.length === 1) {
      params.append(key, value);
    } else {
      return null;
    }
  }
  return params.toString();
}

/** The ref for a web address: its host, or an unknown host (public). */
export function httpDestinationRef(url: string): DestinationRef {
  let host: string | undefined;
  try {
    host = new URL(url).hostname;
  } catch {
    host = undefined;
  }
  return networkDestinationRef("http", undefined, host);
}

/** True for node types the egress checkpoint covers (HTTP, Web Browse, connector senders, RAG services; never triggers). */
export function isEgressNodeType(type: string): boolean {
  if (HTTP_EGRESS_TYPES.has(type) || RAG_EGRESS_TYPES.has(type)) return true;
  if (type.endsWith("_trigger")) return false;
  return getNodeDefinition(type)?.category === "Connector";
}

export interface DescribeEgressOptions {
  /** Values of the secrets the node's settings reference: scanned in place; a finding entirely inside one is not counted. */
  secretValues?: readonly string[];
  /** A connector whose address lives in its secret: the secret's value, read for the host only. */
  secretAddress?: string;
  /** RAG nodes: where the embedder, vector store and reranker send (resolved by the engine). */
  ragRefs?: DestinationRef[];
}

/** Form bodies decode `+` as a space and percent escapes, so a card split that way is still seen. */
function readableBody(body: string, headers: Record<string, string>): string {
  const type = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  if (!/application\/x-www-form-urlencoded/i.test(type) && !/^[\w.%+-]+=[^&]*(&[\w.%+-]+=[^&]*)*$/.test(body.trim())) return body;
  try {
    return decodeURIComponent(body.replace(/\+/g, " "));
  } catch {
    return body;
  }
}

/**
 * What an egress node is about to send, rendered once, exactly as its handler
 * renders it (the handler then sends this rendering, never a new one); null
 * when there is nothing to check (an unrenderable request fails in the
 * handler as before; a connector with no network).
 */
export function describeEgressRequest(
  node: Pick<WorkflowNode, "type" | "name" | "id">,
  config: Record<string, unknown>,
  templateData: Record<string, unknown>,
  options: DescribeEgressOptions = {}
): EgressRequest | null {
  const label = node.name || node.type;
  const secrets = (options.secretValues ?? []).filter((value) => value.length >= 4);
  const finish = (request: Omit<EgressRequest, "content"> & { content: Record<string, unknown> }): EgressRequest => {
    // Secret values stay in place for the scan (taking them out could split a finding around them); a finding
    // entirely inside one is not counted, and evidence never shows one.
    if (!containsAny(request.content, secrets)) return request;
    // A rewrite of content that carries a secret value is not sent: blocked instead.
    return { ...request, ignoredValues: secrets, apply: () => null };
  };
  if (node.type === "http_request") {
    const method = typeof config.method === "string" ? config.method.trim().toUpperCase() : "GET";
    const safeMethod = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "GET";
    const renderedUrl = renderTemplate(typeof config.urlTemplate === "string" ? config.urlTemplate : "", templateData).trim();
    if (!renderedUrl) return null;
    let headers: Record<string, string> = {};
    try {
      headers = Object.fromEntries(Object.entries(record(JSON.parse(renderTemplate(typeof config.headersTemplate === "string" ? config.headersTemplate : "{}", templateData) || "{}"))).map(([key, value]) => [key, String(value)]));
    } catch {
      return null;
    }
    const body = safeMethod !== "GET" && safeMethod !== "DELETE" ? renderTemplate(typeof config.bodyTemplate === "string" ? config.bodyTemplate : "", templateData) : "";
    const parts = urlContent(renderedUrl);
    const ref = networkDestinationRef("http", undefined, parts.host);
    const readable = readableBody(body, headers);
    return finish({
      refs: [ref],
      channel: "egress",
      content: { method: safeMethod, url: parts.url, query: parts.query, headers, body: readable },
      what: `${label} (HTTP request to ${ref.host || "an unknown host"})`,
      approvalTag: ref.host ?? "",
      sent: { kind: "http", url: renderedUrl, headers, body },
      apply(rewritten) {
        const value = record(rewritten);
        if (typeof value.url !== "string" || typeof value.body !== "string") return null;
        // A decoded form body cannot be encoded back exactly: a rewrite there is blocked.
        if (readable !== body && value.body !== readable) return null;
        let url: URL;
        try {
          url = new URL(renderedUrl);
        } catch {
          return null;
        }
        // The address itself must not move: a rewrite only changes values (a rewritten path is refused).
        if (value.url !== parts.url) return null;
        const query = rebuiltQuery(url, record(value.query));
        if (query === null) return null;
        if (query !== undefined) url.search = query;
        const nextHeaders = Object.fromEntries(Object.entries(record(value.headers)).map(([key, item]) => [key, String(item)]));
        return { kind: "http", url: url.toString(), headers: nextHeaders, body: readable !== body ? body : value.body };
      }
    });
  }
  if (node.type === "web_browse") {
    const url =
      typeof config.url === "string" && config.url.trim()
        ? config.url.trim()
        : typeof config.urlTemplate === "string" && config.urlTemplate.trim()
          ? renderTemplate(config.urlTemplate, templateData).trim()
          : "";
    if (!url) return null;
    const parts = urlContent(url);
    const ref = networkDestinationRef("http", undefined, parts.host);
    return finish({
      refs: [ref],
      channel: "egress",
      content: { url: parts.url, query: parts.query },
      what: `${label} (browsing ${ref.host || "an unknown host"})`,
      approvalTag: ref.host ?? "",
      sent: { kind: "browse", url },
      // A browser fetches the page itself: a rewritten address cannot be handed to it safely.
      apply: () => null
    });
  }
  if (RAG_EGRESS_TYPES.has(node.type)) {
    const refs = options.ragRefs ?? [];
    if (refs.length === 0) return null;
    let query = "";
    let documents: unknown[] = [];
    if (node.type === "embeddings_azure_openai") {
      const inputKey = typeof config.inputKey === "string" && config.inputKey.trim() ? config.inputKey.trim() : "user_prompt";
      query = String(readData(templateData, inputKey) ?? readData(templateData, "user_prompt") ?? "");
    } else {
      const queryTemplate = typeof config.queryTemplate === "string" ? config.queryTemplate : "{{user_prompt}}";
      query = renderTemplate(queryTemplate, templateData).trim();
      const upstream = documentsContent(readData(templateData, "documents"));
      documents = node.type === "rag_retrieve" ? [...upstream, ...documentsContent(config.documents)] : upstream;
    }
    const hosts = [...new Set(refs.map((entry) => entry.host || entry.id || "an unknown host"))].join(", ");
    return finish({
      refs,
      channel: "egress",
      content: { query, documents },
      what: `${label} (${node.type.replace(/_/g, " ")} to ${hosts})`,
      approvalTag: refs.map((entry) => entry.host || entry.id || "").join(">"),
      sent: { kind: "rag", query },
      // Embeddings of rewritten text are not the documents' embeddings: a rewrite is blocked.
      apply: () => null
    });
  }
  const ref = connectorDestinationRef(node.type, config, options.secretAddress);
  if (!ref) return null;
  const unrendered = UNRENDERED_CONNECTOR_TYPES.has(node.type);
  const renderings = new Map<string, string>();
  const rendered = record(settingsContent(config, unrendered ? null : (text) => renderTemplate(text, templateData), renderings));
  return finish({
    refs: [ref],
    channel: "egress",
    content: { connector: node.type, settings: rendered },
    what: `${label} (${node.type.replace(/_/g, " ")} to ${ref.host || "an unknown host"})`,
    approvalTag: ref.host || node.type,
    sent: unrendered ? { kind: "none" } : { kind: "renderings", renderings },
    apply(rewritten) {
      // The adapter sends its settings as they are: a rewrite cannot reach it.
      if (unrendered) return null;
      const settings = record(record(rewritten).settings);
      const next = new Map(renderings);
      if (!mapRewrites(config, rendered, settings, next)) return null;
      return { kind: "renderings", renderings: next };
    }
  });
}

/**
 * Maps a rewrite of rendered settings back onto the handler's renderings: a
 * changed value must come from a template (the handler renders it, so it
 * sends the rewritten text); a changed literal, a changed shape or one
 * template text rewritten two ways cannot be applied (false: blocked).
 */
function mapRewrites(original: unknown, rendered: unknown, rewritten: unknown, renderings: Map<string, string>, depth = 0): boolean {
  if (depth > 16) return false;
  if (typeof original === "string") {
    if (rewritten === rendered) return true;
    if (typeof rewritten !== "string" || !original.includes("{{")) return false;
    const previous = renderings.get(original);
    if (previous !== undefined && previous !== rendered && previous !== rewritten) return false;
    renderings.set(original, rewritten);
    return true;
  }
  if (Array.isArray(original)) {
    if (!Array.isArray(rendered) || !Array.isArray(rewritten) || rewritten.length !== original.length) return false;
    return original.every((item, index) => mapRewrites(item, rendered[index], rewritten[index], renderings, depth + 1));
  }
  if (original && typeof original === "object") {
    const before = record(rendered);
    const after = record(rewritten);
    for (const [key, item] of Object.entries(original as Record<string, unknown>)) {
      if (isSecretReference(item)) continue;
      if (!(key in after)) return false;
      if (!mapRewrites(item, before[key], after[key], renderings, depth + 1)) return false;
    }
    return true;
  }
  return JSON.stringify(rewritten) === JSON.stringify(rendered);
}

function readData(data: Record<string, unknown>, key: string): unknown {
  if (key in data) return data[key];
  let current: unknown = data;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Documents as checked content: a string as it is, an object whole (its
 * text and also its id and metadata, which network stores upsert beside it).
 */
function documentsContent(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => (typeof item === "string" ? item.length > 0 : item !== null && item !== undefined));
}

/** The MCP Tool node's call: its arguments, to its server. */
export function describeMcpToolRequest(
  node: Pick<WorkflowNode, "name" | "type">,
  server: { serverId?: string; registryServerId?: string; connection?: unknown },
  toolName: string,
  args: unknown
): EgressRequest | null {
  const ref = mcpServerDestinationRef(server);
  if (!ref) return null;
  return {
    refs: [ref],
    channel: "tool_arguments",
    content: record(args),
    what: `${node.name || node.type} (MCP tool ${toolName} on ${ref.host || ref.id || "an unknown host"})`,
    approvalTag: toolName,
    sent: { kind: "mcp_args", args },
    apply: (rewritten) => (rewritten && typeof rewritten === "object" && !Array.isArray(rewritten) ? { kind: "mcp_args", args: rewritten } : null)
  };
}

/**
 * The arguments of an MCP server prompt (`prompts/get`), to its server: a
 * rewrite is sent when it keeps every argument as text, else blocked.
 */
export function describeMcpPromptRequest(
  node: Pick<WorkflowNode, "name" | "type">,
  server: { serverId?: string; registryServerId?: string; connection?: unknown },
  promptName: string,
  args: Record<string, string>
): EgressRequest | null {
  const ref = mcpServerDestinationRef(server);
  if (!ref) return null;
  const keys = Object.keys(args);
  return {
    refs: [ref],
    channel: "tool_arguments",
    content: { ...args },
    what: `${node.name || node.type} (MCP prompt ${promptName} on ${ref.host || ref.id || "an unknown host"})`,
    approvalTag: `prompt:${promptName}`,
    sent: { kind: "mcp_args", args },
    apply(rewritten) {
      const value = record(rewritten);
      const next = Object.keys(value);
      if (next.length !== keys.length || !keys.every((key) => typeof value[key] === "string")) return null;
      return { kind: "mcp_args", args: Object.fromEntries(keys.map((key) => [key, value[key] as string])) };
    }
  };
}

/** Runs the egress (or MCP) check for a described request; returns what the handler sends (the checked rendering, rewritten when the check rewrote it). */
export async function checkEgressRequest(
  request: EgressRequest,
  input: Omit<OutboundCheckInput, "channel" | "content" | "refs" | "what" | "approvalTag">
): Promise<{ override: EgressOverride; declassified: string[] }> {
  const outcome = await checkOutbound({
    ...input,
    channel: request.channel,
    content: request.content,
    refs: request.refs,
    what: request.what,
    approvalTag: request.approvalTag,
    ...(request.ignoredValues?.length ? { ignoredValues: request.ignoredValues } : {}),
    ...(request.channel === "tool_arguments" ? { destinationOnly: true } : {})
  });
  if (!outcome.transformed) return { override: request.sent, declassified: [] };
  const override = request.apply(outcome.content);
  if (!override) {
    throw new GuardBlockedError(
      `${request.what} was blocked by the guard: the guard asked to rewrite this request, which cannot be done safely here, so it was not sent (${describeGuardVerdict(outcome.result)})`,
      outcome.result.verdicts
    );
  }
  return { override, declassified: outcome.declassified };
}
