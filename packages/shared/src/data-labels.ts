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

/** Phase 16 — the union of label sets (missing parts ignored), always source `propagated`; empty labels when there are none. */
export function unionDataLabels(parts: ReadonlyArray<DataLabels | null | undefined>): DataLabels {
  const merged = mergeDataLabels(parts.filter((part): part is DataLabels => Boolean(part)));
  return merged ? { ...merged, source: "propagated" } : { provenance: [], dataClasses: [], source: "propagated" };
}

/**
 * Phase 16 — the labels to store when a run that does not track labels saves
 * over a row. It cannot know what it carried forward from the stored value,
 * so labels are never dropped: none stored stays none (zero-config writes
 * nothing new), stored labels stay and gain `untrusted_external` (the new
 * content has an unknown origin).
 */
export function labelsForUntrackedSave(stored: DataLabels | null | undefined): DataLabels | null {
  if (!stored || isEmptyDataLabels(stored)) return null;
  return unionDataLabels([stored, { provenance: ["untrusted_external"], dataClasses: [], source: "propagated" }]);
}

/**
 * Phase 16 — labels a run carries per node, in a side map beside the node
 * outputs (never inside an output value). Serialisable, so a paused run's
 * state and a run's history can hold it.
 */
export type NodeLabelMap = Record<string, DataLabels>;
export const nodeLabelMapSchema = z.record(z.string(), dataLabelsSchema);

/** Labels with nothing in them. */
export function emptyDataLabels(source: DataLabelSource = "propagated"): DataLabels {
  return { provenance: [], dataClasses: [], source };
}

/** True when the labels say nothing: no provenance and no data class. */
export function isEmptyDataLabels(labels: DataLabels | null | undefined): boolean {
  return !labels || (labels.provenance.length === 0 && labels.dataClasses.length === 0);
}

/**
 * Declassify: the labels without the given data classes (a guard redacted,
 * masked or protected them in the content). Provenance is never removed:
 * where content came from does not change when part of it is rewritten.
 */
export function withoutDataClasses(labels: DataLabels, classes: readonly string[]): DataLabels {
  if (classes.length === 0) return labels;
  const removed = new Set(classes);
  return { ...labels, dataClasses: labels.dataClasses.filter((name) => !removed.has(name)) };
}

/** Parses stored labels (a JSON column, a node result field); anything invalid or empty is null. */
export function parseStoredDataLabels(value: unknown): DataLabels | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = dataLabelsSchema.safeParse(candidate);
  if (!parsed.success || isEmptyDataLabels(parsed.data)) return null;
  return parsed.data;
}

/**
 * Who produced a run's input, decided by the server where the run started
 * (never by a caller-supplied trigger name): `scheduler` for the server's own
 * scheduled runs, `user` for runs a signed-in user or an API key started
 * (the editor, the queue, the execute API), `external` for everything else.
 */
export type RunInputOrigin = "scheduler" | "user" | "external";

/** Production triggers whose input a person typed (chat, forms, app messages) or an authenticated caller sent. */
const USER_INPUT_TRIGGERS = new Set(["chat", "form", "webhook_api", "webhook_api_stream", "mcp_server", "slack_webhook", "telegram_webhook", "discord_webhook"]);

/**
 * The provenance of a run's input. `trusted` only for the server's own
 * scheduler: a trigger name a caller chose (`cron` on the queue route) earns
 * nothing.
 */
export function inputProvenance(triggerType: string | null | undefined, origin: RunInputOrigin | undefined): ProvenanceLabel {
  if (origin === "scheduler") return "trusted";
  if (origin === "user") return "user";
  if (triggerType && USER_INPUT_TRIGGERS.has(triggerType)) return "user";
  return "untrusted_external";
}

// ---------------------------------------------------------------------------
// 12.2 — provenance sources: trigger trust, declared sensitive output, endorsement
// ---------------------------------------------------------------------------

/**
 * What an admin may declare about a trigger's input (`inputTrust` in the
 * trigger node's config). Never `trusted`: only the server's own scheduler
 * starts runs whose input is trusted.
 */
export const TRIGGER_TRUST_LEVELS = ["user", "untrusted_external"] as const;
export type TriggerTrust = (typeof TRIGGER_TRUST_LEVELS)[number];
export const triggerTrustSchema = z.enum(TRIGGER_TRUST_LEVELS);

/** The trigger node config key an admin sets. */
export const TRIGGER_TRUST_CONFIG_KEY = "inputTrust";
/** The node config key that declares a node's output sensitive. */
export const SENSITIVE_OUTPUT_CONFIG_KEY = "sensitiveOutput";

/** The admin's trust setting in a trigger node's config; anything else (absent, invalid) is none. */
export function triggerTrustOf(config: unknown): TriggerTrust | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const parsed = triggerTrustSchema.safeParse((config as Record<string, unknown>)[TRIGGER_TRUST_CONFIG_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The provenance of a webhook run's input: the admin's setting when there is
 * one, else `user` when the server verified the caller (a bearer token or an
 * HMAC signature against the trigger's secret), else `untrusted_external`.
 * Nothing in the request itself (a header, a body field) can choose it.
 */
export function triggerInputProvenance(input: { verified: boolean; trust?: TriggerTrust }): ProvenanceLabel {
  return input.trust ?? (input.verified ? "user" : "untrusted_external");
}

/** True when a node's config declares its output sensitive ("Sensitive output"). */
export function declaresSensitiveOutput(config: unknown): boolean {
  return Boolean(config && typeof config === "object" && !Array.isArray(config) && (config as Record<string, unknown>)[SENSITIVE_OUTPUT_CONFIG_KEY] === true);
}

/**
 * Endorse: a person approved this content, so outside content in it now
 * counts as the user's. Only `untrusted_external` changes (to `user`);
 * `sensitive`, `trusted` and the data classes stay. Only a human approval
 * endorses: never a guard scan or any other automated check.
 */
export function endorseLabels(labels: DataLabels): DataLabels {
  if (!labels.provenance.includes("untrusted_external")) return labels;
  const provenance = new Set<ProvenanceLabel>(labels.provenance.filter((label) => label !== "untrusted_external"));
  provenance.add("user");
  return { ...labels, provenance: PROVENANCE_LABELS.filter((label) => provenance.has(label)) };
}

export const LABEL_ENDORSEMENT_KINDS = ["human_approval", "approval_gate", "tool_call"] as const;
export type LabelEndorsementKind = (typeof LABEL_ENDORSEMENT_KINDS)[number];

/**
 * A human approval that endorsed content, as the run's trace records it on
 * the approving node's result: who approved, when, and which nodes' outputs
 * it covers (the approving node and the inputs it showed the approver).
 * Nodes downstream of the approval read those outputs endorsed; any other
 * reader, and any source that joins later, keeps its labels.
 */
export const labelEndorsementSchema = z.object({
  kind: z.enum(LABEL_ENDORSEMENT_KINDS),
  approvedBy: z.string().nullable(),
  approvedAt: z.string(),
  nodeIds: z.array(z.string()).max(500),
  /** The approved tool call's tool, for `tool_call`. */
  toolName: z.string().optional()
});
export type LabelEndorsement = z.output<typeof labelEndorsementSchema>;

/** 12.2 — data classes found in content make it `sensitive` too (detected classes exist on tracked runs only). */
export function withImpliedSensitive(labels: DataLabels): DataLabels {
  if (labels.dataClasses.length === 0 || labels.provenance.includes("sensitive")) return labels;
  const provenance = new Set<ProvenanceLabel>(labels.provenance);
  provenance.add("sensitive");
  return { ...labels, provenance: PROVENANCE_LABELS.filter((label) => provenance.has(label)) };
}
