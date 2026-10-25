import type { DataLabels, ProvenanceLabel } from "@ai-orchestrator/shared";

/**
 * Phase 16 — where a node's data came from and what it contains, in plain
 * words: "from outside · contains email". Shown only for runs whose guard
 * profile tracks data labels; other runs store none, so nothing renders.
 */

const PROVENANCE_WORDS: Record<ProvenanceLabel, string> = {
  trusted: "from your system",
  user: "from a user",
  untrusted_external: "from outside",
  sensitive: "sensitive"
};

/** The order the words appear in: the riskiest origin first. */
const PROVENANCE_ORDER: ProvenanceLabel[] = ["untrusted_external", "sensitive", "user", "trusted"];

function readLabels(value: unknown): DataLabels | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const provenance = Array.isArray(record.provenance) ? record.provenance.filter((entry): entry is ProvenanceLabel => typeof entry === "string" && entry in PROVENANCE_WORDS) : [];
  const dataClasses = Array.isArray(record.dataClasses) ? record.dataClasses.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  if (provenance.length === 0 && dataClasses.length === 0) return null;
  return { provenance, dataClasses, source: record.source === "scan" || record.source === "file" ? record.source : "propagated" };
}

/** A data class name as people say it: `card_number` → "card number". */
export function dataClassWords(dataClass: string): string {
  return dataClass.replace(/[_-]+/g, " ").trim();
}

/** The chip words for a node's labels, or [] when there is nothing to show. */
export function describeDataLabels(value: unknown): string[] {
  const labels = readLabels(value);
  if (!labels) return [];
  const origins = PROVENANCE_ORDER.filter((label) => labels.provenance.includes(label)).map((label) => PROVENANCE_WORDS[label]);
  const contents = labels.dataClasses.length > 0 ? [`contains ${labels.dataClasses.map(dataClassWords).join(", ")}`] : [];
  return [...origins, ...contents];
}

export function DataLabelChips({ labels }: { labels: unknown }) {
  const words = describeDataLabels(labels);
  if (words.length === 0) return null;
  return (
    <span className="data-label-chips" aria-label={`Data labels: ${words.join(" · ")}`} title="Where this node's data came from and what it contains">
      {words.map((word) => (
        <span key={word} className={word.startsWith("contains") ? "data-label-chip is-class" : word === PROVENANCE_WORDS.untrusted_external ? "data-label-chip is-external" : "data-label-chip"}>
          {word}
        </span>
      ))}
    </span>
  );
}
