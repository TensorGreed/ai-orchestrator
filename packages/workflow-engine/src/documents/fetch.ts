import { createHash } from "node:crypto";
import { BodyTooLargeError, CONTENT_SCAN_LIMITS, readBodyCapped } from "@ai-orchestrator/shared";
import type { DnsResolver } from "@ai-orchestrator/guard-sdk";
import { guardedFetch, OutboundUrlBlockedError, type OutboundGuardConfig } from "../outbound-url-guard.js";
import { DocumentError } from "./errors.js";

/**
 * Fetches a document through the outbound URL checks: `guardedFetch` pins each connection to the addresses it vetted
 * (DNS-rebinding safe), re-checks every redirect hop and drops credential headers across origins. On top of that:
 * no cookies or credentials are ever sent (and a URL with a user name or password is refused), redirects are capped,
 * an optional host allow-list is checked on every hop, the body is read with a cap on decoded bytes (and on the
 * expansion of a compressed body), and there is a first-byte timeout and a total one.
 */

export interface DocumentFetchOptions {
  outbound: OutboundGuardConfig;
  resolver?: DnsResolver;
  /** Replaces the pinned fetch (tests only: the connection is then not pinned). */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  firstByteTimeoutMs?: number;
  maxRedirects?: number;
  /** Checked on the URL and on every redirect target; false refuses the fetch (host_not_allowed). */
  allowHost?: (host: string) => boolean;
  signal?: AbortSignal;
}

export interface FetchedDocument {
  bytes: Uint8Array;
  /** The response's Content-Type (null when absent). */
  mediaType: string | null;
  /** The URL's origin and a hash of its path and query: what may be logged (paths and queries carry ids and tokens). */
  origin: string;
  pathHash: string;
}

const ACCEPT = "text/html, text/plain, text/markdown, text/csv, application/json;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.1";

/** The loggable form of a URL: its origin and the first 16 hex characters of SHA-256(path + query). */
export function urlLogRef(url: URL): { origin: string; pathHash: string } {
  return { origin: url.origin, pathHash: createHash("sha256").update(`${url.pathname}${url.search}`).digest("hex").slice(0, 16) };
}

function parseDocumentUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DocumentError("invalid_url", "The URL could not be parsed");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DocumentError("blocked_url", "Only http and https URLs can be fetched", "scheme");
  if (url.username || url.password) throw new DocumentError("invalid_url", "URLs with a user name or password are not accepted; credentials are never sent");
  url.hash = "";
  return url;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export async function fetchDocument(rawUrl: string, options: DocumentFetchOptions): Promise<FetchedDocument> {
  const url = parseDocumentUrl(rawUrl);
  const ref = urlLogRef(url);
  if (options.allowHost && !options.allowHost(hostOf(url))) throw new DocumentError("host_not_allowed", `Host '${hostOf(url)}' is not on this toolset's list of document hosts`);
  const maxBytes = options.maxBytes ?? CONTENT_SCAN_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? CONTENT_SCAN_LIMITS.fetchTimeoutMs;
  const firstByteTimeoutMs = Math.min(options.firstByteTimeoutMs ?? CONTENT_SCAN_LIMITS.firstByteTimeoutMs, timeoutMs);

  const controller = new AbortController();
  let timedOut: "total" | "first_byte" | null = null;
  const total = setTimeout(() => {
    timedOut = "total";
    controller.abort();
  }, timeoutMs);
  let firstByte: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = "first_byte";
    controller.abort();
  }, firstByteTimeoutMs);
  const clearFirstByte = () => {
    if (firstByte) clearTimeout(firstByte);
    firstByte = undefined;
  };
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await guardedFetch(
        url.toString(),
        {
          method: "GET",
          headers: { accept: ACCEPT, "accept-encoding": "gzip, br, deflate", "user-agent": "L2M-content-rules-document-scan/1.0" },
          credentials: "omit",
          signal: controller.signal
        },
        {
          config: options.outbound,
          ...(options.resolver ? { resolver: options.resolver } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          maxRedirects: options.maxRedirects ?? CONTENT_SCAN_LIMITS.maxRedirects,
          onRedirect: async (next) => {
            const target = parseDocumentUrl(next);
            if (options.allowHost && !options.allowHost(hostOf(target))) {
              throw new DocumentError("host_not_allowed", `The URL redirected to host '${hostOf(target)}', which is not on this toolset's list of document hosts`);
            }
          }
        }
      );
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      if (error instanceof OutboundUrlBlockedError) throw new DocumentError("blocked_url", error.message, error.reason);
      if (timedOut) throw new DocumentError("timeout", timedOut === "first_byte" ? `The server did not answer within ${firstByteTimeoutMs} ms` : `The document did not arrive within ${timeoutMs} ms`);
      throw new DocumentError("fetch_failed", "The document could not be fetched (network error)");
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw new DocumentError("fetch_failed", `The server answered with HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    const encoded = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
    if ((!encoded || encoded === "identity") && Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new DocumentError("too_large", `The document is larger than ${maxBytes} bytes`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBodyCapped(response, maxBytes, { maxExpansion: CONTENT_SCAN_LIMITS.maxExpansion, onChunk: clearFirstByte });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new DocumentError("too_large", error.reason === "expansion" ? "The compressed document expands far beyond its size, so it was not read" : `The document is larger than ${maxBytes} bytes`);
      }
      if (timedOut) throw new DocumentError("timeout", timedOut === "first_byte" ? `The server did not send the document within ${firstByteTimeoutMs} ms` : `The document did not arrive within ${timeoutMs} ms`);
      throw new DocumentError("fetch_failed", "The document could not be read (the connection failed or the encoding was invalid)");
    }
    return { bytes, mediaType: response.headers.get("content-type"), ...ref };
  } finally {
    clearTimeout(total);
    clearFirstByte();
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
