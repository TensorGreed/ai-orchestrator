/**
 * 13.2 — the one place sign-in sessions are issued, and the per-request sign-in context.
 *
 * Every sign-in path (password, the MFA step, OIDC, SAML, LDAP) calls `issueSession`, so each session row records how
 * it was issued, from where, whether it passed MFA, and whether it is a break-glass session. Nothing else calls
 * `store.saveSession` (session-service.test.ts scans the sources).
 *
 * The request context is what the auth layer resolved for one request: the user, the credential (session cookie or
 * API key), the session row or the key's id and scopes. `requireRole` records it; later checks read it with
 * `getRequestAuth` instead of looking the session up again.
 */
import crypto from "node:crypto";
import net from "node:net";
import type { LoginSession, SessionAuthMethod, SessionEndReason, Store } from "../db/store.js";
import type { SafeUser, UserRole } from "./auth-service.js";
import type { KeyScope } from "./key-scopes.js";
import {
  SESSION_TOUCH_THROTTLE_MS,
  absoluteHoursFor,
  defaultSessionPolicy,
  maxSessionsFor,
  sessionPolicyVerdict,
  type SessionPolicy
} from "./session-policy.js";

export type { LoginSession, SessionAuthMethod, SessionEndReason };

/** Session IDs this server issues: `sess_` plus 24 to 64 URL-safe characters. Anything else cannot name a session. */
export const SESSION_ID_FORMAT = /^sess_[A-Za-z0-9_-]{24,64}$/;

/** The longest user agent kept on a session row; longer values are cut. */
export const SESSION_USER_AGENT_MAX = 512;

/** The longest address kept on a session row (an IPv4-mapped IPv6 address is 45 characters). */
export const SESSION_IP_MAX = 45;

/** A break-glass session never lives longer than this, whatever TTL the caller asks for. */
export const BREAK_GLASS_MAX_TTL_HOURS = 1;

/** A session's activity time is written at most once per this many milliseconds (per instance). */
export { SESSION_TOUCH_THROTTLE_MS };

/** The most sessions whose last write time one instance remembers for the touch throttle. */
export const SESSION_TOUCH_MAP_MAX = 10_000;

/** The request header the studio sets on its background polls: such requests never count as user activity. */
export const BACKGROUND_REQUEST_HEADER = "x-l2m-background";

/** True when a request says it is background traffic (`X-L2M-Background: 1`). */
export function isBackgroundRequest(headers: Record<string, unknown> | undefined): boolean {
  return headerValue(headers, BACKGROUND_REQUEST_HEADER) === "1";
}

/**
 * The non-secret name the sessions API uses for a session: the session ID is the cookie value, so it is never sent
 * back. A hash prefix is stable, unique in practice, and reveals nothing about the cookie.
 */
export function sessionHandle(sessionId: string): string {
  return `ses_${crypto.createHash("sha256").update(sessionId).digest("base64url").slice(0, 22)}`;
}

/** The parts of a request a session records. Fastify's request satisfies it (`ip` honours TRUST_PROXY). */
export interface SessionRequestInfo {
  ip?: string;
  headers?: Record<string, unknown>;
}

export interface IssueSessionInput {
  /** The user signing in; with `role`, the session policy for that role applies (lifetime and session limit). */
  user: Pick<SafeUser, "id"> & { role?: UserRole };
  method: SessionAuthMethod;
  /** Where the sign-in came from; leave it out for sessions minted outside a request. */
  request?: SessionRequestInfo;
  /** True when this sign-in passed an MFA check (local TOTP or IdP-asserted MFA): sets `mfa_verified_at` to now. */
  mfaVerified?: boolean;
  /**
   * Absolute lifetime in hours; defaults to the role's SESSION_ABSOLUTE_TIMEOUT_HOURS, else SESSION_TTL_HOURS. A
   * `break_glass` session is capped at BREAK_GLASS_MAX_TTL_HOURS.
   */
  ttlHours?: number;
}

export interface IssuedSession {
  session: LoginSession;
  sessionId: string;
  expiresAt: string;
  /** Sessions of the same user this sign-in ended under SESSION_MAX_PER_USER (oldest first; empty when none). */
  evictedSessionIds: string[];
}

/** Why a session cookie no longer signs anyone in (`invalid`: unknown session, or its user is gone). */
export type SessionRejectReason = SessionEndReason | "invalid";

/** What the auth layer resolved for one request. */
export type RequestAuthContext =
  | { credential: "session"; user: SafeUser; session: LoginSession }
  | {
      credential: "api_key";
      /** The key's owner as the key acts: role capped by the key's scope, `projectScope` set when it lists projects. */
      user: SafeUser;
      apiKeyId: string;
      /** The scopes as stored. */
      keyScopes: string[];
      /** 13.2 — the parsed scope (key-scopes.ts). */
      keyScope: KeyScope;
      /** 13.2 — the key belongs to a service account. */
      serviceAccount: boolean;
    };

/** Where the service reports housekeeping failures it carries on from (pino's `warn(object, message)` shape). */
export interface SessionServiceLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface SessionServiceOptions {
  ttlHours: number;
  /** Idle and absolute timeouts and the session limit; unset keeps the behaviour before 13.2 L1. */
  policy?: SessionPolicy;
  now?: () => number;
  log?: SessionServiceLogger;
}

/** A new session ID: `sess_` plus 32 random bytes, base64url (43 characters). */
export function newSessionId(): string {
  return `sess_${crypto.randomBytes(32).toString("base64url")}`;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string {
  const raw = headers?.[name];
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
  return value.trim();
}

/**
 * The IP address and user agent a session records for this request (null when absent). Behind a trusted proxy the
 * address comes from X-Forwarded-For unchecked, so only a valid IPv4 or IPv6 address of at most SESSION_IP_MAX
 * characters is kept; anything else is recorded as null. The user agent is cut to SESSION_USER_AGENT_MAX.
 */
export function sessionRequestFields(request: SessionRequestInfo | undefined): { ipAddress: string | null; userAgent: string | null } {
  const ip = typeof request?.ip === "string" ? request.ip.trim() : "";
  const validIp = ip.length > 0 && ip.length <= SESSION_IP_MAX && net.isIP(ip) !== 0 ? ip : null;
  const userAgent = headerValue(request?.headers, "user-agent").slice(0, SESSION_USER_AGENT_MAX);
  return { ipAddress: validIp, userAgent: userAgent || null };
}

/**
 * True for a session the role-based session policies leave alone (break-glass sessions). Network allow-lists still
 * apply to it.
 */
export function isPolicyExempt(session: Pick<LoginSession, "breakGlass"> | null | undefined): boolean {
  return session?.breakGlass === true;
}

export class SessionService {
  private readonly requestSessions = new WeakMap<object, Promise<LoginSession | null>>();
  private readonly requestAuth = new WeakMap<object, RequestAuthContext>();
  private readonly now: () => number;
  private log: SessionServiceLogger | undefined;
  private policyValue: SessionPolicy;
  /** When this instance last wrote each session's activity time (the touch throttle). */
  private readonly lastTouch = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly options: SessionServiceOptions
  ) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
    this.policyValue = options.policy ?? defaultSessionPolicy(options.ttlHours);
  }

  /** The session policy in force (the app sets it from the environment at startup). */
  get policy(): SessionPolicy {
    return this.policyValue;
  }

  setPolicy(policy: SessionPolicy): void {
    this.policyValue = policy;
  }

  /** The current time in milliseconds, as this service sees it (tests pass a clock). */
  nowMs(): number {
    return this.now();
  }

  /**
   * What the policy says about a live session row for a user in `role`: null while it may be used, `expired` past its
   * expiry or absolute timeout, `idle` past its idle timeout. Break-glass sessions only expire.
   */
  verdict(session: LoginSession, role: UserRole | undefined): "expired" | "idle" | null {
    return sessionPolicyVerdict(this.policyValue, session, role, this.now(), { exempt: isPolicyExempt(session) });
  }

  /**
   * The latest activity time recorded for a session: its row's `last_seen_at`, or this instance's later write to it.
   * The idle deadline the studio is told is measured from here: the same deadline the server applies.
   */
  recordedActivityAt(session: Pick<LoginSession, "id" | "lastSeenAt" | "createdAt">): string {
    const stored = Date.parse(session.lastSeenAt ?? session.createdAt);
    const written = this.lastTouch.get(session.id);
    const latest = written !== undefined && (!Number.isFinite(stored) || written > stored) ? written : stored;
    return Number.isFinite(latest) ? new Date(latest).toISOString() : session.createdAt;
  }

  /**
   * Records user activity on a session. Background requests (X-L2M-Background: 1) never count, and each instance
   * writes at most once per SESSION_TOUCH_THROTTLE_MS per session, so `last_seen_at` can lag by up to a minute.
   */
  async recordActivity(sessionId: string, options: { background?: boolean } = {}): Promise<void> {
    if (options.background) return;
    const now = this.now();
    const last = this.lastTouch.get(sessionId);
    if (last !== undefined && now - last < SESSION_TOUCH_THROTTLE_MS) return;
    // Keep the map bounded: drop stale entries, then the oldest ones (Map keeps insertion order, and each write
    // re-inserts its session at the end). Forgetting an entry only means one extra write.
    this.lastTouch.delete(sessionId);
    if (this.lastTouch.size >= SESSION_TOUCH_MAP_MAX) {
      for (const [id, at] of this.lastTouch) {
        if (now - at >= SESSION_TOUCH_THROTTLE_MS) this.lastTouch.delete(id);
      }
      for (const id of this.lastTouch.keys()) {
        if (this.lastTouch.size < SESSION_TOUCH_MAP_MAX) break;
        this.lastTouch.delete(id);
      }
    }
    this.lastTouch.set(sessionId, now);
    await this.store.touchSession(sessionId);
  }

  /** Where housekeeping failures are reported (the app passes its logger). */
  setLogger(log: SessionServiceLogger): void {
    this.log = log;
  }

  get ttlHours(): number {
    return this.options.ttlHours;
  }

  /**
   * Issues a session for a user who just signed in. The caller sets the cookie. The break-glass flag follows the
   * method: only `break_glass` sets it, and such a session lives at most BREAK_GLASS_MAX_TTL_HOURS.
   */
  async issueSession(input: IssueSessionInput): Promise<IssuedSession> {
    // Housekeeping only: a failing sweep never blocks a sign-in.
    try {
      await this.store.revokeExpiredSessions();
    } catch (error) {
      this.log?.warn({ reason: error instanceof Error ? error.message : String(error) }, "Expired-session sweep failed; signing in anyway");
    }
    const now = this.now();
    const breakGlass = input.method === "break_glass";
    const requested = input.ttlHours ?? absoluteHoursFor(this.policyValue, input.user.role);
    const ttlHours = breakGlass ? Math.min(requested, BREAK_GLASS_MAX_TTL_HOURS) : requested;
    const expiresAt = new Date(now + ttlHours * 60 * 60 * 1000).toISOString();
    const session = await this.store.saveSession({
      id: newSessionId(),
      userId: input.user.id,
      expiresAt,
      authMethod: input.method,
      ...sessionRequestFields(input.request),
      mfaVerifiedAt: input.mfaVerified ? new Date(now).toISOString() : null,
      breakGlass
    });
    // SESSION_MAX_PER_USER: a sign-in never fails over the limit; the user's oldest other sessions end instead. The
    // store ranks and ends them under a per-user lock, so concurrent sign-ins on several instances keep exactly `limit`.
    const limit = breakGlass ? null : maxSessionsFor(this.policyValue, input.user.role);
    let evictedSessionIds: string[] = [];
    if (limit !== null) {
      try {
        // Sessions the policy already condemns (idle, or past the role's absolute timeout) end with that reason
        // first, so they never take a place under the limit from a session in use.
        await this.liveSessions(input.user.id, input.user.role);
        evictedSessionIds = await this.store.revokeOldestUserSessions(input.user.id, limit, "evicted", { protectId: session.id });
      } catch (error) {
        // The new session is already saved; the next sign-in enforces the limit again.
        this.log?.warn({ reason: error instanceof Error ? error.message : String(error) }, "Session limit not applied; signing in anyway");
      }
    }
    for (const id of evictedSessionIds) this.lastTouch.delete(id);
    return { session, sessionId: session.id, expiresAt: session.expiresAt, evictedSessionIds };
  }

  /**
   * A user's live sessions (newest first) as the policy sees them for `role`: rows that are idle or past the role's
   * absolute timeout are ended here with that reason and left out.
   */
  async liveSessions(userId: string, role: UserRole | undefined): Promise<LoginSession[]> {
    const rows = await this.store.listUserSessions(userId, { liveOnly: true, now: new Date(this.now()).toISOString() });
    const live: LoginSession[] = [];
    for (const row of rows) {
      const verdict = this.verdict(row, role);
      if (verdict) await this.endSession(row.id, verdict);
      else live.push(row);
    }
    return live;
  }

  /** How many sessions this instance remembers for the touch throttle (at most SESSION_TOUCH_MAP_MAX). */
  get touchedSessionCount(): number {
    return this.lastTouch.size;
  }

  /** Ends one session; false when it was already ended or does not exist. */
  async endSession(sessionId: string, reason: SessionEndReason): Promise<boolean> {
    if (!sessionId) return false;
    this.lastTouch.delete(sessionId);
    return await this.store.revokeSession(sessionId, reason);
  }

  /**
   * The session row the request's cookie names, looked up at most once per request: the rate-limit exemption check
   * and the auth layer share the result. A cookie that is not shaped like a session ID costs no lookup. A failed
   * lookup is not remembered (the next caller looks again).
   */
  getRequestSession(request: object, sessionId: string): Promise<LoginSession | null> {
    if (!SESSION_ID_FORMAT.test(sessionId)) return Promise.resolve(null);
    const cached = this.requestSessions.get(request);
    if (cached) return cached;
    const lookup = this.store.getSession(sessionId);
    this.requestSessions.set(request, lookup);
    lookup.catch(() => this.requestSessions.delete(request));
    return lookup;
  }

  /** Records what the auth layer resolved for this request (app.ts `resolveRequestAuth`). */
  setRequestAuth(request: object, context: RequestAuthContext): void {
    this.requestAuth.set(request, context);
  }

  /**
   * What the auth layer resolved for this request, or undefined when it has not authenticated it. Only app.ts
   * `resolveRequestAuth` records it (requireRole, requestIsAdmin and executeChannelFor go through it), so a check
   * that finds undefined must deny: the request was authenticated another way (or not at all), not "nothing to
   * check". The session row is the one read at the start of the request.
   */
  getRequestAuth(request: object): RequestAuthContext | undefined {
    return this.requestAuth.get(request);
  }
}
