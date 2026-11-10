import { describe, expect, it } from "vitest";
import { parseConfig, resolveMfaPolicy } from "../config.js";
import type { SafeUser } from "./auth-service.js";
import { parseKeyScopes } from "./key-scopes.js";
import type { LoginSession, RequestAuthContext } from "./session-service.js";
import {
  STEP_UP_ACTIONS,
  decideStepUp,
  mfaGateAllows,
  mfaRequiredFor,
  sessionMfaGate,
  sessionOwesMfa
} from "./mfa-policy.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

function session(overrides: Partial<LoginSession> = {}): LoginSession {
  return {
    id: "sess_test",
    userId: "usr_1",
    expiresAt: "2026-11-10T12:00:00.000Z",
    createdAt: "2026-11-09T11:00:00.000Z",
    lastSeenAt: "2026-11-09T11:00:00.000Z",
    revokedAt: null,
    authMethod: "password",
    ipAddress: null,
    userAgent: null,
    mfaVerifiedAt: null,
    breakGlass: false,
    endedReason: null,
    ...overrides
  };
}

const user = { id: "usr_1", email: "a@example.com", role: "admin" as const };

describe("resolveMfaPolicy", () => {
  it("unset: no role requires MFA and step-up is off", () => {
    expect(resolveMfaPolicy({})).toEqual({ requiredRoles: [], stepUpMaxAgeMinutes: 0, notes: [] });
  });

  it("reads the role list in role order, case-insensitively, without duplicates", () => {
    expect(resolveMfaPolicy({ MFA_REQUIRED_ROLES: " Builder, admin ,builder" }).requiredRoles).toEqual(["admin", "builder"]);
  });

  it("MFA_ENFORCE=true is an alias that adds admin", () => {
    expect(resolveMfaPolicy({ MFA_ENFORCE: true }).requiredRoles).toEqual(["admin"]);
    const both = resolveMfaPolicy({ MFA_ENFORCE: true, MFA_REQUIRED_ROLES: "operator" });
    expect(both.requiredRoles).toEqual(["admin", "operator"]);
    expect(both.notes).toEqual(["MFA_ENFORCE=true adds admin to MFA_REQUIRED_ROLES"]);
  });

  it("notes that MFA_ENABLED has no effect", () => {
    expect(resolveMfaPolicy({ MFA_ENABLED: true }).notes[0]).toMatch(/MFA_ENABLED has no effect/);
  });

  it("refuses an unknown role at startup", () => {
    expect(() => resolveMfaPolicy({ MFA_REQUIRED_ROLES: "admin,owner" })).toThrow(/MFA_REQUIRED_ROLES has "owner"/);
    expect(() => parseConfig({ SECRET_MASTER_KEY_BASE64: "x", MFA_REQUIRED_ROLES: "superuser" })).toThrow(/MFA_REQUIRED_ROLES/);
  });

  it("parses STEP_UP_MAX_AGE_MINUTES (empty = off) and refuses a negative value", () => {
    const base = { SECRET_MASTER_KEY_BASE64: "x" };
    expect(resolveMfaPolicy(parseConfig({ ...base, STEP_UP_MAX_AGE_MINUTES: "15" })).stepUpMaxAgeMinutes).toBe(15);
    expect(resolveMfaPolicy(parseConfig({ ...base, STEP_UP_MAX_AGE_MINUTES: "" })).stepUpMaxAgeMinutes).toBe(0);
    expect(() => parseConfig({ ...base, STEP_UP_MAX_AGE_MINUTES: "-1" })).toThrow();
  });
});

describe("the role rule and the session gate", () => {
  const policy = { requiredRoles: ["admin", "builder"] as Array<"admin" | "builder"> };

  it("applies only to listed roles", () => {
    expect(mfaRequiredFor(policy, "admin")).toBe(true);
    expect(mfaRequiredFor(policy, "viewer")).toBe(false);
    expect(sessionOwesMfa(policy, "viewer", session())).toBe(false);
  });

  it("a listed role owes MFA until the session records a check; break-glass never owes it", () => {
    expect(sessionOwesMfa(policy, "builder", session())).toBe(true);
    expect(sessionOwesMfa(policy, "builder", session({ mfaVerifiedAt: "2026-11-09T11:00:00.000Z" }))).toBe(false);
    expect(sessionOwesMfa(policy, "admin", session({ breakGlass: true }))).toBe(false);
  });

  it("without TOTP the session can only enrol; with TOTP only verify", () => {
    expect(sessionMfaGate(false, false)).toBe("none");
    expect(sessionMfaGate(true, false)).toBe("enrollment_required");
    expect(sessionMfaGate(true, true)).toBe("verification_required");
  });

  it("allows /api/auth/me and MFA status on both, MFA setup when enrolling, step-up when verifying", () => {
    for (const gate of ["enrollment_required", "verification_required"] as const) {
      expect(mfaGateAllows(gate, "GET", "/api/auth/me")).toBe(true);
      expect(mfaGateAllows(gate, "GET", "/api/auth/mfa/status")).toBe(true);
      expect(mfaGateAllows(gate, "GET", "/api/workflows")).toBe(false);
      expect(mfaGateAllows(gate, "PUT", "/api/users/:id")).toBe(false);
    }
    expect(mfaGateAllows("enrollment_required", "POST", "/api/auth/mfa/enroll")).toBe(true);
    expect(mfaGateAllows("enrollment_required", "POST", "/api/auth/mfa/activate")).toBe(true);
    expect(mfaGateAllows("enrollment_required", "POST", "/api/auth/step-up")).toBe(false);
    expect(mfaGateAllows("verification_required", "POST", "/api/auth/step-up")).toBe(true);
    expect(mfaGateAllows("verification_required", "POST", "/api/auth/mfa/enroll")).toBe(false);
    expect(mfaGateAllows("none", "DELETE", "/api/anything")).toBe(true);
  });
});

describe("decideStepUp", () => {
  const sessionContext = (overrides: Partial<LoginSession> = {}): RequestAuthContext => ({
    credential: "session",
    user,
    session: session(overrides)
  });
  const keyContext = (keyScopes: string[], serviceAccount = false, actsAs: SafeUser["role"] = user.role): RequestAuthContext => ({
    credential: "api_key",
    user: { ...user, role: actsAs },
    apiKeyId: "key_1",
    keyScopes,
    keyScope: parseKeyScopes(keyScopes),
    serviceAccount
  });

  it("off: everything passes, keys included, as today", () => {
    expect(decideStepUp({ maxAgeMinutes: 0, context: keyContext([]), now: NOW })).toEqual({ kind: "allow" });
    expect(decideStepUp({ maxAgeMinutes: 0, context: undefined, now: NOW })).toEqual({ kind: "allow" });
  });

  it("on: a missing context is denied, never treated as nothing to check", () => {
    expect(decideStepUp({ maxAgeMinutes: 15, context: undefined, now: NOW })).toEqual({ kind: "unauthenticated" });
  });

  it("on: a session passes only with an MFA check inside the window", () => {
    const fresh = new Date(NOW - 14 * 60_000).toISOString();
    const stale = new Date(NOW - 16 * 60_000).toISOString();
    expect(decideStepUp({ maxAgeMinutes: 15, context: sessionContext({ mfaVerifiedAt: fresh }), now: NOW }).kind).toBe("allow");
    expect(decideStepUp({ maxAgeMinutes: 15, context: sessionContext({ mfaVerifiedAt: stale }), now: NOW }).kind).toBe("required");
    expect(decideStepUp({ maxAgeMinutes: 15, context: sessionContext(), now: NOW }).kind).toBe("required");
    expect(decideStepUp({ maxAgeMinutes: 15, context: sessionContext({ breakGlass: true }), now: NOW }).kind).toBe("allow");
  });

  it("on (D9): personal keys are refused; a service-account key passes only with role:admin", () => {
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin"]), now: NOW }).kind).toBe("key_refused");
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin"], false), now: NOW }).kind).toBe("key_refused");
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:operator"], true, "operator"), now: NOW }).kind).toBe("key_refused");
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext([], true), now: NOW }).kind).toBe("key_refused");
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin"], true), now: NOW }).kind).toBe("allow");
  });

  it("on (D9): a service-account role:admin key that no longer acts as admin is refused", () => {
    // A project list caps the key at builder; a demoted account lowers its keys. Either way it is not an admin key.
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin", "project:alpha"], true, "builder"), now: NOW }).kind).toBe("key_refused");
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin"], true, "operator"), now: NOW }).kind).toBe("key_refused");
  });

  it("on: any service-account key is refused on an action that targets a person; sessions are judged as before", () => {
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin"], true), now: NOW, targetsPerson: true })).toEqual({
      kind: "key_refused",
      reason: "person_target"
    });
    expect(decideStepUp({ maxAgeMinutes: 15, context: keyContext(["role:admin"], true), now: NOW, targetsPerson: false }).kind).toBe("allow");
    const fresh = new Date(NOW - 60_000).toISOString();
    expect(decideStepUp({ maxAgeMinutes: 15, context: sessionContext({ mfaVerifiedAt: fresh }), now: NOW, targetsPerson: true }).kind).toBe("allow");
    // Off: nothing is checked, as before.
    expect(decideStepUp({ maxAgeMinutes: 0, context: keyContext(["role:admin"], true), now: NOW, targetsPerson: true }).kind).toBe("allow");
  });

  it("names a fixed, documented action list", () => {
    expect(Object.keys(STEP_UP_ACTIONS)).toEqual([
      "user.create",
      "user.invite",
      "user.role_change",
      "user.delete",
      "user.mfa_reset",
      "user.sessions_revoke",
      "mfa.disable",
      "api_key.create",
      "mcp_client.create",
      "secret.create",
      "secret.update",
      "secret.delete",
      "sso_mapping.change",
      "project_member.change",
      "custom_role.change",
      "notification_channel.change",
      "audit_export.change",
      "legal_hold.change"
    ]);
  });
});
