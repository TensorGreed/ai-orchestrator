import { isMrtrMethod } from "./constants";

/**
 * MCP 2026-07-28 — `resultType`. Every modern result says what it is:
 * `complete` (the final content) or `input_required` (the server needs input
 * before it can finish; see `mrtr.ts`). Extensions may add values, but only
 * for extensions the client declared, and L2M declares none, so any other
 * value is invalid. A result without `resultType` comes from an older server
 * and counts as `complete`.
 */

export const MCP_RESULT_TYPE_COMPLETE = "complete";
export const MCP_RESULT_TYPE_INPUT_REQUIRED = "input_required";

/** One server-to-client request inside an `input_required` result. */
export interface McpInputRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface McpInputRequiredResult {
  /** Keyed by server-assigned ids; empty when the server sent none. */
  inputRequests: Record<string, McpInputRequest>;
  /** Opaque; echoed back byte for byte on the retry, never inspected, logged or stored. */
  requestState?: string;
}

export type ClassifiedMcpResult =
  | { resultType: "complete"; result: Record<string, unknown> }
  | { resultType: "input_required"; inputRequired: McpInputRequiredResult };

/** A result the client must not accept: an unknown `resultType`, or a malformed `input_required`. */
export class McpInvalidResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInvalidResultError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseInputRequired(method: string, result: Record<string, unknown>): McpInputRequiredResult {
  if (!isMrtrMethod(method)) {
    throw new McpInvalidResultError(`The server answered ${method} with input_required, which only tools/call, resources/read and prompts/get allow.`);
  }
  const inputRequests: Record<string, McpInputRequest> = {};
  if (result.inputRequests !== undefined) {
    if (!isRecord(result.inputRequests)) throw new McpInvalidResultError("input_required result has an inputRequests that is not an object.");
    for (const [key, raw] of Object.entries(result.inputRequests)) {
      if (!isRecord(raw) || typeof raw.method !== "string" || !raw.method) {
        throw new McpInvalidResultError(`input_required result has an input request '${key}' without a method.`);
      }
      if (raw.params !== undefined && !isRecord(raw.params)) {
        throw new McpInvalidResultError(`input_required result has an input request '${key}' whose params are not an object.`);
      }
      inputRequests[key] = { method: raw.method, ...(raw.params !== undefined ? { params: raw.params as Record<string, unknown> } : {}) };
    }
  }
  if (result.requestState !== undefined && typeof result.requestState !== "string") {
    throw new McpInvalidResultError("input_required result has a requestState that is not a string.");
  }
  const requestState = result.requestState as string | undefined;
  if (Object.keys(inputRequests).length === 0 && requestState === undefined) {
    throw new McpInvalidResultError("input_required result has neither inputRequests nor requestState.");
  }
  return { inputRequests, ...(requestState !== undefined ? { requestState } : {}) };
}

/**
 * Classify the `result` of a response to `method`. Throws
 * `McpInvalidResultError` for a result that is not an object, a `resultType`
 * that is not a known string, an `input_required` answer to a method that
 * may not return one, or an `input_required` result without
 * `inputRequests` and `requestState`. Meant for modern servers; results from
 * legacy servers never carry `resultType` and classify as `complete`.
 */
export function classifyMcpResult(method: string, result: unknown): ClassifiedMcpResult {
  if (!isRecord(result)) throw new McpInvalidResultError(`The server's ${method} result is not an object.`);
  const type = result.resultType;
  if (type === undefined || type === MCP_RESULT_TYPE_COMPLETE) return { resultType: "complete", result };
  if (type === MCP_RESULT_TYPE_INPUT_REQUIRED) return { resultType: "input_required", inputRequired: parseInputRequired(method, result) };
  const shown = typeof type === "string" ? `'${type.slice(0, 64)}'` : `of type ${Array.isArray(type) ? "array" : typeof type}`;
  throw new McpInvalidResultError(`The server's ${method} result has resultType ${shown}, which this client does not support.`);
}
