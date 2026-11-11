import { describe, expect, it } from "vitest";
import { RETENTION_PURGE_CLASSES } from "./retention";
import {
  RETENTION_DATA_CLASSES,
  RETENTION_DATA_CLASS_PURGES,
  clampRetentionDays,
  RETENTION_ADMIN_TO_SHORTEN,
  projectRetentionUpdateSchema,
  retentionDataClassOf,
  retentionDaysProblem,
  retentionShortensDeployment
} from "./retention-policy";

describe("per-project retention values", () => {
  it("maps each purge class to at most one per-project class", () => {
    expect(retentionDataClassOf("runs")).toBe("runs");
    expect(retentionDataClassOf("cassettes_approvals")).toBe("runs");
    expect(retentionDataClassOf("queue")).toBe("runs");
    expect(retentionDataClassOf("tool_calls")).toBe("tool_calls");
    expect(retentionDataClassOf("rule_events")).toBe("rule_events");
    expect(retentionDataClassOf("agent_memory")).toBe("agent_memory");
    for (const only of ["usage", "gateway_requests", "eval_runs", "captures", "simulations"] as const) expect(retentionDataClassOf(only)).toBeNull();
    const governed = RETENTION_DATA_CLASSES.flatMap((dataClass) => RETENTION_DATA_CLASS_PURGES[dataClass]);
    expect(new Set(governed).size).toBe(governed.length);
    for (const purgeClass of governed) expect(RETENTION_PURGE_CLASSES).toContain(purgeClass);
  });

  it("checks a value against the bounds; keep forever only without a maximum", () => {
    const open = { minDays: 1, maxDays: null };
    const bounded = { minDays: 7, maxDays: 365 };
    expect(retentionDaysProblem(30, open)).toBeNull();
    expect(retentionDaysProblem(0, open)).toBeNull();
    expect(retentionDaysProblem(36_500, open)).toBeNull();
    expect(retentionDaysProblem(7, bounded)).toBeNull();
    expect(retentionDaysProblem(365, bounded)).toBeNull();
    expect(retentionDaysProblem(6, bounded)).toMatch(/at least 7 days/);
    expect(retentionDaysProblem(366, bounded)).toMatch(/at most 365 days/);
    expect(retentionDaysProblem(0, bounded)).toMatch(/cannot be kept forever/);
    expect(retentionDaysProblem(1.5, open)).toMatch(/whole number/);
    expect(retentionDaysProblem(-1, open)).toMatch(/whole number/);
  });

  it("brings a stored value inside bounds that changed since it was saved", () => {
    const bounded = { minDays: 7, maxDays: 365 };
    expect(clampRetentionDays(30, bounded)).toBe(30);
    expect(clampRetentionDays(3, bounded)).toBe(7);
    expect(clampRetentionDays(1000, bounded)).toBe(365);
    expect(clampRetentionDays(0, bounded)).toBe(365);
    expect(clampRetentionDays(0, { minDays: 7, maxDays: null })).toBe(0);
    expect(clampRetentionDays(3, { minDays: 1, maxDays: null })).toBe(3);
  });

  it("tells when a value keeps a class for less time than the deployment", () => {
    expect(RETENTION_ADMIN_TO_SHORTEN).toEqual(["tool_calls", "rule_events"]);
    expect(retentionShortensDeployment(7, 30)).toBe(true);
    expect(retentionShortensDeployment(30, 30)).toBe(false);
    expect(retentionShortensDeployment(400, 30)).toBe(false);
    expect(retentionShortensDeployment(0, 30)).toBe(false);
    expect(retentionShortensDeployment(3650, 0)).toBe(true);
    expect(retentionShortensDeployment(0, 0)).toBe(false);
  });

  it("accepts days or null per known class only", () => {
    expect(projectRetentionUpdateSchema.safeParse({ classes: { runs: 7, agent_memory: null } }).success).toBe(true);
    expect(projectRetentionUpdateSchema.safeParse({ classes: {} }).success).toBe(true);
    expect(projectRetentionUpdateSchema.safeParse({ classes: { usage: 30 } }).success).toBe(false);
    expect(projectRetentionUpdateSchema.safeParse({ classes: { runs: "30" } }).success).toBe(false);
    expect(projectRetentionUpdateSchema.safeParse({ classes: { runs: 36_501 } }).success).toBe(false);
    expect(projectRetentionUpdateSchema.safeParse({ runs: 30 }).success).toBe(false);
  });
});
