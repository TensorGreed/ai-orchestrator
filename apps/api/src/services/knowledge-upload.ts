/**
 * What a knowledge base upload holds, as documents ready to chunk: text kinds go through the loaders
 * (document-loader-service), a PDF's text is read page by page with the sandboxed PDF reader (the one document scans
 * and Extract from File use), and anything else that is not text is refused, so raw bytes never become chunks.
 *
 *   - Text arrives as `content` (a string). A PDF, or any file the browser cannot read as text, arrives as
 *     `contentBase64`; the bytes decide what it is, not the file name.
 *   - A PDF gives one document per page that has text, with `page` (1-based) and `pageCount` in its metadata, so every
 *     chunk says which page it came from. Pages without a text layer (scanned) are skipped and the answer says so; a
 *     PDF with no text at all is refused: there is no text recognition.
 *   - Word, Excel, PowerPoint and other Office files, images, archives and other binary files are refused with a
 *     message that says what to upload instead. So is a PDF sent as text (decoding it as text already lost its bytes).
 */

import { DocumentError, isPdf, readPdf } from "@ai-orchestrator/workflow-engine";
import { loadDocuments, inferDocumentKind, type DocumentKind, type LoadedDocument } from "./document-loader-service.js";

/** A refusal with the HTTP status the upload route answers. Messages never carry the document's content. */
export class KnowledgeUploadError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413 | 422 | 499 | 503,
    readonly code: string
  ) {
    super(message);
    this.name = "KnowledgeUploadError";
  }
}

export interface KnowledgeUploadInput {
  filename?: unknown;
  kind?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  metadata?: Record<string, unknown>;
  csv?: { textColumn?: string; metadataColumns?: string[] };
}

export interface KnowledgeUploadLimits {
  /** Bytes of a file sent as `contentBase64` (CONTENT_SCAN_MAX_BYTES). */
  maxBytes: number;
  /** Characters of a PDF's text read before reading stops (CONTENT_SCAN_MAX_CHARS). */
  maxChars: number;
}

export interface LoadedUpload {
  kind: DocumentKind | "pdf";
  documents: LoadedDocument[];
  /** For a PDF: pages in the document. */
  pageCount?: number;
  /** What was left out (scanned pages, pages past the limits), in a sentence for the person who uploaded. */
  notice?: string;
}

const TEXT_KINDS: readonly DocumentKind[] = ["text", "markdown", "html", "csv", "json"];

const OFFICE_EXTENSIONS = /\.(docx?|docm|dotx|xlsx?|xlsm|pptx?|pptm|odt|ods|odp|rtf|pages|numbers|key|epub)$/i;

const NOT_TEXT_MESSAGE =
  "This file is not text, so it cannot be added. Upload a PDF with selectable text, or a text, Markdown, HTML, CSV or JSON file.";
const OFFICE_MESSAGE =
  "Word, Excel, PowerPoint and other office files cannot be read yet. Save it as a PDF (with selectable text) or as plain text, and upload that.";
const PDF_AS_TEXT_MESSAGE =
  "This is a PDF sent as text, which loses its contents. Send the file's bytes as contentBase64 (the Knowledge page does this when you pick a PDF).";
const SCANNED_MESSAGE =
  "This PDF has no text layer: it looks scanned (pictures of pages). Text recognition (OCR) is not supported, so nothing could be added. Upload a PDF with selectable text, or the text itself.";

const filenameOf = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Characters a text file does not have: NUL, other control characters (tab, line breaks and form feed aside), and the
 * replacement character a browser puts where bytes were not valid text. More than a few, or a NUL, means the
 * "text" is a binary file read as text.
 */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let odd = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c)) odd += 1;
  }
  return odd >= 4 && odd / Math.max(1, text.length) > 0.01;
}

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

function decodeBase64(raw: string, maxBytes: number): Uint8Array {
  // A data: URL (what FileReader.readAsDataURL gives) is accepted as its base64 part.
  const compact = raw.replace(/^\s*data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!compact) throw new KnowledgeUploadError("The file is empty", 400, "empty");
  if (!BASE64.test(compact)) throw new KnowledgeUploadError("contentBase64 must be base64", 400, "invalid_base64");
  if (Math.floor((compact.length * 3) / 4) - 2 > maxBytes) throw tooLarge(maxBytes);
  const bytes = new Uint8Array(Buffer.from(compact, compact.includes("-") || compact.includes("_") ? "base64url" : "base64"));
  if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
  return bytes;
}

function tooLarge(maxBytes: number): KnowledgeUploadError {
  return new KnowledgeUploadError(`The file is larger than ${maxBytes} bytes (CONTENT_SCAN_MAX_BYTES)`, 413, "too_large");
}

/**
 * The text of a file sent as bytes: UTF-8 (with or without a byte order mark), UTF-16 with a byte order mark, or,
 * when the bytes are not valid UTF-8 but hold no NUL or control bytes, Windows-1252 (Latin-1 and its superset), the
 * usual encoding of older text files. Undefined when the bytes are not text in any of these.
 */
export function decodeTextBytes(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    for (const byte of bytes) {
      if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c)) return undefined;
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** "%PDF-" as the first bytes (after an optional byte order mark or whitespace), as a real PDF starts. */
function startsWithPdfHeader(bytes: Uint8Array): boolean {
  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) index += 1;
  return String.fromCharCode(...bytes.subarray(index, index + 5)) === "%PDF-";
}

/** A zip archive (DOCX, XLSX, PPTX, ODT and EPUB are zip files) or an old Office (OLE) file. */
function isOfficeOrArchive(bytes: Uint8Array): boolean {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  return zip || ole;
}

function textKindOf(input: KnowledgeUploadInput): DocumentKind {
  if (typeof input.kind === "string" && (TEXT_KINDS as readonly string[]).includes(input.kind)) return input.kind as DocumentKind;
  const filename = filenameOf(input.filename);
  return filename ? inferDocumentKind(filename) : "text";
}

function loadText(input: KnowledgeUploadInput, text: string, sourceId: string): LoadedUpload {
  if (/^\s*%PDF-/.test(text.slice(0, 1024))) throw new KnowledgeUploadError(PDF_AS_TEXT_MESSAGE, 400, "pdf_as_text");
  if (looksBinary(text)) {
    const office = OFFICE_EXTENSIONS.test(filenameOf(input.filename));
    throw new KnowledgeUploadError(office ? OFFICE_MESSAGE : NOT_TEXT_MESSAGE, 400, office ? "office_file" : "not_text");
  }
  const kind = textKindOf(input);
  let documents: LoadedDocument[];
  try {
    documents = loadDocuments(kind, text, { sourceId, metadata: input.metadata ?? {}, csv: input.csv });
  } catch (error) {
    throw new KnowledgeUploadError(`Loader failed: ${error instanceof Error ? error.message : String(error)}`, 400, "loader_failed");
  }
  return { kind, documents };
}

async function loadPdf(input: KnowledgeUploadInput, bytes: Uint8Array, sourceId: string, limits: KnowledgeUploadLimits, signal?: AbortSignal): Promise<LoadedUpload> {
  let read: Awaited<ReturnType<typeof readPdf>>;
  try {
    read = await readPdf(bytes, { maxChars: limits.maxChars, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    if (error.code === "busy") throw new KnowledgeUploadError(error.message, 503, "busy");
    if (error.code === "cancelled") throw new KnowledgeUploadError("The upload was cancelled", 499, "cancelled");
    // The reader reports its time limit as too_large; it is a slow (often damaged or huge) PDF, not a big upload.
    if (error.code === "too_large" && /took longer than/i.test(error.message)) {
      throw new KnowledgeUploadError(`The PDF could not be read: ${error.message}. Try a smaller PDF, or split it.`, 422, "pdf_timeout");
    }
    if (error.code === "too_large") throw new KnowledgeUploadError(`The PDF could not be read: ${error.message}`, 413, "too_large");
    if (error.code === "unsupported_type") {
      throw new KnowledgeUploadError("This PDF is password-protected and cannot be read. Upload a copy without a password.", 400, "pdf_password");
    }
    throw new KnowledgeUploadError(`The PDF could not be read: ${error.message}`, 400, "pdf_unreadable");
  }
  const base: Record<string, unknown> = { ...(input.metadata ?? {}), sourceId, kind: "pdf", pageCount: read.numPages };
  const documents: LoadedDocument[] = [];
  let pagesWithoutText = 0;
  read.pages.forEach((page, index) => {
    const text = page.text.trim();
    if (!text) {
      pagesWithoutText += 1;
      return;
    }
    documents.push({ text, metadata: { ...base, page: index + 1 } });
  });
  if (documents.length === 0) throw new KnowledgeUploadError(SCANNED_MESSAGE, 400, "pdf_no_text");
  const notices: string[] = [];
  if (pagesWithoutText > 0) {
    notices.push(`${pagesWithoutText} page${pagesWithoutText === 1 ? " has" : "s have"} no text layer (scanned) and ${pagesWithoutText === 1 ? "was" : "were"} skipped; text recognition (OCR) is not supported.`);
  }
  if (read.pages.length < read.numPages || read.stoppedAtChars) {
    notices.push(`Only the first ${read.pages.length} of ${read.numPages} page${read.numPages === 1 ? "" : "s"} were read (the deployment's page and text limits).`);
  }
  return { kind: "pdf", documents, pageCount: read.numPages, ...(notices.length > 0 ? { notice: notices.join(" ") } : {}) };
}

/** The upload's documents, or a KnowledgeUploadError that says why it cannot be added. */
export async function loadKnowledgeUpload(
  input: KnowledgeUploadInput,
  sourceId: string,
  limits: KnowledgeUploadLimits,
  signal?: AbortSignal
): Promise<LoadedUpload> {
  const filename = filenameOf(input.filename);
  // An empty contentBase64 next to text content is the text upload (the route's own check reads it the same way).
  if (typeof input.contentBase64 === "string" && input.contentBase64.trim().length > 0) {
    const bytes = decodeBase64(input.contentBase64, limits.maxBytes);
    if (isPdf(bytes)) {
      try {
        return await loadPdf(input, bytes, sourceId, limits, signal);
      } catch (error) {
        // The PDF check looks for %PDF- near the start; a text file that only mentions it is still text.
        const named = input.kind === "pdf" || /\.pdf$/i.test(filename);
        if (!(error instanceof KnowledgeUploadError) || error.code !== "pdf_unreadable" || named || startsWithPdfHeader(bytes)) throw error;
        const text = decodeTextBytes(bytes);
        if (text === undefined) throw error;
        return loadText(input, text, sourceId);
      }
    }
    if (isOfficeOrArchive(bytes) || OFFICE_EXTENSIONS.test(filename)) throw new KnowledgeUploadError(OFFICE_MESSAGE, 400, "office_file");
    if (input.kind === "pdf" || /\.pdf$/i.test(filename)) throw new KnowledgeUploadError("The file is not a PDF (it does not start with %PDF-).", 400, "not_pdf");
    const text = decodeTextBytes(bytes);
    if (text === undefined) throw new KnowledgeUploadError(NOT_TEXT_MESSAGE, 400, "not_text");
    return loadText(input, text, sourceId);
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new KnowledgeUploadError("content (string) or contentBase64 is required", 400, "empty");
  }
  if (input.kind === "pdf" || /\.pdf$/i.test(filename)) throw new KnowledgeUploadError(PDF_AS_TEXT_MESSAGE, 400, "pdf_as_text");
  return loadText(input, input.content, sourceId);
}
