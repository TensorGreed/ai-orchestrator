import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";

/**
 * An HTTP Request node got a status outside 200–299 and is set to fail on it.
 * `retryable` says whether the status is on the node's retry list;
 * `retryAfterMs` is the server's Retry-After, when it sent one.
 * The message names the method and the URL without credentials or query.
 */
export class HttpStatusError extends WorkflowError {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message, ErrorCategory.HTTP_STATUS, retryable, { status });
    this.name = "HttpStatusError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  static fromResponse(options: { status: number; statusText?: string; method: string; safeUrl: string; retryable: boolean; retryAfterMs?: number }): HttpStatusError {
    const reason = options.statusText?.trim() ? ` ${options.statusText.trim()}` : "";
    return new HttpStatusError(`HTTP ${options.status}${reason} from ${options.method} ${options.safeUrl}`, options.status, options.retryable, options.retryAfterMs);
  }

  /** The same failure, final: `note` says why it is not retried. */
  final(note: string): HttpStatusError {
    return new HttpStatusError(`${this.message}; ${note}`, this.status, false);
  }
}

/** The system error code under a failed `fetch` (ECONNREFUSED, ENOTFOUND, ...), when there is one. */
function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True for a failure of the connection itself (`fetch failed`, a DNS or
 * socket error), as opposed to a refusal by the outbound policy or a rule.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const code = networkErrorCode(error);
  return code !== undefined && code !== "EOUTBOUNDBLOCKED";
}

/** A network failure as a retryable error that names the request (the URL already without credentials or query). */
export function httpNetworkError(error: unknown, method: string, safeUrl: string): WorkflowError {
  const message = error instanceof Error ? error.message : String(error);
  const code = networkErrorCode(error);
  const detail = code && !message.includes(code) ? `${message} (${code})` : message;
  return new WorkflowError(
    `HTTP Request ${method} ${safeUrl} failed: ${detail}`,
    ErrorCategory.CONNECTOR_TRANSIENT,
    true,
    { ...(code ? { code } : {}) },
    "The server could not be reached. Check the URL and that the server is up and reachable from the API host; the node retries network errors as set under Retries on Failure."
  );
}
