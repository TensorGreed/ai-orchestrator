/**
 * 12.6b — Content rules on /v1 AI gateway traffic (A3, A4).
 *
 * A route set's or client's rule set binding turns these checks on (`GuardService.resolveGateway` with the route set in
 * the toolset's place). Without either, the project's enforced rule set and the deployment's destination rules still
 * apply (Phase 12 coverage, D13); with none of those /v1 runs no content rules. The built-in rule set never applies here.
 * Checkpoints:
 *   - `prompt` on the final provider request, built and ready to send: `outboundTextSlots` walks all of it, so a field
 *     added to the request later is read without anyone remembering to add it here. Everything goes in one array (a
 *     rewrite maps back slot by slot); the contents of `tool` messages (results of tools the caller ran: outside
 *     content) go in a second check labelled `untrusted_external`; the deployment's destination rules run on the route's
 *     provider. A `user` message the caller marks `l2m: { untrusted: true }` (text from outside its app, such as its own
 *     retrieval) goes in the second check too; the mark is never sent upstream. Embedding requests go through the same
 *     walk. Images are not read: the gateway takes images only as data URLs, which are not text.
 *     Conversation history: a piece of text that passed cleanly (nothing found, nothing changed) is remembered for ten
 *     minutes in this process, keyed by the project, the client, the rule sets and a hash of the text, so the next turn
 *     checks only what is new. The memo never holds text, and is not used when destination rules apply to the request.
 *   - `final_output` on the answer: its text and the arguments of the tool calls it asks for.
 * `review` and `require_approval` block (nobody waits on an API call). Verdicts go to guard_events under the request's
 * `aigw_*` id, placement `gateway`, with the route's alias as the node id.
 *
 * Streaming: `outputGuardMode` says how an answer is checked (`channelStreamMode` per rule set).
 *   - `buffered`: a rule set may rewrite the answer and has not opted in to windowed streaming, or a rule asks for
 *     `stream: "buffer"`. The whole answer is generated, checked and then sent. Rule sets written before windowed
 *     streaming, the built-in one included, stay here.
 *   - `chunked`: the answer is checked but rewritten by no rule, or only by redact, mask and transform rules marked
 *     `stream: "window"` that cannot catch a finding wider than a stretch of text (a key block).
 * In `chunked` mode, at sentence or size boundaries the new text is checked with the end of what was already released
 * in front of it for context, and what passes is released except for a held-back tail (`streamReleaseLength`), so a
 * match still forming is not sent before it can be seen. Windowed rewrites apply to the part being released
 * (`GuardInput.streamWindow`); a value that runs past the release point waits, so it is never sent in two pieces, and
 * one that began in text already sent stops the stream. A block cuts the stream. Those boundary checks record nothing;
 * the full raw answer is checked once more at the end and recorded (the audit check), and only then does the tail go
 * out. If the audit check rewrites a value that went out unchanged, the stream ends with `content_filter` and is
 * recorded as blocked, never as rewritten. Each boundary check reads a bounded window, so the work grows with the
 * answer's length, not its square.
 * Whole-answer checks (a JSON schema, grounding) skip the boundary checks (`partial`) and run in the audit check; one
 * that can block makes the answer `buffered`, as does a whole-answer check that a rewrite rule could apply to.
 * Checks that call a model do not run here yet: rule sets bound to AI route sets or clients cannot use them.
 */
import {
  channelStreamMode,
  contentText,
  profileBlocksOnWholeAnswer,
  createDefaultGuardRegistry,
  createGuardVerdictMemo,
  type GuardRegistry,
  isMemoisableVerdict,
  type GuardChannel,
  type GuardSpan,
  type GuardVerdictMemo,
  type ProvenanceLabel
} from "@ai-orchestrator/guard-sdk";
import { providerDestinationRef } from "@ai-orchestrator/provider-sdk";
import type { DataLabels, LLMProviderConfig, McpToolPolicySubject, SecretReference } from "@ai-orchestrator/shared";
import {
  guardCheckMemoKey,
  needsApproval,
  profilesHaveDestinationRules,
  resolveDestinationRefs,
  runGuardCheck,
  type GuardRunResolution,
  type GuardRuntimeDependencies,
  type ResolvedGuardProfile
} from "@ai-orchestrator/workflow-engine";
import type { GuardService } from "./guard-service.js";
import { gatewayBlockReason } from "./mcp-gateway-guard.js";

export type AiGatewayOutputMode = "none" | "chunked" | "buffered";

let defaultRegistry: GuardRegistry | undefined;

/** How the answer is checked for this stack (see the module comment). */
export function outputGuardMode(stack: ReadonlyArray<ResolvedGuardProfile>, registry: Pick<GuardRegistry, "get"> = (defaultRegistry ??= createDefaultGuardRegistry())): AiGatewayOutputMode {
  let checked = false;
  for (const { profile } of stack) {
    if (!profile.channels.final_output) continue;
    if (channelStreamMode(profile, "final_output", registry) === "buffer") return "buffered";
    checked = true;
    // Phase 12 coverage — a whole-answer check (schema, grounding) that blocks runs only on the complete answer: hold
    // the stream back so a block stops the answer instead of cutting it off after most of it was sent.
    if (profileBlocksOnWholeAnswer(profile, "final_output")) return "buffered";
  }
  return checked ? "chunked" : "none";
}

const VALUE_REWRITES = new Set(["redact", "mask", "protect"]);

/**
 * The pieces of the values a check rewrote (from the first rule set's verdict, in the raw text's coordinates): runs of
 * at least 8 characters between spaces, line breaks and quotes, left out when the rewritten text still has them (a
 * label kept in place, a word used elsewhere). If one of these reached a caller, a value went out unchanged.
 */
export function rewrittenValuePieces(rawText: string, rewrittenText: string, summary: { findings: Array<{ spans: Array<{ start: number; end: number }> }>; actions: Array<{ effective: string; shadow: boolean }> } | undefined): string[] {
  if (!summary) return [];
  const pieces = new Set<string>();
  summary.findings.forEach((finding, index) => {
    const action = summary.actions[index];
    if (!action || action.shadow || !VALUE_REWRITES.has(action.effective)) return;
    for (const span of finding.spans) {
      for (const piece of rawText.slice(span.start, span.end).split(/\s+|\\[nrt]|"/)) {
        if (piece.length >= 8 && !rewrittenText.includes(piece)) pieces.add(piece);
      }
    }
  });
  return [...pieces];
}

/** A history memo entry: only that the text passed cleanly. */
export type AiGatewayHistoryMemo = GuardVerdictMemo<true>;

/** D16 — the process-local memo of prompt text that passed cleanly: bounded, ten minutes. */
export function createAiGatewayHistoryMemo(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}): AiGatewayHistoryMemo & { readonly size: number } {
  return createGuardVerdictMemo<true>({ maxEntries: options.maxEntries ?? 10_000, ttlMs: options.ttlMs ?? 600_000, ...(options.now ? { now: options.now } : {}) });
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
  /** D16 — prompt text that passed cleanly before. Absent: every request checks all of its text. */
  historyMemo?: AiGatewayHistoryMemo;
}

export type AiGatewayGuardOutcome<T> =
  | { action: "allow" }
  /** `values`: pieces of the values the check rewrote, when it read them (the answer check). */
  | { action: "rewrite"; content: T; values?: string[] }
  | { action: "block"; reason: string; categories: string[]; profiles: Array<{ profileId: string; version: number }> };

type BlockOutcome = { action: "block"; reason: string; categories: string[]; profiles: Array<{ profileId: string; version: number }> };

type CheckOutcome =
  /** `clean`: nothing was found and nothing changed in any rule set (a memo may keep it). */
  | { action: "allow"; clean: boolean; window?: GuardSpan }
  /** `values`: pieces of the rewritten values (`rewrittenValuePieces`). */
  | { action: "rewrite"; content: unknown; window?: GuardSpan; values: string[] }
  | BlockOutcome;

/** `outputGuardMode` for a scope, with the detectors its checks run (a detector the registry lacks counts as not local). */
export function aiGatewayOutputMode(scope: AiGatewayGuardScope): AiGatewayOutputMode {
  const registry = runtimeOf(scope).registry;
  return registry ? outputGuardMode(scope.resolution.stack, registry) : outputGuardMode(scope.resolution.stack);
}

function runtimeOf(scope: AiGatewayGuardScope) {
  return scope.guard.gatewayRuntime(
    { executionId: scope.requestId, toolsetId: scope.routeSetId, clientId: scope.clientId, projectId: scope.projectId },
    scope.resolution
  );
}

async function check(
  scope: AiGatewayGuardScope,
  channel: GuardChannel,
  content: unknown,
  options: { labels: ProvenanceLabel[]; provider?: LLMProviderConfig; record: boolean; streamWindow?: GuardSpan; partial?: boolean; deps?: GuardRuntimeDependencies }
): Promise<CheckOutcome> {
  const profiles = scope.resolution.stack;
  if (profiles.length === 0) return { action: "allow", clean: true, ...(options.streamWindow ? { window: options.streamWindow } : {}) };
  const deps = options.deps ?? runtimeOf(scope);
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
    {
      content,
      channel,
      labels: options.labels,
      ...(destination ? { destination, dataLabels } : {}),
      ...(options.streamWindow ? { streamWindow: options.streamWindow } : {}),
      ...(options.partial ? { partial: true } : {})
    }
  );
  if (result.action === "block" || needsApproval(result.action)) {
    return {
      action: "block",
      ...gatewayBlockReason(result),
      profiles: result.verdicts.map((entry) => ({ profileId: entry.profile.profileId, version: entry.profile.version }))
    };
  }
  const window = result.window ? { window: result.window } : {};
  if (result.transformed) {
    const values = options.streamWindow ? [] : rewrittenValuePieces(contentText(content), contentText(result.content), result.verdicts[0]?.summary);
    return { action: "rewrite", content: result.content, ...window, values };
  }
  const clean = result.action === "allow" && result.verdicts.length === profiles.length && result.verdicts.every((entry) => isMemoisableVerdict(entry.summary));
  return { action: "allow", clean, ...window };
}

function rewrittenStrings(content: unknown, length: number): string[] | null {
  if (!Array.isArray(content) || content.length !== length) return null;
  return content.map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")));
}

const blockedRewrite = (reason: string): BlockOutcome => ({ action: "block", reason, categories: [], profiles: [] });

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

/** How the caller marked its request's text (D17). */
export interface OutboundTextOptions {
  /** Indexes of `user` messages marked `l2m: { untrusted: true }`: their text is outside content, like a tool result. */
  untrustedMessages?: ReadonlySet<number>;
}

/**
 * Every piece of caller text in a provider request (chat or embeddings). The walk reads everything but
 * `outsideTheWalk`, so a new field is read by default rather than missed.
 */
export function outboundTextSlots(request: object, options: OutboundTextOptions = {}): { slots: OutboundTextSlot[] } {
  const slots: OutboundTextSlot[] = [];
  const keys = new Set<string>();
  const root = request as { messages?: Array<{ role?: string }> };
  const isToolContent = (path: ReadonlyArray<string | number>) =>
    path.length === 3 &&
    path[0] === "messages" &&
    path[2] === "content" &&
    (root.messages?.[path[1] as number]?.role === "tool" || (options.untrustedMessages?.has(path[1] as number) ?? false));

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
export async function checkAiGatewayRequest<T extends { provider: LLMProviderConfig }>(
  scope: AiGatewayGuardScope,
  request: T,
  options: OutboundTextOptions = {}
): Promise<AiGatewayGuardOutcome<T>> {
  const { slots } = outboundTextSlots(request, options);
  const plain = slots.filter((slot) => !slot.untrusted);
  const outside = slots.filter((slot) => slot.untrusted);
  const verdict = await checkAiGatewayPrompt(scope, { texts: plain.map((slot) => slot.text), toolTexts: outside.map((slot) => slot.text), provider: request.provider });
  if (verdict.action !== "rewrite") return verdict;
  const next = applyOutboundRewrite(request, [...plain, ...outside], [...verdict.content.texts, ...verdict.content.toolTexts]);
  return next ? { action: "rewrite", content: next } : blockedRewrite("Blocked by content rules: restricted text in a name or key that cannot be rewritten");
}

/**
 * One pass of the prompt check. With a history memo (and no destination rules on the request), text that passed
 * cleanly before is left out, and what passes cleanly now is remembered; a pass with nothing new runs no check and
 * records nothing. The memo key starts with the project and the client, so one tenant's traffic never answers for
 * another's (not even through timing).
 */
async function promptPass(
  scope: AiGatewayGuardScope,
  texts: string[],
  labels: ProvenanceLabel[],
  provider: LLMProviderConfig,
  failure: string
): Promise<BlockOutcome | { action: "pass"; texts: string[]; rewritten: boolean }> {
  const profiles = scope.resolution.stack;
  const memo = scope.historyMemo && !profilesHaveDestinationRules(profiles) ? scope.historyMemo : undefined;
  const deps = runtimeOf(scope);
  let keys: Array<string | undefined> = [];
  if (memo) {
    const runtime = { guard: deps, subject: scope.subject };
    const prefix = `${scope.projectId ?? ""}:${scope.clientId}:`;
    keys = texts.map((text) => {
      const key = guardCheckMemoKey(runtime, profiles, { content: text, channel: "prompt", labels });
      return key ? prefix + key : undefined;
    });
  }
  const pending = memo ? texts.flatMap((_, index) => (keys[index] && memo.get(keys[index]!) ? [] : [index])) : texts.map((_, index) => index);
  if (memo && pending.length === 0) return { action: "pass", texts, rewritten: false };
  const subset = pending.length === texts.length ? texts : pending.map((index) => texts[index]!);
  const outcome = await check(scope, "prompt", subset, { labels, provider, record: true, deps });
  if (outcome.action === "block") return outcome;
  if (outcome.action === "rewrite") {
    const next = rewrittenStrings(outcome.content, subset.length);
    if (!next) return blockedRewrite(failure);
    const out = [...texts];
    pending.forEach((index, at) => (out[index] = next[at]!));
    return { action: "pass", texts: out, rewritten: true };
  }
  if (memo && outcome.clean) {
    for (const index of pending) if (keys[index]) memo.set(keys[index]!, true);
  }
  return { action: "pass", texts, rewritten: false };
}

/** The two passes of the prompt check: `texts`, then `toolTexts` (outside content). A rewrite keeps both lengths. */
async function checkAiGatewayPrompt(
  scope: AiGatewayGuardScope,
  input: { texts: string[]; toolTexts: string[]; provider: LLMProviderConfig }
): Promise<AiGatewayGuardOutcome<{ texts: string[]; toolTexts: string[] }>> {
  const first = await promptPass(scope, input.texts, [], input.provider, "Blocked by content rules: the rewritten prompt could not be used");
  if (first.action === "block") return first;
  let toolTexts = input.toolTexts;
  let rewritten = first.rewritten;
  if (toolTexts.length > 0) {
    const second = await promptPass(scope, toolTexts, ["untrusted_external"], input.provider, "Blocked by content rules: the rewritten tool results could not be used");
    if (second.action === "block") return second;
    toolTexts = second.texts;
    rewritten ||= second.rewritten;
  }
  return rewritten ? { action: "rewrite", content: { texts: first.texts, toolTexts } } : { action: "allow" };
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
  // Phase 12 coverage — a boundary check sees the answer so far: whole-answer checks (schema, grounding) wait for the end.
  const outcome = await check(scope, "final_output", answerContent(answer), { labels: [], record, ...(record ? {} : { partial: true }) });
  if (outcome.action !== "rewrite") return outcome;
  const content = outcome.content;
  const values = outcome.values;
  if (typeof content === "string" && answer.toolCalls.length === 0) return { action: "rewrite", content: { content, toolCalls: [] }, values };
  const record_ = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : null;
  const calls = Array.isArray(record_?.tool_calls) ? (record_!.tool_calls as Array<Record<string, unknown>>) : null;
  if (!record_ || typeof record_.content !== "string" || !calls || calls.length !== answer.toolCalls.length) {
    return blockedRewrite("Blocked by content rules: the rewritten answer could not be used");
  }
  return {
    action: "rewrite",
    values,
    content: {
      content: record_.content,
      toolCalls: answer.toolCalls.map((call, index) => ({ ...call, arguments: typeof calls[index]!.arguments === "string" ? (calls[index]!.arguments as string) : call.arguments }))
    }
  };
}

/** What a boundary check of a streamed answer lets out. */
export type AiGatewayStreamRelease =
  /** `text` goes to the caller in place of the first `consumed` characters of the pending text. */
  | { action: "release"; text: string; consumed: number; rewritten: boolean }
  | BlockOutcome;

/**
 * D14/D15 — a boundary check of a streamed answer (records nothing). It reads `context` (the end of the raw text
 * already released) and all of `pending`, and judges and rewrites only the first `release` characters of `pending`.
 * What comes back may be shorter than `release` when a value to rewrite runs past it; that part waits. When the
 * rewritten text cannot be placed exactly (a later rule set rewrote text the window then left held), nothing is released
 * this time.
 */
export async function checkAiGatewayStreamWindow(
  scope: AiGatewayGuardScope,
  input: { context: string; pending: string; release: number }
): Promise<AiGatewayStreamRelease> {
  const content = input.context + input.pending;
  const start = input.context.length;
  const release = Math.max(0, Math.min(input.release, input.pending.length));
  // A boundary check sees only part of the answer: whole-answer checks (schema, grounding) wait for the audit check.
  const outcome = await check(scope, "final_output", content, { labels: [], record: false, partial: true, streamWindow: { start, end: start + release } });
  if (outcome.action === "block") return outcome;
  const window = outcome.window ?? { start, end: start + release };
  if (outcome.action === "allow") {
    const consumed = Math.max(0, Math.min(release, window.end - start));
    return { action: "release", text: input.pending.slice(0, consumed), consumed, rewritten: false };
  }
  const out = outcome.content;
  const nothing: AiGatewayStreamRelease = { action: "release", text: "", consumed: 0, rewritten: false };
  if (typeof out !== "string" || window.start !== start || window.end < start || window.end > out.length) return nothing;
  const suffix = out.slice(window.end);
  if (!out.startsWith(input.context) || suffix.length > input.pending.length || !input.pending.endsWith(suffix)) return nothing;
  return { action: "release", text: out.slice(start, window.end), consumed: input.pending.length - suffix.length, rewritten: true };
}

/** A boundary in streamed text where a check is worth it: the end of a sentence or line, or enough new text. */
export function streamCheckDue(unchecked: string, options: { minChars?: number; maxChars?: number } = {}): boolean {
  const min = options.minChars ?? 48;
  const max = options.maxChars ?? 400;
  if (unchecked.length >= max) return true;
  return unchecked.length >= min && /[.!?。\n]\s*$/.test(unchecked);
}

/**
 * Checked text stays held back for this many characters. The size comes from the detectors: 254 characters is the
 * longest address mail servers accept (RFC 5321), the longest value of bounded length they look for, and values that
 * may contain spaces (cards, phone numbers, IBANs, a labelled credential) are far shorter. At a typical 50 to 100 tokens
 * a second it adds about a second before the first text.
 */
export const STREAM_HOLD_CHARS = 256;

/**
 * An unbroken value (a token, a JWT, a URL) has no fixed length, so the release point also backs up to where the value
 * starts, up to this far. The limit keeps memory bounded on a long run with no break in it; 4096 covers signed tokens.
 */
export const STREAM_MAX_VALUE_CHARS = 4096;

/**
 * How much of the text already released a boundary check reads in front of the new text (D15): enough for any value the
 * hold could have kept back, so a check never misses context a whole-answer check would have seen nearby.
 */
export const STREAM_OVERLAP_CHARS = STREAM_HOLD_CHARS + STREAM_MAX_VALUE_CHARS;

/** Text a boundary check waits for before checking at a sentence end (the hold delays the text that long anyway). */
export const STREAM_CHECK_MIN_CHARS = 256;

/**
 * How much of the released text a boundary check reads in front of the new text: the tail's length, or the full
 * overlap when the released text ends inside an unbroken value (the release point gave up backing up to its start).
 */
export function streamContextChars(released: string, holdChars = STREAM_HOLD_CHARS): number {
  const last = released.charCodeAt(released.length - 1);
  return released.length > 0 && inValue(last) ? holdChars + STREAM_MAX_VALUE_CHARS : holdChars;
}

/** Printable ASCII other than a space: what emails, keys and URLs are made of. Anything else ends such a value. */
function inValue(code: number): boolean {
  return code > 0x20 && code < 0x7f;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * How much of checked text may be released: all but the last `holdChars`, then back to the start of the value that
 * point falls in, so a value is never cut in two. Text with no spaces in it (Chinese, say) is not held any longer:
 * only a run of value characters holds the release point back.
 */
export function streamReleaseLength(pending: string, holdChars = STREAM_HOLD_CHARS, maxValueChars = STREAM_MAX_VALUE_CHARS): number {
  const limit = pending.length - holdChars;
  if (limit <= 0) return 0;
  const floor = Math.max(0, limit - maxValueChars);
  for (let at = limit; at > floor; at -= 1) {
    const before = pending.charCodeAt(at - 1);
    if (!inValue(before) && !isHighSurrogate(before)) return at;
  }
  return floor;
}
