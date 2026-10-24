import { z } from "zod";

/**
 * Phase 15.6 — data labels: what kind of data a node's output holds and where
 * it came from. This slice builds the foundations only:
 *
 *   - provenance: where the content came from (a trusted workflow author, a
 *     user, an external system, or data known to be sensitive). Guard
 *     policies key on these labels.
 *   - dataClasses: the DLP data classes found in it (email, card_number, a
 *     profile dictionary's class, ...).
 *   - source: `scan` when a scan of the recorded content found them (a
 *     production capture's masking pass); `propagated` is reserved for labels
 *     carried from a node's inputs to its output; `file` for labels read
 *     from an imported golden-set file, which are never trusted (an import
 *     drops `trusted` from them).
 *
 * Labels never carry values: only class names and counts.
 */

/** Where content came from. Ordered from most to least trusted, except `sensitive`, which marks data that needs care whatever its origin. */
export const PROVENANCE_LABELS = ["trusted", "user", "untrusted_external", "sensitive"] as const;
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];
export const provenanceLabelSchema = z.enum(PROVENANCE_LABELS);

export const DATA_LABEL_SOURCES = ["scan", "propagated", "file"] as const;
export type DataLabelSource = (typeof DATA_LABEL_SOURCES)[number];

/** A data class name: a built-in DLP class or a profile dictionary's class. */
export const dataClassNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Data class names use letters, digits, '_', '.', ':' and '-' only");

export const dataLabelsSchema = z.object({
  provenance: z.array(provenanceLabelSchema).max(PROVENANCE_LABELS.length).default([]),
  dataClasses: z.array(dataClassNameSchema).max(100).default([]),
  source: z.enum(DATA_LABEL_SOURCES)
});
export type DataLabels = z.output<typeof dataLabelsSchema>;

/** The union of several label sets: provenance and classes merged, sorted and de-duplicated. `source` is `propagated` unless every part was scanned. */
export function mergeDataLabels(parts: readonly DataLabels[]): DataLabels | null {
  if (parts.length === 0) return null;
  const provenance = new Set<ProvenanceLabel>();
  const dataClasses = new Set<string>();
  for (const part of parts) {
    part.provenance.forEach((label) => provenance.add(label));
    part.dataClasses.forEach((name) => dataClasses.add(name));
  }
  return {
    provenance: PROVENANCE_LABELS.filter((label) => provenance.has(label)),
    dataClasses: [...dataClasses].sort(),
    source: parts.every((part) => part.source === "scan") ? "scan" : "propagated"
  };
}
