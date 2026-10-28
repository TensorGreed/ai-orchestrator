import type { ReleaseGateStats, ReleaseGateView, ReleaseStateView, ReleaseVerdict } from "@ai-orchestrator/shared";

/** Phase 15.4 — helpers behind the version pill, the Publish dialog and the Gates tab. */

export type PillTone = "live" | "ahead" | "draft" | "unknown";

/** The editor's version pill: what production runs and how far the draft is ahead of it. */
export function releasePillLabel(state: ReleaseStateView | null): { text: string; tone: PillTone; title: string } {
  if (!state) return { text: "Publish", tone: "unknown", title: "Publish a saved version to production" };
  if (state.productionRefused) {
    return {
      text: state.draftVersion ? `v${state.draftVersion} · not published` : "Not published",
      tone: "draft",
      title: "The release gate is on and no version is published: production refuses runs until a version passes the gate, is approved or an admin overrides"
    };
  }
  if (state.publishedVersion === null && state.unpublishedAt) {
    return {
      text: state.draftVersion ? `v${state.draftVersion} · unpublished` : "Unpublished",
      tone: "draft",
      title: state.gateEnabled
        ? "Unpublished: production runs the latest save, which the release gate does not check, until a version is published again"
        : "Unpublished: production runs the latest save until a version is published again"
    };
  }
  if (state.publishedVersion === null) {
    return {
      text: state.draftVersion ? `v${state.draftVersion} · not published` : "Not saved",
      tone: "draft",
      title: "Production runs the latest save until a version is published"
    };
  }
  if (state.aheadBy > 0) {
    return {
      text: `v${state.publishedVersion} live · draft +${state.aheadBy}`,
      tone: "ahead",
      title: `Production runs v${state.publishedVersion}; the draft has ${state.aheadBy} newer saved version${state.aheadBy === 1 ? "" : "s"}`
    };
  }
  return { text: `v${state.publishedVersion} live`, tone: "live", title: `Production runs v${state.publishedVersion}, the latest save` };
}

const VERDICT_LABELS: Record<ReleaseVerdict, string> = {
  passed: "Gate passed",
  overridden: "Admin override",
  ungated: "No gate",
  rollback: "Rollback",
  approved: "Approved",
  unpublished: "Unpublished"
};

export function releaseVerdictLabel(verdict: ReleaseVerdict): string {
  return VERDICT_LABELS[verdict] ?? verdict;
}

export function releaseVerdictTone(verdict: ReleaseVerdict): "ok" | "warn" | "neutral" {
  if (verdict === "passed" || verdict === "approved") return "ok";
  if (verdict === "overridden" || verdict === "rollback" || verdict === "unpublished") return "warn";
  return "neutral";
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** Short facts about the judged job, for the Publish dialog. */
export function gateStatsLines(stats: ReleaseGateStats | null): string[] {
  if (!stats) return [];
  const lines = [`${stats.pass} of ${stats.cases} cases passed (${pct(stats.passRate)})`];
  if (stats.regressions > 0) lines.push(`${stats.regressions} regression${stats.regressions === 1 ? "" : "s"}`);
  if (stats.costIncreasePct !== null) lines.push(`cost ${stats.costIncreasePct >= 0 ? "+" : ""}${Math.round(stats.costIncreasePct)}%`);
  if (stats.p95LatencyIncreasePct !== null) lines.push(`p95 latency ${stats.p95LatencyIncreasePct >= 0 ? "+" : ""}${Math.round(stats.p95LatencyIncreasePct)}%`);
  if (stats.newGuardBlocks > 0) lines.push(`${stats.newGuardBlocks} new guard block${stats.newGuardBlocks === 1 ? "" : "s"}`);
  const admission = stats.admission;
  if (admission && admission.pending > 0) lines.push(`${admission.pending} case${admission.pending === 1 ? "" : "s"} pending admission (run, not counted)`);
  if (admission && admission.required > 0) lines.push(`${admission.required} required case${admission.required === 1 ? "" : "s"}${admission.requiredFailures.length > 0 ? `, ${admission.requiredFailures.length} not passing` : ""}`);
  return lines;
}

/**
 * The plain banner on an enforced gate with cases waiting for admission;
 * null when nothing waits.
 */
export function gateAdmissionBanner(pending: number): string | null {
  if (pending <= 0) return null;
  return pending === 1
    ? "1 new case waiting for admin admission. It runs but doesn't count yet."
    : `${pending} new cases waiting for admin admission. They run but don't count yet.`;
}

/** The editable form of a gate's settings. */
export interface GateForm {
  enabled: boolean;
  enforced: boolean;
  datasetIds: string[];
  mcpMode: "strict" | "lenient";
  minPassRatePct: string;
  maxRegressions: string;
  minCases: string;
  maxCostIncreasePct: string;
  maxP95LatencyIncreasePct: string;
  maxRecordingAgeDays: string;
  noNewGuardBlocks: boolean;
  errorsCountAsFailures: boolean;
  requireApproval: boolean;
  approverRoles: string[];
  approverUsers: string;
  /** Approvers with no roles or users named: anyone else who may publish the workflow approves. */
  anyPublisherApproves: boolean;
  allowSelfApproval: boolean;
}

/**
 * Which gate fields the user may change. On an enforced gate a non-admin
 * may only tighten the policy and add golden sets; switching it off, the
 * approvers, self-approval, the MCP mode and removing sets are the admin's.
 * Allowing self-approval is the admin's on every gate.
 */
export interface GateLocks {
  /** Every admin-only field (the gate is enforced and the user is not an admin). */
  adminOnly: boolean;
  /** Self-approval can only be turned on by an admin. */
  selfApproval: boolean;
}

export function gateLocks(gate: Pick<ReleaseGateView, "enforced">, isAdmin: boolean): GateLocks {
  return { adminOnly: gate.enforced && !isAdmin, selfApproval: !isAdmin };
}

export function gateFormFrom(gate: ReleaseGateView): GateForm {
  const policy = gate.policy;
  return {
    enabled: gate.enabled,
    enforced: gate.enforced,
    datasetIds: [...gate.datasetIds],
    mcpMode: gate.candidateOptions.mcpMode === "lenient" ? "lenient" : "strict",
    minPassRatePct: String(Math.round(policy.minPassRate * 100)),
    maxRegressions: String(policy.maxRegressions),
    minCases: String(policy.minCases),
    maxCostIncreasePct: policy.maxCostIncreasePct === undefined ? "" : String(policy.maxCostIncreasePct),
    maxP95LatencyIncreasePct: policy.maxP95LatencyIncreasePct === undefined ? "" : String(policy.maxP95LatencyIncreasePct),
    maxRecordingAgeDays: String(policy.maxRecordingAgeDays),
    noNewGuardBlocks: policy.noNewGuardBlocks,
    errorsCountAsFailures: policy.errorsCountAsFailures,
    requireApproval: gate.requireApproval,
    approverRoles: gate.approvers ? [...gate.approvers.approverRoles] : [],
    approverUsers: gate.approvers ? gate.approvers.approverUsers.join(", ") : "",
    anyPublisherApproves: Boolean(gate.approvers && gate.approvers.approverRoles.length === 0 && gate.approvers.approverUsers.length === 0),
    allowSelfApproval: gate.approvers?.allowSelfApproval ?? false
  };
}

function wholeNumber(value: string, label: string, errors: string[], min = 0): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min) {
    errors.push(`${label} must be a number of at least ${min}`);
    return undefined;
  }
  return parsed;
}

/** The PUT body for a gate form, plus the errors to show before sending. */
export function gateSettingsFromForm(form: GateForm, previous: ReleaseGateView): { settings: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  if (form.enabled && form.datasetIds.length === 0) errors.push("Pick at least one golden set");
  const minPassRatePct = wholeNumber(form.minPassRatePct, "Minimum pass rate", errors);
  if (minPassRatePct !== undefined && minPassRatePct > 100) errors.push("Minimum pass rate is a percentage up to 100");
  const users = form.approverUsers
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const named = form.approverRoles.length > 0 || users.length > 0;
  const hasApprovers = named || form.anyPublisherApproves;
  if (form.requireApproval && !hasApprovers) errors.push("Requiring approval needs at least one approver role or user");
  const policy: Record<string, unknown> = {
    minPassRate: minPassRatePct === undefined ? previous.policy.minPassRate : minPassRatePct / 100,
    maxRegressions: wholeNumber(form.maxRegressions, "Maximum regressions", errors) ?? previous.policy.maxRegressions,
    minCases: wholeNumber(form.minCases, "Minimum cases", errors, 1) ?? previous.policy.minCases,
    maxRecordingAgeDays: wholeNumber(form.maxRecordingAgeDays, "Recording age", errors, 1) ?? previous.policy.maxRecordingAgeDays,
    noNewGuardBlocks: form.noNewGuardBlocks,
    errorsCountAsFailures: form.errorsCountAsFailures,
    requiredScorers: previous.policy.requiredScorers
  };
  const cost = wholeNumber(form.maxCostIncreasePct, "Cost increase", errors);
  if (cost !== undefined) policy.maxCostIncreasePct = cost;
  const latency = wholeNumber(form.maxP95LatencyIncreasePct, "p95 latency increase", errors);
  if (latency !== undefined) policy.maxP95LatencyIncreasePct = latency;
  const settings: Record<string, unknown> = {
    enabled: form.enabled,
    enforced: form.enforced,
    datasetIds: form.datasetIds,
    // Unset means strict: keep it unset rather than change the gate's options by naming the default.
    candidateOptions:
      (previous.candidateOptions.mcpMode ?? "strict") === form.mcpMode ? { ...previous.candidateOptions } : { ...previous.candidateOptions, mcpMode: form.mcpMode },
    policy,
    requireApproval: form.requireApproval,
    approvers: hasApprovers
      ? {
          approverRoles: form.approverRoles,
          approverUsers: users,
          allowSelfApproval: form.allowSelfApproval,
          timeoutMinutes: previous.approvers?.timeoutMinutes ?? 10080
        }
      : null
  };
  return { settings, errors };
}
