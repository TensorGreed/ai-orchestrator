/**
 * Phase 15.6 — production capture in the web app: the settings form and the
 * inbox's labels. Pure helpers; CaptureInbox renders them.
 */

import { REPLAY_CAPTURE_MAX_PER_DAY_LIMIT, REPLAY_CAPTURE_STATUSES, type ReplayCaptureSettingsUpdate, type ReplayCaptureSettingsView, type ReplayCaptureStatus } from "@ai-orchestrator/shared";

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
