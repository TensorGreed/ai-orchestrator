import type { McpToolErrorKind, MCPToolResult } from "@ai-orchestrator/shared";
import { JSON_RPC_INVALID_PARAMS } from "./client-features";

/**
 * Phase 10.7 — error classes the adapters throw, so a failed call can be
 * told apart: a server that is down (counts against the circuit breaker)
 * versus a server that answered "bad arguments" (does not).
 */

/** The server answered a request with a JSON-RPC error object. */
export class McpJsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    /** MCP 2026-07-28 — the error's `data` member, for errors such as -32022 whose data the client acts on. */
    readonly data?: unknown
  ) {
    super(message);
    this.name = "McpJsonRpcError";
  }
}

/**
 * MCP 2026-07-28 — a request was sent and no answer arrived (the connection
 * broke, or the response stream closed early), and it was not sent again
 * because doing so is not known to be safe: the tool is not marked
 * read-only or idempotent. The server may or may not have acted on it.
 */
export class McpOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOutcomeUnknownError";
  }
}

/**
 * MCP 2026-07-28 — a modern server refused a request with -32021
 * (MissingRequiredClientCapability): it needs a client capability the
 * request did not declare. `data.requiredCapabilities` names it.
 */
export class McpMissingClientCapabilityError extends McpJsonRpcError {
  constructor(message: string, code: number, data?: unknown) {
    super(message, code, data);
    this.name = "McpMissingClientCapabilityError";
  }
}

/** A request ran past its timeout. */
export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

/** The sandbox policy refused to start a stdio server. Never retried, never counted against the server. */
export class McpSandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSandboxPolicyError";
  }
}

/** A delegated server has no usable token for the run subject. */
export class McpDelegatedCredentialError extends Error {
  constructor(
    message: string,
    /** Where the user can connect their account, when the API knows it. */
    readonly connectUrl?: string
  ) {
    super(message);
    this.name = "McpDelegatedCredentialError";
  }
}

/** Failure kinds that say nothing about the server's health. */
const NOT_SERVER_FAILURES: ReadonlySet<McpToolErrorKind> = new Set<McpToolErrorKind>([
  "tool",
  "invalid_arguments",
  "output_validation",
  "canceled",
  "credentials",
  "sandbox",
  "rate_limited",
  "concurrency_limited",
  "circuit_open"
]);

/** True when a failure of this kind should count against the circuit breaker. */
export function isServerFailureKind(kind: McpToolErrorKind | undefined): boolean {
  return kind === undefined ? true : !NOT_SERVER_FAILURES.has(kind);
}

/** Classify an error an adapter caught while calling a tool. */
export function classifyMcpError(error: unknown, signal?: AbortSignal): McpToolErrorKind {
  if (error instanceof McpSandboxPolicyError) return "sandbox";
  if (error instanceof McpDelegatedCredentialError) return "credentials";
  if (error instanceof McpTimeoutError) return "timeout";
  if (error instanceof McpOutcomeUnknownError) return "outcome_unknown";
  // MCP 2026-07-28 -32021 from a modern server: the call needs a client capability it did not declare (no model
  // attached for sampling, say). A setup matter, not a sign the server is unhealthy.
  if (error instanceof McpMissingClientCapabilityError) return "tool";
  if (error instanceof McpJsonRpcError) return error.code === JSON_RPC_INVALID_PARAMS ? "invalid_arguments" : "protocol";
  // MCP 2026-07-28 protocol errors (`protocol/`), matched by name to keep this module free of import cycles.
  if (error instanceof Error) {
    if (error.name === "McpHeaderValueError") return "invalid_arguments";
    if (error.name === "McpInputRequestError") return (error as Error & { reason?: string }).reason === "refused" ? "tool" : "protocol";
    if (error.name === "McpInvalidResultError" || error.name === "McpMrtrRoundLimitError") return "protocol";
  }
  if (signal?.aborted) return "canceled";
  if (error instanceof Error && error.name === "McpRequestCanceledError") return "canceled";
  return "transport";
}

/**
 * The failure kind of a tool result. Adapters tag their own failures; an
 * untagged failure with content came from the tool itself, one without
 * anything is treated as a transport failure.
 */
export function toolResultErrorKind(result: MCPToolResult): McpToolErrorKind | undefined {
  if (result.ok) return undefined;
  if (result.errorKind) return result.errorKind;
  if (result.content !== undefined || (result.output !== null && result.output !== undefined)) return "tool";
  return "transport";
}
