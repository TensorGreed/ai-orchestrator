import { createHash } from "node:crypto";
import { riskLevelOf, scanSensitiveText, type SensitiveScanRequest, type SensitiveScanSettings } from "@ai-orchestrator/guard-sdk";
import { CONTENT_SCAN_LIMITS, type DocumentFinding, type DocumentRiskLevel } from "@ai-orchestrator/shared";
import { lineLocator, locationLabel, type ExtractedDocument } from "./extract.js";

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

/** The content rules data scan with a rule set's settings and a call's narrowing (entity types, allow-list). */
export function sensitiveDocumentScanner(settings: SensitiveScanSettings, request: SensitiveScanRequest = {}): DocumentTextScanner {
  return (text) => scanSensitiveText(text, settings, request).findings;
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
  for (const segment of document.segments) {
    const hits = segment.text.length === 0 ? [] : [...(await options.scanner(segment.text))].sort((a, b) => a.start - b.start);
    let locate: ReturnType<typeof lineLocator> | undefined;
    for (const hit of hits) {
      total += 1;
      counts[hit.dataClass] = (counts[hit.dataClass] ?? 0) + 1;
      scored.push({ dataClass: hit.dataClass, score: hit.score });
      maxScore[hit.dataClass] = Math.max(maxScore[hit.dataClass] ?? 0, hit.score);
      if (findings.length < maxFindings) {
        if (segment.lines) locate ??= lineLocator(segment.text);
        const where = { ...segment.where, ...(locate ? locate(hit.start) : {}) };
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
