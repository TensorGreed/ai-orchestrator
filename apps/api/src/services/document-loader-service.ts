/**
 * Phase 9.2 — Document loaders.
 *
 * Each loader takes a raw payload (string for text-based, Buffer for binary)
 * and returns a list of `{ text, metadata }` documents. The orchestrator at
 * `POST /api/knowledge-bases/:id/upload` chains:
 *
 *   payload -> loader -> chunker -> embedder -> KB.addChunks
 *
 * Design notes:
 *   - HTML uses a tiny regex-based stripper rather than `cheerio` to avoid a
 *     new runtime dep. Good enough for typical web pages and markdown-ish
 *     HTML; for full-DOM extraction we'd add cheerio later.
 *   - PDF / DOCX are deliberately out of scope for 9.2. They each need a
 *     binary parser and platform-specific binaries; will land as 9.2.x
 *     follow-ups so this commit stays focused.
 *   - All loaders are pure — they don't touch the network, FS, or DB. Easy
 *     to test in isolation.
 */

export type DocumentKind = "text" | "markdown" | "html" | "csv" | "json";

export interface LoadedDocument {
  text: string;
  metadata: Record<string, unknown>;
}

export interface LoadOptions {
  /** Caller's name for the source (filename, URL, etc.) — copied onto every doc's metadata. */
  sourceId?: string;
  /** Extra metadata merged onto every loaded doc. */
  metadata?: Record<string, unknown>;
  /** Loader-specific options. */
  csv?: { textColumn?: string; metadataColumns?: string[] };
}

export function loadDocuments(
  kind: DocumentKind,
  payload: string,
  options: LoadOptions = {}
): LoadedDocument[] {
  const baseMeta: Record<string, unknown> = {
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    ...(options.metadata ?? {})
  };

  switch (kind) {
    case "text":
    case "markdown":
      return loadPlainText(payload, baseMeta);
    case "html":
      return loadHtml(payload, baseMeta);
    case "csv":
      return loadCsv(payload, baseMeta, options.csv);
    case "json":
      return loadJson(payload, baseMeta);
    default:
      throw new Error(`Unknown document kind: ${kind}`);
  }
}

/** Filename → kind heuristic. Falls back to "text" so unknown extensions still work. */
export function inferDocumentKind(filename: string): DocumentKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".json") || lower.endsWith(".ndjson")) return "json";
  return "text";
}

// ---------------------------------------------------------------------------
// Plain text / Markdown
// ---------------------------------------------------------------------------

function loadPlainText(payload: string, baseMeta: Record<string, unknown>): LoadedDocument[] {
  if (!payload.trim()) return [];
  return [{ text: payload, metadata: { ...baseMeta, kind: "text" } }];
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function loadHtml(payload: string, baseMeta: Record<string, unknown>): LoadedDocument[] {
  const text = stripHtml(payload);
  if (!text.trim()) return [];
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(payload);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.trim()) : null;
  return [
    {
      text,
      metadata: {
        ...baseMeta,
        kind: "html",
        ...(title ? { title } : {})
      }
    }
  ];
}

/**
 * Tiny HTML-to-text stripper. Removes <script>/<style>/<head> blocks first,
 * then drops every remaining tag, then collapses whitespace. Sufficient for
 * the "user pastes a wikipedia article" workflow without pulling in cheerio.
 */
function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|td|th|blockquote|pre)>/gi, "$&\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
  ).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function loadCsv(
  payload: string,
  baseMeta: Record<string, unknown>,
  options: { textColumn?: string; metadataColumns?: string[] } = {}
): LoadedDocument[] {
  const rows = parseCsv(payload);
  if (rows.length < 2) return [];
  const header = rows[0]!;
  const textColIdx = options.textColumn ? header.indexOf(options.textColumn) : -1;
  const metaIdxs = (options.metadataColumns ?? []).map((c) => ({ name: c, idx: header.indexOf(c) }));

  return rows.slice(1).map((row, rowIdx) => {
    let text: string;
    const metadata: Record<string, unknown> = { ...baseMeta, kind: "csv", rowIndex: rowIdx };
    if (textColIdx >= 0) {
      text = row[textColIdx] ?? "";
      // include other columns as metadata
      for (let i = 0; i < header.length; i++) {
        if (i !== textColIdx) metadata[header[i]!] = row[i] ?? null;
      }
    } else {
      // No text column declared — concat every column as "key: value\n..."
      text = header
        .map((col, i) => `${col}: ${row[i] ?? ""}`)
        .filter((line) => line.length > 0)
        .join("\n");
      for (const { name, idx } of metaIdxs) {
        if (idx >= 0) metadata[name] = row[idx] ?? null;
      }
    }
    return { text: text.trim(), metadata };
  }).filter((doc) => doc.text.length > 0);
}

/**
 * RFC-4180-ish CSV parser. Handles quoted fields with embedded commas,
 * escaped quotes (""), and CRLF/LF line endings. Doesn't support
 * multi-character delimiters — tab-separated files would need a follow-up.
 */
function parseCsv(payload: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (payload[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // ignore — \n will close the row
      } else {
        field += c;
      }
    }
  }
  // flush
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// JSON / NDJSON
// ---------------------------------------------------------------------------

/**
 * If the payload parses as a JSON array, each element becomes a doc. If it's
 * an object, treat it as a single doc. NDJSON (one JSON value per line) is
 * detected by the presence of multiple newlines outside of any JSON.
 */
function loadJson(payload: string, baseMeta: Record<string, unknown>): LoadedDocument[] {
  const trimmed = payload.trim();
  if (!trimmed) return [];

  // NDJSON — each non-empty line is its own JSON value
  if (trimmed.includes("\n") && !trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    const docs: LoadedDocument[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t);
        docs.push(jsonValueToDoc(parsed, baseMeta));
      } catch {
        // skip malformed lines silently — better than failing the whole upload
      }
    }
    return docs;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => jsonValueToDoc(v, baseMeta));
    }
    return [jsonValueToDoc(parsed, baseMeta)];
  } catch {
    return [];
  }
}

function jsonValueToDoc(value: unknown, baseMeta: Record<string, unknown>): LoadedDocument {
  if (typeof value === "string") {
    return { text: value, metadata: { ...baseMeta, kind: "json" } };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    // Convention: { text, metadata } means "use this as-is"; otherwise serialize.
    if (typeof obj.text === "string") {
      const meta = obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)
        ? (obj.metadata as Record<string, unknown>)
        : {};
      return { text: obj.text, metadata: { ...baseMeta, ...meta, kind: "json" } };
    }
    return { text: JSON.stringify(obj), metadata: { ...baseMeta, kind: "json" } };
  }
  return { text: String(value), metadata: { ...baseMeta, kind: "json" } };
}
