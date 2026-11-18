import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { CONTENT_SCAN_LIMITS, type PdfPart, type PdfTextLayer } from "@ai-orchestrator/shared";
import { DocumentError } from "./errors.js";

/**
 * A PDF's text, read with pdf.js (pdfjs-dist, legacy build) in a worker thread, one per document:
 *
 * - the worker has a heap limit (`memoryMb`), a 4 MB stack and an empty environment, and is stopped when its buffers
 *   (decoded streams live outside the heap) pass the same limit, when `timeoutMs` passes, or when the caller cancels;
 * - pdf.js never compiles fonts to code, never loads font faces or system fonts, never fetches anything, and refuses a
 *   broken document instead of half-recovering it (see pdf-worker.mjs);
 * - at most `maxPages` pages are read, and reading stops once the text passes the character limit;
 * - an encrypted document is opened only when the empty password opens it;
 * - at most `maxConcurrent` PDFs are read at once in this process; more wait their turn (up to `timeoutMs`);
 * - the worker's answer is checked (shape, page count, characters) before it is used.
 *
 * The worker limits resources, not privileges: it runs in the API process with its rights. What keeps a document from
 * running code is pdf.js itself (no eval path, no font compilation, no fetches), pinned and updated on its own.
 *
 * Read are the page's text layer (as lines), comments and their authors, text and choice form field values, link
 * addresses, and the document properties (information dictionary and XMP). A page whose text layer is empty is an
 * image of text (a scanned page): there is no text recognition, so the result says how many pages had no text.
 */

export interface PdfLimits {
  maxPages: number;
  timeoutMs: number;
  memoryMb: number;
  maxConcurrent: number;
  /** Extract from File only (document scans pass their own): bytes of a PDF, and characters of text read. */
  maxBytes: number;
  maxChars: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  maxPages: CONTENT_SCAN_LIMITS.maxPages,
  timeoutMs: CONTENT_SCAN_LIMITS.pdfTimeoutMs,
  memoryMb: CONTENT_SCAN_LIMITS.pdfMemoryMb,
  maxConcurrent: CONTENT_SCAN_LIMITS.maxConcurrent,
  maxBytes: CONTENT_SCAN_LIMITS.maxBytes,
  maxChars: CONTENT_SCAN_LIMITS.maxChars
};

let configured: PdfLimits = { ...DEFAULT_PDF_LIMITS };

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 1;

/**
 * Sets the deployment's PDF limits (API startup): CONTENT_SCAN_MAX_PAGES, CONTENT_SCAN_PDF_TIMEOUT_MS,
 * CONTENT_SCAN_PDF_MEMORY_MB, CONTENT_SCAN_MAX_CONCURRENT, and for Extract from File CONTENT_SCAN_MAX_BYTES and
 * CONTENT_SCAN_MAX_CHARS.
 */
export function configurePdfExtraction(limits: Partial<PdfLimits>): void {
  const next = { ...configured };
  if (positiveInt(limits.maxPages)) next.maxPages = Math.floor(limits.maxPages);
  if (positiveInt(limits.timeoutMs)) next.timeoutMs = Math.floor(limits.timeoutMs);
  if (positiveInt(limits.memoryMb)) next.memoryMb = Math.max(CONTENT_SCAN_LIMITS.pdfMemoryMbFloor, Math.floor(limits.memoryMb));
  if (positiveInt(limits.maxConcurrent)) next.maxConcurrent = Math.floor(limits.maxConcurrent);
  if (positiveInt(limits.maxBytes)) next.maxBytes = Math.floor(limits.maxBytes);
  if (positiveInt(limits.maxChars)) next.maxChars = Math.floor(limits.maxChars);
  configured = next;
}

/** The PDF limits in force. */
export function pdfExtractionLimits(): PdfLimits {
  return { ...configured };
}

/** True when `%PDF-` appears in the first 1024 bytes (where PDF readers look for the header). */
export function isPdf(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 1024 + 5) - 5;
  for (let index = 0; index <= end; index += 1) {
    if (bytes[index] === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44 && bytes[index + 3] === 0x46 && bytes[index + 4] === 0x2d) return true;
  }
  return false;
}

export interface PdfItem {
  part: Exclude<PdfPart, "text" | "properties">;
  /** The annotation's 1-based position among the page's annotations of its kind. */
  item: number;
  text: string;
}

export interface PdfPage {
  /** The page's text layer, one line per line of text ("" for a page without one). */
  text: string;
  items: PdfItem[];
}

export interface PdfRead {
  numPages: number;
  pages: PdfPage[];
  properties: Array<{ name: string; text: string }>;
  /**
   * The text passed the character limit: the last page read was cut there, and later pages were not read (`pages`
   * holds the pages read, the last one partly).
   */
  stoppedAtChars: boolean;
  /** Files embedded in the document (not read). */
  attachments: number;
}

/** Whether the pages read had a text layer: none of them (a scanned document), some, or all; and how many had none. */
export function textLayerOf(pages: readonly PdfPage[]): { textLayer: PdfTextLayer; pagesWithoutText: number } {
  const pagesWithoutText = pages.filter((page) => page.text.trim().length === 0).length;
  const textLayer: PdfTextLayer = pages.length === 0 || pagesWithoutText === pages.length ? "empty" : pagesWithoutText > 0 ? "partial" : "present";
  return { textLayer, pagesWithoutText };
}

type WorkerAnswer = ({ ok: true } & PdfRead) | { ok: false; code: "password" | "invalid" | "nesting" };

let assetRootCache: string | undefined;

/** The pdfjs-dist package folder (with a trailing slash): its character maps and standard font data are read locally. */
function assetRoot(): string {
  assetRootCache ??= `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  return assetRootCache;
}

// ---------------------------------------------------------------------------
// Concurrency: PDFs read at once in this process
// ---------------------------------------------------------------------------

let running = 0;
const waiters: Array<() => void> = [];

async function acquire(limits: PdfLimits, signal?: AbortSignal): Promise<void> {
  if (running < limits.maxConcurrent) {
    running += 1;
    return;
  }
  const acquired = await new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      resolve(value);
    };
    const waiter = () => done(true);
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), limits.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
  });
  if (!acquired) {
    if (signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
    throw new DocumentError("busy", "Too many PDF documents are being read right now; try again shortly");
  }
}

function release(): void {
  const next = waiters.shift();
  // The slot passes straight to the next waiter (the count stays), or is given back.
  if (next) next();
  else running -= 1;
}

// ---------------------------------------------------------------------------
// Reading one PDF
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const MEMORY_POLL_MS = 100;

export interface ReadPdfOptions {
  /** Characters of text after which reading stops (the rest of the document is reported as not checked). */
  maxChars: number;
  /** Overrides the configured limits (tests and callers with their own). */
  limits?: Partial<PdfLimits>;
  signal?: AbortSignal;
}

/**
 * Reads a PDF's text in a worker. Throws DocumentError: `unsupported_type` for a password-protected document,
 * `invalid_document` for one pdf.js cannot read (or nested too deeply), `too_large` when the worker runs out of time
 * or memory, `busy` when no slot frees up in time, `cancelled` when `signal` aborts. Messages never carry content.
 */
export async function readPdf(bytes: Uint8Array, options: ReadPdfOptions): Promise<PdfRead> {
  const limits: PdfLimits = { ...configured, ...Object.fromEntries(Object.entries(options.limits ?? {}).filter(([, value]) => positiveInt(value))) };
  if (options.signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
  await acquire(limits, options.signal);
  try {
    if (options.signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
    return await runWorker(bytes, limits, options);
  } finally {
    release();
  }
}

async function runWorker(bytes: Uint8Array, limits: PdfLimits, options: ReadPdfOptions): Promise<PdfRead> {
  // A copy the worker owns (the caller's bytes stay usable: the document id is their hash).
  const copy = new Uint8Array(bytes);
  const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
    workerData: { bytes: copy, maxPages: limits.maxPages, maxChars: options.maxChars, assetRoot: assetRoot() },
    transferList: [copy.buffer as ArrayBuffer],
    resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb, maxYoungGenerationSizeMb: Math.min(32, Math.max(8, Math.floor(limits.memoryMb / 8))), stackSizeMb: 4 },
    env: {},
    execArgv: [],
    stdout: true,
    stderr: true
  });
  // Nothing the worker prints is kept or forwarded (pdf.js warnings could quote the document).
  worker.stdout.resume();
  worker.stderr.resume();

  return await new Promise<PdfRead>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: PdfRead } | { error: DocumentError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      options.signal?.removeEventListener("abort", onAbort);
      // The slot is given back only once the worker has stopped, so the concurrency cap holds.
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => {
          if ("value" in outcome) resolve(outcome.value);
          else reject(outcome.error);
        });
    };
    const tooLarge = () => finish({ error: new DocumentError("too_large", `The PDF needs more than ${limits.memoryMb} MB of memory to read`) });
    const timer = setTimeout(() => finish({ error: new DocumentError("too_large", `Reading the PDF took longer than ${Math.round(limits.timeoutMs / 100) / 10} s`) }), limits.timeoutMs);
    const onAbort = () => finish({ error: new DocumentError("cancelled", "The scan was cancelled") });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Decoded streams are buffers outside the heap limit: the worker is stopped when they pass the same limit.
    let polling = false;
    const poll = setInterval(() => {
      if (polling || settled) return;
      polling = true;
      worker
        .getHeapStatistics()
        .then((stats) => {
          if (stats.external_memory > limits.memoryMb * MB) tooLarge();
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, MEMORY_POLL_MS);
    worker.once("message", (answer: WorkerAnswer) => {
      if (answer.ok) {
        const value = checkedAnswer(answer, limits.maxPages, options.maxChars);
        finish(value ? { value } : { error: new DocumentError("invalid_document", "The PDF could not be read; it may be damaged") });
      } else if (answer.code === "password") {
        finish({ error: new DocumentError("unsupported_type", "The PDF is password-protected; remove the password and send it again") });
      } else if (answer.code === "nesting") {
        finish({ error: new DocumentError("invalid_document", "The PDF is nested too deeply to read") });
      } else {
        finish({ error: new DocumentError("invalid_document", "The PDF could not be read; it may be damaged") });
      }
    });
    worker.once("error", (error: Error & { code?: string }) => {
      if (error.code === "ERR_WORKER_OUT_OF_MEMORY") tooLarge();
      else finish({ error: new DocumentError("invalid_document", "The PDF could not be read; it may be damaged") });
    });
    worker.once("exit", () => finish({ error: new DocumentError("invalid_document", "The PDF could not be read; it may be damaged") }));
  });
}

const isText = (value: unknown): value is string => typeof value === "string";
const ITEM_PARTS = new Set(["comment", "comment_author", "form_field", "link"]);

/** The worker's answer when it has the expected shape and stays within the page and character limits; else null. */
export function checkedAnswer(answer: unknown, maxPages: number, maxChars: number): PdfRead | null {
  if (!answer || typeof answer !== "object") return null;
  const { numPages, pages, properties, stoppedAtChars, attachments } = answer as Record<string, unknown>;
  if (!Number.isInteger(numPages) || (numPages as number) < 0 || !Array.isArray(pages) || !Array.isArray(properties)) return null;
  if (pages.length > Math.min(maxPages, numPages as number) || typeof stoppedAtChars !== "boolean" || !Number.isInteger(attachments)) return null;
  let chars = 0;
  for (const property of properties as unknown[]) {
    const entry = property as { name?: unknown; text?: unknown } | null;
    if (!entry || !isText(entry.name) || !isText(entry.text)) return null;
    chars += entry.text.length;
  }
  for (const page of pages as unknown[]) {
    const entry = page as { text?: unknown; items?: unknown } | null;
    if (!entry || !isText(entry.text) || !Array.isArray(entry.items)) return null;
    chars += entry.text.length;
    for (const item of entry.items as unknown[]) {
      const value = item as { part?: unknown; item?: unknown; text?: unknown } | null;
      if (!value || !ITEM_PARTS.has(value.part as string) || !Number.isInteger(value.item) || !isText(value.text)) return null;
      chars += value.text.length;
    }
  }
  if (chars > maxChars + 1) return null;
  return { numPages: numPages as number, pages: pages as PdfPage[], properties: properties as PdfRead["properties"], stoppedAtChars, attachments: attachments as number };
}
