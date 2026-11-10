/**
 * 13.3 — per-project retention: the data classes a project may give its own number of days, which purge classes each
 * one governs, and the views of `GET /api/projects/:id/retention`.
 *
 * A project without a value for a class inherits the deployment's. A value must fall within the deployment's bounds
 * (RETENTION_MIN_DAYS to RETENTION_MAX_DAYS); 0 keeps that class forever and is allowed only when no maximum is set.
 */
import { z } from "zod";
import type { RetentionPurgeClass } from "./retention";

/** The classes a project can set, in display order. */
export const RETENTION_DATA_CLASSES = ["runs", "tool_calls", "rule_events", "agent_memory"] as const;

export type RetentionDataClass = (typeof RETENTION_DATA_CLASSES)[number];

/** The purge classes a project's value for each class governs. */
export const RETENTION_DATA_CLASS_PURGES: Record<RetentionDataClass, readonly RetentionPurgeClass[]> = {
  // Runs take with them what has always gone with them: cassettes, decided approvals and finished queue jobs.
  runs: ["runs", "cassettes_approvals", "queue"],
  tool_calls: ["tool_calls"],
  rule_events: ["rule_events"],
  agent_memory: ["agent_memory"]
};

/** The per-project class a purge class follows; null for purge classes only the deployment sets. */
export function retentionDataClassOf(purgeClass: RetentionPurgeClass): RetentionDataClass | null {
  for (const dataClass of RETENTION_DATA_CLASSES) {
    if (RETENTION_DATA_CLASS_PURGES[dataClass].includes(purgeClass)) return dataClass;
  }
  return null;
}

export const RETENTION_DATA_CLASS_LABELS: Record<RetentionDataClass, { label: string; what: string }> = {
  runs: { label: "Runs", what: "Run history (inputs, outputs and traces), with its cassettes, decided approvals and finished queue jobs" },
  tool_calls: { label: "Tool calls", what: "MCP tool-call telemetry: argument summaries and errors" },
  rule_events: { label: "Rule events", what: "Content rules events with their masked evidence" },
  agent_memory: { label: "Agent memory", what: "Simple Memory sessions, agent artifacts and the session tool cache" }
};

/**
 * The classes that hold security evidence about a project (what its tools were called with, what content rules
 * caught): only a deployment admin may set them shorter than the deployment's value. A project's admins may raise
 * them, and set runs and agent memory either way, within the bounds.
 */
export const RETENTION_ADMIN_TO_SHORTEN: readonly RetentionDataClass[] = ["tool_calls", "rule_events"];

/** Whether `days` keeps a class for less time than the deployment's `deploymentDays` (0 = forever on both sides). */
export function retentionShortensDeployment(days: number, deploymentDays: number): boolean {
  if (days <= 0) return false;
  return deploymentDays <= 0 || days < deploymentDays;
}

/** What time-based retention never deletes, whatever the project sets. */
export const RETENTION_EXEMPTIONS_TEXT =
  "Golden runs and golden-set cases, paused runs, pending approvals, and the eval runs that back a workflow's current " +
  "or previous published version are never deleted by age.";

/** The largest number of days a value may name (100 years). */
export const RETENTION_POLICY_MAX_DAYS = 36_500;

const daysSchema = z.number().int().min(0).max(RETENTION_POLICY_MAX_DAYS);

/**
 * `PUT /api/projects/:id/retention`: a value per class to set, null to go back to the deployment's value. Classes
 * left out keep what they have.
 */
export const projectRetentionUpdateSchema = z
  .object({
    classes: z
      .object({
        runs: daysSchema.nullable().optional(),
        tool_calls: daysSchema.nullable().optional(),
        rule_events: daysSchema.nullable().optional(),
        agent_memory: daysSchema.nullable().optional()
      })
      .strict()
  })
  .strict();

export type ProjectRetentionUpdate = z.infer<typeof projectRetentionUpdateSchema>;

/** The range a project's value must fall in. maxDays null: no upper limit (and 0, keep forever, is allowed). */
export interface RetentionBounds {
  minDays: number;
  maxDays: number | null;
}

/** Why a project value is refused, or null when it is within the bounds. */
export function retentionDaysProblem(days: number, bounds: RetentionBounds): string | null {
  if (!Number.isInteger(days) || days < 0) return "must be a whole number of days, 0 or more";
  if (days === 0) {
    return bounds.maxDays === null ? null : `cannot be kept forever: this deployment keeps data at most ${bounds.maxDays} days`;
  }
  if (days < bounds.minDays) return `must be at least ${bounds.minDays} day${bounds.minDays === 1 ? "" : "s"}`;
  if (bounds.maxDays !== null && days > bounds.maxDays) return `must be at most ${bounds.maxDays} days`;
  return null;
}

/**
 * The days a stored project value keeps, under bounds that may have changed since it was saved: a value outside them
 * is brought to the nearest bound (keep forever under a maximum becomes the maximum).
 */
export function clampRetentionDays(days: number, bounds: RetentionBounds): number {
  if (!Number.isFinite(days) || days < 0) return bounds.minDays;
  const whole = Math.floor(days);
  if (whole === 0) return bounds.maxDays ?? 0;
  if (whole < bounds.minDays) return bounds.minDays;
  if (bounds.maxDays !== null && whole > bounds.maxDays) return bounds.maxDays;
  return whole;
}

/** One stored per-project value (`retention_policies`). */
export interface RetentionPolicyRecord {
  scopeType: "project";
  scopeId: string;
  dataClass: RetentionDataClass;
  days: number;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ProjectRetentionClassView {
  class: RetentionDataClass;
  label: string;
  what: string;
  /** The deployment's value and the setting it comes from (0 = kept forever). */
  deploymentDays: number;
  deploymentSetting: string;
  /** The project's own value; null when it inherits the deployment's. */
  days: number | null;
  /** What purges apply: the project's value within the bounds, else the deployment's (0 = kept forever). */
  effectiveDays: number;
  /** The stored value lies outside the current bounds, so the nearest bound applies. */
  clamped: boolean;
  /** Only a deployment admin may set this class shorter than the deployment's value (RETENTION_ADMIN_TO_SHORTEN). */
  shortenNeedsAdmin: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** `GET /api/projects/:id/retention`. */
export interface ProjectRetentionView {
  projectId: string;
  bounds: RetentionBounds;
  classes: ProjectRetentionClassView[];
  exemptions: string;
  /** Whether the caller may change the values (admins and the project's admins). */
  canEdit: boolean;
  /** Whether the caller is a deployment admin, who may also shorten the classes in RETENTION_ADMIN_TO_SHORTEN. */
  deploymentAdmin: boolean;
}

/** A project with values of its own, on the admin Data protection page. */
export interface ProjectRetentionOverride {
  projectId: string;
  projectName: string | null;
  classes: Partial<Record<RetentionDataClass, number>>;
}
