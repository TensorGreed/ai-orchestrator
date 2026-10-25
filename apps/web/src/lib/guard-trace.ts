// Phase 12.1 — pure helpers behind the Guard trace, the run tape marker and
// the Security page. Everything here reads verdict summaries (masked evidence
// only) from node outputs and guard events; nothing holds raw content.

import type { GuardEventView } from "@ai-orchestrator/shared";

export type GuardActionName = "allow" | "transform" | "mask" | "redact" | "protect" | "review" | "require_approval" | "block";

const SEVERITY: GuardActionName[] = ["allow", "transform", "mask", "redact", "protect", "review", "require_approval", "block"];

export function mostSevere(actions: string[]): GuardActionName {
  return actions.reduce<GuardActionName>((best, next) => (SEVERITY.indexOf(next as GuardActionName) > SEVERITY.indexOf(best) ? (next as GuardActionName) : best), "allow");
}

export const GUARD_ACTION_LABEL: Record<GuardActionName, string> = {
  allow: "Allowed",
  transform: "Transformed",
  mask: "Masked",
  redact: "Redacted",
  protect: "Protected",
  review: "Review",
  require_approval: "Approval",
  block: "Blocked"
};

export const GUARD_CHANNEL_LABEL: Record<string, string> = {
  prompt: "Prompt",
  model_output: "Model output",
  tool_arguments: "Tool arguments",
  tool_result: "Tool result",
  final_output: "Final answer",
  egress: "Outbound (egress)"
};

export function actionLabel(action: string): string {
  return GUARD_ACTION_LABEL[action as GuardActionName] ?? action;
}

export function channelLabel(channel: string): string {
  return GUARD_CHANNEL_LABEL[channel] ?? channel;
}

export interface GuardTraceFinding {
  detectorId: string;
  category: string;
  dataClass?: string;
  score: number;
  evidence: string;
  message?: string;
  requested?: string;
  effective?: string;
  shadow?: boolean;
}

export interface GuardTraceVerdict {
  key: string;
  nodeId: string;
  placement: "node" | "agent";
  iteration?: number;
  channel: string;
  toolName?: string;
  action: GuardActionName;
  /** What shadow-mode rules would have done. */
  shadowAction: GuardActionName;
  approved?: boolean;
  profiles: GuardTraceProfile[];
  findings: GuardTraceFinding[];
  timings: Array<{ detectorId: string; durationMs: number; status: string }>;
  latencyMs: number;
  budgetExceeded: boolean;
  skippedDetectors: string[];
}

export interface GuardTraceProfile {
  profileId: string;
  version: number;
  hash?: string;
  name?: string;
  /**
   * More than one evaluation of this profile version ran, e.g. an enforced
   * profile plus the node's tightened copy of it (overrides or protection).
   */
  tightened?: boolean;
}

export interface GuardTraceNode {
  nodeId: string;
  placement: "node" | "agent";
  /** Where the profiles came from: port, enforced, workflow, project, instance or a guard node's own choice. */
  source?: string;
  profiles: GuardTraceProfile[];
  chain?: Array<{ level: string; mode: string; profileId?: string | null; version?: number | null }>;
  spotlighting?: string;
  canary?: boolean;
  route?: string;
  verdicts: GuardTraceVerdict[];
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * One entry per profile version. A stacked check can evaluate the same
 * version twice (the enforced original and a tightened copy, each with its
 * own hash); that shows as one profile marked as tightened.
 */
export function mergeProfiles(profiles: GuardTraceProfile[]): GuardTraceProfile[] {
  const byKey = new Map<string, GuardTraceProfile>();
  for (const profile of profiles) {
    const key = `${profile.profileId}@${profile.version}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...profile });
      continue;
    }
    if (profile.hash !== seen.hash) seen.tightened = true;
    if (!seen.name && profile.name) seen.name = profile.name;
  }
  return [...byKey.values()];
}

/**
 * The same finding reported by more than one stacked evaluation (an enforced
 * profile and its tightened copy both see the same email address) is listed
 * once, with the most severe action any of them took.
 */
export function mergeFindings(findings: GuardTraceFinding[]): GuardTraceFinding[] {
  const byKey = new Map<string, GuardTraceFinding>();
  for (const finding of findings) {
    const key = [finding.detectorId, finding.category, finding.dataClass ?? "", finding.evidence, finding.message ?? ""].join("\u0000");
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...finding });
      continue;
    }
    seen.score = Math.max(seen.score, finding.score);
    if (finding.effective && (!seen.effective || mostSevere([seen.effective, finding.effective]) !== seen.effective)) {
      seen.effective = finding.effective;
      seen.requested = finding.requested;
      seen.shadow = finding.shadow;
    } else if (seen.shadow && finding.effective === seen.effective && finding.shadow === false) {
      seen.shadow = false;
    }
  }
  return [...byKey.values()];
}

const TIMING_STATUS_RANK = ["ran", "skipped_short_circuit", "skipped_budget", "missing", "timed_out", "error"];

/** One timing per detector: stacked evaluations add up; the worst status wins. */
export function mergeTimings(timings: GuardTraceVerdict["timings"]): GuardTraceVerdict["timings"] {
  const byDetector = new Map<string, GuardTraceVerdict["timings"][number]>();
  for (const timing of timings) {
    const seen = byDetector.get(timing.detectorId);
    if (!seen) {
      byDetector.set(timing.detectorId, { ...timing });
      continue;
    }
    seen.durationMs = Math.round((seen.durationMs + timing.durationMs) * 1000) / 1000;
    const rank = (status: string) => {
      const index = TIMING_STATUS_RANK.indexOf(status);
      return index === -1 ? TIMING_STATUS_RANK.length : index;
    };
    if (rank(timing.status) > rank(seen.status)) seen.status = timing.status;
  }
  return [...byDetector.values()];
}

/** One stacked check (one or more profiles) from the summaries the engine puts in node outputs. */
function verdictFromSummaries(input: {
  key: string;
  nodeId: string;
  placement: "node" | "agent";
  iteration?: number;
  channel: string;
  toolName?: string;
  action?: string;
  approved?: boolean;
  entries: unknown[];
}): GuardTraceVerdict {
  const findings: GuardTraceFinding[] = [];
  const timings: GuardTraceVerdict["timings"] = [];
  const profiles: GuardTraceVerdict["profiles"] = [];
  const shadow: string[] = [];
  const actions: string[] = [];
  let latencyMs = 0;
  let budgetExceeded = false;
  const skipped = new Set<string>();
  for (const raw of input.entries) {
    const entry = rec(raw);
    const summary = rec(entry?.summary);
    const profile = rec(entry?.profile);
    if (profile) profiles.push({ profileId: text(profile.profileId) ?? "?", version: num(profile.version, 1), ...(text(profile.hash) ? { hash: text(profile.hash) } : {}) });
    if (!summary) continue;
    actions.push(text(summary.action) ?? "allow");
    shadow.push(text(summary.shadowAction) ?? "allow");
    const applied = arr(summary.actions).map(rec);
    arr(summary.findings).forEach((rawFinding, index) => {
      const finding = rec(rawFinding);
      if (!finding) return;
      const action = applied[index];
      findings.push({
        detectorId: text(finding.detectorId) ?? "",
        category: text(finding.category) ?? "",
        ...(text(finding.dataClass) ? { dataClass: text(finding.dataClass) } : {}),
        score: num(finding.score),
        evidence: text(finding.evidence) ?? "",
        ...(text(finding.message) ? { message: text(finding.message) } : {}),
        ...(action ? { requested: text(action.requested), effective: text(action.effective), shadow: action.shadow === true } : {})
      });
    });
    const timing = rec(summary.timings);
    latencyMs += num(timing?.totalMs);
    for (const detector of arr(timing?.detectors)) {
      const row = rec(detector);
      if (row) timings.push({ detectorId: text(row.detectorId) ?? "", durationMs: num(row.durationMs), status: text(row.status) ?? "ran" });
    }
    const budget = rec(summary.budget);
    if (budget?.exceeded === true) budgetExceeded = true;
    for (const id of arr(budget?.skippedDetectors)) if (typeof id === "string") skipped.add(id);
  }
  return {
    key: input.key,
    nodeId: input.nodeId,
    placement: input.placement,
    ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
    channel: input.channel,
    ...(input.toolName ? { toolName: input.toolName } : {}),
    action: (input.action as GuardActionName | undefined) ?? mostSevere(actions),
    shadowAction: mostSevere(shadow),
    ...(input.approved !== undefined ? { approved: input.approved } : {}),
    profiles: mergeProfiles(profiles),
    findings: mergeFindings(findings),
    timings: mergeTimings(timings),
    latencyMs: Math.round(latencyMs * 10) / 10,
    budgetExceeded,
    skippedDetectors: [...skipped]
  };
}

function profileList(value: unknown): GuardTraceProfile[] {
  return arr(value)
    .map(rec)
    .filter((p): p is Rec => Boolean(p))
    .map((p) => ({
      profileId: text(p.profileId) ?? "?",
      version: num(p.version, 1),
      ...(text(p.hash) ? { hash: text(p.hash) } : {}),
      ...(text(p.name) ? { name: text(p.name) } : {})
    }));
}

/** Guard nodes (`output.guard`) and agents (`output._guard`) in a run's node results. */
export function extractGuardTrace(nodeResults: unknown[]): GuardTraceNode[] {
  const out: GuardTraceNode[] = [];
  for (const raw of nodeResults) {
    const result = rec(raw);
    const nodeId = text(result?.nodeId);
    const output = rec(result?.output);
    if (!nodeId || !output) continue;
    const agent = rec(output._guard);
    if (agent) {
      out.push({
        nodeId,
        placement: "agent",
        ...(text(agent.source) ? { source: text(agent.source) } : {}),
        profiles: mergeProfiles(profileList(agent.profiles)),
        chain: arr(agent.chain).map(rec).filter((c): c is Rec => Boolean(c)).map((c) => ({ level: text(c.level) ?? "", mode: text(c.mode) ?? "", profileId: text(c.profileId) ?? null, version: typeof c.version === "number" ? c.version : null })),
        ...(text(agent.spotlighting) ? { spotlighting: text(agent.spotlighting) } : {}),
        canary: agent.canary === true,
        verdicts: arr(agent.verdicts)
          .map(rec)
          .filter((v): v is Rec => Boolean(v))
          .map((v, index) =>
            verdictFromSummaries({
              key: `${nodeId}-${index}`,
              nodeId,
              placement: "agent",
              iteration: num(v.iteration, 0),
              channel: text(v.channel) ?? "prompt",
              ...(text(v.toolName) ? { toolName: text(v.toolName) } : {}),
              ...(text(v.action) ? { action: text(v.action) } : {}),
              ...(typeof v.approved === "boolean" ? { approved: v.approved } : {}),
              entries: arr(v.verdicts)
            })
          )
      });
      continue;
    }
    const node = rec(output.guard);
    if (node && Array.isArray(node.verdicts)) {
      out.push({
        nodeId,
        placement: "node",
        ...(text(node.source) ? { source: text(node.source) } : {}),
        profiles: mergeProfiles(profileList(node.profiles)),
        ...(text(node.route) ? { route: text(node.route) } : {}),
        verdicts: [
          verdictFromSummaries({
            key: `${nodeId}-0`,
            nodeId,
            placement: "node",
            channel: text(node.channel) ?? "prompt",
            ...(text(node.action) ? { action: text(node.action) } : {}),
            entries: arr(node.verdicts)
          })
        ]
      });
    }
  }
  return out;
}

/**
 * Nodes that have guard events but no trace in their output (for example an
 * agent whose final answer was blocked, which fails the node) are rebuilt
 * from the events, one verdict per verdict id.
 */
export function traceFromEvents(events: GuardEventView[], known: Set<string>): GuardTraceNode[] {
  const byNode = new Map<string, Map<string, GuardEventView[]>>();
  for (const event of events) {
    if (known.has(event.nodeId)) continue;
    const verdicts = byNode.get(event.nodeId) ?? new Map<string, GuardEventView[]>();
    const rows = verdicts.get(event.verdictId) ?? [];
    rows.push(event);
    verdicts.set(event.verdictId, rows);
    byNode.set(event.nodeId, verdicts);
  }
  const out: GuardTraceNode[] = [];
  for (const [nodeId, verdicts] of byNode) {
    const nodeVerdicts: GuardTraceVerdict[] = [];
    const profiles: GuardTraceProfile[] = [];
    for (const [verdictId, rows] of verdicts) {
      const first = rows[0]!;
      profiles.push({ profileId: first.profileId, version: first.profileVersion, hash: first.profileHash });
      nodeVerdicts.push({
        key: verdictId,
        nodeId,
        placement: first.placement,
        ...(typeof first.iteration === "number" ? { iteration: first.iteration } : {}),
        channel: first.channel,
        ...(first.toolName ? { toolName: first.toolName } : {}),
        action: first.verdictAction as GuardActionName,
        shadowAction: mostSevere(rows.filter((row) => row.shadow).map((row) => row.effectiveAction)),
        profiles: [{ profileId: first.profileId, version: first.profileVersion, hash: first.profileHash }],
        findings: mergeFindings(rows
          .filter((row) => row.detectorId)
          .map((row) => ({
            detectorId: row.detectorId ?? "",
            category: row.category ?? "",
            ...(row.dataClass ? { dataClass: row.dataClass } : {}),
            score: row.score ?? 0,
            evidence: row.evidence[0]?.evidence ?? "",
            ...(row.evidence[0]?.message ? { message: row.evidence[0].message } : {}),
            requested: row.requestedAction,
            effective: row.effectiveAction,
            shadow: row.shadow
          }))),
        timings: [],
        latencyMs: first.latencyMs,
        budgetExceeded: first.budgetExceeded,
        skippedDetectors: first.skippedDetectors
      });
    }
    out.push({ nodeId, placement: nodeVerdicts[0]?.placement ?? "node", profiles: mergeProfiles(profiles), verdicts: nodeVerdicts });
  }
  return out;
}

export interface GuardMarker {
  kind: "blocked" | "review" | "approval" | "rewritten";
  label: string;
  title: string;
}

/** The run tape marker for a node: the most severe guard outcome it recorded. */
export function guardMarkerFor(result: { output?: unknown; error?: string; status?: string }): GuardMarker | null {
  if (typeof result.error === "string" && /^Guard blocked/.test(result.error)) {
    return { kind: "blocked", label: "Guard blocked", title: result.error };
  }
  const traces = extractGuardTrace([{ nodeId: "_", output: result.output }]);
  const verdicts = traces.flatMap((trace) => trace.verdicts);
  const route = traces[0]?.route;
  if (verdicts.length === 0) return null;
  const pending = result.status === "waiting_approval";
  const blocked = verdicts.filter((verdict) => verdict.action === "block").length;
  const review = verdicts.filter((verdict) => (verdict.action === "review" || verdict.action === "require_approval") && !verdict.approved).length;
  if (route === "blocked" || blocked > 0) {
    return { kind: "blocked", label: "Guard blocked", title: `${blocked || 1} guard verdict${blocked === 1 ? "" : "s"} blocked content` };
  }
  if (pending || route === "review" || review > 0) {
    return { kind: pending ? "approval" : "review", label: pending ? "Guard approval" : "Guard review", title: "A guard verdict needs a person to look at it" };
  }
  if (verdicts.some((verdict) => ["redact", "mask", "protect", "transform"].includes(verdict.action))) {
    return { kind: "rewritten", label: "Guard rewrote", title: "Sensitive content was redacted, masked or protected" };
  }
  return null;
}

/** Day buckets for the Security page chart, oldest first, with a zero for every missing day. */
export function dailySeries(daily: Array<{ day: string; action: string; count: number }>, days: number, now = new Date()): Array<{ day: string; blocked: number; review: number; rewritten: number; allowed: number }> {
  const out: Array<{ day: string; blocked: number; review: number; rewritten: number; allowed: number }> = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    out.push({ day: date.toISOString().slice(0, 10), blocked: 0, review: 0, rewritten: 0, allowed: 0 });
  }
  const index = new Map(out.map((entry, position) => [entry.day, position]));
  for (const row of daily) {
    const position = index.get(row.day);
    if (position === undefined) continue;
    const bucket = out[position]!;
    if (row.action === "block") bucket.blocked += row.count;
    else if (row.action === "review" || row.action === "require_approval") bucket.review += row.count;
    else if (row.action === "allow") bucket.allowed += row.count;
    else bucket.rewritten += row.count;
  }
  return out;
}
