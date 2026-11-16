/**
 * 12.7 — content rule events as log stream events (category `rule_events`).
 *
 * One stored rule event row (`guard_events`) becomes one log stream event whose `metadata` is a `RuleStreamEvent`
 * (schema `l2m.rule_event`, `schemaVersion` 1). The row already holds masked evidence only (detectors mask what they
 * matched before a verdict is recorded); this mapping caps it further and, for a run started from a sensitive run's
 * content, sends only a digest of each piece. Matched raw content is never part of a row, so it never reaches a
 * destination.
 *
 * Fields only ever get added within schema version 1; a renamed or removed field bumps the version.
 */
import { createHash } from "node:crypto";
import type { GuardEventInsert } from "../db/database";
import type { LogLevel, LogStreamEvent } from "./log-streaming-service.js";

export const RULE_EVENTS_CATEGORY = "rule_events";
export const RULE_EVENT_SCHEMA = "l2m.rule_event";
export const RULE_EVENT_SCHEMA_VERSION = 1;
export const RULE_EVENT_TYPE = "content_rules.event";

/** At most this many evidence pieces per event, each at most this long. */
export const RULE_EVENT_MAX_EVIDENCE = 5;
export const RULE_EVENT_MAX_EVIDENCE_LENGTH = 160;

export type RuleEventSource = "workflow" | "mcp_gateway" | "ai_gateway";

export interface RuleStreamEvidence {
  /** The masked evidence as stored; absent when `evidenceWithheld` is true. */
  masked?: string;
  /** `sha256:` and the first 16 hex characters of the hash of the masked evidence, for correlation. */
  digest: string;
  spanCount: number;
  message?: string;
}

export interface RuleStreamEvent {
  schema: typeof RULE_EVENT_SCHEMA;
  schemaVersion: typeof RULE_EVENT_SCHEMA_VERSION;
  eventId: string;
  verdictId: string;
  source: RuleEventSource;
  ruleSet: { id: string; version: number; hash: string };
  detector: { id: string; category: string | null; dataClass: string | null; score: number | null } | null;
  action: { requested: string; effective: string; verdict: string; shadow: boolean };
  channel: string;
  placement: string;
  nodeId: string;
  toolName: string | null;
  iteration: number | null;
  executionId: string;
  workflowId: string | null;
  projectId: string | null;
  latencyMs: number;
  budgetExceeded: boolean;
  skippedDetectors: string[];
  evidence: RuleStreamEvidence[];
  evidenceWithheld: boolean;
}

export interface RuleEventStreamOptions {
  /** Send digests in place of masked evidence (a run started from a sensitive run's content). */
  withholdEvidence?: boolean;
}

const BLOCKING_ACTIONS = new Set(["block", "require_approval", "review"]);

export function ruleEventSource(executionId: string): RuleEventSource {
  if (executionId.startsWith("aigw_")) return "ai_gateway";
  if (executionId.startsWith("mcpgw_")) return "mcp_gateway";
  return "workflow";
}

/**
 * The log level of a rule event: `warn` when the effective action stopped or held the content, `info` for any other
 * finding (rewrites, shadow findings, reveals), `debug` for a check that found nothing. A destination's minimum level
 * (default `info`) therefore leaves out clean checks unless it asks for `debug`.
 */
export function ruleEventLevel(row: Pick<GuardEventInsert, "effectiveAction" | "detectorId">): LogLevel {
  if (BLOCKING_ACTIONS.has(row.effectiveAction)) return "warn";
  if (row.detectorId) return "info";
  return "debug";
}

function digestOf(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/** Cut by code point, so a surrogate pair is never split. */
function capped(value: string, max: number): string {
  const points = Array.from(value);
  return points.length > max ? `${points.slice(0, max).join("")}…` : value;
}

export function toRuleStreamEvent(row: GuardEventInsert, options: RuleEventStreamOptions = {}): RuleStreamEvent {
  const withhold = options.withholdEvidence === true;
  const evidence = row.evidence.slice(0, RULE_EVENT_MAX_EVIDENCE).map((entry): RuleStreamEvidence => ({
    ...(withhold ? {} : { masked: capped(entry.evidence, RULE_EVENT_MAX_EVIDENCE_LENGTH) }),
    digest: digestOf(entry.evidence),
    spanCount: entry.spans.length,
    ...(!withhold && entry.message ? { message: capped(entry.message, RULE_EVENT_MAX_EVIDENCE_LENGTH) } : {})
  }));
  return {
    schema: RULE_EVENT_SCHEMA,
    schemaVersion: RULE_EVENT_SCHEMA_VERSION,
    eventId: row.id,
    verdictId: row.verdictId,
    source: ruleEventSource(row.executionId),
    ruleSet: { id: row.profileId, version: row.profileVersion, hash: row.profileHash },
    detector: row.detectorId ? { id: row.detectorId, category: row.category, dataClass: row.dataClass, score: row.score } : null,
    action: { requested: row.requestedAction, effective: row.effectiveAction, verdict: row.verdictAction, shadow: row.shadow },
    channel: row.channel,
    placement: row.placement,
    nodeId: row.nodeId,
    toolName: row.toolName,
    iteration: row.iteration,
    executionId: row.executionId,
    workflowId: row.workflowId,
    projectId: row.projectId,
    latencyMs: row.latencyMs,
    budgetExceeded: row.budgetExceeded,
    skippedDetectors: [...row.skippedDetectors],
    evidence,
    evidenceWithheld: withhold
  };
}

/** One stored rule event row as a log stream event (category `rule_events`). */
export function ruleEventToLogStreamEvent(row: GuardEventInsert, options: RuleEventStreamOptions = {}): LogStreamEvent {
  const event = toRuleStreamEvent(row, options);
  const what = event.detector ? `${event.detector.id}${event.detector.dataClass ? ` (${event.detector.dataClass})` : ""}` : "no finding";
  return {
    category: RULE_EVENTS_CATEGORY,
    eventType: RULE_EVENT_TYPE,
    level: ruleEventLevel(row),
    outcome: BLOCKING_ACTIONS.has(row.effectiveAction) ? "denied" : "success",
    message: `Content rule ${row.effectiveAction}${row.shadow ? " (shadow)" : ""}: ${what} on ${row.channel} at ${row.nodeId}`,
    actor: { type: "system" },
    resourceType: "execution",
    resourceId: row.executionId || null,
    projectId: row.projectId,
    metadata: event,
    createdAt: row.createdAt
  };
}
