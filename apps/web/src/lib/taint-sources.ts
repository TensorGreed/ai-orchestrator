import type { DataLabels, LabelEndorsement, ProvenanceLabel } from "@ai-orchestrator/shared";

/**
 * 12.2 — provenance sources in the editor: the trigger trust choices, the
 * one-word label badge a canvas node shows after a run, and the plain-words
 * line for an approval that cleared outside content. Pure helpers.
 */

export type TriggerTrustChoice = "" | "user" | "untrusted_external";

export const TRIGGER_TRUST_OPTIONS: Array<{ value: TriggerTrustChoice; label: string }> = [
  { value: "", label: "From the auth mode" },
  { value: "user", label: "A user's input" },
  { value: "untrusted_external", label: "Outside content" }
];

export function readTriggerTrust(config: Record<string, unknown>): TriggerTrustChoice {
  return config.inputTrust === "user" || config.inputTrust === "untrusted_external" ? config.inputTrust : "";
}

/** What a webhook's input counts as, in words, for the auth mode and trust setting. */
export function describeTriggerTrust(authMode: string, trust: TriggerTrustChoice): string {
  if (trust === "user") return "Input counts as a user's, whatever the caller sends. Set by an admin.";
  if (trust === "untrusted_external") return "Input counts as outside content, even from a verified caller. Set by an admin.";
  return authMode === "bearer_token" || authMode === "hmac_sha256"
    ? "Input from a verified caller counts as a user's."
    : "With no auth, input counts as outside content. Use a bearer token or HMAC signature to have it count as a user's.";
}

/** The config with the trust setting changed; "" removes it, so a workflow without one stays as it was. */
export function withTriggerTrust(config: Record<string, unknown>, trust: TriggerTrustChoice): Record<string, unknown> {
  const next = { ...config };
  if (trust) next.inputTrust = trust;
  else delete next.inputTrust;
  return next;
}

/** The config with the "sensitive output" flag set or removed (never stored as false). */
export function withSensitiveOutput(config: Record<string, unknown>, sensitive: boolean): Record<string, unknown> {
  const next = { ...config };
  if (sensitive) next.sensitiveOutput = true;
  else delete next.sensitiveOutput;
  return next;
}

const BADGE_WORDS: Partial<Record<ProvenanceLabel, string>> = {
  untrusted_external: "outside",
  sensitive: "sensitive"
};

export interface CanvasLabelBadge {
  /** One or two short words: "outside", "sensitive", "outside · sensitive". */
  text: string;
  /** The full description for the tooltip. */
  title: string;
  tone: "external" | "sensitive";
  cleared: boolean;
}

function readProvenance(value: unknown): ProvenanceLabel[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const provenance = (value as Partial<DataLabels>).provenance;
  return Array.isArray(provenance) ? provenance.filter((entry): entry is ProvenanceLabel => typeof entry === "string") : [];
}

/**
 * The badge for a node after a run: only the labels worth a look (outside content, sensitive), or a
 * "cleared" badge when an approval cleared outside content here. Nothing for runs without labels.
 */
export function canvasLabelBadge(labels: unknown, endorsement?: unknown): CanvasLabelBadge | null {
  const provenance = readProvenance(labels);
  const words = (["untrusted_external", "sensitive"] as const).filter((label) => provenance.includes(label)).map((label) => BADGE_WORDS[label]!);
  const cleared = describeEndorsement(endorsement);
  if (words.length === 0 && !cleared) return null;
  const text = words.length > 0 ? words.join(" · ") : "cleared";
  const title = [
    provenance.includes("untrusted_external") ? "This node's data includes outside content." : null,
    provenance.includes("sensitive") ? "This node's data is sensitive." : null,
    cleared
  ]
    .filter(Boolean)
    .join(" ");
  return { text, title, tone: provenance.includes("untrusted_external") || !provenance.includes("sensitive") ? "external" : "sensitive", cleared: Boolean(cleared) };
}

export function readEndorsement(value: unknown): LabelEndorsement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "human_approval" && record.kind !== "approval_gate" && record.kind !== "tool_call") return null;
  if (typeof record.approvedAt !== "string") return null;
  return {
    kind: record.kind,
    approvedBy: typeof record.approvedBy === "string" ? record.approvedBy : null,
    approvedAt: record.approvedAt,
    nodeIds: Array.isArray(record.nodeIds) ? record.nodeIds.filter((entry): entry is string => typeof entry === "string") : [],
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {})
  };
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * "Cleared by maria@example.org at 2026-10-31 10:04 UTC (Human Approval)": who approved the content here and when.
 * An approved tool call clears nothing (its result is new outside content), so it reads as "Approved".
 */
export function describeEndorsement(value: unknown): string | null {
  const endorsement = readEndorsement(value);
  if (!endorsement) return null;
  const who = endorsement.approvedBy ?? "an approver";
  const when = formatWhen(endorsement.approvedAt);
  if (endorsement.kind === "tool_call") return `Tool call${endorsement.toolName ? ` ${endorsement.toolName}` : ""} approved by ${who} at ${when}; its result is still outside content.`;
  return `Outside content cleared by ${who} at ${when} (${endorsement.kind === "approval_gate" ? "Approval Gate" : "Human Approval"}).`;
}
