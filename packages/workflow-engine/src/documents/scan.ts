import { createHash } from "node:crypto";
import { EntityScanError, riskLevelOf, scanSensitiveTextAsync, type SensitiveScanContext, type SensitiveScanRequest, type SensitiveScanSettings } from "@ai-orchestrator/guard-sdk";
import { CONTENT_SCAN_LIMITS, type DocumentFinding, type DocumentRiskLevel } from "@ai-orchestrator/shared";
import { DocumentError } from "./errors.js";
import { csvFieldName, jsonPointerOf, lineLocator, locationLabel, type DocumentSegment, type ExtractedDocument } from "./extract.js";

/**
 * Checks an extracted document's segments with a text scanner (the content rules data scan by default) and maps each
 * finding to its place in the document. Findings carry masked previews only; the redacted view replaces each finding
 * with what `protect` returns.
 */

export interface DocumentTextFinding {
  dataClass: string;
  start: number;
  end: number;
  score: number;
  /** Masked; never the value. */
  preview: string;
}

/** Finds sensitive data in one text; spans must be disjoint (as the data scan returns them). */
export type DocumentTextScanner = (text: string) => Promise<DocumentTextFinding[]> | DocumentTextFinding[];

/**
 * The content rules data scan with a rule set's settings and a call's narrowing (entity types, allow-list), plus person
 * names, locations and street addresses when the call names them or the rule set runs `data.entities` (with the
 * deployment's recognizer from `context`). A failed names and addresses check fails the scan (`check_failed`); the
 * recognizer's own message stays on the server.
 */
export function sensitiveDocumentScanner(settings: SensitiveScanSettings, request: SensitiveScanRequest = {}, context: SensitiveScanContext = {}): DocumentTextScanner {
  return async (text) => {
    if (context.signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
    try {
      return (await scanSensitiveTextAsync(text, settings, request, context)).findings;
    } catch (error) {
      if (!(error instanceof EntityScanError)) throw error;
      if (context.signal?.aborted) throw new DocumentError("cancelled", "The scan was cancelled");
      throw new DocumentError("check_failed", "Names and addresses could not be checked; try again, or leave person_name, location and street_address out of the entity types");
    }
  };
}

export interface DocumentScanOptions {
  scanner: DocumentTextScanner;
  maxFindings?: number;
  /** When set, the redacted view is built: each finding replaced by what this returns for its value. */
  protect?: (value: string, dataClass: string) => Promise<string>;
}

export interface DocumentScanOutcome {
  documentId: string;
  riskLevel: DocumentRiskLevel;
  countsByClass: Record<string, number>;
  findings: DocumentFinding[];
  findingsTruncated: boolean;
  /** How many findings there are in all (the list may be shorter). */
  total: number;
  /** The highest score per data class, over every finding. */
  maxScoreByClass: Record<string, number>;
  redactedText?: string;
}

export function documentIdOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export async function scanExtractedDocument(document: ExtractedDocument, bytes: Uint8Array, options: DocumentScanOptions): Promise<DocumentScanOutcome> {
  const maxFindings = options.maxFindings ?? CONTENT_SCAN_LIMITS.maxFindings;
  const findings: DocumentFinding[] = [];
  const counts: Record<string, number> = {};
  const scored: Array<{ dataClass: string; score: number }> = [];
  const maxScore: Record<string, number> = {};
  const rewritten: string[] = [];
  let total = 0;
  // Pass one: every segment's findings. JSON keys and CSV headers that hold one are then never echoed in a location.
  const allHits: DocumentTextFinding[][] = [];
  const unsafeNames = new Set<string>();
  for (const [index, segment] of document.segments.entries()) {
    // Many small segments (CSV cells, JSON strings) are checked synchronously: give the event loop a turn now and then.
    if (index > 0 && index % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const hits = segment.text.length === 0 ? [] : [...(await options.scanner(segment.text))].sort((a, b) => a.start - b.start);
    allHits.push(hits);
    if (hits.length > 0 && (segment.where.key || (segment.where.kind === "csv" && segment.where.row === 1))) unsafeNames.add(segment.text);
  }
  const whereOf = (segment: DocumentSegment) => {
    if (segment.where.kind === "json") return { ...segment.where, pointer: jsonPointerOf(segment.path, unsafeNames) };
    const field = csvFieldName(segment.header, unsafeNames);
    return field ? { ...segment.where, field } : segment.where;
  };
  for (const [index, segment] of document.segments.entries()) {
    const hits = allHits[index] ?? [];
    let locate: ReturnType<typeof lineLocator> | undefined;
    for (const hit of hits) {
      total += 1;
      counts[hit.dataClass] = (counts[hit.dataClass] ?? 0) + 1;
      scored.push({ dataClass: hit.dataClass, score: hit.score });
      maxScore[hit.dataClass] = Math.max(maxScore[hit.dataClass] ?? 0, hit.score);
      if (findings.length < maxFindings) {
        if (segment.lines) locate ??= lineLocator(segment.text);
        const where = { ...whereOf(segment), ...(locate ? locate(hit.start) : {}) };
        findings.push({ dataClass: hit.dataClass, score: hit.score, location: { ...where, label: locationLabel(where) }, maskedPreview: hit.preview });
      }
    }
    if (options.protect) {
      let out = "";
      let cursor = 0;
      for (const hit of hits) {
        if (hit.start < cursor) continue;
        out += segment.text.slice(cursor, hit.start) + (await options.protect(segment.text.slice(hit.start, hit.end), hit.dataClass));
        cursor = hit.end;
      }
      rewritten.push(out + segment.text.slice(cursor));
    }
  }
  return {
    documentId: documentIdOf(bytes),
    riskLevel: riskLevelOf(scored),
    countsByClass: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
    findings,
    findingsTruncated: total > findings.length,
    total,
    maxScoreByClass: maxScore,
    ...(options.protect ? { redactedText: document.render(rewritten) } : {})
  };
}
