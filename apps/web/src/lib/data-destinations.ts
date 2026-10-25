/**
 * Phase 16 — form state for the Data destinations tab: a row (or a
 * not-classified-yet suggestion) to an editable form and back to the API
 * input, and the plain-language description of what a row matches.
 */

import {
  DESTINATION_KIND_LABELS,
  type DataDestinationInput,
  type DataDestinationRow,
  type DestinationKind,
  type DestinationTier,
  type UnclassifiedDestination
} from "@ai-orchestrator/shared";

export interface DestinationForm {
  name: string;
  kind: DestinationKind;
  targetId: string;
  host: string;
  tier: DestinationTier;
  region: string;
  /** Comma-separated data classes. */
  holds: string;
  note: string;
}

/** A new row starts public, the tier every unclassified destination has: the admin picks a nearer tier on purpose. */
export const EMPTY_DESTINATION_FORM: DestinationForm = { name: "", kind: "http", targetId: "", host: "", tier: "public", region: "", holds: "", note: "" };

/** Shown on rows matched by id alone: the host a builder sets decides, unless this row is stricter. */
export const ID_ONLY_ROW_HINT = "Without a web address this row can only make matching calls stricter.";

/** What the target id field is called for each kind (web addresses have none). */
export const TARGET_ID_LABEL: Record<DestinationKind, string | null> = {
  model_provider: "Provider id",
  mcp_server: "MCP server id",
  connector: "Connector type",
  http: null
};

export function formFromRow(row: DataDestinationRow): DestinationForm {
  return {
    name: row.name,
    kind: row.kind,
    targetId: row.targetId ?? "",
    host: row.host ?? "",
    tier: row.tier,
    region: row.region === "unknown" ? "" : row.region,
    holds: row.holdsDataClasses.join(", "),
    note: row.note ?? ""
  };
}

export function formFromSuggestion(entry: UnclassifiedDestination): DestinationForm {
  return {
    ...EMPTY_DESTINATION_FORM,
    name: entry.suggestion.name,
    kind: entry.suggestion.kind,
    targetId: entry.suggestion.targetId ?? "",
    host: entry.suggestion.host ?? "",
    tier: entry.suggestion.tier
  };
}

/** Add destination pre-filled to override a built-in row for the same host (region under Advanced). */
export function formFromBuiltIn(row: DataDestinationRow): DestinationForm {
  return { ...EMPTY_DESTINATION_FORM, name: row.name, kind: "http", host: row.host ?? "", tier: row.tier };
}

export function inputFromForm(form: DestinationForm): DataDestinationInput {
  const holds = form.holds
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    name: form.name.trim(),
    kind: form.kind,
    ...(form.kind !== "http" && form.targetId.trim() ? { targetId: form.targetId.trim() } : {}),
    ...(form.host.trim() ? { host: form.host.trim() } : {}),
    tier: form.tier,
    ...(form.region.trim() ? { region: form.region.trim() } : {}),
    holdsDataClasses: [...new Set(holds)],
    ...(form.note.trim() ? { note: form.note.trim() } : {})
  };
}

/** "Model provider openai at api.openai.com", "Web address *.corp.example". */
export function describeMatch(entry: { kind: DestinationKind; targetId?: string | null; host?: string | null }): string {
  const parts = [DESTINATION_KIND_LABELS[entry.kind]];
  if (entry.targetId) parts.push(entry.targetId);
  if (entry.host) parts.push(entry.targetId ? `at ${entry.host}` : entry.host);
  return parts.join(" ");
}
