import { createHash } from "node:crypto";
import type { GuardProfile } from "./profile";
import type { GuardRegistry } from "./registry";
import { contentText, stableStringify, type GuardChannel, type GuardInput } from "./types";
import type { GuardVerdictSummary } from "./wiring";

/**
 * Phase 12 coverage — a memo of clean verdicts, so the same text checked
 * twice under the same rule sets (an agent's final answer, then a Content
 * Rules node, then the response check) is scanned once. It holds only
 * checks that found nothing and changed nothing; a hit records no new rule
 * event, because the first check already did. It never holds content: keys
 * are hashes, entries are clean verdict summaries.
 *
 * In a workflow run the memo lives for that run only. The `/v1` gateway may
 * keep a process-local one with a time limit for conversation history.
 */
export interface GuardVerdictMemo<T = unknown> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export interface GuardVerdictMemoOptions {
  /** Oldest entries are dropped beyond this many. Default 10 000. */
  maxEntries?: number;
  /** Entries older than this are ignored and dropped. Absent: no time limit. */
  ttlMs?: number;
  /** Clock for the time limit. Default `Date.now`. */
  now?: () => number;
}

export const DEFAULT_VERDICT_MEMO_MAX_ENTRIES = 10_000;

/**
 * Channels whose checks may use a memo: content checks only. Tool arguments
 * and outbound requests are judged against DNS answers, the filesystem and
 * destinations, which can change between two checks of the same text.
 */
export const MEMOISABLE_CHANNELS: ReadonlySet<GuardChannel> = new Set(["prompt", "tool_result", "model_output", "final_output", "response"]);

/**
 * Whether a check may be answered from, or stored in, a memo: a content
 * channel, no destination, redirect chain or destination-only pass, and no
 * detector in the applied rule sets that depends on state outside the input
 * (`memoisable: false`, or unknown to the registry).
 */
export function guardCheckIsMemoisable(input: GuardInput, profiles: readonly GuardProfile[], registry: Pick<GuardRegistry, "get">): boolean {
  if (!MEMOISABLE_CHANNELS.has(input.channel)) return false;
  if (input.destination || input.destinationOnly || (input.redirectChain && input.redirectChain.length > 0)) return false;
  for (const profile of profiles) {
    for (const entry of profile.channels[input.channel]?.detectors ?? []) {
      const detector = registry.get(entry.id);
      if (!detector || detector.memoisable === false) return false;
    }
  }
  return true;
}

/** A bounded least-recently-used memo with an optional time limit. */
export function createGuardVerdictMemo<T = unknown>(options: GuardVerdictMemoOptions = {}): GuardVerdictMemo<T> & { readonly size: number } {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_VERDICT_MEMO_MAX_ENTRIES));
  const ttlMs = options.ttlMs;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: T; at: number }>();
  return {
    get size() {
      return entries.size;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (ttlMs !== undefined && now() - entry.at > ttlMs) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, at: now() });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The memo key of a check: the rule sets applied (their hashes, in order),
 * the channel, the sorted provenance labels and the SHA-256 of the canonical
 * content. Everything else in the input that can change a verdict (tool,
 * canaries, redirect chain, destination, data labels, subject, ignored
 * values, sources) is folded in as one more hash, so a hit always means the
 * same check. Piece metadata does not change verdicts and is left out.
 */
export function guardVerdictMemoKey(profileHashes: readonly string[], input: GuardInput): string {
  const labels = [...new Set(input.labels ?? [])].sort();
  const context = {
    tool: input.tool,
    canaries: input.canaries ? [...input.canaries].sort() : undefined,
    redirectChain: input.redirectChain,
    destination: input.destination,
    dataLabels: input.dataLabels,
    subject: input.subject,
    ignoredValues: input.ignoredValues ? [...input.ignoredValues].sort() : undefined,
    destinationOnly: input.destinationOnly,
    sources: input.sources,
    streamWindow: input.streamWindow
  };
  return [
    "v1",
    sha256(profileHashes.join(",")),
    input.channel,
    labels.join(","),
    sha256(contentText(input.content)),
    sha256(stableStringify(context))
  ].join(":");
}

/** A verdict the memo may keep: allowed, nothing found (shadow included), nothing rewritten, no detector skipped. */
export function isMemoisableVerdict(summary: Pick<GuardVerdictSummary, "action" | "findings" | "actions" | "transformed" | "protectedCount" | "budget">): boolean {
  return (
    summary.action === "allow" &&
    summary.findings.length === 0 &&
    summary.actions.length === 0 &&
    !summary.transformed &&
    summary.protectedCount === 0 &&
    !summary.budget.exceeded &&
    summary.budget.skippedDetectors.length === 0
  );
}
