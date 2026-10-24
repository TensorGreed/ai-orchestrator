/**
 * Phase 15.6 — production capture in the web app: the settings form and the
 * inbox's labels. Pure helpers; CaptureInbox renders them.
 */

import {
  REPLAY_CAPTURE_API_KEY_FILTER,
  REPLAY_CAPTURE_MAX_PER_DAY_LIMIT,
  REPLAY_CAPTURE_STATUSES,
  type ReplayCaptureSettingsUpdate,
  type ReplayCaptureSettingsView,
  type ReplayCaptureStatus,
  type ReplayCaptureLastDrop,
  type ReplayFindSubjectDeleteResult,
  type ReplayFindSubjectKind,
  type ReplayFindSubjectMatch,
  type ReplayFindSubjectQuery,
  type ReplayFindSubjectResult
} from "@ai-orchestrator/shared";

export interface CaptureForm {
  enabled: boolean;
  /** Percent, as typed. */
  ratePercent: string;
  maxPerDay: string;
  onlyStatuses: ReplayCaptureStatus[];
  dlp: boolean;
  /** "" = the "Captured" set, created on the first promote. */
  targetDatasetId: string;
  /** Why masking is turned off (admins only). */
  reason: string;
}

/** Percent with at most two decimals, no trailing zeros: 0.1 → "10", 0.0125 → "1.25". */
export function ratePercentText(rate: number): string {
  return String(Math.round(rate * 10_000) / 100);
}

export function captureFormFrom(view: ReplayCaptureSettingsView): CaptureForm {
  return {
    enabled: view.enabled,
    ratePercent: ratePercentText(view.rate),
    maxPerDay: String(view.maxPerDay),
    onlyStatuses: [...view.onlyStatuses],
    dlp: view.dlp,
    targetDatasetId: view.targetDatasetId ?? "",
    reason: view.dlpOffReason ?? ""
  };
}

/** The PUT body for `form`, or the errors to show; only fields that changed from `view` are sent. */
export function captureSettingsFromForm(form: CaptureForm, view: ReplayCaptureSettingsView, isAdmin: boolean): { settings: ReplayCaptureSettingsUpdate; errors: string[] } {
  const errors: string[] = [];
  const settings: ReplayCaptureSettingsUpdate = {};
  const percent = Number(form.ratePercent);
  const maxRatePercent = view.deployment.maxRate * 100;
  if (!form.ratePercent.trim() || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
    errors.push("Sample rate is a percentage above 0 and at most 100.");
  } else if (percent > maxRatePercent + 1e-9) {
    errors.push(`This deployment captures at most ${ratePercentText(view.deployment.maxRate)}% of runs.`);
  }
  const perDay = Number(form.maxPerDay);
  if (!/^\d+$/.test(form.maxPerDay.trim()) || perDay < 1 || perDay > REPLAY_CAPTURE_MAX_PER_DAY_LIMIT) {
    errors.push(`Daily limit is a whole number from 1 to ${REPLAY_CAPTURE_MAX_PER_DAY_LIMIT}.`);
  }
  if (form.onlyStatuses.length === 0) errors.push("Keep at least one run outcome.");
  if (!form.dlp && view.dlp) {
    if (!isAdmin) errors.push("Only an admin can turn masking off.");
    else if (!form.reason.trim()) errors.push("Say why masking is turned off; the reason is audited.");
  }
  if (errors.length > 0) return { settings, errors };

  if (form.enabled !== view.enabled || !view.configured) settings.enabled = form.enabled;
  const rate = Math.round(percent * 100) / 10_000;
  if (rate !== view.rate || !view.configured) settings.rate = rate;
  if (perDay !== view.maxPerDay || !view.configured) settings.maxPerDay = perDay;
  const statuses = REPLAY_CAPTURE_STATUSES.filter((status) => form.onlyStatuses.includes(status));
  if (statuses.join() !== view.onlyStatuses.join()) settings.onlyStatuses = statuses;
  if (form.dlp !== view.dlp) {
    settings.dlp = form.dlp;
    if (!form.dlp) settings.reason = form.reason.trim();
  }
  const target = form.targetDatasetId || null;
  if (target !== view.targetDatasetId) settings.targetDatasetId = target;
  return { settings, errors };
}

const DATA_CLASS_LABELS: Record<string, string> = {
  email: "email",
  card_number: "card",
  iban: "IBAN",
  us_ssn: "SSN",
  phone: "phone",
  national_id: "national ID",
  credential: "credential",
  private_key: "private key",
  jwt: "token"
};

export function dataClassLabel(dataClass: string): string {
  return DATA_CLASS_LABELS[dataClass] ?? dataClass.replace(/_/g, " ");
}

const STATUS_LABELS: Record<ReplayCaptureStatus, string> = { success: "Succeeded", error: "Failed", canceled: "Canceled" };

export function captureStatusLabel(status: ReplayCaptureStatus): string {
  return STATUS_LABELS[status];
}

const TRIGGER_LABELS: Record<string, string> = {
  [REPLAY_CAPTURE_API_KEY_FILTER]: "API key",
  webhook: "Webhook",
  webhook_api: "API",
  webhook_api_stream: "API (stream)",
  cron: "Schedule",
  schedule: "Schedule",
  chat: "Chat",
  form: "Form",
  mcp_server: "MCP gateway",
  queue: "Queue",
  slack_webhook: "Slack",
  github_webhook: "GitHub",
  stripe_webhook: "Stripe",
  telegram_webhook: "Telegram",
  discord_webhook: "Discord"
};

/**
 * Production triggers the inbox can filter by, in the order the filter lists
 * them. `api_key` filters on the capture source (runs an API key started;
 * their trigger stays `manual`).
 */
export const CAPTURE_TRIGGER_FILTERS = [
  "webhook",
  "webhook_api",
  REPLAY_CAPTURE_API_KEY_FILTER,
  "cron",
  "chat",
  "form",
  "mcp_server",
  "queue",
  "slack_webhook",
  "telegram_webhook",
  "discord_webhook"
] as const;

export type CapturePeriod = "" | "24h" | "7d" | "30d";
export const CAPTURE_PERIODS: Array<{ value: CapturePeriod; label: string }> = [
  { value: "", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" }
];
const PERIOD_MS: Record<Exclude<CapturePeriod, "">, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

/** The `from` bound (ISO) for a period, or undefined for any time. */
export function capturePeriodFrom(period: CapturePeriod, now: Date = new Date()): string | undefined {
  if (!period) return undefined;
  return new Date(now.getTime() - PERIOD_MS[period]).toISOString();
}

export function captureTriggerLabel(trigger: string | null | undefined): string {
  if (!trigger) return "Production";
  return TRIGGER_LABELS[trigger] ?? trigger.replace(/_/g, " ");
}

/** One line under the toggle: what capture does right now. */
export function captureSummaryLine(view: ReplayCaptureSettingsView): string {
  if (!view.deployment.enabled) return "Capture is turned off for this deployment (REPLAY_CAPTURE_ENABLED).";
  if (!view.enabled) return "Off. Production runs are not recorded.";
  const masked = view.dlp ? "personal data masked" : "masking off";
  return `Capturing ${ratePercentText(view.effectiveRate)}% of production runs, up to ${view.maxPerDay} a day, ${masked}. ${view.capturedToday} today.`;
}

/** Why capture dropped a sampled run, in plain words. */
const DROP_REASONS: Record<ReplayCaptureLastDrop["outcome"], string> = {
  dropped_identifier_value: "a personal value was in an MCP server or tool name, which is kept as written",
  dropped_unscannable: "the run's content was nested too deeply to check for personal data",
  dropped_incomplete_mask: "a personal value could not be masked everywhere",
  skipped_too_large: "the run was larger than the capture size limit",
  failed: "an error while saving it"
};

/** The last run capture dropped, with when and why; null when none was. */
export function captureLastDropLine(lastDrop: ReplayCaptureLastDrop | null | undefined, formatWhen: (iso: string) => string): string | null {
  if (!lastDrop) return null;
  return `Last run not captured: ${formatWhen(lastDrop.at)}, because ${DROP_REASONS[lastDrop.outcome] ?? "of an error"}.`;
}

// ---------------------------------------------------------------------------
// Data-subject lookup (admins)
// ---------------------------------------------------------------------------

/** How the admin asked the lookup to read the value. */
export type SubjectReadAs = "text" | "phone";

/** "Read as" is offered for 7–15 bare digits: they could be a phone number or plain text (an account number). */
export function subjectReadAsOffered(value: string): boolean {
  return /^\d{7,15}$/.test(value.trim());
}

/** The search body: a phone hint and its country only when the admin chose them for bare digits. */
export function subjectQuery(value: string, readAs: SubjectReadAs, country: string): ReplayFindSubjectQuery {
  const query: ReplayFindSubjectQuery = { value: value.trim() };
  if (subjectReadAsOffered(value) && readAs === "phone") {
    query.dataClass = "phone";
    if (country) query.country = country;
  }
  return query;
}

const SUBJECT_CLASS_LABELS: Record<string, string> = {
  email: "email address",
  phone: "phone",
  card_number: "card number",
  iban: "IBAN",
  us_ssn: "SSN",
  national_id: "national ID"
};

/** The line above the results: "Searched as phone (+1)", "Searched as phone (no country code)", "Searched as text". */
export function subjectSearchedAs(result: Pick<ReplayFindSubjectResult, "dataClass" | "callingCode">): string {
  if (!result.dataClass) return "Searched as text";
  const label = SUBJECT_CLASS_LABELS[result.dataClass] ?? dataClassLabel(result.dataClass);
  if (result.dataClass !== "phone") return `Searched as ${label}`;
  return result.callingCode ? `Searched as phone (+${result.callingCode})` : "Searched as phone (no country code)";
}

const SUBJECT_KIND_LABELS: Record<ReplayFindSubjectKind, string> = {
  recording: "Golden or captured run",
  fixture: "Golden-set case",
  eval_result: "Replay result",
  execution: "Replay run",
  cassette: "Replay cassette"
};

export function subjectKindLabel(kind: ReplayFindSubjectKind): string {
  return SUBJECT_KIND_LABELS[kind];
}

export const subjectKey = (match: Pick<ReplayFindSubjectMatch, "kind" | "id">) => `${match.kind}:${match.id}`;

/** Certain matches (ticked by default) and possible matches (a country code missing in the stored data or in the search; never ticked by default). */
export function splitSubjectMatches(matches: readonly ReplayFindSubjectMatch[]): { exact: ReplayFindSubjectMatch[]; possible: ReplayFindSubjectMatch[] } {
  return { exact: matches.filter((match) => match.certainty === "exact"), possible: matches.filter((match) => match.certainty !== "exact") };
}

/** Delete targets for the ticked rows: a possible match is sent with its explicit confirmation. */
export function subjectDeleteTargets(
  matches: readonly ReplayFindSubjectMatch[],
  ticked: ReadonlySet<string>
): Array<{ kind: ReplayFindSubjectKind; id: string; confirmPossible?: true }> {
  return matches
    .filter((match) => ticked.has(subjectKey(match)))
    .map((match) => (match.certainty === "exact" ? { kind: match.kind, id: match.id } : { kind: match.kind, id: match.id, confirmPossible: true as const }));
}

/** The second delete step: how many rows, and how many of them are possible matches the admin selected. */
export function subjectConfirmText(targets: ReadonlyArray<{ confirmPossible?: true }>): string {
  const count = targets.length;
  const possible = targets.filter((target) => target.confirmPossible === true).length;
  const rows = `${count} ${count === 1 ? "row" : "rows"}`;
  const ofThem = possible > 0 ? `, ${possible} of them ${possible === 1 ? "a possible match" : "possible matches"}` : "";
  return `Permanently delete ${rows}${ofThem}? A golden run takes its golden-set cases and results with it.`;
}

/** The notice after a delete: what was deleted, and why anything was skipped (unconfirmed possible matches named apart). */
export function subjectDeleteNotice(outcome: Pick<ReplayFindSubjectDeleteResult, "removed" | "skipped">): string {
  const deleted = outcome.removed.length;
  const unconfirmed = outcome.skipped.filter((entry) => entry.reason === "possible_match_unconfirmed").length;
  const other = outcome.skipped.length - unconfirmed;
  const reasons: string[] = [];
  if (unconfirmed > 0) reasons.push(`${unconfirmed} ${unconfirmed === 1 ? "possible match" : "possible matches"} not confirmed`);
  if (other > 0) reasons.push(`${other} gone, or no longer holding the value`);
  const skipped = outcome.skipped.length;
  return `Deleted ${deleted} ${deleted === 1 ? "row" : "rows"}${skipped > 0 ? `; ${skipped} skipped (${reasons.join("; ")})` : ""}.`;
}
