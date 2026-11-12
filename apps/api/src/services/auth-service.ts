import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { LoginSession, Store, StoredUserKind } from "../db/store.js";
import { SessionService, type SessionRejectReason, type SessionRequestInfo } from "./session-service.js";

export type UserRole = "admin" | "builder" | "operator" | "viewer";

export interface SafeUser {
  id: string;
  email: string;
  role: UserRole;
  /**
   * 13.2 — set only when the request is authenticated by an API key limited to projects (key-scopes.ts): the projects
   * it may reach. RBAC checks (rbacService.can) refuse every other project.
   */
  projectScope?: string[];
  /**
   * 13.2 — the API key the request was authenticated with. Work that runs later on this user's behalf (an approval
   * it decided, a queued run, an eval or replay job) records it, and runs again with that key's limits.
   */
  apiKeyId?: string;
  /** 13.2 — set when the user is a service account (acting through one of its keys): it is never an approver. */
  serviceAccount?: true;
}

/** 13.2 — a person, or a service account (a machine identity that only uses API keys). */
export type UserKind = StoredUserKind;

/** Service accounts get an email in this reserved domain (RFC 2606), so no person or SSO login can claim it. */
export const SERVICE_ACCOUNT_EMAIL_DOMAIN = "service.invalid";

export function isServiceAccountEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`);
}

/** The password hash a service account is stored with: not `salt:hash`, so no password ever matches it. */
export const UNUSABLE_PASSWORD_HASH = "!";

const validRoles: UserRole[] = ["admin", "builder", "operator", "viewer"];

function isValidRole(value: string): value is UserRole {
  return validRoles.includes(value as UserRole);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) {
    return false;
  }

  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "base64");

  if (candidate.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidate, expected);
}

export class AuthService {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly cleanupTasks: Array<() => Promise<unknown>> = [];
  /** 13.2 — issues every sign-in session and holds the per-request sign-in context. */
  readonly sessions: SessionService;

  constructor(
    private readonly store: Store,
    sessionTtlHours: number,
    sessions?: SessionService
  ) {
    this.sessions = sessions ?? new SessionService(store, { ttlHours: sessionTtlHours });
  }

  async countUsers(): Promise<number> {
    return await this.store.countUsers();
  }

  /**
   * Phase 13.1 — more best-effort cleanup for the session cleanup tick (cluster mode: expired pending challenges and
   * rate-limit windows). A task that fails is ignored until the next tick.
   */
  addCleanupTask(task: () => Promise<unknown>): void {
    this.cleanupTasks.push(task);
  }

  startSessionCleanup(intervalMs = 5 * 60 * 1000): void {
    if (this.cleanupTimer !== null) return;
    const tick = async () => {
      try {
        const result = await this.store.revokeExpiredSessions() as unknown;
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // best-effort background cleanup; ignore failures
      }
      for (const task of this.cleanupTasks) {
        await task().catch(() => undefined);
      }
    };
    // promise-ok: tick catches its own errors (best-effort cleanup)
    this.cleanupTimer = setInterval(tick, intervalMs);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  stopSessionCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private toSafeUser(user: { id: string; email: string; role: string }): SafeUser {
    return {
      id: user.id,
      email: user.email,
      role: isValidRole(user.role) ? user.role : "viewer"
    };
  }

  async register(input: { email: string; password: string; role: UserRole }): Promise<SafeUser> {
    const email = normalizeEmail(input.email);
    if (isServiceAccountEmail(email)) {
      throw new Error(`Emails in @${SERVICE_ACCOUNT_EMAIL_DOMAIN} are reserved for service accounts`);
    }
    const existing = await this.store.getUserByEmail(email);
    if (existing) {
      throw new Error("An account with this email already exists");
    }

    const saved = await this.store.saveUser({
      id: `usr_${nanoid(12)}`,
      email,
      passwordHash: hashPassword(input.password),
      role: input.role
    });

    return this.toSafeUser(saved);
  }

  /** Checks an email and password without issuing a session; throws "Invalid email or password" on a mismatch. */
  async verifyCredentials(emailInput: string, password: string): Promise<SafeUser> {
    const email = normalizeEmail(emailInput);
    const user = await this.store.getUserByEmail(email);
    // A service account never signs in (its hash matches no password; the kind check makes that explicit).
    if (!user || user.kind === "service" || !verifyPassword(password, user.passwordHash)) {
      throw new Error("Invalid email or password");
    }
    return this.toSafeUser(user);
  }

  /** Checks the password and issues a password session (no MFA step; the login route decides on MFA first). */
  async login(
    emailInput: string,
    password: string,
    request?: SessionRequestInfo
  ): Promise<{ user: SafeUser; sessionId: string; expiresAt: string }> {
    const user = await this.verifyCredentials(emailInput, password);
    const issued = await this.sessions.issueSession({ user, method: "password", request });
    return {
      user,
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt
    };
  }

  /**
   * The user and live session a session ID names, or why there is none. A session past its expiry or its role's
   * absolute timeout is ended here with reason `expired`, one past its idle timeout with `idle` (SESSION_* policy; the
   * user's current role applies). A live one records activity unless the request is background traffic.
   *
   * `knownSession` is the row a caller already looked up for this ID (`null`: it does not exist). Leave it out to
   * look the session up here.
   */
  async resolveSession(
    sessionId: string,
    knownSession?: LoginSession | null,
    options: { background?: boolean } = {}
  ): Promise<{ ok: true; user: SafeUser; session: LoginSession } | { ok: false; reason: SessionRejectReason }> {
    if (!sessionId) {
      return { ok: false, reason: "invalid" };
    }

    const session = knownSession === undefined ? await this.store.getSession(sessionId) : knownSession;
    if (!session) {
      return { ok: false, reason: "invalid" };
    }
    if (session.revokedAt) {
      return { ok: false, reason: session.endedReason ?? "invalid" };
    }

    const stored = await this.store.getUserById(session.userId);
    // 13.2 — service accounts have no sign-in sessions; a row naming one is not honoured.
    const user = stored && stored.kind !== "service" ? this.toSafeUser(stored) : null;
    const verdict = this.sessions.verdict(session, user?.role);
    if (verdict) {
      await this.sessions.endSession(session.id, verdict);
      return { ok: false, reason: verdict };
    }
    if (!user) {
      return { ok: false, reason: "invalid" };
    }

    await this.sessions.recordActivity(session.id, { background: options.background });
    return { ok: true, user, session };
  }

  /**
   * True when `sessionId` names a live session of an active user. A check only: unlike resolveSession it records no
   * activity and never ends a session that has run out (the request's own sign-in check does that).
   */
  async checkSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    const session = await this.store.getSession(sessionId);
    if (!session || session.revokedAt) return false;
    const stored = await this.store.getUserById(session.userId);
    const user = stored && stored.kind !== "service" ? this.toSafeUser(stored) : null;
    if (!user) return false;
    return this.sessions.verdict(session, user.role) === null;
  }

  /** The user and live session a session ID names, or null (see resolveSession). */
  async getSessionAuth(
    sessionId: string,
    knownSession?: LoginSession | null,
    options: { background?: boolean } = {}
  ): Promise<{ user: SafeUser; session: LoginSession } | null> {
    const resolved = await this.resolveSession(sessionId, knownSession, options);
    return resolved.ok ? { user: resolved.user, session: resolved.session } : null;
  }

  /** The signed-in user a session ID names (see resolveSession). */
  async getSessionUser(sessionId: string, knownSession?: LoginSession | null): Promise<SafeUser | null> {
    return (await this.getSessionAuth(sessionId, knownSession))?.user ?? null;
  }

  async logout(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    await this.sessions.endSession(sessionId, "logout");
  }

  async bootstrapAdmin(email?: string, password?: string): Promise<SafeUser | null> {
    if (!email || !password) {
      return null;
    }

    if (await this.store.countUsers() > 0) {
      return null;
    }

    return await this.register({
      email,
      password,
      role: "admin"
    });
  }
}

