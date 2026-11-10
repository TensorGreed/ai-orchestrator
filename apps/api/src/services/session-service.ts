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
import type { SafeUser } from "./auth-service.js";

export type { LoginSession, SessionAuthMethod, SessionEndReason };

/** Session IDs this server issues: `sess_` plus 24 to 64 URL-safe characters. Anything else cannot name a session. */
export const SESSION_ID_FORMAT = /^sess_[A-Za-z0-9_-]{24,64}$/;

/** The longest user agent kept on a session row; longer values are cut. */
export const SESSION_USER_AGENT_MAX = 512;

/** The longest address kept on a session row (an IPv4-mapped IPv6 address is 45 characters). */
export const SESSION_IP_MAX = 45;

/** A break-glass session never lives longer than this, whatever TTL the caller asks for. */
export const BREAK_GLASS_MAX_TTL_HOURS = 1;

/** The parts of a request a session records. Fastify's request satisfies it (`ip` honours TRUST_PROXY). */
export interface SessionRequestInfo {
  ip?: string;
  headers?: Record<string, unknown>;
}

export interface IssueSessionInput {
  user: Pick<SafeUser, "id">;
  method: SessionAuthMethod;
  /** Where the sign-in came from; leave it out for sessions minted outside a request. */
  request?: SessionRequestInfo;
  /** True when this sign-in passed an MFA check (local TOTP or IdP-asserted MFA): sets `mfa_verified_at` to now. */
  mfaVerified?: boolean;
  /**
   * Absolute lifetime in hours; defaults to the service's TTL (SESSION_TTL_HOURS). A `break_glass` session is capped
   * at BREAK_GLASS_MAX_TTL_HOURS.
   */
  ttlHours?: number;
}

export interface IssuedSession {
  session: LoginSession;
  sessionId: string;
  expiresAt: string;
}

/** What the auth layer resolved for one request. */
export type RequestAuthContext =
  | { credential: "session"; user: SafeUser; session: LoginSession }
  | { credential: "api_key"; user: SafeUser; apiKeyId: string; keyScopes: string[] };

/** Where the service reports housekeeping failures it carries on from (pino's `warn(object, message)` shape). */
export interface SessionServiceLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface SessionServiceOptions {
  ttlHours: number;
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

  constructor(
    private readonly store: Store,
    private readonly options: SessionServiceOptions
  ) {
    this.now = options.now ?? Date.now;
    this.log = options.log;
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
    const requested = input.ttlHours ?? this.options.ttlHours;
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
    return { session, sessionId: session.id, expiresAt: session.expiresAt };
  }

  /** Ends one session; false when it was already ended or does not exist. */
  async endSession(sessionId: string, reason: SessionEndReason): Promise<boolean> {
    if (!sessionId) return false;
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

  /** Records what the auth layer resolved for this request (called by requireRole). */
  setRequestAuth(request: object, context: RequestAuthContext): void {
    this.requestAuth.set(request, context);
  }

  /**
   * What the auth layer resolved for this request, or undefined when it has not authenticated it. Only requireRole
   * records it, so a check that finds undefined must deny: the request was authenticated another way (or not at
   * all), not "nothing to check". The session row is the one read at the start of the request.
   */
  getRequestAuth(request: object): RequestAuthContext | undefined {
    return this.requestAuth.get(request);
  }
}
