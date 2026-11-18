import { ErrorCategory, WorkflowError, type PdfTextLayer } from "@ai-orchestrator/shared";
import { DocumentError } from "./errors.js";
import { isPdf, pdfExtractionLimits, readPdf, textLayerOf, type PdfItem } from "./pdf.js";

/**
 * Extract from File's `pdf` format: the PDF's text, per page with its comments, form field values and links, and the
 * document properties, read in a worker under the deployment's limits (CONTENT_SCAN_MAX_BYTES, CONTENT_SCAN_MAX_CHARS,
 * CONTENT_SCAN_MAX_PAGES, CONTENT_SCAN_PDF_TIMEOUT_MS, CONTENT_SCAN_PDF_MEMORY_MB). Pages that are images of text
 * (scanned) have no text layer: `textLayer` and `pagesWithoutText` say so, since there is no text recognition.
 */

export interface PdfNodeOutput {
  /** The text of the pages read, pages separated by a blank line. */
  text: string;
  pages: Array<{ page: number; text: string; annotations: Array<{ type: PdfItem["part"]; item: number; text: string }> }>;
  properties: Record<string, string>;
  pageCount: number;
  pagesRead: number;
  textLayer: PdfTextLayer;
  pagesWithoutText: number;
  /** Pages past CONTENT_SCAN_MAX_PAGES, or text past CONTENT_SCAN_MAX_CHARS, were not read. */
  truncated: boolean;
  /** Files embedded in the PDF (not read). */
  attachments: number;
  notice?: string;
}

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The PDF's bytes: base64 (encoding "base64", or unset and not raw), or a binary string that starts with %PDF-. */
function pdfBytes(raw: string, encoding: string, maxBytes: number): Uint8Array {
  if (!raw) throw new WorkflowError("extract_from_file_node: no PDF data (set data, or inputKey to a key holding the PDF as base64)", ErrorCategory.NODE_CONFIG, false);
  let bytes: Uint8Array;
  if (encoding !== "base64" && raw.startsWith("%PDF-")) {
    if (raw.length > maxBytes) throw tooLarge(maxBytes);
    bytes = new Uint8Array(Buffer.from(raw, "latin1"));
  } else {
    const compact = raw.replace(/\s+/g, "");
    if (!BASE64.test(compact)) throw new WorkflowError("extract_from_file_node: the PDF data must be base64 (set encoding to base64)", ErrorCategory.NODE_CONFIG, false);
    if (Math.floor((compact.length * 3) / 4) - 2 > maxBytes) throw tooLarge(maxBytes);
    bytes = new Uint8Array(Buffer.from(compact, compact.includes("-") || compact.includes("_") ? "base64url" : "base64"));
  }
  if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
  if (!isPdf(bytes)) throw new WorkflowError("extract_from_file_node: the data is not a PDF (it does not start with %PDF-)", ErrorCategory.NODE_CONFIG, false);
  return bytes;
}

function tooLarge(maxBytes: number): WorkflowError {
  return new WorkflowError(`extract_from_file_node: the PDF is larger than ${maxBytes} bytes (CONTENT_SCAN_MAX_BYTES)`, ErrorCategory.NODE_CONFIG, false);
}

export async function extractPdfForNode(raw: string, encoding: string, signal?: AbortSignal): Promise<PdfNodeOutput> {
  const limits = pdfExtractionLimits();
  const bytes = pdfBytes(raw, encoding, limits.maxBytes);
  let read: Awaited<ReturnType<typeof readPdf>>;
  try {
    read = await readPdf(bytes, { maxChars: limits.maxChars, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    // Too busy is worth a retry; everything else is about this document.
    throw new WorkflowError(`extract_from_file_node: ${error.message}`, error.code === "busy" ? ErrorCategory.CONNECTOR_TRANSIENT : ErrorCategory.NODE_CONFIG, error.code === "busy");
  }
  const pages = read.pages.map((page, index) => ({ page: index + 1, text: page.text, annotations: page.items.map((item) => ({ type: item.part, item: item.item, text: item.text })) }));
  const { textLayer, pagesWithoutText } = textLayerOf(read.pages);
  const properties: Record<string, string> = {};
  for (const property of read.properties) properties[property.name] = properties[property.name] ? `${properties[property.name]}\n${property.text}` : property.text;
  return {
    text: pages.map((page) => page.text).join("\n\n"),
    pages,
    properties,
    pageCount: read.numPages,
    pagesRead: read.pages.length,
    textLayer,
    pagesWithoutText,
    truncated: read.pages.length < read.numPages || read.stoppedAtChars,
    attachments: read.attachments,
    ...(textLayer === "empty"
      ? { notice: "No text layer: this looks like a scanned PDF. Text recognition (OCR) is not supported, so there is no text." }
      : textLayer === "partial"
        ? { notice: `${pagesWithoutText} page${pagesWithoutText === 1 ? " has" : "s have"} no text layer (scanned); text recognition (OCR) is not supported.` }
        : {})
  };
}
