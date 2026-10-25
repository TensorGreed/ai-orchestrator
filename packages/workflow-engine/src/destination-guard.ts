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
 * header values, the body or the connector's rendered settings. Secret
 * values never enter the content: they are resolved by the handlers, after
 * the check. Destinations are resolved per run from the deployment's rows and
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
  if (guard.mayUseLabels && !guard.mayUseLabels()) return [];
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
      ...(destination ? { destination, dataLabels: input.dataLabels } : {})
    },
    input.channel === "egress" || input.channel === "tool_arguments" ? { toolName: input.approvalTag } : {}
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

/** What the handler sends instead of rendering its settings again, after a rewrite. */
export type EgressOverride =
  | { kind: "http"; url: string; headers: Record<string, string>; body: string }
  | { kind: "config"; config: Record<string, unknown> }
  | { kind: "mcp_args"; args: unknown };

export interface EgressRequest {
  refs: DestinationRef[];
  channel: "egress" | "tool_arguments";
  content: Record<string, unknown>;
  what: string;
  approvalTag: string;
  /** The handler's input after a rewrite; null when this request cannot be rewritten safely (it is blocked instead). */
  apply(rewritten: unknown): EgressOverride | null;
}

/** Node types that send requests the egress checkpoint sees, besides category `Connector` senders. */
const HTTP_EGRESS_TYPES = new Set(["http_request", "web_browse"]);
/** Settings keys that hold credentials or references to them: never part of the checked content. */
const SECRET_KEY = /secret|credential|password|passwd|token|api[_-]?key|private[_-]?key/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function renderDeep(value: unknown, data: Record<string, unknown>, depth = 0): unknown {
  if (depth > 16) return undefined;
  if (typeof value === "string") return value.includes("{{") ? renderTemplate(value, data) : value;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, data, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = renderDeep(item, data, depth + 1);
    }
    return out;
  }
  return value;
}

function containsTemplate(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some((item) => containsTemplate(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some((item) => containsTemplate(item, depth + 1));
  return false;
}

/** The URL's parts as checked content: the address without its query, and each query value apart. */
function urlContent(url: string): { url: string; query: Record<string, string>; host: string | undefined } {
  try {
    const parsed = new URL(url);
    const query: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) query[key] = query[key] !== undefined ? `${query[key]} ${value}` : value;
    const bare = new URL(url);
    bare.search = "";
    return { url: bare.toString(), query, host: parsed.hostname };
  } catch {
    return { url, query: {}, host: undefined };
  }
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

/** True for node types the egress checkpoint covers (HTTP, Web Browse, connector senders; never triggers). */
export function isEgressNodeType(type: string): boolean {
  if (HTTP_EGRESS_TYPES.has(type)) return true;
  if (type.endsWith("_trigger")) return false;
  return getNodeDefinition(type)?.category === "Connector";
}

/**
 * What an egress node is about to send, rendered exactly as its handler
 * renders it; null when there is nothing to check (an unrenderable request
 * fails in the handler as before).
 */
export function describeEgressRequest(node: Pick<WorkflowNode, "type" | "name" | "id">, config: Record<string, unknown>, templateData: Record<string, unknown>): EgressRequest | null {
  const label = node.name || node.type;
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
    return {
      refs: [ref],
      channel: "egress",
      content: { method: safeMethod, url: parts.url, query: parts.query, headers, body },
      what: `${label} (HTTP request to ${ref.host || "an unknown host"})`,
      approvalTag: ref.host ?? "",
      apply(rewritten) {
        const value = record(rewritten);
        if (typeof value.url !== "string" || typeof value.body !== "string") return null;
        let url: URL;
        try {
          url = new URL(value.url);
        } catch {
          return null;
        }
        // The address itself must not move: a rewrite only changes values.
        if (url.hostname !== parts.host) return null;
        for (const [key, item] of Object.entries(record(value.query))) url.searchParams.set(key, String(item));
        const nextHeaders = Object.fromEntries(Object.entries(record(value.headers)).map(([key, item]) => [key, String(item)]));
        return { kind: "http", url: url.toString(), headers: nextHeaders, body: value.body };
      }
    };
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
    return {
      refs: [ref],
      channel: "egress",
      content: { url: parts.url, query: parts.query },
      what: `${label} (browsing ${ref.host || "an unknown host"})`,
      approvalTag: ref.host ?? "",
      // A browser fetches the page itself: a rewritten address cannot be handed to it safely.
      apply: () => null
    };
  }
  const rendered = record(renderDeep(config, templateData));
  const ref = connectorDestinationRef(node.type, rendered);
  return {
    refs: [ref],
    channel: "egress",
    content: { connector: node.type, settings: rendered },
    what: `${label} (${node.type.replace(/_/g, " ")} to ${ref.host || "an unknown host"})`,
    approvalTag: ref.host || node.type,
    apply(rewritten) {
      const settings = record(record(rewritten).settings);
      // The handler renders its settings again: a value that now holds `{{` would be evaluated, so that is refused.
      if (containsTemplate(settings)) return null;
      return { kind: "config", config: { ...config, ...settings } };
    }
  };
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
    apply: (rewritten) => (rewritten && typeof rewritten === "object" && !Array.isArray(rewritten) ? { kind: "mcp_args", args: rewritten } : null)
  };
}

/** Runs the egress (or MCP) check for a described request; returns the override for the handler, if the content was rewritten. */
export async function checkEgressRequest(
  request: EgressRequest,
  input: Omit<OutboundCheckInput, "channel" | "content" | "refs" | "what" | "approvalTag">
): Promise<{ override: EgressOverride | null; declassified: string[] }> {
  const outcome = await checkOutbound({
    ...input,
    channel: request.channel,
    content: request.content,
    refs: request.refs,
    what: request.what,
    approvalTag: request.approvalTag,
    ...(request.channel === "tool_arguments" ? { destinationOnly: true } : {})
  });
  if (!outcome.transformed) return { override: null, declassified: [] };
  const override = request.apply(outcome.content);
  if (!override) {
    throw new GuardBlockedError(
      `${request.what} was blocked by the guard: the guard asked to rewrite this request, which cannot be done safely here, so it was not sent (${describeGuardVerdict(outcome.result)})`,
      outcome.result.verdicts
    );
  }
  return { override, declassified: outcome.declassified };
}
