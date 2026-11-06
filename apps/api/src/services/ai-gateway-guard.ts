/**
 * 12.6b — Content rules on /v1 AI gateway traffic (A3, A4).
 *
 * A route set's or client's rule set binding turns these checks on (`GuardService.resolveGateway` with the route set in
 * the toolset's place); with neither, /v1 runs no content rules (the gg1 rule). Checkpoints:
 *   - `prompt` on the final provider request, built and ready to send: `outboundTextSlots` walks all of it, so a field
 *     added to the request later is read without anyone remembering to add it here. Everything goes in one array (a
 *     rewrite maps back slot by slot); the contents of `tool` messages (results of tools the caller ran: outside
 *     content) go in a second check labelled `untrusted_external`; the deployment's destination rules run on the route's
 *     provider. Embedding requests go through the same walk. Images are not text, so these checks do not read them.
 *   - `final_output` on the answer: its text and the arguments of the tool calls it asks for.
 * `review` and `require_approval` block (nobody waits on an API call). Verdicts go to guard_events under the request's
 * `aigw_*` id, placement `gateway`, with the route's alias as the node id.
 *
 * Streaming: `outputGuardMode` says how an answer is checked. `buffered` when a profile may rewrite the answer
 * (redact, mask, protect, transform on final_output): text already sent cannot be rewritten, so the whole answer is
 * generated, checked and then sent. `chunked` when final_output is checked but never rewritten: text is held back
 * until the text so far passes a check at a sentence or size boundary, so nothing unchecked reaches the caller; a
 * block cuts the stream. Those boundary checks record nothing; the full answer is checked once more at the end and
 * recorded (the audit check).
 */
import type { GuardChannel, ProvenanceLabel } from "@ai-orchestrator/guard-sdk";
import { providerDestinationRef } from "@ai-orchestrator/provider-sdk";
import type { DataLabels, LLMProviderConfig, McpToolPolicySubject, SecretReference } from "@ai-orchestrator/shared";
import {
  needsApproval,
  profilesHaveDestinationRules,
  resolveDestinationRefs,
  runGuardCheck,
  type GuardRunResolution,
  type ResolvedGuardProfile
} from "@ai-orchestrator/workflow-engine";
import type { GuardService } from "./guard-service.js";
import { gatewayBlockReason } from "./mcp-gateway-guard.js";

const REWRITE_ACTIONS = new Set(["redact", "mask", "protect", "transform"]);

export type AiGatewayOutputMode = "none" | "chunked" | "buffered";

/** How the answer is checked for this stack (see the module comment). */
export function outputGuardMode(stack: ReadonlyArray<ResolvedGuardProfile>): AiGatewayOutputMode {
  let checked = false;
  for (const { profile } of stack) {
    const channel = profile.channels.final_output;
    if (!channel) continue;
    checked = true;
    const rules = [channel.defaultAction, ...Object.values(channel.actions)];
    for (const rule of rules) {
      const shadow = rule.shadow ?? profile.shadow[rule.action] ?? false;
      if (!shadow && REWRITE_ACTIONS.has(rule.action)) return "buffered";
    }
  }
  return checked ? "chunked" : "none";
}

export interface AiGatewayGuardScope {
  guard: GuardService;
  resolution: GuardRunResolution;
  /** The request's `aigw_*` id. */
  requestId: string;
  routeSetId: string;
  clientId: string;
  projectId: string | null;
  /** The route's alias: the verdicts' node id. */
  alias: string;
  subject: McpToolPolicySubject;
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
  logger?: (message: string, metadata?: unknown) => void;
}

export type AiGatewayGuardOutcome<T> =
  | { action: "allow" }
  | { action: "rewrite"; content: T }
  | { action: "block"; reason: string; categories: string[]; profiles: Array<{ profileId: string; version: number }> };

async function check(
  scope: AiGatewayGuardScope,
  channel: GuardChannel,
  content: unknown,
  options: { labels: ProvenanceLabel[]; provider?: LLMProviderConfig; record: boolean }
): Promise<{ action: "allow" } | { action: "rewrite"; content: unknown } | { action: "block"; reason: string; categories: string[]; profiles: Array<{ profileId: string; version: number }> }> {
  const profiles = scope.resolution.stack;
  if (profiles.length === 0) return { action: "allow" };
  const deps = scope.guard.gatewayRuntime(
    { executionId: scope.requestId, toolsetId: scope.routeSetId, clientId: scope.clientId, projectId: scope.projectId },
    scope.resolution
  );
  const ref = options.provider && profilesHaveDestinationRules(profiles) ? providerDestinationRef(options.provider) : null;
  const destination = ref ? await resolveDestinationRefs(deps, [ref]) : undefined;
  const dataLabels: DataLabels = { provenance: options.labels.length ? [...options.labels] : ["user"], dataClasses: [], source: "propagated" };
  const result = await runGuardCheck(
    {
      guard: deps,
      resolveSecret: scope.resolveSecret,
      // An empty id records nothing (the boundary checks of a streamed answer).
      executionId: options.record ? scope.requestId : "",
      workflowId: "",
      nodeId: scope.alias,
      placement: "gateway",
      subject: scope.subject,
      ...(scope.logger ? { logger: scope.logger } : {})
    },
    profiles,
    { content, channel, labels: options.labels, ...(destination ? { destination, dataLabels } : {}) }
  );
  if (result.action === "block" || needsApproval(result.action)) {
    return {
      action: "block",
      ...gatewayBlockReason(result),
      profiles: result.verdicts.map((entry) => ({ profileId: entry.profile.profileId, version: entry.profile.version }))
    };
  }
  return result.transformed ? { action: "rewrite", content: result.content } : { action: "allow" };
}

function rewrittenStrings(content: unknown, length: number): string[] | null {
  if (!Array.isArray(content) || content.length !== length) return null;
  return content.map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")));
}

const blockedRewrite = (reason: string): AiGatewayGuardOutcome<never> => ({ action: "block", reason, categories: [], profiles: [] });

/** One piece of caller text in a provider request. */
export interface OutboundTextSlot {
  path: ReadonlyArray<string | number>;
  text: string;
  /** The content of a `tool` message: outside content. */
  untrusted: boolean;
  /** An object key, or a name the rest of the request refers to: a rewrite here would leave the request broken. */
  fixed: boolean;
}

/** Free-form JSON the caller wrote: inside it, object keys and numbers can carry data too. */
const FREE_FORM_FIELDS = new Set(["arguments", "inputSchema", "schema"]);

const FIXED_FIELD = /^(?:messages\.\d+\.(?:name|toolCallId|toolCalls\.\d+\.(?:id|name))|tools\.\d+\.name|options\.toolChoice\.name|options\.responseFormat\.jsonSchema\.name)$/;

/** All that the walk leaves out: the route's own settings, roles (fixed values) and image data (not text). */
function outsideTheWalk(path: ReadonlyArray<string | number>): boolean {
  if (path.length === 1) return path[0] === "provider";
  return path.length === 3 && path[0] === "messages" && (path[2] === "role" || path[2] === "images");
}

/**
 * Every piece of caller text in a provider request (chat or embeddings). The walk reads everything but
 * `outsideTheWalk`, so a new field is read by default rather than missed.
 */
export function outboundTextSlots(request: object): { slots: OutboundTextSlot[] } {
  const slots: OutboundTextSlot[] = [];
  const keys = new Set<string>();
  const root = request as { messages?: Array<{ role?: string }> };
  const isToolContent = (path: ReadonlyArray<string | number>) =>
    path.length === 3 && path[0] === "messages" && path[2] === "content" && root.messages?.[path[1] as number]?.role === "tool";

  const visit = (value: unknown, path: Array<string | number>, freeForm: boolean): void => {
    if (typeof value === "string") {
      if (value) slots.push({ path, text: value, untrusted: isToolContent(path), fixed: FIXED_FIELD.test(path.join(".")) });
    } else if (typeof value === "number") {
      if (freeForm) slots.push({ path, text: String(value), untrusted: false, fixed: false });
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index], freeForm));
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        const next = [...path, key];
        if (outsideTheWalk(next)) continue;
        // A key is read once however often it repeats: it is never rewritten, so one sighting is enough.
        if (!keys.has(key)) {
          keys.add(key);
          slots.push({ path: next, text: key, untrusted: false, fixed: true });
        }
        visit(entry, next, freeForm || FREE_FORM_FIELDS.has(key));
      }
    }
  };
  visit(request, [], false);
  return { slots };
}

/** The request with `rewritten` in its slots; null when a rewrite touches a slot that cannot take one. */
function applyOutboundRewrite<T extends { provider: LLMProviderConfig }>(request: T, slots: OutboundTextSlot[], rewritten: string[]): T | null {
  const { provider, ...rest } = request;
  const copy = structuredClone(rest) as unknown as Record<string | number, unknown>;
  for (const [index, slot] of slots.entries()) {
    if (rewritten[index] === slot.text) continue;
    if (slot.fixed) return null;
    let target = copy;
    for (const part of slot.path.slice(0, -1)) target = target[part] as Record<string | number, unknown>;
    target[slot.path.at(-1)!] = rewritten[index];
  }
  return { ...copy, provider } as unknown as T;
}

/**
 * The prompt check of a provider request, as it is about to be sent. A rewrite comes back as the same request with
 * the new text in place; one that would change a key or a name blocks instead.
 */
export async function checkAiGatewayRequest<T extends { provider: LLMProviderConfig }>(scope: AiGatewayGuardScope, request: T): Promise<AiGatewayGuardOutcome<T>> {
  const { slots } = outboundTextSlots(request);
  const plain = slots.filter((slot) => !slot.untrusted);
  const outside = slots.filter((slot) => slot.untrusted);
  const verdict = await checkAiGatewayPrompt(scope, { texts: plain.map((slot) => slot.text), toolTexts: outside.map((slot) => slot.text), provider: request.provider });
  if (verdict.action !== "rewrite") return verdict;
  const next = applyOutboundRewrite(request, [...plain, ...outside], [...verdict.content.texts, ...verdict.content.toolTexts]);
  return next ? { action: "rewrite", content: next } : blockedRewrite("Blocked by content rules: restricted text in a name or key that cannot be rewritten");
}

/** The two passes of the prompt check: `texts`, then `toolTexts` (outside content). A rewrite keeps both lengths. */
async function checkAiGatewayPrompt(
  scope: AiGatewayGuardScope,
  input: { texts: string[]; toolTexts: string[]; provider: LLMProviderConfig }
): Promise<AiGatewayGuardOutcome<{ texts: string[]; toolTexts: string[] }>> {
  let texts = input.texts;
  let toolTexts = input.toolTexts;
  let rewritten = false;
  const first = await check(scope, "prompt", texts, { labels: [], provider: input.provider, record: true });
  if (first.action === "block") return first;
  if (first.action === "rewrite") {
    const next = rewrittenStrings(first.content, texts.length);
    if (!next) return blockedRewrite("Blocked by content rules: the rewritten prompt could not be used");
    texts = next;
    rewritten = true;
  }
  if (toolTexts.length > 0) {
    const second = await check(scope, "prompt", toolTexts, { labels: ["untrusted_external"], provider: input.provider, record: true });
    if (second.action === "block") return second;
    if (second.action === "rewrite") {
      const next = rewrittenStrings(second.content, toolTexts.length);
      if (!next) return blockedRewrite("Blocked by content rules: the rewritten tool results could not be used");
      toolTexts = next;
      rewritten = true;
    }
  }
  return rewritten ? { action: "rewrite", content: { texts, toolTexts } } : { action: "allow" };
}

export interface AiGatewayAnswer {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/** What the output checks see: the text alone, or the text and the tool calls it asks for. */
function answerContent(answer: AiGatewayAnswer): unknown {
  if (answer.toolCalls.length === 0) return answer.content;
  return { content: answer.content, tool_calls: answer.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })) };
}

/**
 * The `final_output` check of an answer. `record: false` for a stream's boundary checks (nothing is recorded);
 * the full answer's check records.
 */
export async function checkAiGatewayAnswer(scope: AiGatewayGuardScope, answer: AiGatewayAnswer, record = true): Promise<AiGatewayGuardOutcome<AiGatewayAnswer>> {
  const outcome = await check(scope, "final_output", answerContent(answer), { labels: [], record });
  if (outcome.action !== "rewrite") return outcome;
  const content = outcome.content;
  if (typeof content === "string" && answer.toolCalls.length === 0) return { action: "rewrite", content: { content, toolCalls: [] } };
  const record_ = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : null;
  const calls = Array.isArray(record_?.tool_calls) ? (record_!.tool_calls as Array<Record<string, unknown>>) : null;
  if (!record_ || typeof record_.content !== "string" || !calls || calls.length !== answer.toolCalls.length) {
    return blockedRewrite("Blocked by content rules: the rewritten answer could not be used");
  }
  return {
    action: "rewrite",
    content: {
      content: record_.content,
      toolCalls: answer.toolCalls.map((call, index) => ({ ...call, arguments: typeof calls[index]!.arguments === "string" ? (calls[index]!.arguments as string) : call.arguments }))
    }
  };
}

/** A boundary in streamed text where a check is worth it: the end of a sentence or line, or enough new text. */
export function streamCheckDue(pending: string, options: { minChars?: number; maxChars?: number } = {}): boolean {
  const min = options.minChars ?? 48;
  const max = options.maxChars ?? 400;
  if (pending.length >= max) return true;
  return pending.length >= min && /[.!?。\n]\s*$/.test(pending);
}
