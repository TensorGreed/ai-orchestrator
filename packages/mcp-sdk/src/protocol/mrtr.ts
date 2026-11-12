import { createHash } from "node:crypto";
import type { McpElicitationRequest, McpSamplingRequest } from "@ai-orchestrator/shared";
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_REQUEST_REFUSED,
  McpServerRequestError,
  buildClientCapabilities,
  declinedElicitation,
  validateElicitationRequest,
  validateSamplingRequest
} from "../client-features";
import { McpTimeoutError } from "../errors";
import { cancelReason } from "../progress";
import type { MCPExecutionContext, McpServerRequestOrigin } from "../types";
import type { McpMrtrMethod } from "./constants";
import { classifyMcpResult, type McpInputRequest } from "./result";

/**
 * MCP 2026-07-28 — Multi Round-Trip Requests. A modern server never sends
 * the client a request of its own; it answers `tools/call`, `resources/read`
 * or `prompts/get` with `resultType: "input_required"`, listing what it
 * needs (`elicitation/create`, `sampling/createMessage`, `roots/list`) and
 * perhaps an opaque `requestState`. The client gathers the answers and sends
 * the original request again as a new request (new JSON-RPC id) with
 * `inputResponses` and the exact `requestState`.
 *
 * One engine serves both adapters. It answers input requests with the same
 * validation and the same context handlers that answer legacy server
 * requests (`answerServerRequest`), so elicitation forms, credential-field
 * refusal, sampling rules, model allowlists, budgets and cassette capture
 * behave the same in both eras.
 *
 * Differences from the legacy path, because MRTR has no per-request error
 * answer: an input request the client did not declare a capability for, a
 * malformed one, and a sampling request the handler refuses all end the
 * call with `McpInputRequestError` instead of being sent back as JSON-RPC
 * errors. An elicitation without a handler is declined, as today.
 */

/** Rounds after the first request before the engine gives up. */
export const DEFAULT_MRTR_MAX_ROUNDS = 5;

export type McpInputRequestFailure =
  /** The server asked for something the client never declared (always the case for `roots/list`). */
  | "undeclared"
  /** The input request was malformed. */
  | "invalid"
  /** The handler refused it (sampling rules, budgets, no model attached). */
  | "refused";

/** An input request could not be answered; the call ends. */
export class McpInputRequestError extends Error {
  constructor(
    message: string,
    readonly reason: McpInputRequestFailure,
    readonly inputKey: string,
    readonly inputMethod: string,
    /** The JSON-RPC style code the legacy path would have answered with. */
    readonly code: number
  ) {
    super(message);
    this.name = "McpInputRequestError";
  }
}

/** The server kept asking for input past the round limit. */
export class McpMrtrRoundLimitError extends Error {
  constructor(
    message: string,
    readonly rounds: number
  ) {
    super(message);
    this.name = "McpMrtrRoundLimitError";
  }
}

/** Thrown when the run's abort signal fires between rounds or before a handler runs. */
export class McpMrtrCanceledError extends Error {
  constructor(message: string) {
    super(message);
    // The adapters' cancel error has this name; `classifyMcpError` maps it to "canceled", so both report alike.
    this.name = "McpRequestCanceledError";
  }
}

/** Length and SHA-256 of a `requestState`: what traces may record instead of the value. */
export interface McpRequestStateFingerprint {
  length: number;
  sha256: string;
}

export function requestStateFingerprint(requestState: string): McpRequestStateFingerprint {
  return { length: requestState.length, sha256: createHash("sha256").update(requestState, "utf-8").digest("hex") };
}

/** What one `input_required` round asked for, for traces. Never carries `requestState` itself. */
export interface McpMrtrRoundInfo {
  /** 1 for the first `input_required` answer. */
  round: number;
  method: McpMrtrMethod;
  inputRequests: Array<{ key: string; method: string }>;
  requestState?: McpRequestStateFingerprint;
}

export interface McpMrtrOptions {
  /** Supplies `onElicitation`, `onSampling` and the abort signal. */
  context: Pick<MCPExecutionContext, "onElicitation" | "onSampling" | "signal">;
  origin: McpServerRequestOrigin;
  /**
   * The capabilities the requests declared in `_meta`. Defaults to what
   * `buildClientCapabilities(context)` declares. An input request for a
   * capability not in it is refused.
   */
  clientCapabilities?: Record<string, unknown>;
  /** Default `DEFAULT_MRTR_MAX_ROUNDS`. */
  maxRounds?: number;
  /**
   * Epoch milliseconds after which no further round starts (the node's own
   * timeout). It does not interrupt a handler that is waiting for a person;
   * the run's abort signal and the handler's own deadline do that.
   */
  deadlineAt?: number;
  /** Called once per `input_required` answer, before its input requests are handled. */
  onRound?: (info: McpMrtrRoundInfo) => void;
}

/**
 * Sends one request and returns the JSON-RPC `result` of its response. The
 * engine calls it once per round with the full params; each call must be a
 * new JSON-RPC request with a new id, carrying the same `_meta` and (on
 * HTTP) headers derived from these params. JSON-RPC errors are thrown.
 */
export type McpMrtrSend = (params: Record<string, unknown>, round: number) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new McpMrtrCanceledError(`MCP request canceled: ${cancelReason(signal)}`);
}

/**
 * The answer to one input request, as an `inputResponses` value. Throws
 * `McpInputRequestError` when it cannot be answered.
 */
export async function answerInputRequest(key: string, request: McpInputRequest, options: McpMrtrOptions): Promise<Record<string, unknown>> {
  const { context, origin } = options;
  const declared = options.clientCapabilities ?? buildClientCapabilities(context);
  const fail = (reason: McpInputRequestFailure, message: string, code: number): never => {
    throw new McpInputRequestError(message, reason, key, request.method, code);
  };
  switch (request.method) {
    case "elicitation/create": {
      const capability = declared.elicitation;
      const mode = request.params?.mode;
      const formDeclared = isRecord(capability) && (Object.keys(capability).length === 0 || isRecord(capability.form));
      const modeDeclared =
        mode === undefined || mode === "form" ? formDeclared : mode === "url" && isRecord(capability) && isRecord(capability.url);
      if (!modeDeclared) {
        fail("undeclared", `The server asked for a ${typeof mode === "string" ? `${mode} ` : ""}elicitation, which this client did not declare.`, JSON_RPC_REQUEST_REFUSED);
      }
      let parsed: McpElicitationRequest;
      try {
        parsed = validateElicitationRequest(request.params);
      } catch (error) {
        return fail("invalid", errorMessage(error, "Invalid elicitation request."), JSON_RPC_INVALID_PARAMS);
      }
      if (!context.onElicitation) return { ...declinedElicitation() };
      throwIfCanceled(context.signal);
      const result = await context.onElicitation(parsed, origin);
      return result.action === "accept" ? { action: "accept", content: result.content ?? {} } : { action: result.action };
    }
    case "sampling/createMessage": {
      if (!isRecord(declared.sampling)) {
        fail("undeclared", "The server asked for sampling, which this client did not declare for this call.", JSON_RPC_REQUEST_REFUSED);
      }
      let parsed: McpSamplingRequest;
      try {
        parsed = validateSamplingRequest(request.params);
      } catch (error) {
        return fail("invalid", errorMessage(error, "Invalid sampling request."), JSON_RPC_INVALID_PARAMS);
      }
      if (!context.onSampling) {
        return fail("refused", "Sampling is not available for this call: no model is attached to it.", JSON_RPC_REQUEST_REFUSED);
      }
      throwIfCanceled(context.signal);
      try {
        const result = await context.onSampling(parsed, origin);
        return { role: "assistant", content: result.content, model: result.model, ...(result.stopReason ? { stopReason: result.stopReason } : {}) };
      } catch (error) {
        if (error instanceof McpServerRequestError) return fail("refused", error.message, error.code);
        throw error;
      }
    }
    default:
      return fail("undeclared", `The server asked for ${JSON.stringify(request.method.slice(0, 80))}, which this client does not support.`, JSON_RPC_METHOD_NOT_FOUND);
  }
}

/**
 * Run a `tools/call`, `resources/read` or `prompts/get` request to
 * completion: send it, and while the server answers `input_required`,
 * answer its input requests in order and send the request again with
 * `inputResponses` and the exact `requestState` (left out when the server
 * sent none). `inputResponses` and `requestState` from the original params
 * are never carried into a round they do not belong to. Returns the
 * `complete` result.
 *
 * Throws `McpInvalidResultError` for an invalid result,
 * `McpInputRequestError` for an input request that cannot be answered,
 * `McpMrtrRoundLimitError` past `maxRounds`, `McpTimeoutError` past
 * `deadlineAt` and `McpMrtrCanceledError` when the signal fires. Errors
 * from `send` and from the handlers propagate.
 */
export async function runMrtrRequest(
  method: McpMrtrMethod,
  params: Record<string, unknown>,
  send: McpMrtrSend,
  options: McpMrtrOptions
): Promise<Record<string, unknown>> {
  const maxRounds = Math.max(0, Math.floor(options.maxRounds ?? DEFAULT_MRTR_MAX_ROUNDS));
  const original: Record<string, unknown> = { ...params };
  delete original.inputResponses;
  delete original.requestState;
  let next: Record<string, unknown> = original;
  for (let round = 0; ; round += 1) {
    throwIfCanceled(options.context.signal);
    if (round > 0 && options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
      throw new McpTimeoutError(`MCP ${method} ran out of time after ${round} input round${round === 1 ? "" : "s"}.`);
    }
    const classified = classifyMcpResult(method, await send(next, round));
    if (classified.resultType === "complete") return classified.result;
    const { inputRequests, requestState } = classified.inputRequired;
    if (round + 1 > maxRounds) {
      throw new McpMrtrRoundLimitError(
        `The server kept asking for more input on ${method}; stopped after ${maxRounds} round${maxRounds === 1 ? "" : "s"}.`,
        maxRounds
      );
    }
    const entries = Object.entries(inputRequests);
    options.onRound?.({
      round: round + 1,
      method,
      inputRequests: entries.map(([key, request]) => ({ key, method: request.method })),
      ...(requestState !== undefined ? { requestState: requestStateFingerprint(requestState) } : {})
    });
    const inputResponses: Record<string, unknown> = {};
    for (const [key, request] of entries) {
      Object.defineProperty(inputResponses, key, { value: await answerInputRequest(key, request, options), enumerable: true, writable: true, configurable: true });
    }
    throwIfCanceled(options.context.signal);
    next = {
      ...original,
      ...(entries.length > 0 ? { inputResponses } : {}),
      ...(requestState !== undefined ? { requestState } : {})
    };
  }
}
