/**
 * Node retries and HTTP status handling, shared by the engine (which acts on
 * them) and the editor (which shows and checks them).
 */

/** The status codes an HTTP Request node retries when none are listed: 429 and every 5xx. */
export const DEFAULT_HTTP_RETRY_ON_STATUS = "429, 5xx";

/** The longest wait between two retries of a node when it sets none (30 s). */
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/** Jitter spreads each retry wait over ±20% of its exponential value. */
export const RETRY_JITTER_RATIO = 0.2;

export interface ParsedStatusList {
  /** Inclusive [from, to] ranges. */
  ranges: Array<[number, number]>;
  /** Entries that are not a status code (100–599), an `Nxx` class or a `from-to` range. */
  invalid: string[];
}

/**
 * Reads a status list such as `"429, 5xx"`, `"500-504 408"` or `[429, 503]`.
 * Accepts single codes, `Nxx` classes and `from-to` ranges, separated by commas or spaces.
 */
export function parseStatusList(value: unknown): ParsedStatusList {
  const entries: string[] = Array.isArray(value)
    ? value.map((entry) => String(entry).trim())
    : typeof value === "string"
      ? value.split(/[\s,;]+/)
      : typeof value === "number"
        ? [String(value)]
        : [];
  const ranges: Array<[number, number]> = [];
  const invalid: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const klass = /^([1-5])xx$/.exec(entry);
    if (klass) {
      const base = Number(klass[1]) * 100;
      ranges.push([base, base + 99]);
      continue;
    }
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(entry);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (isStatusCode(from) && isStatusCode(to) && from <= to) {
        ranges.push([from, to]);
        continue;
      }
    }
    if (/^\d{3}$/.test(entry) && isStatusCode(Number(entry))) {
      ranges.push([Number(entry), Number(entry)]);
      continue;
    }
    invalid.push(raw.trim());
  }
  return { ranges, invalid };
}

function isStatusCode(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

/** True when `status` is in the list (an empty or missing list means the default, 429 and 5xx). */
export function statusInList(status: number, value: unknown): boolean {
  const configured = value === undefined || value === null || (typeof value === "string" && !value.trim()) ? DEFAULT_HTTP_RETRY_ON_STATUS : value;
  return parseStatusList(configured).ranges.some(([from, to]) => status >= from && status <= to);
}

interface RetrySettingsLike {
  retryOnFail?: boolean;
}

/** True when the node asks for retries itself (Retries on Failure above 0, `retry.enabled` or `errorConfig.retryOnFail`). */
export function nodeSetsRetries(config: Record<string, unknown> | undefined, errorConfig?: RetrySettingsLike): boolean {
  if (errorConfig?.retryOnFail === true) return true;
  if (!config) return false;
  if (typeof config.retryCount === "number" && Number.isFinite(config.retryCount) && config.retryCount > 0) return true;
  const retry = config.retry;
  return Boolean(retry && typeof retry === "object" && (retry as Record<string, unknown>).enabled === true);
}

/**
 * Which error statuses (outside 200–299) fail an HTTP Request node:
 * - `all`: every one (`failOnHttpError: true`, stored on new nodes);
 * - `retry_list`: only those on its retry list, once retries are spent, for a
 *   node saved before the option existed that asks for retries; it returns
 *   other error statuses with `ok: false` as before;
 * - `none`: none (`failOnHttpError: false`, or an older node without retries).
 */
export type HttpErrorStatusMode = "all" | "retry_list" | "none";

export function httpErrorStatusMode(config: Record<string, unknown> | undefined, errorConfig?: RetrySettingsLike): HttpErrorStatusMode {
  if (typeof config?.failOnHttpError === "boolean") return config.failOnHttpError ? "all" : "none";
  return nodeSetsRetries(config, errorConfig) ? "retry_list" : "none";
}

/** True when the status fails the node under its mode (304 Not Modified never does). */
export function httpStatusFailsNode(status: number, config: Record<string, unknown> | undefined, errorConfig?: RetrySettingsLike): boolean {
  if (status >= 200 && status < 300) return false;
  if (status === 304) return false;
  const mode = httpErrorStatusMode(config, errorConfig);
  if (mode === "all") return true;
  if (mode === "retry_list") return statusInList(status, config?.retryOnStatus);
  return false;
}

export interface RetryBackoff {
  /** The first wait, in ms. */
  delayMs: number;
  /** Each later wait is this many times the one before (≥ 1). */
  backoffMultiplier: number;
  /** No wait is longer than this, in ms. */
  maxDelayMs: number;
}

/**
 * The wait before retry number `attempt` (1 = the wait after the first
 * failure): exponential, capped, with ±20% jitter (`random` in [0, 1)).
 */
export function retryDelayFor(backoff: RetryBackoff, attempt: number, random: number = Math.random()): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(backoff.maxDelayMs, backoff.delayMs * Math.pow(Math.max(1, backoff.backoffMultiplier), exponent));
  if (base <= 0) return 0;
  const factor = 1 - RETRY_JITTER_RATIO + 2 * RETRY_JITTER_RATIO * Math.min(Math.max(random, 0), 1);
  return Math.max(0, Math.min(backoff.maxDelayMs, Math.round(base * factor)));
}

/** Reads a `Retry-After` header (seconds or an HTTP date) as ms from `now`; undefined when absent or unreadable. */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
