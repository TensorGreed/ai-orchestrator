import { describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import {
  absoluteHoursFor,
  idleExpiresAt,
  idleMinutesFor,
  maxSessionsFor,
  parseRoleValues,
  parseSessionPolicy,
  sessionPolicyVerdict
} from "./session-policy.js";

const range = { min: 0, max: 1000 };

describe("parseRoleValues", () => {
  it("reads a global value, role overrides, or both; blank is unset", () => {
    expect(parseRoleValues("X", undefined, range)).toBeNull();
    expect(parseRoleValues("X", "  ", range)).toBeNull();
    expect(parseRoleValues("X", "60", range)).toEqual({ global: 60, roles: {} });
    expect(parseRoleValues("X", "60, admin:15 ,Viewer:0", range)).toEqual({ global: 60, roles: { admin: 15, viewer: 0 } });
    expect(parseRoleValues("X", "admin:15", range)).toEqual({ global: null, roles: { admin: 15 } });
  });

  it("refuses malformed entries, naming the variable and the entry", () => {
    expect(() => parseRoleValues("SESSION_IDLE_TIMEOUT_MINUTES", "60,root:5", range)).toThrow(/SESSION_IDLE_TIMEOUT_MINUTES entry "root:5" names an unknown role/);
    expect(() => parseRoleValues("X", "abc", range)).toThrow(/entry "abc" must be a whole number/);
    expect(() => parseRoleValues("X", "1.5", range)).toThrow(/must be a whole number/);
    expect(() => parseRoleValues("X", "-1", range)).toThrow(/must be a whole number/);
    expect(() => parseRoleValues("X", "60,70", range)).toThrow(/repeats the global value/);
    expect(() => parseRoleValues("X", "admin:1,admin:2", range)).toThrow(/repeats a role/);
    expect(() => parseRoleValues("X", "60,,admin:1", range)).toThrow(/is empty/);
    expect(() => parseRoleValues("X", "2000", range)).toThrow(/at most 1000/);
    expect(() => parseRoleValues("X", "0", { min: 1, max: 10 })).toThrow(/at least 1/);
  });
});

describe("session policy", () => {
  it("unset keeps today's behaviour: no idle timeout, SESSION_TTL_HOURS lifetime, no limit", () => {
    const policy = parseSessionPolicy({ SESSION_TTL_HOURS: 168 });
    expect(idleMinutesFor(policy, "admin")).toBeNull();
    expect(absoluteHoursFor(policy, "admin")).toBe(168);
    expect(maxSessionsFor(policy, "viewer")).toBeNull();
    const old = { createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z" };
    expect(sessionPolicyVerdict(policy, old, "admin", Date.parse("2026-01-07T23:59:00.000Z"))).toBeNull();
    expect(sessionPolicyVerdict(policy, old, "admin", Date.parse("2026-01-08T00:00:00.000Z"))).toBe("expired");
  });

  it("applies per-role overrides over the global value; 0 turns a limit off for that role", () => {
    const policy = parseSessionPolicy({
      SESSION_TTL_HOURS: 168,
      SESSION_IDLE_TIMEOUT_MINUTES: "60,admin:15,viewer:0",
      SESSION_ABSOLUTE_TIMEOUT_HOURS: "admin:12",
      SESSION_MAX_PER_USER: "3,builder:0"
    });
    expect(idleMinutesFor(policy, "admin")).toBe(15);
    expect(idleMinutesFor(policy, "builder")).toBe(60);
    expect(idleMinutesFor(policy, "viewer")).toBeNull();
    expect(absoluteHoursFor(policy, "admin")).toBe(12);
    expect(absoluteHoursFor(policy, "operator")).toBe(168);
    expect(maxSessionsFor(policy, "operator")).toBe(3);
    expect(maxSessionsFor(policy, "builder")).toBeNull();
    expect(maxSessionsFor(policy, undefined)).toBe(3);
  });

  it("ends a session past its role's idle or absolute timeout; break-glass sessions only expire", () => {
    const policy = parseSessionPolicy({ SESSION_TTL_HOURS: 168, SESSION_IDLE_TIMEOUT_MINUTES: "60,admin:15", SESSION_ABSOLUTE_TIMEOUT_HOURS: "168,admin:12" });
    const t0 = Date.parse("2026-03-01T00:00:00.000Z");
    const session = { createdAt: new Date(t0).toISOString(), lastSeenAt: new Date(t0).toISOString(), expiresAt: new Date(t0 + 168 * 3_600_000).toISOString() };
    // The deadline allows for the one-minute touch throttle: never earlier than the configured idle time.
    expect(sessionPolicyVerdict(policy, session, "admin", t0 + 16 * 60_000 - 1)).toBeNull();
    expect(sessionPolicyVerdict(policy, session, "admin", t0 + 16 * 60_000)).toBe("idle");
    expect(sessionPolicyVerdict(policy, session, "builder", t0 + 16 * 60_000)).toBeNull();
    expect(sessionPolicyVerdict(policy, session, "admin", t0 + 16 * 60_000, { exempt: true })).toBeNull();
    const active = { ...session, lastSeenAt: new Date(t0 + 12 * 3_600_000 - 1000).toISOString() };
    expect(sessionPolicyVerdict(policy, active, "admin", t0 + 12 * 3_600_000)).toBe("expired");
    expect(sessionPolicyVerdict(policy, active, "builder", t0 + 12 * 3_600_000)).toBeNull();
    expect(idleExpiresAt(policy, session, "admin")).toBe(new Date(t0 + (15 + 1) * 60_000).toISOString());
    expect(idleExpiresAt(policy, session, "admin", { exempt: true })).toBeNull();
    // An exempt (break-glass) session still ends at its expiry.
    expect(sessionPolicyVerdict(policy, session, "admin", t0 + 168 * 3_600_000, { exempt: true })).toBe("expired");
    // A row without an activity time is measured from its creation.
    expect(sessionPolicyVerdict(policy, { ...session, lastSeenAt: null }, "admin", t0 + 16 * 60_000)).toBe("idle");
  });

  it("refuses to start on a malformed setting", () => {
    const base = { SECRET_MASTER_KEY_BASE64: Buffer.alloc(32, 1).toString("base64") };
    expect(() => parseConfig({ ...base, SESSION_MAX_PER_USER: "two" })).toThrow(/SESSION_MAX_PER_USER entry "two"/);
    expect(() => parseConfig({ ...base, SESSION_ABSOLUTE_TIMEOUT_HOURS: "0" })).toThrow(/SESSION_ABSOLUTE_TIMEOUT_HOURS entry "0" must be at least 1/);
    expect(parseConfig({ ...base, SESSION_IDLE_TIMEOUT_MINUTES: "30,admin:10" }).SESSION_IDLE_TIMEOUT_MINUTES).toBe("30,admin:10");
  });
});
