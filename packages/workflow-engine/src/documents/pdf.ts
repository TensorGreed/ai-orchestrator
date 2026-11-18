import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_SCAN_LIMITS, type PdfPart, type PdfTextLayer } from "@ai-orchestrator/shared";
import { DocumentError } from "./errors.js";

/**
 * A PDF's text, read with pdf.js (pdfjs-dist, legacy build) in a child process, one per document:
 *
 * - the child runs under Node's permission model: it may read only its script and the pdfjs-dist package folder, and
 *   may not write files, start processes or worker threads, load addons, or (Node 25 and later, as in the API image)
 *   open network connections; string compilation (eval, new Function) is off and its environment is empty;
 * - its heap is capped (`memoryMb`), it is stopped when its resident memory passes `memoryMb` plus the room Node and
 *   pdf.js need (decoded streams live outside the heap; Linux), when `timeoutMs` passes, or when the caller cancels;
 * - pdf.js never compiles fonts to code, never loads font faces or system fonts, never fetches anything, and refuses a
 *   broken document instead of half-recovering it (see pdf-child.mjs);
 * - at most `maxPages` pages are read, and reading stops once the text passes the character limit;
 * - an encrypted document is opened only when the empty password opens it;
 * - at most `maxConcurrent` PDFs are read at once in this process, and with two or more one slot is kept for
 *   interactive scans (the rule set panel and the gateway), which workflow runs cannot take; more wait their turn (up
 *   to `timeoutMs`);
 * - the child's answer is checked (shape, page count, characters) before it is used.
 *
 * Starting a child and loading pdf.js takes about 150 ms, so one child is kept loaded and waiting; it is used for one
 * document only and replaced, never reused. A waiting child is stopped after a minute without work.
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

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

let pathsCache: { script: string; harden: string; assetRoot: string } | undefined;

/** The child's script and the pdfjs-dist package folder (real paths, with a trailing slash for the folder). */
export function pdfChildPaths(): { script: string; harden: string; assetRoot: string } {
  pathsCache ??= {
    script: realpathSync(fileURLToPath(new URL("./pdf-child.mjs", import.meta.url))),
    harden: realpathSync(fileURLToPath(new URL("./pdf-child-harden.mjs", import.meta.url))),
    assetRoot: `${realpathSync(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")))}/`
  };
  return pathsCache;
}

/**
 * The Node options a reader child runs with: the permission model with reads of `script`, pdf-child-harden.mjs and
 * the pdfjs-dist folder only, no string compilation, and the heap limit. Exported for the tests that prove what the child cannot do.
 */
export function pdfChildArgs(script: string, memoryMb: number): string[] {
  const { harden, assetRoot } = pdfChildPaths();
  return [
    "--permission",
    `--allow-fs-read=${script}`,
    `--allow-fs-read=${harden}`,
    `--allow-fs-read=${assetRoot}`,
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${memoryMb}`,
    script,
    assetRoot
  ];
}

/** Starts a reader child; it says `{ ready: true }` once pdf.js is loaded. Its output is discarded. */
export function spawnPdfChild(memoryMb: number, script = pdfChildPaths().script): ChildProcess {
  return spawn(process.execPath, pdfChildArgs(script, memoryMb), { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
}

interface WarmChild {
  child: ChildProcess;
  memoryMb: number;
  ready: Promise<boolean>;
}

const IDLE_MS = 60_000;
let warm: WarmChild | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function startChild(memoryMb: number): WarmChild {
  const child = spawnPdfChild(memoryMb);
  const ready = new Promise<boolean>((resolve) => {
    child.once("message", (message: unknown) => resolve(Boolean(message && typeof message === "object" && (message as { ready?: unknown }).ready === true)));
    child.once("exit", () => resolve(false));
    child.once("error", () => resolve(false));
  });
  return { child, memoryMb, ready };
}

/** A waiting child does not keep the process alive, and is stopped after a minute without work. */
function park(entry: WarmChild): void {
  entry.child.unref();
  (entry.child.channel as { unref?: () => void } | null | undefined)?.unref?.();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (warm === entry) warm = undefined;
    entry.child.kill("SIGKILL");
  }, IDLE_MS);
  idleTimer.unref();
}

/** A child for one document (the waiting one when its limits match), and a new one started for the next. */
function takeChild(memoryMb: number): WarmChild {
  let entry = warm;
  warm = undefined;
  if (idleTimer) clearTimeout(idleTimer);
  if (!entry || entry.memoryMb !== memoryMb || entry.child.exitCode !== null || entry.child.signalCode !== null) {
    entry?.child.kill("SIGKILL");
    entry = startChild(memoryMb);
  }
  entry.child.ref();
  (entry.child.channel as { ref?: () => void } | null | undefined)?.ref?.();
  // The next document's child starts now; if it cannot, the next read starts its own.
  try {
    const next = startChild(memoryMb);
    warm = next;
    park(next);
  } catch {
    warm = undefined;
  }
  return entry;
}

/** Stops the waiting child (tests; a process that wants no child left behind). */
export function stopPdfReaders(): void {
  if (idleTimer) clearTimeout(idleTimer);
  warm?.child.kill("SIGKILL");
  warm = undefined;
}

// ---------------------------------------------------------------------------
// Concurrency: PDFs read at once in this process, one slot kept for interactive scans
// ---------------------------------------------------------------------------

/** Who is reading: an interactive scan (rule set panel, gateway) or a workflow run (Extract from File). */
export type PdfReader = "interactive" | "workflow";

let running = 0;
let runningWorkflow = 0;
const waiters: Array<{ reader: PdfReader; wake: () => void }> = [];

/**
 * Whether a reader may start now, by the configured cap (CONTENT_SCAN_MAX_CONCURRENT): workflow runs may hold all but
 * one slot, so an interactive scan always has one. With a cap of 1, a workflow run and an interactive scan may each
 * read one PDF (two at most), so workflow runs can still read PDFs and interactive scans are never blocked by them.
 */
function canStart(reader: PdfReader): boolean {
  const cap = configured.maxConcurrent;
  if (reader === "workflow") return running < Math.max(2, cap) && runningWorkflow < Math.max(1, cap - 1);
  return running < Math.max(2, cap) && running - runningWorkflow < cap;
}

function take(reader: PdfReader): void {
  running += 1;
  if (reader === "workflow") runningWorkflow += 1;
}

/** Wakes waiters that may start now, interactive ones first. */
function pump(): void {
  for (const reader of ["interactive", "workflow"] as const) {
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index]!;
      if (waiter.reader === reader && canStart(reader)) {
        waiters.splice(index, 1);
        take(reader);
        waiter.wake();
      } else {
        index += 1;
      }
    }
  }
}

async function acquire(reader: PdfReader, limits: PdfLimits, signal?: AbortSignal): Promise<void> {
  if (waiters.length === 0 && canStart(reader)) {
    take(reader);
    return;
  }
  const acquired = await new Promise<boolean>((resolve) => {
    let waiter: { reader: PdfReader; wake: () => void };
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      resolve(value);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), limits.timeoutMs);
    waiter = { reader, wake: () => done(true) };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
    pump();
  });
  if (!acquired) {
    if (signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
    throw new DocumentError("busy", "Too many PDF documents are being read right now; try again shortly");
  }
}

function release(reader: PdfReader): void {
  running -= 1;
  if (reader === "workflow") runningWorkflow -= 1;
  pump();
}

// ---------------------------------------------------------------------------
// Reading one PDF
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;
const MEMORY_POLL_MS = 100;
/** Resident memory Node and a loaded pdf.js need besides the document (about 85 MB measured), with room to spare. */
const RSS_HEADROOM_MB = 128;
/** How long a stopped child is waited for before its slot is given back anyway. */
const EXIT_WAIT_MS = 5_000;

export interface ReadPdfOptions {
  /** Characters of text after which reading stops (the rest of the document is reported as not checked). */
  maxChars: number;
  /** Overrides the configured limits (tests and callers with their own). */
  limits?: Partial<PdfLimits>;
  signal?: AbortSignal;
  /** Default `interactive`; workflow runs never take the slot kept for interactive scans. */
  reader?: PdfReader;
}

/**
 * Reads a PDF's text in a child process. Throws DocumentError: `unsupported_type` for a password-protected document,
 * `invalid_document` for one pdf.js cannot read (or nested too deeply), `too_large` when the child runs out of time
 * or memory, `busy` when no slot frees up in time, `cancelled` when `signal` aborts. Messages never carry content.
 */
export async function readPdf(bytes: Uint8Array, options: ReadPdfOptions): Promise<PdfRead> {
  const limits: PdfLimits = { ...configured, ...Object.fromEntries(Object.entries(options.limits ?? {}).filter(([, value]) => positiveInt(value))) };
  const reader = options.reader ?? "interactive";
  if (options.signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
  await acquire(reader, limits, options.signal);
  try {
    if (options.signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
    return await runChild(bytes, limits, options);
  } finally {
    release(reader);
  }
}

/** The child's resident memory in bytes (Linux); undefined where /proc is not available. */
async function residentBytes(pid: number): Promise<number | undefined> {
  try {
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(await readFile(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

async function runChild(bytes: Uint8Array, limits: PdfLimits, options: ReadPdfOptions): Promise<PdfRead> {
  const timeLimit = () => new DocumentError("too_large", `Reading the PDF took longer than ${Math.round(limits.timeoutMs / 100) / 10} s`);
  const entry = takeChild(limits.memoryMb);
  const child = entry.child;
  const damaged = () => new DocumentError("invalid_document", "The PDF could not be read (it may be damaged), so nothing in it was checked");

  return await new Promise<PdfRead>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: PdfRead } | { error: DocumentError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      options.signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners("message");
      // The slot is given back only once the child has exited, so the concurrency cap holds (a child that never
      // started has nothing to wait for; the wait is bounded in case no exit event comes).
      const exited =
        child.pid === undefined || child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((done) => {
              const bound = setTimeout(done, EXIT_WAIT_MS);
              child.once("exit", () => {
                clearTimeout(bound);
                done();
              });
            });
      child.kill("SIGKILL");
      void exited.then(() => {
        if ("value" in outcome) resolve(outcome.value);
        else reject(outcome.error);
      });
    };
    const tooLarge = () => finish({ error: new DocumentError("too_large", `The PDF needs more than ${limits.memoryMb} MB of memory to read`) });
    // The time limit covers the child's start too.
    const timer = setTimeout(() => finish({ error: timeLimit() }), limits.timeoutMs);
    const onAbort = () => finish({ error: new DocumentError("cancelled", "The scan was cancelled") });
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Decoded streams are buffers outside the heap limit: the child is stopped when its resident memory passes the limit.
    let polling = false;
    const poll = setInterval(() => {
      if (polling || settled || child.pid === undefined) return;
      polling = true;
      void residentBytes(child.pid)
        .then((rss) => {
          if (rss !== undefined && rss > (limits.memoryMb + RSS_HEADROOM_MB) * MB) tooLarge();
        })
        .finally(() => {
          polling = false;
        });
    }, MEMORY_POLL_MS);
    const onAnswer = (answer: WorkerAnswer) => {
      if (answer && (answer as { ok?: unknown }).ok === true) {
        const value = checkedAnswer(answer, limits.maxPages, options.maxChars);
        finish(value ? { value } : { error: damaged() });
      } else if ((answer as { code?: unknown })?.code === "password") {
        finish({ error: new DocumentError("unsupported_type", "The PDF is password-protected; remove the password and send it again") });
      } else if ((answer as { code?: unknown })?.code === "nesting") {
        finish({ error: new DocumentError("invalid_document", "The PDF is nested too deeply to read, so nothing in it was checked") });
      } else {
        finish({ error: damaged() });
      }
    };
    // A child that cannot start reports an error and may never exit.
    child.once("error", () => finish({ error: new DocumentError("invalid_document", "The PDF reader could not start, so nothing in the document was checked") }));
    // A child that dies on its own (out of heap, crashed) has given no answer: the document is refused.
    child.once("exit", (code, signal) => {
      if (code === null && signal === "SIGKILL") return finish({ error: damaged() });
      // V8 aborts with a fatal error when the heap limit is reached.
      finish({ error: code === 134 || signal === "SIGABRT" || signal === "SIGTRAP" ? new DocumentError("too_large", `The PDF needs more than ${limits.memoryMb} MB of memory to read`) : damaged() });
    });
    // Once pdf.js is loaded (its `ready` message is taken by the start-up listener), the document goes over IPC.
    void entry.ready.then((ready) => {
      if (settled) return;
      if (!ready) return finish({ error: new DocumentError("invalid_document", "The PDF reader could not start, so nothing in the document was checked") });
      child.once("message", onAnswer);
      child.send({ bytes, maxPages: limits.maxPages, maxChars: options.maxChars }, (error) => {
        if (error) finish({ error: damaged() });
      });
    });
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
