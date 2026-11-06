/**
 * 12.6b — what a /v1 request is charged when the provider's own usage is missing or partial: a caller that hung up
 * before the usage frame, a server that sends none, a stream cut by a content rule, a provider failure. Budgets count
 * tokens and cost from the usage row, so a request that reached the provider must never record zero.
 *
 * Every number here leans high. The estimate is flagged on the row (`usageEstimated`).
 */
import type { LLMUsage } from "@ai-orchestrator/shared";

/**
 * Three UTF-8 bytes a token. English runs nearer four characters a token and Chinese or Japanese nearer one character
 * (three bytes), so this holds for both and overstates English by about a third. The chars/4 of the echo provider is a
 * display figure: it would undercount those languages fourfold.
 */
const BYTES_PER_TOKEN = 3;

/** An image's flat charge, at the top of what providers bill for one image; its base64 size says nothing about tokens. */
const TOKENS_PER_IMAGE = 1600;

/** Output that may have been produced but never read when the gateway stopped reading: the least to allow. */
const MIN_UNSEEN_OUTPUT_TOKENS = 256;

/** A fast provider's output rate, for how much it may have produced while nothing reached the gateway. */
const UNSEEN_OUTPUT_TOKENS_PER_SECOND = 100;

export interface UsageEstimate {
  input: number;
  output: number;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

/** A provider request's input tokens: everything in it but the route's own settings, images at a flat rate. */
export function estimateRequestTokens<T extends { provider: unknown }>(request: T): number {
  const { provider: _provider, ...sent } = request;
  let images = 0;
  const text = JSON.stringify(sent, (key, value: unknown) => {
    if (key !== "images" || !Array.isArray(value)) return value;
    images += value.length;
    return undefined;
  });
  return estimateTextTokens(text) + images * TOKENS_PER_IMAGE;
}

/** The output tokens of an answer the gateway received. */
export function estimateAnswerTokens(text: string, toolCalls: ReadonlyArray<{ name: string; arguments: string }>): number {
  return estimateTextTokens(text + toolCalls.map((call) => call.name + call.arguments).join(""));
}

/**
 * An allowance for output the gateway never read, when it stopped reading before the provider finished: time since
 * anything arrived at a fast provider's rate, at least the minimum, and never more than `maxTokens` leaves.
 */
export function unseenOutputTokens(input: { quietMs: number; seenTokens: number; maxTokens?: number | undefined }): number {
  const allowance = Math.max(MIN_UNSEEN_OUTPUT_TOKENS, Math.ceil((input.quietMs / 1000) * UNSEEN_OUTPUT_TOKENS_PER_SECOND));
  return input.maxTokens ? Math.min(allowance, Math.max(0, input.maxTokens - input.seenTokens)) : allowance;
}

const positive = (value: number | undefined): number | undefined => (typeof value === "number" && value > 0 ? value : undefined);

/**
 * What to record for a request that reached the provider: its own numbers where it gave them, the estimate for the rest.
 * Zeros count as missing, since some servers send them when they do not count. `estimate` runs only when needed.
 */
export function chargedUsage(reported: LLMUsage | undefined, estimate: () => UsageEstimate): { usage: LLMUsage; estimated: boolean } {
  const input = positive(reported?.inputTokens);
  const output = positive(reported?.outputTokens);
  const total = positive(reported?.totalTokens);
  if (input !== undefined && output !== undefined) return { usage: reported!, estimated: false };
  const guess = estimate();
  if (total !== undefined && input === undefined && output === undefined) {
    // A real total with no split: keep the total, and split it as well as can be done for the price.
    const outputTokens = Math.min(total, guess.output);
    return { usage: { ...reported, inputTokens: total - outputTokens, outputTokens, totalTokens: total }, estimated: false };
  }
  const inputTokens = input ?? guess.input;
  const outputTokens = output ?? guess.output;
  return {
    usage: { ...reported, inputTokens, outputTokens, totalTokens: Math.max(total ?? 0, inputTokens + outputTokens) },
    estimated: input === undefined || (output === undefined && guess.output > 0)
  };
}
