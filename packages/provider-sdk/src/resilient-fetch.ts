/**
 * Resilient fetch wrapper with retry, backoff, timeout, and rate-limit awareness.
 * Drop-in replacement for native fetch with automatic transient error recovery.
 */

export enum ErrorCategory {
  PROVIDER_TRANSIENT = "provider_transient",
  PROVIDER_AUTH = "provider_auth",
  PROVIDER_CONFIG = "provider_config",
  PROVIDER_QUOTA = "provider_quota",
  NETWORK = "network",
  TIMEOUT = "timeout",
  UNKNOWN = "unknown"
}

export class LLMProviderError extends Error {
  readonly category: ErrorCategory;
  readonly statusCode: number | undefined;
  readonly retryAttempts: number;
  readonly retryable: boolean;
  readonly provider: string;

  constructor(input: {
    message: string;
    provider: string;
    category: ErrorCategory;
    statusCode?: number;
    retryAttempts: number;
    retryable: boolean;
    cause?: Error;
  }) {
    super(input.message);
    this.name = "LLMProviderError";
    this.provider = input.provider;
    this.category = input.category;
    this.statusCode = input.statusCode;
    this.retryAttempts = input.retryAttempts;
    this.retryable = input.retryable;
    if (input.cause) {
      this.cause = input.cause;
    }
  }
}

export interface ResilientFetchOptions {
  /** Maximum number of retry attempts (default 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 1000) */
  baseDelayMs?: number;
  /** Per-attempt timeout in ms (default 60000) */
  timeoutMs?: number;
  /** HTTP status codes that trigger a retry (default [408, 429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
  /** Provider identifier for error messages */
  provider?: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_JITTER_MS = 500;

function categorizeStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) {
    return ErrorCategory.PROVIDER_AUTH;
  }
  if (status === 429) {
    return ErrorCategory.PROVIDER_QUOTA;
  }
  if (status >= 500) {
    return ErrorCategory.PROVIDER_TRANSIENT;
  }
  return ErrorCategory.UNKNOWN;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  // Retry-After can be seconds (integer) or a date string
  const asNumber = Number(retryAfter);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.min(asNumber * 1000, 120_000); // cap at 2 minutes
  }

  const asDate = new Date(retryAfter).getTime();
  if (Number.isFinite(asDate)) {
    const delayMs = asDate - Date.now();
    if (delayMs > 0) {
      return Math.min(delayMs, 120_000);
    }
  }

  return undefined;
}

function computeBackoffDelay(attempt: number, baseDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
  return exponentialDelay + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch wrapper with retry, exponential backoff, per-attempt timeout,
 * and rate-limit header awareness.
 *
 * Retries on: network errors, timeouts, and configurable HTTP statuses.
 * Respects `Retry-After` headers on 429 responses.
 */
export async function resilientFetch(
  url: string | URL,
  init?: RequestInit,
  options?: ResilientFetchOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryableStatuses = options?.retryableStatuses
    ? new Set(options.retryableStatuses)
    : DEFAULT_RETRYABLE_STATUSES;
  const provider = options?.provider ?? "unknown";

  let lastError: Error | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const existingSignal = init?.signal;

    // Merge external signal with our timeout signal
    if (existingSignal?.aborted) {
      throw new LLMProviderError({
        message: `Request to ${provider} was aborted before sending.`,
        provider,
        category: ErrorCategory.TIMEOUT,
        retryAttempts: attempt,
        retryable: false
      });
    }

    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    // If the caller provided their own signal, propagate abort
    const externalAbortHandler = existingSignal
      ? () => controller.abort()
      : undefined;
    if (existingSignal && externalAbortHandler) {
      existingSignal.addEventListener("abort", externalAbortHandler, { once: true });
    }

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });

      lastStatus = response.status;

      // Non-retryable failure — return immediately for caller to handle
      if (!response.ok && !retryableStatuses.has(response.status)) {
        return response;
      }

      // Success — return
      if (response.ok) {
        return response;
      }

      // Retryable status — check if we have more attempts
      if (attempt < maxRetries) {
        // Read body so the connection is freed for retry
        const errorBody = await response.text().catch(() => "");

        // Determine delay
        let delayMs: number;
        if (response.status === 429) {
          delayMs = parseRetryAfterMs(response.headers) ?? computeBackoffDelay(attempt, baseDelayMs);
        } else {
          delayMs = computeBackoffDelay(attempt, baseDelayMs);
        }

        lastError = new Error(
          `${provider} returned ${response.status}: ${errorBody.slice(0, 500)}`
        );

        await sleep(delayMs);
        continue;
      }

      // Last attempt, return the response for caller to handle
      return response;
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      const isNetwork =
        error instanceof TypeError ||
        (error instanceof Error && /fetch|network|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket/i.test(error.message));

      lastError = error instanceof Error ? error : new Error(String(error));

      if (isAbort && existingSignal?.aborted) {
        // External abort — don't retry
        throw new LLMProviderError({
          message: `Request to ${provider} was aborted by caller.`,
          provider,
          category: ErrorCategory.TIMEOUT,
          retryAttempts: attempt,
          retryable: false,
          cause: lastError
        });
      }

      if (attempt < maxRetries && (isAbort || isNetwork)) {
        const delayMs = computeBackoffDelay(attempt, baseDelayMs);
        await sleep(delayMs);
        continue;
      }

      // Exhausted retries or non-retryable network error
      throw new LLMProviderError({
        message: `${provider} request failed after ${attempt + 1} attempt(s): ${lastError.message}`,
        provider,
        category: isAbort ? ErrorCategory.TIMEOUT : ErrorCategory.NETWORK,
        retryAttempts: attempt + 1,
        retryable: false,
        cause: lastError
      });
    } finally {
      clearTimeout(timeoutHandle);
      if (existingSignal && externalAbortHandler) {
        existingSignal.removeEventListener("abort", externalAbortHandler);
      }
    }
  }

  // Should not reach here, but safety net
  throw new LLMProviderError({
    message: `${provider} request failed after ${maxRetries + 1} attempt(s)${lastStatus ? ` (last status: ${lastStatus})` : ""}: ${lastError?.message ?? "unknown error"}`,
    provider,
    category: lastStatus ? categorizeStatus(lastStatus) : ErrorCategory.UNKNOWN,
    statusCode: lastStatus,
    retryAttempts: maxRetries + 1,
    retryable: false,
    cause: lastError
  });
}
