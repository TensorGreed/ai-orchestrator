import { z } from "zod";
import type { ChatMessage } from "./types";
import { dataLabelsSchema, type DataLabels } from "./data-labels";

/**
 * Phase 15.3 — the model tape: what a run's model calls asked and answered,
 * so a replay can answer them without calling the model.
 *
 * It mirrors the MCP cassette: entries are keyed by the call site (node id
 * and agent iteration), the provider, the model and the SHA-256 of the
 * canonical, scrubbed request (messages, tools and sampling parameters;
 * never the endpoint or the credential). Repeated identical calls are
 * answered in recorded order. Any upstream change (a prompt, an earlier
 * tool result, a different model) changes the key, so the call is not on
 * the tape.
 *
 * A tape is recorded together with the run's MCP cassette (the same
 * "Record calls" switch) and stored in the cassette row, under the same
 * size limits, scrubbing and retention. A golden run saved from that run
 * copies it, with the memory seed: what session memory held for each
 * session the run read, before the run changed it.
 */

export const MODEL_TAPE_FORMAT = "l2m.model-tape";
export const MODEL_TAPE_VERSION = 1;

export interface ModelTapeCallSite {
  /** The node that made the call; null when the engine did not say (MCP sampling outside a node). */
  nodeId: string | null;
  /** Agent loop iteration; null for single-call nodes. */
  iteration: number | null;
}

export interface ModelTapeEntry extends ModelTapeCallSite {
  /** 1-based position in recording order. */
  seq: number;
  providerId: string;
  model: string;
  /** SHA-256 of the canonical scrubbed request: the replay match key with the fields above. */
  requestHash: string;
  /** The scrubbed request, kept to explain a miss. */
  request: { messages: unknown; tools: unknown; params: unknown };
  /** The scrubbed answer (`LLMCallResponse`). */
  response?: unknown;
  /** Set when the call failed; the replay fails with the same message. */
  error?: string;
  /** Recorded from a streaming call; the replay can stream it back. */
  streamed?: boolean;
  /** Milliseconds since the tape started. */
  at: number;
  durationMs: number;
}

export interface ModelTape {
  format: typeof MODEL_TAPE_FORMAT;
  version: typeof MODEL_TAPE_VERSION;
  recordedAt: string;
  entries: ModelTapeEntry[];
  /** True when the size limit stopped the recording early. */
  truncated: boolean;
  /** Serialized size of `entries`, in bytes. */
  bytes: number;
}

/**
 * How a replay treats a model call the tape has no answer for:
 *   - strict: the call fails, and the case is inconclusive;
 *   - lenient: an exhausted call reuses its last recorded answer, and a call
 *     the tape never saw goes to the live model (reported, never silent).
 */
export type ModelTapeMode = "strict" | "lenient";

export interface ModelTapeReport {
  mode: ModelTapeMode;
  /** Calls answered from the tape. */
  matched: number;
  /** Calls answered by reusing an exhausted entry (lenient only). */
  reused: number;
  /** Calls sent to the live model (lenient only). */
  live: number;
  /** The live calls' sites and usage, so only they are priced (tape answers cost nothing). */
  liveCalls?: Array<ModelTapeCallSite & { providerId: string; model: string; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null }>;
  unmatched: Array<ModelTapeCallSite & { providerId: string; model: string; reason: string }>;
}

/** Session memory as a recorded run first read it, per namespace and session. */
export interface ModelMemorySeedEntry {
  namespace: string;
  sessionId: string;
  messages: ChatMessage[];
  /** Phase 16 — the labels stored with that memory when the run read it; absent when none were recorded. */
  labels?: DataLabels;
}

export interface ModelMemorySeed {
  sessions: ModelMemorySeedEntry[];
  truncated: boolean;
}

const callSiteShape = {
  nodeId: z.string().max(200).nullable(),
  iteration: z.number().int().min(0).max(100_000).nullable()
};

export const modelTapeSchema = z.object({
  format: z.literal(MODEL_TAPE_FORMAT),
  version: z.literal(MODEL_TAPE_VERSION),
  recordedAt: z.string(),
  entries: z
    .array(
      z.object({
        ...callSiteShape,
        seq: z.number().int().positive(),
        providerId: z.string().min(1).max(200),
        model: z.string().max(400),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
        request: z.object({ messages: z.unknown(), tools: z.unknown(), params: z.unknown() }),
        response: z.unknown().optional(),
        error: z.string().optional(),
        streamed: z.boolean().optional(),
        at: z.number().nonnegative(),
        durationMs: z.number().nonnegative()
      })
    )
    .max(100_000),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative()
});

export const modelMemorySeedSchema = z.object({
  sessions: z
    .array(
      z.object({
        namespace: z.string().max(400),
        sessionId: z.string().max(400),
        messages: z.array(z.record(z.string(), z.unknown())).max(10_000),
        /** Phase 16 — the labels stored with that memory when the run read it (absent: none recorded). */
        labels: dataLabelsSchema.optional()
      })
    )
    .max(1_000),
  truncated: z.boolean()
});
