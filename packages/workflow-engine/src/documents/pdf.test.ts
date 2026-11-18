import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DocumentError } from "./errors.js";
import { extractDocument, extractDocumentAsync } from "./extract.js";
import { configurePdfExtraction, DEFAULT_PDF_LIMITS, isPdf, pdfExtractionLimits, readPdf } from "./pdf.js";
import { extractPdfForNode } from "./pdf-node.js";
import {
  deepNestingPdf,
  deepPageTreePdf,
  encryptedPdf,
  endlessContentPdf,
  flateBombPdf,
  fontMatrixPocPdf,
  hugeXrefPdf,
  hugeXrefStreamPdf,
  scannedPdf,
  selfDrawingPdf,
  textPdf,
  unterminatedStreamPdf
} from "./pdf-fixtures.js";
import { scanExtractedDocument, sensitiveDocumentScanner } from "./scan.js";

const scanner = sensitiveDocumentScanner({ dictionaries: [] });

async function expectDocumentError(promise: Promise<unknown>, code: string): Promise<DocumentError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).code).toBe(code);
    return error as DocumentError;
  }
  throw new Error(`expected DocumentError ${code}`);
}

/** A malicious document must be answered (read, or refused) within its time limit, with the process unharmed. */
async function bounded(bytes: Uint8Array, limits: Parameters<typeof readPdf>[1]["limits"] = {}) {
  const started = Date.now();
  let outcome: { ok: true; text: string } | { ok: false; code: string };
  try {
    const read = await readPdf(bytes, { maxChars: 100_000, limits: { timeoutMs: 5_000, ...limits } });
    outcome = { ok: true, text: read.pages.map((page) => page.text).join("\n") };
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentError);
    outcome = { ok: false, code: (error as DocumentError).code };
  }
  return { outcome, ms: Date.now() - started };
}

const sample = () =>
  textPdf([["Invoice for Jane", "Contact jane.doe@example.com"], ["Card 4111 1111 1111 1111"]], {
    comments: [[{ text: "Call bob@example.org", author: "Reviewer" }]],
    fields: [[{ name: "email", value: "form.filler@example.net" }]],
    links: [[], ["mailto:link.target@example.com"]],
    info: { Title: "Invoice", Author: "author@example.com" }
  });

afterEach(() => configurePdfExtraction(DEFAULT_PDF_LIMITS));

describe("reading a PDF", () => {
  it("reads page text as lines, comments and their authors, form fields, links and properties", async () => {
    const read = await readPdf(sample(), { maxChars: 100_000 });
    expect(read.numPages).toBe(2);
    expect(read.pages[0]!.text).toBe("Invoice for Jane\nContact jane.doe@example.com");
    expect(read.pages[0]!.items).toEqual([
      { part: "comment", item: 1, text: "Call bob@example.org" },
      { part: "comment_author", item: 1, text: "Reviewer" },
      { part: "form_field", item: 1, text: "form.filler@example.net" }
    ]);
    expect(read.pages[1]).toEqual({ text: "Card 4111 1111 1111 1111", items: [{ part: "link", item: 1, text: "mailto:link.target@example.com" }] });
    expect(read.properties).toEqual([
      { name: "Title", text: "Invoice" },
      { name: "Author", text: "author@example.com" }
    ]);
    expect(read.stoppedAtChars).toBe(false);
  });

  it("is sniffed by its bytes, and the synchronous reader still refuses it", async () => {
    expect(isPdf(sample())).toBe(true);
    expect(isPdf(new TextEncoder().encode("PDF-1.7"))).toBe(false);
    expect(() => extractDocument({ bytes: sample(), mediaType: "application/pdf" })).toThrow(DocumentError);
    const extracted = await extractDocumentAsync({ bytes: sample(), mediaType: "text/plain" });
    expect(extracted).toMatchObject({ kind: "pdf", typeMismatch: true, encoding: "pdf", truncated: false, pdf: { pages: { total: 2, checked: 2 }, textLayer: "present", pagesWithoutText: 0 } });
    const declared = await extractDocumentAsync({ bytes: sample(), mediaType: "application/pdf" });
    expect(declared.typeMismatch).toBe(false);
  });

  it("finds data with page and line locations, in comments, fields, links and properties, and renders the redacted text", async () => {
    const bytes = sample();
    const extracted = await extractDocumentAsync({ bytes, mediaType: "application/pdf" });
    const outcome = await scanExtractedDocument(extracted, bytes, { scanner, protect: async (_value, dataClass) => `[${dataClass.toUpperCase()}]` });
    const labels = outcome.findings.map((finding) => `${finding.dataClass} @ ${finding.location.label}`);
    expect(labels).toEqual([
      "email @ page 1, line 2, column 9",
      "email @ page 1, comment 1",
      "email @ page 1, form field 1",
      "card_number @ page 2, line 1, column 6",
      "email @ page 2, link 1",
      "email @ document properties (Author)"
    ]);
    expect(outcome.findings[0]!.location).toMatchObject({ kind: "pdf", page: 1, part: "text", line: 2, column: 9 });
    for (const finding of outcome.findings) expect(JSON.stringify(finding)).not.toMatch(/jane\.doe@|4111 1111 1111 1111|bob@example/);
    expect(outcome.redactedText).toBe(
      [
        "--- page 1 ---",
        "Invoice for Jane\nContact [EMAIL]",
        "[comment 1] Call [EMAIL]",
        "[comment author 1] Reviewer",
        "[form field 1] [EMAIL]",
        "--- page 2 ---",
        "Card [CARD_NUMBER]",
        "[link 1] mailto:[EMAIL]",
        "--- document properties ---",
        "Title: Invoice",
        "Author: [EMAIL]"
      ].join("\n")
    );
  });

  it("reports a scanned document (no text layer) instead of a clean one, and a partly scanned one", async () => {
    const scanned = await extractDocumentAsync({ bytes: scannedPdf(3), mediaType: "application/pdf" });
    expect(scanned.pdf).toEqual({ pages: { total: 3, checked: 3 }, textLayer: "empty", pagesWithoutText: 3 });
    expect(scanned.segments).toEqual([]);

    const mixed = await extractDocumentAsync({ bytes: textPdf([["has text"], [], ["more text"]]), mediaType: "application/pdf" });
    expect(mixed.pdf).toEqual({ pages: { total: 3, checked: 3 }, textLayer: "partial", pagesWithoutText: 1 });
  });

  it("reads at most maxPages pages and says how many it checked", async () => {
    const bytes = textPdf(Array.from({ length: 12 }, (_, index) => [`page ${index + 1}`]));
    const extracted = await extractDocumentAsync({ bytes, mediaType: "application/pdf", pdfLimits: { maxPages: 5 } });
    expect(extracted.truncated).toBe(true);
    expect(extracted.covered).toBeUndefined();
    expect(extracted.pdf?.pages).toEqual({ total: 12, checked: 5 });
    expect(extracted.render(extracted.segments.map((segment) => segment.text))).toMatch(/\[not checked: pages 6 to 12, past the page limit\]$/);

    configurePdfExtraction({ maxPages: 3 });
    expect((await readPdf(bytes, { maxChars: 100_000 })).pages).toHaveLength(3);
  });

  it("stops reading at the character limit and never returns text past it", async () => {
    const bytes = textPdf(Array.from({ length: 10 }, (_, index) => [`page ${index + 1} ${"x".repeat(50)}`]));
    const read = await readPdf(bytes, { maxChars: 120 });
    expect(read.pages).toHaveLength(3);
    expect(read.stoppedAtChars).toBe(true);
    expect(read.pages.reduce((sum, page) => sum + page.text.length, 0)).toBe(121);
    const extracted = await extractDocumentAsync({ bytes, mediaType: "application/pdf", limits: { maxChars: 120 } });
    expect(extracted.truncated).toBe(true);
    expect(extracted.covered).toEqual({ chars: 120, of: 121 });
    expect(extracted.pdf?.pages).toEqual({ total: 10, checked: 3 });
  });

  it("opens an encrypted document whose user password is empty, and refuses one that needs a password", async () => {
    const open = await readPdf(encryptedPdf(["Card 4111 1111 1111 1111"], ""), { maxChars: 100_000 });
    expect(open.pages[0]!.text).toBe("Card 4111 1111 1111 1111");
    const error = await expectDocumentError(readPdf(encryptedPdf(["secret"], "user-password"), { maxChars: 100_000 }), "unsupported_type");
    expect(error.message).toMatch(/password-protected/);
  });

  it("refuses bytes that are not a readable PDF without echoing them", async () => {
    const error = await expectDocumentError(readPdf(new TextEncoder().encode("%PDF-1.7\nnot really jane.doe@example.com"), { maxChars: 1000 }), "invalid_document");
    expect(error.message).not.toMatch(/jane/);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const reading = readPdf(endlessContentPdf(), { maxChars: 100_000, limits: { timeoutMs: 20_000 }, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await expectDocumentError(reading, "cancelled");
    expect(Date.now() - started).toBeLessThan(3_000);
    const aborted = new AbortController();
    aborted.abort();
    await expectDocumentError(readPdf(sample(), { maxChars: 1000, signal: aborted.signal }), "cancelled");
  });

  it("reads at most maxConcurrent PDFs at once; a waiter past its time is refused as busy", async () => {
    configurePdfExtraction({ maxConcurrent: 1 });
    const slow = readPdf(endlessContentPdf(), { maxChars: 100_000, limits: { timeoutMs: 2_000 } }).catch((error: unknown) => error);
    const waiting = readPdf(sample(), { maxChars: 100_000, limits: { timeoutMs: 300 } });
    await expectDocumentError(waiting, "busy");
    expect(((await slow) as DocumentError).code).toBe("too_large");
    // The slot is given back: the next read runs.
    expect((await readPdf(sample(), { maxChars: 100_000 })).numPages).toBe(2);
  });

  it("keeps the configured limits within their floors", () => {
    configurePdfExtraction({ memoryMb: 1, maxPages: 0, timeoutMs: Number.NaN });
    expect(pdfExtractionLimits()).toMatchObject({ memoryMb: 64, maxPages: DEFAULT_PDF_LIMITS.maxPages, timeoutMs: DEFAULT_PDF_LIMITS.timeoutMs });
  });
});

describe("malicious PDF shapes stay inside the limits", () => {
  const marker = mkdtempSync(join(tmpdir(), "l2m-pdf-"));
  afterAll(() => rmSync(marker, { recursive: true, force: true }));

  it("a cross-reference table claiming two billion entries", async () => {
    const { outcome, ms } = await bounded(hugeXrefPdf());
    expect(outcome).toEqual({ ok: true, text: "huge xref" });
    expect(ms).toBeLessThan(5_000);
  });

  it("a cross-reference stream claiming two billion wide entries", async () => {
    const { outcome, ms } = await bounded(hugeXrefStreamPdf());
    expect(outcome).toEqual({ ok: false, code: "invalid_document" });
    expect(ms).toBeLessThan(5_000);
  });

  it("arrays and dictionaries nested 100 000 levels deep", async () => {
    const error = await expectDocumentError(readPdf(deepNestingPdf(), { maxChars: 100_000, limits: { timeoutMs: 5_000 } }), "invalid_document");
    expect(error.message).toMatch(/nested too deeply/);
  });

  it("a page tree 50 000 levels deep", async () => {
    const { outcome } = await bounded(deepPageTreePdf());
    expect(outcome.ok ? "read" : outcome.code).toMatch(/^(read|invalid_document)$/);
  });

  it("the FontMatrix injection shape (CVE-2024-4367) runs nothing, and the page is still read", async () => {
    const file = join(marker, "pwned");
    const read = await readPdf(fontMatrixPocPdf(`process.getBuiltinModule('fs').writeFileSync('${file}', 'x')`, ["Contact jane.doe@example.com"]), { maxChars: 100_000 });
    expect(read.pages[0]!.text).toContain("Contact jane.doe@example.com");
    expect(existsSync(file)).toBe(false);
  });

  it("an endless content stream is stopped at the time limit", async () => {
    const started = Date.now();
    const error = await expectDocumentError(readPdf(endlessContentPdf(), { maxChars: 10_000_000, limits: { timeoutMs: 1_000 } }), "too_large");
    expect(error.message).toMatch(/longer than 1 s/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a stream without an end and a /Length past the end of the file", async () => {
    const { outcome, ms } = await bounded(unterminatedStreamPdf());
    expect(outcome.ok ? "read" : outcome.code).toMatch(/^(read|invalid_document)$/);
    expect(ms).toBeLessThan(5_000);
  });

  it("a form that draws itself", async () => {
    const { outcome, ms } = await bounded(selfDrawingPdf());
    expect(outcome.ok ? "read" : outcome.code).toMatch(/^(read|invalid_document)$/);
    expect(ms).toBeLessThan(5_000);
  });

  it("a decompression bomb is stopped at the memory limit", async () => {
    const error = await expectDocumentError(readPdf(flateBombPdf(200), { maxChars: 100_000, limits: { memoryMb: 64, timeoutMs: 20_000 } }), "too_large");
    expect(error.message).toMatch(/more than 64 MB of memory/);
  });

  it("the process still reads ordinary documents afterwards", async () => {
    expect((await readPdf(sample(), { maxChars: 100_000 })).numPages).toBe(2);
  });
});

describe("the pinned pdf.js", () => {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

  it("is a release with the fixes for CVE-2024-4367 (4.2.67) and CVE-2026-16633 (6.2.108)", () => {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
    const [major, minor] = version.split(".").map(Number) as [number, number];
    expect(major > 6 || (major === 6 && minor >= 2)).toBe(true);
  });

  it("has no code path that compiles strings to functions", () => {
    for (const file of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/new Function\s*\(/);
      expect(source).not.toMatch(/[^\w.$]eval\s*\(/);
    }
  });
});

describe("Extract from File's pdf format", () => {
  const base64 = Buffer.from(sample()).toString("base64");

  it("returns the text per page with annotations, properties and the text layer", async () => {
    const output = await extractPdfForNode(base64, "base64");
    expect(output).toMatchObject({
      text: "Invoice for Jane\nContact jane.doe@example.com\n\nCard 4111 1111 1111 1111",
      pageCount: 2,
      pagesRead: 2,
      textLayer: "present",
      pagesWithoutText: 0,
      truncated: false,
      properties: { Title: "Invoice", Author: "author@example.com" }
    });
    expect(output.pages[0]!.annotations).toContainEqual({ type: "form_field", item: 1, text: "form.filler@example.net" });
    expect(output.notice).toBeUndefined();
    // Without an encoding, base64 is read as base64; a binary string that starts with %PDF- as bytes.
    expect((await extractPdfForNode(base64, "")).pageCount).toBe(2);
    expect((await extractPdfForNode(Buffer.from(sample()).toString("latin1"), "utf8")).pageCount).toBe(2);
  });

  it("says when a scanned document has no text", async () => {
    const output = await extractPdfForNode(Buffer.from(scannedPdf()).toString("base64"), "base64");
    expect(output).toMatchObject({ text: "", textLayer: "empty", notice: expect.stringMatching(/OCR\) is not supported/) });
  });

  it("refuses data that is not a PDF, too large, or not base64", async () => {
    await expect(extractPdfForNode(Buffer.from("hello").toString("base64"), "base64")).rejects.toThrow(/not a PDF/);
    await expect(extractPdfForNode("%%% not base64 %%%", "base64")).rejects.toThrow(/must be base64/);
    await expect(extractPdfForNode("", "base64")).rejects.toThrow(/no PDF data/);
    configurePdfExtraction({ maxBytes: 100 });
    await expect(extractPdfForNode(base64, "base64")).rejects.toThrow(/larger than 100 bytes/);
  });

  it("maps a reader failure to a node error", async () => {
    await expect(extractPdfForNode(Buffer.from(encryptedPdf(["x"], "pw")).toString("base64"), "base64")).rejects.toThrow(/extract_from_file_node: The PDF is password-protected/);
  });
});
