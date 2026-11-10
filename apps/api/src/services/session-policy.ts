/**
 * 13.2 — session policy: idle timeout, absolute lifetime and the per-user session limit.
 *
 * Each setting is one environment variable in the form `<global>[,role:value]*`, for example
 * `SESSION_IDLE_TIMEOUT_MINUTES=60,admin:15`. The global value applies to every role without its own entry; either part
 * may be left out. Unset means today's behaviour: no idle timeout, sessions live SESSION_TTL_HOURS, no session limit.
 * The user's current role is used, so a promotion to a role with a stricter value tightens a live session.
 */
import { z } from "zod";
import type { UserRole } from "./auth-service.js";

/**
 * Activity is written at most once per this many milliseconds per session (the touch throttle), so a session's real
 * last activity can be up to this much later than its stored `last_seen_at`. The idle deadline adds it, so a session
 * is never ended before the configured idle time has passed since the user's real last activity (at most this much
 * later).
 */
export const SESSION_TOUCH_THROTTLE_MS = 60_000;

/** The idle deadline (ms) of a session whose stored activity time is `lastSeenMs`. */
function idleDeadlineMs(lastSeenMs: number, idleMinutes: number): number {
  return lastSeenMs + idleMinutes * 60_000 + SESSION_TOUCH_THROTTLE_MS;
}

export const SESSION_POLICY_ROLES: readonly UserRole[] = ["admin", "builder", "operator", "viewer"];

/** A global value plus per-role overrides. */
export interface RoleValues {
  global: number | null;
  roles: Partial<Record<UserRole, number>>;
}

export interface SessionPolicy {
  /** SESSION_IDLE_TIMEOUT_MINUTES; null when unset. A value of 0 means no idle timeout for that role. */
  idleMinutes: RoleValues | null;
  /** SESSION_ABSOLUTE_TIMEOUT_HOURS; null when unset (sessions then live SESSION_TTL_HOURS, as before). */
  absoluteHours: RoleValues | null;
  /** SESSION_MAX_PER_USER; null when unset. A value of 0 means unlimited for that role. */
  maxPerUser: RoleValues | null;
  /** SESSION_TTL_HOURS: the lifetime of a session when no absolute timeout is set. */
  ttlHours: number;
}

export interface SessionPolicyEnv {
  SESSION_TTL_HOURS: number;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  SESSION_ABSOLUTE_TIMEOUT_HOURS?: string;
  SESSION_MAX_PER_USER?: string;
}

const roleSchema = z.enum(["admin", "builder", "operator", "viewer"]);

/**
 * Parses one `<global>[,role:value]*` setting, or returns null when it is unset or blank. `min` is the smallest value
 * allowed (0 where 0 means "off"). Throws an Error naming the variable and the entry for anything else.
 */
export function parseRoleValues(name: string, raw: string | undefined, options: { min: number; max: number }): RoleValues | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const valueSchema = z.coerce
    .number()
    .int("must be a whole number")
    .min(options.min, `must be at least ${options.min}`)
    .max(options.max, `must be at most ${options.max}`);
  const fail = (entry: string, message: string): never => {
    throw new Error(`Invalid environment configuration: ${name} entry "${entry}" ${message} (expected <global>[,role:value]*, roles ${SESSION_POLICY_ROLES.join(", ")})`);
  };
  const result: RoleValues = { global: null, roles: {} };
  for (const piece of text.split(",")) {
    const entry = piece.trim();
    if (!entry) fail(piece, "is empty");
    const colon = entry.indexOf(":");
    const rolePart = colon === -1 ? null : entry.slice(0, colon).trim().toLowerCase();
    const valuePart = colon === -1 ? entry : entry.slice(colon + 1).trim();
    if (!/^\d+$/.test(valuePart)) fail(entry, "must be a whole number");
    const value = valueSchema.safeParse(valuePart);
    if (!value.success) fail(entry, value.error.issues[0]?.message ?? "is not valid");
    const parsed = value.success ? value.data : 0;
    if (rolePart === null) {
      if (result.global !== null) fail(entry, "repeats the global value");
      result.global = parsed;
      continue;
    }
    const role = roleSchema.safeParse(rolePart);
    if (!role.success) fail(entry, "names an unknown role");
    const roleName = role.success ? role.data : "viewer";
    if (result.roles[roleName] !== undefined) fail(entry, "repeats a role");
    result.roles[roleName] = parsed;
  }
  return result;
}

function valueFor(values: RoleValues | null, role: UserRole | undefined): number | null {
  if (!values) return null;
  const own = role ? values.roles[role] : undefined;
  return own ?? values.global;
}

/** Reads and checks the three settings (throws at boot with the variable and entry named). */
export function parseSessionPolicy(env: SessionPolicyEnv): SessionPolicy {
  return {
    idleMinutes: parseRoleValues("SESSION_IDLE_TIMEOUT_MINUTES", env.SESSION_IDLE_TIMEOUT_MINUTES, { min: 0, max: 525_600 }),
    absoluteHours: parseRoleValues("SESSION_ABSOLUTE_TIMEOUT_HOURS", env.SESSION_ABSOLUTE_TIMEOUT_HOURS, { min: 1, max: 87_600 }),
    maxPerUser: parseRoleValues("SESSION_MAX_PER_USER", env.SESSION_MAX_PER_USER, { min: 0, max: 10_000 }),
    ttlHours: env.SESSION_TTL_HOURS
  };
}

/** The policy with nothing set: exactly the behaviour before 13.2 L1. */
export function defaultSessionPolicy(ttlHours: number): SessionPolicy {
  return { idleMinutes: null, absoluteHours: null, maxPerUser: null, ttlHours };
}

/** Idle timeout in minutes for a role, or null when there is none. */
export function idleMinutesFor(policy: SessionPolicy, role: UserRole | undefined): number | null {
  const value = valueFor(policy.idleMinutes, role);
  return value && value > 0 ? value : null;
}

/** The absolute timeout in hours for a role when one is configured for it, else null (SESSION_TTL_HOURS applies). */
export function configuredAbsoluteHoursFor(policy: SessionPolicy, role: UserRole | undefined): number | null {
  return valueFor(policy.absoluteHours, role);
}

/** How long a new session for this role lives: its absolute timeout, falling back to SESSION_TTL_HOURS. */
export function absoluteHoursFor(policy: SessionPolicy, role: UserRole | undefined): number {
  return configuredAbsoluteHoursFor(policy, role) ?? policy.ttlHours;
}

/** The most live sessions a user in this role keeps, or null for unlimited. */
export function maxSessionsFor(policy: SessionPolicy, role: UserRole | undefined): number | null {
  const value = valueFor(policy.maxPerUser, role);
  return value && value > 0 ? value : null;
}

/** What the policy says about one session row right now: null while it may be used, else why it ends. */
export function sessionPolicyVerdict(
  policy: SessionPolicy,
  session: { createdAt: string; lastSeenAt: string | null; expiresAt: string },
  role: UserRole | undefined,
  nowMs: number,
  options: { exempt?: boolean } = {}
): "expired" | "idle" | null {
  if (Date.parse(session.expiresAt) <= nowMs) return "expired";
  if (options.exempt) return null;
  const createdMs = Date.parse(session.createdAt);
  const absolute = configuredAbsoluteHoursFor(policy, role);
  if (absolute !== null && Number.isFinite(createdMs) && createdMs + absolute * 3_600_000 <= nowMs) return "expired";
  const idle = idleMinutesFor(policy, role);
  if (idle !== null) {
    const lastMs = Date.parse(session.lastSeenAt ?? session.createdAt);
    if (Number.isFinite(lastMs) && idleDeadlineMs(lastMs, idle) <= nowMs) return "idle";
  }
  return null;
}

/** When the server ends the session for idleness (ISO; the same deadline sessionPolicyVerdict applies), or null when the role has no idle timeout or the session is exempt. */
export function idleExpiresAt(
  policy: SessionPolicy,
  session: { createdAt: string; lastSeenAt: string | null },
  role: UserRole | undefined,
  options: { exempt?: boolean } = {}
): string | null {
  const idle = idleMinutesFor(policy, role);
  if (idle === null || options.exempt) return null;
  const lastMs = Date.parse(session.lastSeenAt ?? session.createdAt);
  return Number.isFinite(lastMs) ? new Date(idleDeadlineMs(lastMs, idle)).toISOString() : null;
}
