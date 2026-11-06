/**
 * 12.6b — Content rules on /v1 AI gateway traffic (A3, A4).
 *
 * A route set's or client's rule set binding turns these checks on (`GuardService.resolveGateway` with the route set in
 * the toolset's place); with neither, /v1 runs no content rules (the gg1 rule). Checkpoints:
 *   - `prompt` on the request before it goes to the provider: the messages' text as one array (a rewrite maps back
 *     message by message); `tool` messages (results of tools the caller ran: outside content) in a second check
 *     labelled `untrusted_external`; the deployment's destination rules on the route's provider. Embedding inputs are
 *     checked the same way.
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

/**
 * The prompt check: `texts` (the non-tool messages, or embedding inputs) and `toolTexts` (tool results, outside
 * content). A rewrite comes back as arrays of the same lengths.
 */
export async function checkAiGatewayPrompt(
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
