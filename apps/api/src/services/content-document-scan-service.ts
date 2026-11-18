/**
 * Scanning documents with content rules: the bytes of an upload or a URL fetched through the outbound URL checks,
 * extracted to text segments with locations (workflow-engine `documents/`; a PDF in a worker with memory and time
 * limits), then checked with a rule set's data scan.
 *
 * Two callers:
 * - the rule set page's "Scan a document" test (`POST /api/guard/profiles/:id/scan-document`, builders): the rule set's
 *   draft, a saved version or the latest one; URL fetches follow OUTBOUND_DENY_PRIVATE and OUTBOUND_ALLOWLIST like
 *   nodes do; no rule events (a test, like a simulation), an audit entry `guard.document_scan_test`; at most 10 scans a
 *   minute per user;
 * - the gateway's `scan_document` tool (ContentRulesToolsService), whose fetches always refuse private, loopback and
 *   link-local addresses and only reach hosts on the toolset's list.
 *
 * Nothing fetched or uploaded is stored: bytes and text live for the call only, and only the URL's origin and a hash of
 * its path and query are recorded. Scans in this process are capped (CONTENT_SCAN_MAX_CONCURRENT).
 */

import { InMemoryPlaceholderBook, maskForDataClass, placeholdersIn, type DnsResolver, type GuardEntityRecognizer, type GuardProfile, type SensitiveScanRequest } from "@ai-orchestrator/guard-sdk";
import { type DocumentScanRequest, type DocumentScanResult, type DocumentSource } from "@ai-orchestrator/shared";
import {
  DocumentError,
  extractDocumentAsync,
  fetchDocument,
  nodeDnsResolver,
  scanExtractedDocument,
  sensitiveDocumentScanner,
  type DocumentFetchOptions,
  type DocumentScanOutcome,
  type ExtractedDocument,
  type OutboundGuardConfig
} from "@ai-orchestrator/workflow-engine";
import type { SafeUser } from "./auth-service.js";
import { ContentScanSettings } from "./content-scan-settings.js";

export interface ContentDocumentScanLimits {
  maxBytes: number;
  maxChars: number;
  fetchTimeoutMs: number;
  firstByteTimeoutMs: number;
  maxConcurrent: number;
}

export interface ContentDocumentScanOptions {
  limits: ContentDocumentScanLimits;
  /** The deployment's outbound policy (OUTBOUND_DENY_PRIVATE, OUTBOUND_ALLOWLIST): the rule set test's URL fetches. */
  outbound: OutboundGuardConfig;
  resolver?: DnsResolver;
  /** Tests only: replaces the pinned fetch. */
  fetchImpl?: typeof fetch;
  /** Rule set test scans a user may start per minute. Default 10. */
  testScansPerMinute?: number;
  /** The deployment's recognizer for names and addresses; absent: the built-in rules. */
  entityRecognizer?: GuardEntityRecognizer;
  /** A rule set's scan settings (warns once per version about invalid stored names and addresses options). */
  scanSettings?: ContentScanSettings;
  now?: () => number;
}

/** A busy process or a user over the test limit: answered with 429 (the message says which). */
export class DocumentScanBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentScanBusyError";
  }
}

/** The bytes and declared type of a document, with where it came from (for the result and the audit). */
export interface LoadedDocument {
  bytes: Uint8Array;
  mediaType: string | null;
  source: DocumentSource;
}

/** How long a scan waits for a free slot before it is refused. */
const SLOT_WAIT_MS = 2_000;

export class ContentDocumentScanService {
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly testScans = new Map<string, number[]>();
  private readonly gatewayClients = new Set<string>();

  private readonly scanSettings: ContentScanSettings;

  constructor(private readonly options: ContentDocumentScanOptions) {
    this.scanSettings = options.scanSettings ?? new ContentScanSettings();
  }

  get limits(): ContentDocumentScanLimits {
    return this.options.limits;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Runs `work` in one of the process's scan slots, waiting briefly for one; refuses when none frees up. */
  async withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.options.limits.maxConcurrent) {
      const acquired = await new Promise<boolean>((resolve) => {
        const waiter = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        }, SLOT_WAIT_MS);
        this.waiters.push(waiter);
      });
      if (!acquired) throw new DocumentScanBusyError("Too many documents are being scanned right now; try again shortly");
    } else {
      this.running += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      // The slot passes straight to the next waiter (the count stays), or is given back.
      if (next) next();
      else this.running -= 1;
    }
  }

  /** Counts a rule set test scan for `userId`; throws DocumentScanBusyError past the per-minute limit. */
  takeTestScan(userId: string): void {
    const limit = this.options.testScansPerMinute ?? 10;
    const now = this.now();
    const recent = (this.testScans.get(userId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= limit) {
      this.testScans.set(userId, recent);
      throw new DocumentScanBusyError(`At most ${limit} document scans a minute; try again shortly`);
    }
    recent.push(now);
    this.testScans.set(userId, recent);
    if (this.testScans.size > 10_000) {
      for (const [key, times] of this.testScans) if (times.every((at) => now - at >= 60_000)) this.testScans.delete(key);
    }
  }

  /** One document scan at a time per gateway client: refused while the client's previous one runs. */
  async forGatewayClient<T>(clientId: string, work: () => Promise<T>): Promise<T> {
    if (this.gatewayClients.has(clientId)) throw new DocumentScanBusyError("Another document scan from this client is still running; wait for it to finish");
    this.gatewayClients.add(clientId);
    try {
      return await work();
    } finally {
      this.gatewayClients.delete(clientId);
    }
  }

  /** Base64 content as bytes, refused before decoding when it cannot fit the byte limit. */
  decodeUpload(contentBase64: string): Uint8Array {
    const compact = contentBase64.replace(/\s+/g, "");
    if (compact.length === 0) throw new DocumentError("invalid_document", "The document is empty");
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) throw new DocumentError("invalid_document", "The content is not valid base64");
    if (Math.floor((compact.length * 3) / 4) - 2 > this.options.limits.maxBytes) {
      throw new DocumentError("too_large", `The document is larger than ${this.options.limits.maxBytes} bytes`);
    }
    return new Uint8Array(Buffer.from(compact, compact.includes("-") || compact.includes("_") ? "base64url" : "base64"));
  }

  /**
   * Fetches a URL. `gateway`: private, loopback and link-local addresses are always refused (whatever
   * OUTBOUND_DENY_PRIVATE says, and the allowlist cannot widen it), and only `allowHost` hosts are fetched. Otherwise
   * the deployment's outbound policy applies, as for nodes. `signal` aborts the fetch (the caller went away); DNS
   * lookups count against the fetch timeout.
   */
  async fetchUrl(url: string, scope: { gateway: true; allowHost: (target: URL) => boolean } | { gateway: false }, signal?: AbortSignal): Promise<LoadedDocument> {
    const limits = this.options.limits;
    const fetchOptions: DocumentFetchOptions = {
      outbound: scope.gateway ? { denyPrivate: true, allowlist: [] } : this.options.outbound,
      resolver: this.options.resolver ?? nodeDnsResolver,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      maxBytes: limits.maxBytes,
      timeoutMs: limits.fetchTimeoutMs,
      firstByteTimeoutMs: limits.firstByteTimeoutMs,
      ...(scope.gateway ? { allowHost: scope.allowHost } : {}),
      ...(signal ? { signal } : {})
    };
    let fetched: Awaited<ReturnType<typeof fetchDocument>>;
    try {
      fetched = await fetchDocument(url, fetchOptions);
    } catch (error) {
      // A gateway client learns that the address is refused, not what the deployment's outbound settings say.
      if (scope.gateway && error instanceof DocumentError && error.code === "blocked_url") {
        throw new DocumentError("blocked_url", "The URL cannot be fetched: its address is not allowed", error.reason);
      }
      throw error;
    }
    return { bytes: fetched.bytes, mediaType: fetched.mediaType, source: { kind: "url", origin: fetched.origin, pathHash: fetched.pathHash } };
  }

  /**
   * The document's text segments. A PDF is read in a worker under the deployment's PDF limits (configurePdfExtraction:
   * CONTENT_SCAN_MAX_PAGES, CONTENT_SCAN_PDF_TIMEOUT_MS, CONTENT_SCAN_PDF_MEMORY_MB); `signal` stops it.
   */
  async extract(document: LoadedDocument, signal?: AbortSignal): Promise<ExtractedDocument> {
    const limits = this.options.limits;
    return await extractDocumentAsync({ bytes: document.bytes, mediaType: document.mediaType, limits: { maxBytes: limits.maxBytes, maxChars: limits.maxChars }, ...(signal ? { signal } : {}) });
  }

  /**
   * Scans an extracted document with a rule set's data scan settings, and person names, locations and street addresses
   * when the request names them or the rule set runs `data.entities` (with the deployment's recognizer). The whole
   * extracted text (already capped at CONTENT_SCAN_MAX_CHARS) is checked for them.
   */
  async scan(
    extracted: ExtractedDocument,
    loaded: LoadedDocument,
    ruleSet: { id: string; version: number; profile: GuardProfile } | null,
    request: SensitiveScanRequest,
    protect?: (value: string, dataClass: string) => Promise<string>,
    signal?: AbortSignal
  ): Promise<DocumentScanOutcome> {
    const scanner = sensitiveDocumentScanner(this.scanSettings.settingsOf(ruleSet), request, {
      ...(this.options.entityRecognizer ? { recognizer: this.options.entityRecognizer } : {}),
      ...(signal ? { signal } : {}),
      maxChars: this.options.limits.maxChars
    });
    return await scanExtractedDocument(extracted, loaded.bytes, { scanner, ...(protect ? { protect } : {}) });
  }

  /** The rule set page's test: load, extract and scan, with an optional mask or placeholder view (nothing kept). */
  async testScan(
    request: DocumentScanRequest,
    ruleSet: { id: string; version: number; profile: GuardProfile },
    user: SafeUser,
    signal?: AbortSignal
  ): Promise<{ result: DocumentScanResult; total: number }> {
    this.takeTestScan(user.id);
    return await this.withSlot(async () => {
      const loaded: LoadedDocument =
        request.source.kind === "upload"
          ? {
              bytes: this.decodeUpload(request.source.contentBase64),
              mediaType: request.source.mediaType ?? null,
              source: { kind: "upload", ...(request.source.filename ? { filename: request.source.filename } : {}) }
            }
          : await this.fetchUrl(request.source.url, { gateway: false }, signal);
      const extracted = await this.extract(loaded, signal);
      let protect: ((value: string, dataClass: string) => Promise<string>) | undefined;
      if (request.redact === "mask") protect = async (value, dataClass) => maskForDataClass(value, dataClass);
      else if (request.redact === "placeholder") {
        const book = new InMemoryPlaceholderBook();
        const reserved = new Set(extracted.segments.flatMap((segment) => [...placeholdersIn(segment.text)]));
        protect = async (value, dataClass) => book.assignNow(dataClass, value, reserved).placeholder;
      }
      const outcome = await this.scan(extracted, loaded, ruleSet, request.entityTypes ? { entityTypes: request.entityTypes } : {}, protect, signal);
      return {
        result: documentScanResult(extracted, loaded, outcome, { id: ruleSet.id, version: ruleSet.version }, request.redact && outcome.redactedText !== undefined ? { style: request.redact, text: outcome.redactedText } : undefined),
        total: outcome.total
      };
    });
  }
}

/**
 * What a scan did not check, in words, or undefined when it checked everything: a PDF without a text layer, scanned
 * pages, pages or text past the limits, attached files. Clients that read only text see it next to the counts.
 */
export function documentScanNotice(result: Omit<DocumentScanResult, "notice">): string | undefined {
  const notes: string[] = [];
  if (result.textLayer === "empty") notes.push("NOT CHECKED: the PDF has no text layer (a scanned document; there is no text recognition)");
  else if (result.textLayer === "partial") notes.push(`${result.pagesWithoutText} page${result.pagesWithoutText === 1 ? " has" : "s have"} no text layer and ${result.pagesWithoutText === 1 ? "was" : "were"} not checked`);
  if (result.pages?.cutAt) notes.push(`only part of the text was checked: reading stopped in page ${result.pages.cutAt} of ${result.pages.total}`);
  else if (result.pages && result.pages.checked < result.pages.total) notes.push(`only ${result.pages.checked} of ${result.pages.total} pages were checked`);
  else if (result.truncated) notes.push("only part of the text was checked");
  if (result.attachmentsNotChecked) notes.push(`${result.attachmentsNotChecked} attached file${result.attachmentsNotChecked === 1 ? " was" : "s were"} not checked`);
  return notes.length > 0 ? `${notes.join("; ")}.` : undefined;
}

/** The result shape both callers return. */
export function documentScanResult(
  extracted: ExtractedDocument,
  loaded: LoadedDocument,
  outcome: DocumentScanOutcome,
  ruleSet: { id: string; version: number } | null,
  redacted?: DocumentScanResult["redacted"]
): DocumentScanResult {
  const result: DocumentScanResult = {
    documentId: outcome.documentId,
    source: loaded.source,
    mediaType: extracted.mediaType,
    sniffedType: extracted.kind,
    typeMismatch: extracted.typeMismatch,
    encoding: extracted.encoding,
    bytes: extracted.bytes,
    chars: extracted.chars,
    truncated: extracted.truncated,
    ...(extracted.covered ? { covered: extracted.covered } : {}),
    ...(extracted.pdf
      ? {
          pages: extracted.pdf.pages,
          textLayer: extracted.pdf.textLayer,
          pagesWithoutText: extracted.pdf.pagesWithoutText,
          ...(extracted.pdf.attachments > 0 ? { attachmentsNotChecked: extracted.pdf.attachments } : {})
        }
      : {}),
    riskLevel: outcome.riskLevel,
    countsByClass: outcome.countsByClass,
    findings: outcome.findings,
    findingsTruncated: outcome.findingsTruncated,
    ...(redacted ? { redacted } : {}),
    ruleSet
  };
  const notice = documentScanNotice(result);
  return notice ? { ...result, notice } : result;
}
