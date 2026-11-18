import { z } from "zod";
import { dataClassNameSchema } from "./data-labels";

/**
 * Scanning documents with content rules: a text, Markdown, HTML, JSON, CSV or PDF document, uploaded or fetched from a
 * URL, turned into text segments with locations (line:column, row:column, a JSON pointer, the part of an HTML page, or
 * a PDF page and line) and checked with a rule set's data scan. A PDF's text layer, comments, form field values, links
 * and document properties are read in a child process with memory and time limits; scanned pages (images of text) have
 * no text layer and are reported as such, since there is no text recognition.
 *
 * - The rule set page's "Scan a document" panel (`POST /api/guard/profiles/:id/scan-document`): a test, like a
 *   simulation; no rule events.
 * - The `scan_document` gateway tool on a toolset's content rules member, behind its own `documents` switch (off by
 *   default). Fetching URLs is a second switch with a required host allow-list, and gateway fetches never reach
 *   private, loopback or link-local addresses.
 *
 * Nothing fetched or uploaded is stored: bytes and text live for the call only. Findings carry masked previews only.
 * Zip and Office files are not supported yet.
 */

/** Document kinds the extractor reads. */
export const DOCUMENT_KINDS = ["text", "markdown", "html", "json", "csv", "pdf"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Defaults and hard ceilings of the document scan limits (the deployment sets them with CONTENT_SCAN_*). */
export const CONTENT_SCAN_LIMITS = {
  /** Bytes read from an upload or a URL (decoded bytes for a compressed response). */
  maxBytes: 5 * 1024 * 1024,
  maxBytesCeiling: 25 * 1024 * 1024,
  /** Characters of extracted text checked; past this the result says `truncated` and which part was covered. */
  maxChars: 2_000_000,
  maxCharsCeiling: 20_000_000,
  fetchTimeoutMs: 15_000,
  firstByteTimeoutMs: 10_000,
  maxConcurrent: 2,
  maxRedirects: 3,
  /** A compressed response that expands more than this many times (past 1 MiB decoded) is refused. */
  maxExpansion: 100,
  jsonMaxDepth: 64,
  jsonMaxNodes: 200_000,
  csvMaxRows: 100_000,
  /** Each CSV cell is checked on its own; more cells than this are refused. */
  csvMaxCells: 500_000,
  /** Findings listed per document (counts always cover all of them). */
  maxFindings: 1_000,
  /** PDF pages read per document; past this the result says how many were checked. */
  maxPages: 200,
  maxPagesCeiling: 5_000,
  /** Wall-clock time for reading one PDF; the worker reading it is stopped at this point. */
  pdfTimeoutMs: 20_000,
  pdfTimeoutMsCeiling: 300_000,
  /** Memory for reading one PDF (the worker's heap, and separately its buffers); past this the worker is stopped. */
  pdfMemoryMb: 256,
  pdfMemoryMbFloor: 64,
  pdfMemoryMbCeiling: 4_096
} as const;

/** Where a finding is in the document. `label` is the human form ("line 3, column 7", "row 2, column email"). */
export interface DocumentLocation {
  kind: DocumentKind;
  label: string;
  line?: number;
  column?: number;
  /** CSV: 1-based row (the header row is row 1) and column; `field` is the header name when there is a header. */
  row?: number;
  field?: string;
  /** JSON: an RFC 6901 pointer to the string (`/items/0/email`); `key` when the text is an object key. */
  pointer?: string;
  key?: boolean;
  /**
   * HTML: visible text, an `alt`/`title`/`aria-label` attribute, or text the page hides (hidden, aria-hidden, display:none).
   * PDF: the page's text, a comment (its text or author), a form field's value, a link's address, or a document property.
   */
  part?: "visible" | "attribute" | "hidden" | PdfPart;
  /** HTML: the attribute and its tag. PDF: the document property's name (Title, Author, ...). */
  attribute?: string;
  /** PDF: the 1-based page. */
  page?: number;
  /** PDF: the comment, form field or link's 1-based position on its page. */
  item?: number;
}

/** Where a PDF finding is: page text, a comment, a comment's author, a form field value, a link address, or a property. */
export const PDF_PARTS = ["text", "comment", "comment_author", "form_field", "link", "properties"] as const;
export type PdfPart = (typeof PDF_PARTS)[number];

/** Parts of any PDF the reader never reads; every PDF result says so (scan notice, panel, Extract from File). */
export const PDF_NOT_READ =
  "Never read in a PDF: form field values without a widget on a page, pop-up notes, outlines (bookmarks), earlier revisions of the document, and attached files";

/**
 * Whether a PDF had text to check: `present` on every page read, `partial` when some pages have none, `empty` when no
 * page has any (a scanned document: there is no text recognition, so its pages were not checked).
 */
export type PdfTextLayer = "present" | "partial" | "empty";

export interface DocumentFinding {
  dataClass: string;
  score: number;
  location: DocumentLocation;
  /** The value masked the way its class is usually shown; never the value. */
  maskedPreview: string;
}

export type DocumentRiskLevel = "none" | "low" | "medium" | "high";

export type DocumentSource = { kind: "url"; origin: string; pathHash: string } | { kind: "upload"; filename?: string };

export interface DocumentScanResult {
  /** The first 16 hex characters of the SHA-256 of the bytes. */
  documentId: string;
  source: DocumentSource;
  /** The type the upload or the server declared (null: none). */
  mediaType: string | null;
  /** The type the content was read as. */
  sniffedType: DocumentKind;
  /** The declared type and the content disagreed; the content won. */
  typeMismatch: boolean;
  encoding: string;
  bytes: number;
  /** Characters of extracted text. */
  chars: number;
  /** Only part of the document was checked (`covered` says how much text; for a PDF, `pages` says which pages). */
  truncated: boolean;
  /**
   * Characters checked, and of how many. A PDF whose text passed CONTENT_SCAN_MAX_CHARS was not read further, so `of`
   * is absent (unknown) and `pages.cutAt` names the page read only in part.
   */
  covered?: { chars: number; of?: number };
  riskLevel: DocumentRiskLevel;
  countsByClass: Record<string, number>;
  findings: DocumentFinding[];
  /** More findings than CONTENT_SCAN_LIMITS.maxFindings: `findings` lists the first ones, the counts cover all. */
  findingsTruncated: boolean;
  /**
   * PDF: pages in the document and pages read (fewer past CONTENT_SCAN_MAX_PAGES, or when the text passed
   * CONTENT_SCAN_MAX_CHARS: then `cutAt` is the last page read, read only in part).
   */
  pages?: { total: number; checked: number; cutAt?: number };
  /** PDF: whether the pages read had a text layer, and how many had none (scanned pages are not checked). */
  textLayer?: PdfTextLayer;
  pagesWithoutText?: number;
  /** PDF: files embedded in the document; they are not checked. */
  attachmentsNotChecked?: number;
  /** What was not checked, in words (a PDF without a text layer, parts past the limits, attached files); absent when nothing. */
  notice?: string;
  /** Plain text with the findings replaced, when asked for. Never a document file. */
  redacted?: { style: string; text: string; redaction_id?: string; expires_at?: string };
  ruleSet: { id: string; version: number } | null;
}

/** Redaction styles the rule set page's test offers (nothing is kept, so nothing is reversible there). */
export const DOCUMENT_TEST_REDACT_STYLES = ["mask", "placeholder"] as const;

const uploadSourceSchema = z
  .object({
    kind: z.literal("upload"),
    /** The file's bytes, base64. */
    contentBase64: z.string().min(1),
    filename: z.string().trim().min(1).max(255).optional(),
    mediaType: z.string().trim().min(1).max(200).optional()
  })
  .strict();

const urlSourceSchema = z
  .object({
    kind: z.literal("url"),
    url: z.string().trim().min(1).max(2048)
  })
  .strict();

/** `POST /api/guard/profiles/:id/scan-document`. Neither `document` nor `version`: the latest saved version. */
export const documentScanRequestSchema = z
  .object({
    source: z.discriminatedUnion("kind", [uploadSourceSchema, urlSourceSchema]),
    /** The editor's unsaved rule set document (never stored). */
    document: z.record(z.string(), z.unknown()).optional(),
    version: z.number().int().positive().optional(),
    entityTypes: z.array(dataClassNameSchema).max(50).optional(),
    redact: z.enum(DOCUMENT_TEST_REDACT_STYLES).optional()
  })
  .strict()
  .refine((value) => value.document === undefined || value.version === undefined, {
    message: "Send either the rule set document or a saved version, not both"
  });
export type DocumentScanRequest = z.infer<typeof documentScanRequestSchema>;

/**
 * A host allow-list entry: `docs.example.com` (exactly that host) or `*.example.com` (any subdomain of it), optionally
 * with a port (`docs.example.com:8443`). Without a port only the scheme's default port matches (80 for http, 443 for
 * https); with one, only that port.
 */
export const documentHostPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(259)
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}))?$/,
    "Use a host name like docs.example.com, *.example.com or docs.example.com:8443"
  )
  .refine((value) => value.split(":")[0]!.length <= 253, "The host name is longer than 253 characters");

/**
 * The `documents` options of a content rules toolset member. `enabled` lists `scan_document` for inline content;
 * `allowUrls` also lets it fetch, from hosts in `allowedHosts` only (required when URLs are on).
 */
export const contentRulesDocumentsSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowUrls: z.boolean().default(false),
    allowedHosts: z.array(documentHostPatternSchema).max(100).default([])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allowUrls && !value.enabled) ctx.addIssue({ code: "custom", path: ["allowUrls"], message: "Turn on document scanning before allowing URLs" });
    if (value.allowUrls && value.allowedHosts.length === 0) ctx.addIssue({ code: "custom", path: ["allowedHosts"], message: "List the hosts documents may be fetched from" });
  });
export type ContentRulesDocumentsOptions = z.output<typeof contentRulesDocumentsSchema>;

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * True when a URL's host and port match an allow-list entry: the host exactly, or as a subdomain of a `*.` entry; and
 * the entry's port, or, for an entry without one, the scheme's default port (80 for http, 443 for https) only.
 */
export function documentHostAllowed(target: { hostname: string; port: string; protocol: string }, patterns: readonly string[]): boolean {
  const host = target.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const defaultPort = DEFAULT_PORTS[target.protocol.toLowerCase()];
  if (!host || !defaultPort) return false;
  const port = target.port || defaultPort;
  return patterns.some((raw) => {
    const entry = raw.trim().toLowerCase();
    const colon = entry.lastIndexOf(":");
    const pattern = colon >= 0 ? entry.slice(0, colon) : entry;
    const wantedPort = colon >= 0 ? entry.slice(colon + 1) : defaultPort;
    if (port !== wantedPort) return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.length > suffix.length && host.endsWith(suffix);
    }
    return host === pattern;
  });
}

// ---------------------------------------------------------------------------
// The `scan_document` gateway tool
// ---------------------------------------------------------------------------

export const SCAN_DOCUMENT_TOOL_NAME = "scan_document" as const;

export const SCAN_DOCUMENT_REDACT_STYLES = ["placeholder", "token", "mask", "hash"] as const;

export const scanDocumentArgsSchema = z
  .object({
    content_base64: z.string().min(1).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    media_type: z.string().trim().min(1).max(200).optional(),
    filename: z.string().trim().min(1).max(255).optional(),
    rule_set_id: z.string().trim().min(1).max(63).optional(),
    entity_types: z.array(dataClassNameSchema).max(50).optional(),
    allow_list: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
    redact_style: z.enum(SCAN_DOCUMENT_REDACT_STYLES).optional(),
    ttl_seconds: z.number().int().min(60).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.content_base64 === undefined) === (value.url === undefined)) ctx.addIssue({ code: "custom", path: [], message: "Give exactly one of content_base64 or url" });
  });
export type ScanDocumentArgs = z.output<typeof scanDocumentArgsSchema>;

export function scanDocumentInputSchema(allowUrls: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content_base64: { type: "string", description: "The document's bytes, base64 (text, Markdown, HTML, JSON, CSV or PDF)." },
      ...(allowUrls ? { url: { type: "string", description: "An http(s) URL on a host this toolset allows; fetched without cookies or credentials." } } : {}),
      media_type: { type: "string", description: "The document's type, e.g. text/csv (the content decides when they disagree)." },
      filename: { type: "string", description: "The file name, reported back; never used to choose the type." },
      rule_set_id: { type: "string", description: "A rule set this toolset makes available; defaults to the toolset's own." },
      entity_types: { type: "array", items: { type: "string" }, maxItems: 50, description: "Only these data classes." },
      allow_list: { type: "array", items: { type: "string" }, maxItems: 100, description: "Values never reported in this call." },
      redact_style: { type: "string", enum: [...SCAN_DOCUMENT_REDACT_STYLES], description: "Also return the document's text with findings replaced (placeholder and token return a redaction_id)." },
      ttl_seconds: { type: "integer", minimum: 60, description: "How long a placeholder or token redaction can be restored; at most the deployment's limit." }
    },
    additionalProperties: false
  };
}

export function scanDocumentDescription(allowUrls: boolean): string {
  return `Check a document for sensitive data: text, Markdown, HTML, JSON, CSV or PDF${allowUrls ? ", sent as base64 or fetched from an allowed URL" : ", sent as base64"}. Returns each finding's data class, location (line and column, CSV row and column, JSON pointer, the part of an HTML page, or a PDF page and line, comment or form field), a masked preview and a score, and a risk level. A PDF without a text layer (a scanned document) is reported as such, since there is no text recognition. Optionally returns the text with findings replaced. Values are never returned, and nothing is stored.`;
}

// ---------------------------------------------------------------------------
// Storage of a content rules member's options (v77 `mcp_toolset_members.options_json`)
// ---------------------------------------------------------------------------

/** The stored form of a content rules member's options; null when there is nothing to keep. */
export function contentRulesMemberOptionsJson(documents: ContentRulesDocumentsOptions | undefined): string | null {
  return documents ? JSON.stringify({ documents }) : null;
}

/** A content rules member's stored options; anything unreadable or invalid reads as off. */
export function parseContentRulesMemberOptions(raw: unknown): { documents?: ContentRulesDocumentsOptions } {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = contentRulesDocumentsSchema.safeParse((JSON.parse(raw) as { documents?: unknown } | null)?.documents);
    return parsed.success ? { documents: parsed.data } : {};
  } catch {
    return {};
  }
}
