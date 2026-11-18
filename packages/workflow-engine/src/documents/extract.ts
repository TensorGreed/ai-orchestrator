import { CONTENT_SCAN_LIMITS, type DocumentKind, type DocumentLocation, type PdfTextLayer } from "@ai-orchestrator/shared";
import { csvField, parseCsv } from "./csv.js";
import { DocumentError } from "./errors.js";
import { extractHtmlText, normalizeExtractedText } from "./html.js";
import { isPdf, readPdf, textLayerOf, type PdfLimits, type PdfRead } from "./pdf.js";
import { csvDelimiter, decodeDocument, parseMediaType, sniffKind } from "./sniff.js";

/**
 * A document as text segments with locations. Text, Markdown, the parts of an HTML page and a PDF page's text are
 * line-based segments (a finding's line and column are counted inside them); CSV cells, JSON strings, PDF comments,
 * form field values, links and properties are one segment each. `render` rebuilds the document's text from (possibly
 * rewritten) segment texts: the redacted view.
 */

export interface DocumentLimits {
  maxBytes: number;
  maxChars: number;
  jsonMaxDepth: number;
  jsonMaxNodes: number;
  csvMaxRows: number;
  csvMaxCells: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  maxBytes: CONTENT_SCAN_LIMITS.maxBytes,
  maxChars: CONTENT_SCAN_LIMITS.maxChars,
  jsonMaxDepth: CONTENT_SCAN_LIMITS.jsonMaxDepth,
  jsonMaxNodes: CONTENT_SCAN_LIMITS.jsonMaxNodes,
  csvMaxRows: CONTENT_SCAN_LIMITS.csvMaxRows,
  csvMaxCells: CONTENT_SCAN_LIMITS.csvMaxCells
};

/** One step of a JSON path: an array index, or an object member (its key and position). */
export interface JsonPathNode {
  parent: JsonPathNode | null;
  index: number;
  key?: string;
}

export interface DocumentSegment {
  text: string;
  /** The location of the segment; for a line-based one, line and column are added per finding. */
  where: Omit<DocumentLocation, "label" | "line">;
  lines: boolean;
  /** JSON: the path of the string (the pointer is written at scan time, once the keys themselves are checked). */
  path?: JsonPathNode;
  /** CSV: the header cell of the column (shown as the field name only when it is plain and holds no finding). */
  header?: string;
}

export interface ExtractedDocument {
  kind: DocumentKind;
  mediaType: string | null;
  typeMismatch: boolean;
  encoding: string;
  bytes: number;
  /** Characters of extracted text (all segments). */
  chars: number;
  /** The segments checked: all of them, or the first `covered` characters' worth. */
  segments: DocumentSegment[];
  truncated: boolean;
  /** `of` is absent for a PDF whose reading stopped at the limit (the rest was never read, so its size is unknown). */
  covered?: { chars: number; of?: number };
  /** The document's text from these segment texts (one per segment, same order); unchecked parts are left out. */
  render(texts: readonly string[]): string;
  /** PDF: pages in the document and pages read, and whether they had a text layer. */
  pdf?: { pages: { total: number; checked: number; cutAt?: number }; textLayer: PdfTextLayer; pagesWithoutText: number; attachments: number };
}

const NOT_CHECKED = "[not checked: past the size limit]";

const PLAIN_KEY = /^[A-Za-z_$][\w$-]{0,63}$/;
const PLAIN_HEADER = /^[A-Za-z][\w .-]{0,47}$/;

/**
 * The JSON pointer of a path. A key is written by name (RFC 6901 escaped) only when it is a plain name and `unsafe`
 * does not hold it (a key with a finding); otherwise by position, `{#n}`, so a value used as a key never appears.
 */
export function jsonPointerOf(path: JsonPathNode | null | undefined, unsafe: ReadonlySet<string> = new Set()): string {
  const tokens: string[] = [];
  for (let node = path ?? null; node; node = node.parent) {
    if (node.key === undefined) tokens.push(String(node.index));
    else tokens.push(PLAIN_KEY.test(node.key) && !unsafe.has(node.key) ? node.key.replace(/~/g, "~0").replace(/\//g, "~1") : `{#${node.index}}`);
  }
  return tokens.length === 0 ? "/" : `/${tokens.reverse().join("/")}`;
}

/** A CSV header cell as a field name, when it is short and plain and `unsafe` does not hold it. */
export function csvFieldName(header: string | undefined, unsafe: ReadonlySet<string> = new Set()): string | undefined {
  const value = header?.trim();
  return value && PLAIN_HEADER.test(value) && !unsafe.has(header!) ? value : undefined;
}

interface JsonWalk {
  segments: DocumentSegment[];
  /** Rebuilds the value with each string (and key) taken from `texts` in segment order. */
  rebuild(texts: readonly string[]): unknown;
}

/** The strings (and keys) of a JSON value, walked without recursion, with the depth and node limits enforced. */
function walkJson(value: unknown, limits: DocumentLimits): JsonWalk {
  const segments: DocumentSegment[] = [];
  let nodes = 0;
  type Step = { type: "value"; value: unknown; path: JsonPathNode | null; depth: number } | { type: "key"; key: string; path: JsonPathNode };
  const visit: Step[] = [{ type: "value", value, path: null, depth: 0 }];
  while (visit.length > 0) {
    const step = visit.pop()!;
    nodes += 1;
    if (nodes > limits.jsonMaxNodes) throw new DocumentError("too_large", `The JSON has more than ${limits.jsonMaxNodes} values`);
    if (step.type === "key") {
      segments.push({ text: step.key, where: { kind: "json", key: true }, lines: false, path: step.path });
      continue;
    }
    const { value: node, path, depth } = step;
    if (depth > limits.jsonMaxDepth) throw new DocumentError("too_large", `The JSON is nested deeper than ${limits.jsonMaxDepth} levels`);
    if (typeof node === "string") {
      segments.push({ text: node, where: { kind: "json" }, lines: false, ...(path ? { path } : {}) });
    } else if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) visit.push({ type: "value", value: node[index], path: { parent: path, index }, depth: depth + 1 });
    } else if (node && typeof node === "object") {
      const entries = Object.entries(node as Record<string, unknown>);
      // Pushed last first, so each key comes out just before its value: segment order is document order.
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, item] = entries[index]!;
        const memberPath: JsonPathNode = { parent: path, index, key };
        visit.push({ type: "value", value: item, path: memberPath, depth: depth + 1 });
        visit.push({ type: "key", key, path: memberPath });
      }
    }
  }
  return {
    segments,
    rebuild(texts) {
      let cursor = 0;
      const next = () => texts[cursor++] ?? NOT_CHECKED;
      const build = (node: unknown): unknown => {
        if (typeof node === "string") return next();
        if (Array.isArray(node)) return node.map((item) => build(item));
        if (node && typeof node === "object") {
          const out: Record<string, unknown> = {};
          for (const item of Object.values(node as Record<string, unknown>)) {
            let name = next();
            // Two keys redacted to the same text keep both members.
            for (let suffix = 2; Object.prototype.hasOwnProperty.call(out, name); suffix += 1) name = `${name.replace(/ \(\d+\)$/, "")} (${suffix})`;
            // defineProperty: a `__proto__` key stays an own member instead of replacing the prototype.
            Object.defineProperty(out, name, { value: build(item), enumerable: true, writable: true, configurable: true });
          }
          return out;
        }
        return node;
      };
      return build(value);
    }
  };
}

/** Keeps the segments that fit in `maxChars` (the last one cut), so findings never silently cover part of a document. */
function cover(segments: DocumentSegment[], maxChars: number): { segments: DocumentSegment[]; chars: number; truncated: boolean; covered?: { chars: number; of: number } } {
  const chars = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (chars <= maxChars) return { segments, chars, truncated: false };
  const kept: DocumentSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= maxChars) break;
    const room = maxChars - used;
    kept.push(segment.text.length <= room ? segment : { ...segment, text: segment.text.slice(0, room) });
    used += Math.min(room, segment.text.length);
  }
  return { segments: kept, chars, truncated: true, covered: { chars: used, of: chars } };
}

export interface ExtractInput {
  bytes: Uint8Array;
  /** The declared media type (`Content-Type`, or what the uploader said); never a file extension. */
  mediaType?: string | null;
  limits?: Partial<DocumentLimits>;
}

/**
 * Sniffs, decodes and extracts a document. Throws DocumentError for a binary or unsupported format, a document over
 * the byte limit, invalid JSON sent as JSON, or JSON and CSV past their structure limits. Text past `maxChars` is
 * not an error: the result says `truncated` and how much was covered.
 */
export function extractDocument(input: ExtractInput): ExtractedDocument {
  const limits: DocumentLimits = { ...DEFAULT_DOCUMENT_LIMITS, ...input.limits };
  const { bytes } = input;
  if (bytes.byteLength > limits.maxBytes) throw new DocumentError("too_large", `The document is larger than ${limits.maxBytes} bytes`);
  if (bytes.byteLength === 0) throw new DocumentError("invalid_document", "The document is empty");
  const declared = parseMediaType(input.mediaType);
  const decoded = decodeDocument(bytes, declared.charset);
  const sniffed = sniffKind(decoded.text, declared.kind, declared.essence);
  const base = { kind: sniffed.kind, mediaType: declared.essence, typeMismatch: sniffed.typeMismatch, encoding: decoded.encoding, bytes: bytes.byteLength };

  if (sniffed.kind === "html") {
    const html = extractHtmlText(decoded.text);
    const all: DocumentSegment[] = [
      { text: html.visible, where: { kind: "html", part: "visible" }, lines: true },
      ...html.attributes.map((entry): DocumentSegment => ({ text: entry.text, where: { kind: "html", part: "attribute", attribute: `${entry.attribute} of <${entry.tag}>` }, lines: false })),
      ...(html.hidden ? [{ text: html.hidden, where: { kind: "html", part: "hidden" }, lines: true } satisfies DocumentSegment] : [])
    ];
    const covered = cover(all, limits.maxChars);
    return {
      ...base,
      ...covered,
      render(texts) {
        const parts = [texts[0] ?? ""];
        const attributeTexts = covered.segments
          .map((segment, index) => ({ segment, text: texts[index] ?? "" }))
          .filter((entry) => entry.segment.where.part === "attribute");
        if (attributeTexts.length > 0) parts.push(`--- attribute text ---\n${attributeTexts.map((entry) => `${entry.segment.where.attribute}: ${entry.text}`).join("\n")}`);
        const hiddenIndex = covered.segments.findIndex((segment) => segment.where.part === "hidden");
        if (hiddenIndex >= 0) parts.push(`--- hidden text ---\n${texts[hiddenIndex] ?? ""}`);
        if (covered.truncated) parts.push(NOT_CHECKED);
        return parts.join("\n\n");
      }
    };
  }

  if (sniffed.kind === "json") {
    const walk = walkJson(sniffed.json, limits);
    const covered = cover(walk.segments, limits.maxChars);
    return {
      ...base,
      ...covered,
      render(texts) {
        const full = walk.segments.map((_, index) => (index < covered.segments.length ? (texts[index] ?? "") : NOT_CHECKED));
        if (covered.truncated && covered.segments.length > 0) {
          const last = covered.segments.length - 1;
          full[last] = `${full[last]}${NOT_CHECKED}`;
        }
        return JSON.stringify(walk.rebuild(full), null, 2);
      }
    };
  }

  if (sniffed.kind === "csv") {
    const delimiter = csvDelimiter(decoded.text, declared.essence);
    const rows = parseCsv(decoded.text, delimiter, limits.csvMaxRows, limits.csvMaxCells);
    const header = rows[0] ?? [];
    const all: DocumentSegment[] = [];
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (cell === "") return;
        const headerCell = rowIndex > 0 ? header[columnIndex] : undefined;
        all.push({ text: cell, where: { kind: "csv", row: rowIndex + 1, column: columnIndex + 1 }, lines: false, ...(headerCell !== undefined ? { header: headerCell } : {}) });
      });
    });
    const covered = cover(all, limits.maxChars);
    return {
      ...base,
      ...covered,
      render(texts) {
        const rewritten = new Map<string, string>();
        covered.segments.forEach((segment, index) => rewritten.set(`${segment.where.row}:${segment.where.column}`, texts[index] ?? ""));
        const out = rows.map((row, rowIndex) =>
          row
            .map((cell, columnIndex) => {
              if (cell === "") return "";
              const key = `${rowIndex + 1}:${columnIndex + 1}`;
              return csvField(rewritten.has(key) ? rewritten.get(key)! : NOT_CHECKED, delimiter);
            })
            .join(delimiter)
        );
        return out.join("\n");
      }
    };
  }

  const text = sniffed.kind === "markdown" ? decoded.text.replace(/\r\n?/g, "\n") : normalizeLineEndings(decoded.text);
  const covered = cover([{ text, where: { kind: sniffed.kind }, lines: true }], limits.maxChars);
  return {
    ...base,
    ...covered,
    render(texts) {
      return `${texts[0] ?? ""}${covered.truncated ? `\n${NOT_CHECKED}` : ""}`;
    }
  };
}

export interface ExtractAsyncInput extends ExtractInput {
  /** PDF limits instead of the deployment's (configurePdfExtraction). */
  pdfLimits?: Partial<PdfLimits>;
  /** Cancels reading a PDF (its worker is stopped). */
  signal?: AbortSignal;
}

/**
 * Like extractDocument, and also reads PDF documents (sniffed by their `%PDF-` header, whatever the declared type),
 * in a worker with memory and time limits. Throws DocumentError as extractDocument does, and as readPdf does for PDFs.
 */
export async function extractDocumentAsync(input: ExtractAsyncInput): Promise<ExtractedDocument> {
  const limits: DocumentLimits = { ...DEFAULT_DOCUMENT_LIMITS, ...input.limits };
  const { bytes } = input;
  if (bytes.byteLength > limits.maxBytes) throw new DocumentError("too_large", `The document is larger than ${limits.maxBytes} bytes`);
  const declared = parseMediaType(input.mediaType);
  if (!isPdf(bytes)) {
    // Sent as a PDF but without a PDF header: refused rather than read as text.
    if (declared.essence === "application/pdf") throw new DocumentError("invalid_document", "The document was sent as a PDF but has no PDF header");
    return extractDocument(input);
  }
  const read = await readPdf(bytes, { maxChars: limits.maxChars, ...(input.pdfLimits ? { limits: input.pdfLimits } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  return pdfDocument(read, { bytes: bytes.byteLength, mediaType: declared.essence, typeMismatch: declared.essence !== null && declared.essence !== "application/pdf" }, limits.maxChars);
}

const PDF_ITEM_LABEL = { comment: "comment", comment_author: "comment author", form_field: "form field", link: "link" } as const;

/**
 * A read PDF as segments: the document properties, then each page's text (line-based) and annotations. When reading
 * stopped at the character limit the rest of the document was never read, so `covered` gives the characters checked
 * without a total, and `pages.cutAt` names the page that was read only in part.
 */
export function pdfDocument(read: PdfRead, base: { bytes: number; mediaType: string | null; typeMismatch: boolean }, maxChars: number): ExtractedDocument {
  const all: DocumentSegment[] = [];
  for (const property of read.properties) all.push({ text: property.text, where: { kind: "pdf", part: "properties", attribute: property.name }, lines: false });
  read.pages.forEach((page, index) => {
    const number = index + 1;
    if (page.text.length > 0) all.push({ text: page.text, where: { kind: "pdf", page: number, part: "text" }, lines: true });
    for (const item of page.items) all.push({ text: item.text, where: { kind: "pdf", page: number, part: item.part, item: item.item }, lines: false });
  });
  const covered = cover(all, maxChars);
  const { textLayer, pagesWithoutText } = textLayerOf(read.pages);
  const pageLimited = read.pages.length < read.numPages;
  const cutAt = read.stoppedAtChars && read.pages.length > 0 ? read.pages.length : undefined;
  const truncated = covered.truncated || pageLimited || read.stoppedAtChars;
  const checkedChars = covered.covered?.chars ?? covered.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  return {
    kind: "pdf",
    ...base,
    encoding: "pdf",
    segments: covered.segments,
    chars: covered.chars,
    truncated,
    // Past the character limit the rest was never read: how much there was is unknown.
    ...(read.stoppedAtChars ? { covered: { chars: checkedChars } } : covered.covered ? { covered: covered.covered } : {}),
    pdf: { pages: { total: read.numPages, checked: read.pages.length, ...(cutAt ? { cutAt } : {}) }, textLayer, pagesWithoutText, attachments: read.attachments },
    render(texts) {
      const parts: string[] = [];
      let lastPage = 0;
      let inProperties = false;
      covered.segments.forEach((segment, index) => {
        const text = texts[index] ?? "";
        const where = segment.where;
        if (where.part === "properties") {
          if (!inProperties) parts.push("--- document properties ---");
          inProperties = true;
          parts.push(`${where.attribute}: ${text}`);
          return;
        }
        if (where.page !== lastPage) {
          parts.push(`--- page ${where.page} ---`);
          lastPage = where.page!;
        }
        if (where.part === "text") parts.push(text);
        else parts.push(`[${PDF_ITEM_LABEL[where.part as keyof typeof PDF_ITEM_LABEL]} ${where.item}] ${text}`);
      });
      if (read.stoppedAtChars || covered.truncated) {
        const rest = cutAt ? `the rest of page ${cutAt}${read.numPages > cutAt ? ` and pages ${cutAt + 1} to ${read.numPages}` : ""}` : read.numPages > 0 ? `pages 1 to ${read.numPages}` : "";
        parts.push(rest ? `[not checked: past the size limit: ${rest}]` : NOT_CHECKED);
      } else if (pageLimited) {
        parts.push(`[not checked: pages ${read.pages.length + 1} to ${read.numPages}, past the page limit]`);
      }
      if (read.attachments > 0) parts.push(`[not checked: ${read.attachments} attached file${read.attachments === 1 ? "" : "s"}]`);
      return parts.join("\n");
    }
  };
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The 1-based line and column of `offset` in `text`. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  return lineLocator(text)(offset);
}

/** A locator for many offsets in one text: the line starts are found once, each lookup is a binary search. */
export function lineLocator(text: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  };
}

/** The human label of a location. */
export function locationLabel(location: Omit<DocumentLocation, "label">): string {
  const at = location.line !== undefined ? `line ${location.line}, column ${location.column}` : "";
  switch (location.kind) {
    case "csv":
      return `row ${location.row}, column ${location.field ? `${location.column} (${location.field})` : location.column}`;
    case "json":
      return `${location.pointer ?? "/"}${location.key ? " (key)" : ""}`;
    case "html":
      if (location.part === "attribute") return `${location.attribute ?? "attribute"}`;
      return `${location.part === "hidden" ? "hidden text" : "visible text"}, ${at}`;
    case "pdf":
      if (location.part === "properties") return `document properties (${location.attribute ?? "property"})`;
      if (location.part === "text") return `page ${location.page}, ${at}`;
      return `page ${location.page}, ${PDF_ITEM_LABEL[location.part as keyof typeof PDF_ITEM_LABEL] ?? "annotation"} ${location.item ?? ""}`.trimEnd();
    default:
      return at;
  }
}

export { normalizeExtractedText };
