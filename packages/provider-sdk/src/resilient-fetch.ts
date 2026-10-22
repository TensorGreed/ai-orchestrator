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

export interface ResilientFetchRetryInfo {
  provider: string;
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  maxRetries: number;
  /** How long the request waits before the next attempt. */
  delayMs: number;
  reason: "status" | "timeout" | "network";
  status?: number;
}

export interface ResilientFetchOptions {
  /** Maximum number of retry attempts (default 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 1000) */
  baseDelayMs?: number;
  /** Per-attempt timeout in ms for the response headers (default 60000) */
  timeoutMs?: number;
  /** HTTP status codes that trigger a retry (default [408, 429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
  /** Provider identifier for error messages */
  provider?: string;
  /**
   * Called before each backoff wait, so callers can show that the request is
   * being retried instead of looking stuck. Never receives request bodies,
   * headers or URLs.
   */
  onRetry?: (info: ResilientFetchRetryInfo) => void;
}

export interface BoundedReadOptions {
  /** Upper bound for the read, in ms. */
  timeoutMs: number;
  /** Caller's abort signal (run canceled or timed out). */
  signal?: AbortSignal;
  /** Provider identifier for error messages */
  provider: string;
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

/**
 * The error a provider throws for a non-OK response once retries are done. It keeps the
 * status category (auth, quota, transient) so the node shows the matching fix.
 */
export function providerHttpError(provider: string, status: number, message: string): LLMProviderError {
  return new LLMProviderError({
    message,
    provider,
    category: categorizeStatus(status),
    statusCode: status,
    retryAttempts: 0,
    retryable: DEFAULT_RETRYABLE_STATUSES.has(status)
  });
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

function describeAbortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  return "aborted by caller";
}

function abortedByCaller(provider: string, signal: AbortSignal, retryAttempts: number, cause?: Error): LLMProviderError {
  const reason: unknown = signal.reason;
  return new LLMProviderError({
    message: `Request to ${provider} was aborted: ${describeAbortReason(signal)}`,
    provider,
    category: ErrorCategory.TIMEOUT,
    retryAttempts,
    retryable: false,
    cause: cause ?? (reason instanceof Error ? reason : undefined)
  });
}

/** Backoff wait that ends early, with the caller's abort error, when `signal` aborts. */
function sleep(ms: number, provider: string, retryAttempts: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortedByCaller(provider, signal, retryAttempts));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(handle);
      reject(abortedByCaller(provider, signal as AbortSignal, retryAttempts));
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function notifyRetry(options: ResilientFetchOptions | undefined, info: ResilientFetchRetryInfo): void {
  if (!options?.onRetry) {
    return;
  }
  try {
    options.onRetry(info);
  } catch {
    // A failing observer never changes the request outcome.
  }
}

/**
 * Reads one chunk from a response body, bounded by `timeoutMs` and the
 * caller's abort signal. On timeout or abort the reader is canceled, which
 * releases the connection, and an `LLMProviderError` is thrown.
 */
export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: BoundedReadOptions & { timeoutMessage?: string }
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const { provider, signal } = options;
  if (signal?.aborted) {
    void reader.cancel().catch(() => undefined);
    throw abortedByCaller(provider, signal, 0);
  }
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new LLMProviderError({
          message: options.timeoutMessage ?? `${provider} sent no data for ${timeoutMs}ms.`,
          provider,
          category: ErrorCategory.TIMEOUT,
          retryAttempts: 0,
          retryable: false
        })
      );
    }, timeoutMs);
    if (signal) {
      onAbort = () => reject(abortedByCaller(provider, signal, 0));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([reader.read(), interrupted]);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal?.aborted && !(error instanceof LLMProviderError)) {
      throw abortedByCaller(provider, signal, 0, error instanceof Error ? error : undefined);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Reads a whole response body as text within `timeoutMs`. `fetch` resolves
 * once headers arrive, so without a bound a server that stalls mid-body
 * would hang the call forever.
 */
export async function readResponseText(response: Response, options: BoundedReadOptions): Promise<string> {
  if (!response.body) {
    return "";
  }
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const deadline = Date.now() + timeoutMs;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  while (true) {
    const { done, value } = await readStreamChunk(reader, {
      ...options,
      timeoutMs: Math.max(1, deadline - Date.now()),
      timeoutMessage: `${options.provider} response body was not fully received within ${timeoutMs}ms.`
    });
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * How long a streaming response may go without sending a byte before it is
 * treated as hung: `extra.streamIdleTimeoutMs` when set, else the request's
 * own timeout (so a slow model gets as long between chunks as it gets for
 * its first response).
 */
export function streamIdleTimeoutMs(extra: Record<string, unknown> | undefined, fallbackMs: number): number {
  const configured = extra?.streamIdleTimeoutMs;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return fallbackMs;
}

/** `readResponseText` followed by `JSON.parse`. */
export async function readResponseJson<T>(response: Response, options: BoundedReadOptions): Promise<T> {
  return JSON.parse(await readResponseText(response, options)) as T;
}

/**
 * Fetch wrapper with retry, exponential backoff, per-attempt timeout,
 * and rate-limit header awareness.
 *
 * Retries on: network errors, timeouts, and configurable HTTP statuses.
 * Respects `Retry-After` headers on 429 responses. `init.signal` (the run's
 * abort signal) stops the current attempt and any backoff wait at once.
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
  const existingSignal = init?.signal ?? undefined;

  let lastError: Error | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (existingSignal?.aborted) {
      throw abortedByCaller(provider, existingSignal, attempt);
    }

    // The per-attempt timeout covers the wait for response headers. The
    // caller's signal stays linked for the life of the response, so aborting
    // it also stops a body or stream read that is still in progress.
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const signal = existingSignal ? AbortSignal.any([controller.signal, existingSignal]) : controller.signal;

    try {
      const response = await fetch(url, {
        ...init,
        signal
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
        const errorBody = await readResponseText(response, { timeoutMs, signal: existingSignal, provider }).catch(
          (error: unknown) => {
            if (existingSignal?.aborted) {
              throw error;
            }
            return "";
          }
        );

        // Don't retry 429 quota errors that indicate daily/billing limits (not transient rate limits)
        if (response.status === 429 && /quota|billing|exceeded.*plan|limit: 0/i.test(errorBody)) {
          lastError = new Error(
            `${provider} returned ${response.status}: ${errorBody.slice(0, 500)}`
          );
          // Return the response clone-equivalent so the caller can handle it
          return new Response(errorBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }

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

        notifyRetry(options, { provider, attempt: attempt + 1, maxRetries, delayMs, reason: "status", status: response.status });
        await sleep(delayMs, provider, attempt + 1, existingSignal);
        continue;
      }

      // Last attempt, return the response for caller to handle
      return response;
    } catch (error) {
      if (error instanceof LLMProviderError) {
        throw error;
      }
      const isAbort = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      const isNetwork =
        error instanceof TypeError ||
        (error instanceof Error && /fetch|network|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket/i.test(error.message));

      lastError = error instanceof Error ? error : new Error(String(error));

      if (existingSignal?.aborted) {
        // External abort (run canceled or timed out) — don't retry. The
        // signal's reason may be any value, so this check does not depend on
        // the error's name.
        throw abortedByCaller(provider, existingSignal, attempt, lastError);
      }

      if (attempt < maxRetries && (isAbort || isNetwork)) {
        const delayMs = computeBackoffDelay(attempt, baseDelayMs);
        notifyRetry(options, { provider, attempt: attempt + 1, maxRetries, delayMs, reason: isAbort ? "timeout" : "network" });
        await sleep(delayMs, provider, attempt + 1, existingSignal);
        continue;
      }

      // Exhausted retries or non-retryable network error
      throw new LLMProviderError({
        message: `${provider} request failed after ${attempt + 1} attempt(s): ${isAbort ? `no response within ${timeoutMs}ms` : lastError.message}`,
        provider,
        category: isAbort ? ErrorCategory.TIMEOUT : ErrorCategory.NETWORK,
        retryAttempts: attempt + 1,
        retryable: false,
        cause: lastError
      });
    } finally {
      clearTimeout(timeoutHandle);
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
