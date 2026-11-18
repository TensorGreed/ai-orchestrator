import type { DocumentKind } from "@ai-orchestrator/shared";
import { DocumentError } from "./errors.js";

/**
 * Type sniffing and text decoding. The bytes decide, never a file extension: binary formats are refused by their
 * magic bytes, then the text is decoded (BOM, then the declared charset, then an HTML `<meta charset>`, then strict
 * UTF-8, then windows-1252) and read as HTML, JSON, CSV or plain text.
 */

/** A declared media type (`text/csv; charset=utf-8`) as a kind and charset; unknown types give `kind: null`. */
export function parseMediaType(raw: string | null | undefined): { essence: string | null; kind: DocumentKind | null; charset?: string } {
  if (!raw || !raw.trim()) return { essence: null, kind: null };
  const [head, ...params] = raw.split(";");
  const essence = head!.trim().toLowerCase();
  let charset: string | undefined;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq < 0) continue;
    if (param.slice(0, eq).trim().toLowerCase() === "charset") charset = param.slice(eq + 1).trim().replace(/^"|"$/g, "") || undefined;
  }
  let kind: DocumentKind | null = null;
  if (essence === "text/plain") kind = "text";
  else if (essence === "text/markdown" || essence === "text/x-markdown") kind = "markdown";
  else if (essence === "text/html" || essence === "application/xhtml+xml") kind = "html";
  else if (essence === "application/json" || essence === "text/json" || essence.endsWith("+json")) kind = "json";
  else if (essence === "text/csv" || essence === "application/csv" || essence === "text/tab-separated-values") kind = "csv";
  return { essence, kind, ...(charset ? { charset } : {}) };
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);

/** Binary formats refused by magic bytes, with the message the caller sees. */
const BINARY_MAGIC: ReadonlyArray<{ magic: number[]; message: string }> = [
  // PDF documents are read by extractDocumentAsync (in a child process); the synchronous text reader refuses them.
  { magic: [0x25, 0x50, 0x44, 0x46, 0x2d], message: "PDF files are read by the asynchronous document reader only" },
  { magic: [0x50, 0x4b, 0x03, 0x04], message: "Zip and Office files are not supported yet" },
  { magic: [0x50, 0x4b, 0x05, 0x06], message: "Zip and Office files are not supported yet" },
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], message: "Older Office files are not supported" },
  { magic: [0x1f, 0x8b], message: "Compressed (gzip) files are not supported; send the document itself" },
  { magic: [0x42, 0x5a, 0x68], message: "Compressed files are not supported; send the document itself" },
  { magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], message: "Archives are not supported" },
  { magic: [0x52, 0x61, 0x72, 0x21], message: "Archives are not supported" },
  { magic: [0x89, 0x50, 0x4e, 0x47], message: "Images are not supported (there is no text recognition)" },
  { magic: [0xff, 0xd8, 0xff], message: "Images are not supported (there is no text recognition)" },
  { magic: [0x47, 0x49, 0x46, 0x38], message: "Images are not supported (there is no text recognition)" },
  { magic: [0x49, 0x49, 0x2a, 0x00], message: "Images are not supported (there is no text recognition)" },
  { magic: [0x4d, 0x4d, 0x00, 0x2a], message: "Images are not supported (there is no text recognition)" },
  { magic: [0x52, 0x49, 0x46, 0x46], message: "Media files are not supported" },
  { magic: [0x7f, 0x45, 0x4c, 0x46], message: "Executable files are not supported" },
  { magic: [0x4d, 0x5a], message: "Executable files are not supported" },
  { magic: [0xca, 0xfe, 0xba, 0xbe], message: "Executable files are not supported" },
  { magic: [0xcf, 0xfa, 0xed, 0xfe], message: "Executable files are not supported" },
  { magic: [0x00, 0x61, 0x73, 0x6d], message: "Executable files are not supported" }
];

/** A label TextDecoder knows and that is not the `replacement` encoding; else undefined. */
function usableEncoding(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    const encoding = new TextDecoder(label.trim()).encoding;
    return encoding === "replacement" ? undefined : encoding;
  } catch {
    return undefined;
  }
}

/** `<meta charset=...>` or `<meta http-equiv content="...; charset=...">` in the first 1 KB (ASCII view). */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const match = /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]{1,40})/i.exec(head);
  return match?.[1];
}

/**
 * True when the head starts (after whitespace and comments) with a doctype or an html tag, or holds an html, head or
 * body tag. Comments are skipped with indexOf, never with a nested regex quantifier (a run of `<!---->` would make one
 * backtrack exponentially).
 */
export function looksLikeHtml(head: string): boolean {
  let rest = head.trimStart();
  while (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->", 4);
    if (end < 0) return false;
    rest = rest.slice(end + 3).trimStart();
  }
  return /^<(?:!doctype\s+html|html[\s>])/i.test(rest) || /<(?:html|head|body)[\s>]/i.test(head);
}

export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * The bytes as text. Throws DocumentError(unsupported_type) for a binary format. The order: a BOM, the declared charset,
 * an HTML meta charset (first 1 KB), strict UTF-8, then windows-1252.
 */
export function decodeDocument(bytes: Uint8Array, declaredCharset?: string): DecodedText {
  for (const entry of BINARY_MAGIC) {
    if (startsWith(bytes, entry.magic)) throw new DocumentError("unsupported_type", entry.message);
  }
  let encoding: string | undefined;
  let body = bytes;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    encoding = "utf-8";
    body = bytes.subarray(3);
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    encoding = "utf-16le";
    body = bytes.subarray(2);
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    encoding = "utf-16be";
    body = bytes.subarray(2);
  }
  encoding ??= usableEncoding(declaredCharset);
  const wide = encoding === "utf-16le" || encoding === "utf-16be";
  if (!wide) {
    // NUL bytes in a document that is not UTF-16: a binary file, refused rather than read as text.
    const probe = body.subarray(0, 8192);
    if (probe.includes(0)) throw new DocumentError("unsupported_type", "This looks like a binary file; only text, Markdown, HTML, JSON and CSV are supported");
  }
  encoding ??= usableEncoding(metaCharset(body));
  if (encoding) {
    try {
      return { text: new TextDecoder(encoding, { fatal: false }).decode(body), encoding };
    } catch {
      encoding = undefined;
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(body), encoding: "windows-1252" };
  }
}

/** True when most of the first lines split into the same number (two or more) of fields. */
export function looksLikeCsv(text: string, delimiter: string): boolean {
  const lines = text.split(/\r?\n/, 21).filter((line) => line.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return false;
  const counts = lines.map((line) => splitSimple(line, delimiter));
  const first = counts[0]!;
  if (first < 2) return false;
  return counts.filter((count) => count === first).length >= Math.ceil(counts.length * 0.8);
}

/** Fields in one line, honouring double quotes (good enough for a heuristic). */
function splitSimple(line: string, delimiter: string): number {
  let fields = 1;
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) fields += 1;
  }
  return fields;
}

/** The delimiter of a CSV text: tab for TSV, else the one of `,` `;` `\t` that the first line uses most. */
export function csvDelimiter(text: string, essence: string | null): string {
  if (essence === "text/tab-separated-values") return "\t";
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const scores = [",", ";", "\t"].map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }));
  scores.sort((a, b) => b.count - a.count);
  return scores[0]!.count > 0 ? scores[0]!.delimiter : ",";
}

export interface SniffResult {
  kind: DocumentKind;
  /** The declared type was a known one and the content says otherwise. */
  typeMismatch: boolean;
  /** The parsed value of a JSON document (parsed once while sniffing). */
  json?: unknown;
}

/**
 * The kind the text is read as: HTML when it looks like a page, JSON when it parses as an object or array, CSV only
 * when declared and consistent with it, Markdown when declared, otherwise plain text.
 */
export function sniffKind(text: string, declared: DocumentKind | null, declaredEssence: string | null): SniffResult {
  const head = text.slice(0, 1024);
  const trimmed = text.trimStart();
  const mismatch = (kind: DocumentKind) => declaredEssence !== null && declared !== kind && !(declared === "markdown" && kind === "text");
  if (looksLikeHtml(head)) return { kind: "html", typeMismatch: mismatch("html") };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(text) as unknown;
      return { kind: "json", typeMismatch: mismatch("json"), json };
    } catch (error) {
      if (declared === "json") throw new DocumentError("invalid_document", `The JSON could not be parsed: ${(error as Error).message.replace(/".*$/s, "").slice(0, 120)}`);
    }
  } else if (declared === "json") {
    throw new DocumentError("invalid_document", "The document was sent as JSON but is not a JSON object or array");
  }
  if (declared === "html" && /<[a-z!/]/i.test(head)) return { kind: "html", typeMismatch: false };
  if (declared === "csv" && looksLikeCsv(text, csvDelimiter(text, declaredEssence))) return { kind: "csv", typeMismatch: false };
  if (declared === "markdown") return { kind: "markdown", typeMismatch: false };
  return { kind: "text", typeMismatch: mismatch("text") };
}
