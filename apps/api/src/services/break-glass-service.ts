/**
 * 13.2 — break-glass sign-in: the recovery path when no admin can sign in (a sole admin locked out, MFA lost, SSO
 * down). Someone with shell access to the server host runs `admin:break-glass --email <admin>`, which mints a
 * one-time link. The link opens a studio page with the token in its `#fragment` (never sent to a server, a proxy log
 * or a Referer); the page names the admin and, on a click, POSTs the token. So a link preview or a mail scanner that
 * fetches the link uses nothing. The POST gives that admin a session flagged `break_glass` that lives one hour, is
 * exempt from the sign-in policies (not from the network allowlists or its expiry), and has every request audited.
 * Each stage (issued, used, ended) raises the `auth.break_glass_used` alert on the notification channels; alerts are
 * bounded in time and never hold up the sign-in.
 *
 * The link is kept in `pending_challenges` through DbChallengeStore whatever the deployment: the command runs in
 * another process than the API, so an in-memory store would never see it. A consume is one atomic delete, so the link
 * works once across every instance. Only the sha256 of the token is stored; the payload is sealed with the master key.
 *
 * The end alert is claimed through the same table (kind `break_glass_session`, keyed by the session id), so logout,
 * the cleanup sweep and other instances send it once between them.
 */
import crypto from "node:crypto";
import { BREAK_GLASS_LINK_MINUTES, BREAK_GLASS_SIGN_IN_EVENT } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import type { AuditEventInput } from "./audit-service.js";
import type { ChallengeStore, DbChallengeStore } from "./challenge-store.js";
import type { NotificationEvent, NotifyResult } from "./notification-service.js";
import type { LoginSession, SessionRequestInfo, SessionService } from "./session-service.js";
import { BREAK_GLASS_MAX_TTL_HOURS } from "./session-service.js";

export { BREAK_GLASS_LINK_MINUTES };

/** A break-glass session lives exactly this long; it is never renewed. */
export const BREAK_GLASS_SESSION_HOURS = BREAK_GLASS_MAX_TTL_HOURS;

/** How long after the session's end its end-alert claim is kept, so a late sweep still finds it. */
const END_CLAIM_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The route the studio's confirm page POSTs `{ token }` to. */
export const BREAK_GLASS_ROUTE = "/api/auth/break-glass";

/** The fragment key of a link (`<public URL>/#break_glass=<token>&email=<admin>`). */
export const BREAK_GLASS_FRAGMENT_KEY = "break_glass";

/** How long one alert send may take (each channel); alerts never hold up a sign-in. */
export const BREAK_GLASS_ALERT_TIMEOUT_MS = 10_000;

/** How many end claims one sweep reads. */
const SWEEP_BATCH = 100;

/** Links are `bg_` plus 32 random bytes, base64url. Anything else is refused without a lookup. */
export const BREAK_GLASS_TOKEN_FORMAT = /^bg_[A-Za-z0-9_-]{43}$/;

const AUTH_EVENT = BREAK_GLASS_SIGN_IN_EVENT;

/** What a minted link carries (sealed in the database). */
interface BreakGlassLinkPayload {
  email: string;
  origin: string;
  issuedAt: string;
}

/** What the end-alert claim carries (sealed; keyed by the session id's hash). */
interface BreakGlassSessionClaim {
  sessionId: string;
  email: string;
  expiresAt: string;
}

export type BreakGlassRefusalCode = "unknown_user" | "not_admin" | "service_account";

export class BreakGlassRefusal extends Error {
  constructor(
    readonly code: BreakGlassRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "BreakGlassRefusal";
  }
}

type TargetUser = { id: string; email: string; role: string; kind?: string | null };

/**
 * Why `user` cannot receive a break-glass session, or null. Only human admins can: a service account (a user whose
 * `kind` is set to anything but `human`) never signs in through a browser.
 */
export function breakGlassTargetRefusal(user: TargetUser | null): BreakGlassRefusal | null {
  if (!user) return new BreakGlassRefusal("unknown_user", "No user has this email address.");
  // The stores read any kind but 'human' as a service account; a missing kind (an older caller) is a person.
  if (user.kind !== undefined && user.kind !== null && user.kind !== "human") {
    return new BreakGlassRefusal("service_account", "A service account cannot sign in through break-glass.");
  }
  if (user.role !== "admin") {
    return new BreakGlassRefusal("not_admin", `Break-glass signs in admins only; ${user.email} is ${user.role}.`);
  }
  return null;
}

/** `--minutes`: a whole number from 5 to 60; undefined gives the default (15). */
export function parseLinkMinutes(raw: string | undefined): number {
  if (raw === undefined) return BREAK_GLASS_LINK_MINUTES.default;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < BREAK_GLASS_LINK_MINUTES.min || value > BREAK_GLASS_LINK_MINUTES.max) {
    throw new Error(`--minutes must be a whole number from ${BREAK_GLASS_LINK_MINUTES.min} to ${BREAK_GLASS_LINK_MINUTES.max}, got '${raw}'`);
  }
  return value;
}

/** A short, non-reversible reference to a session for audit rows (the id itself is the cookie's credential). */
export function sessionReference(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 16);
}

export interface BreakGlassDeps {
  store: Pick<Store, "getUserByEmail" | "getUserById" | "getSession">;
  /** Always the database store (the link is minted by another process); `list` feeds the end sweep. */
  challenges: Pick<ChallengeStore, "issue" | "consume"> & Pick<DbChallengeStore, "list">;
  /** Records an audit event (the caller fills the actor when it has a request). */
  audit: (event: AuditEventInput) => Promise<void>;
  /** Sends the alert to the notification channels and says what happened (bounded in time, never throws). */
  notify: (event: NotificationEvent) => Promise<NotifyResult>;
  /** Where failures that do not stop the flow are reported. */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface MintedLink {
  link: string;
  token: string;
  expiresAt: string;
  user: TargetUser;
}

export type RedeemResult =
  | { ok: true; user: TargetUser; session: LoginSession; sessionId: string; expiresAt: string }
  | { ok: false; reason: "invalid" | "expired" | BreakGlassRefusalCode; user: TargetUser | null };

/** One line for the operator: who was alerted, or that nobody was. */
export function describeAlertResult(result: NotifyResult): string {
  if (result.matched === 0) {
    return "No notification channel receives auth.break_glass_used: nobody was alerted. Add one in Settings > Notifications (Break-glass sign-in) or with the NOTIFICATION_* settings.";
  }
  if (result.failures.length === 0) return `Alert sent to ${result.delivered} of ${result.matched} notification channel(s).`;
  const why = result.failures.map((failure) => `${failure.channel}: ${failure.error}`).join("; ");
  return `Alert delivery failed on ${result.failures.length} of ${result.matched} notification channel(s) (${why}).`;
}

export class BreakGlassService {
  constructor(private readonly deps: BreakGlassDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async alert(auth: NonNullable<NotificationEvent["auth"]>): Promise<NotifyResult> {
    return await this.deps.notify({ type: AUTH_EVENT, workflowId: "", workflowName: "", timestamp: new Date(this.now()).toISOString(), auth });
  }

  /**
   * Sends an alert in the background: the caller (a sign-in, a logout, the sweep) never waits on a channel. A failed
   * or unheard alert is logged; the audit row is the record either way. Returns the send, for tests.
   */
  private alertInBackground(auth: NonNullable<NotificationEvent["auth"]>): Promise<void> {
    const sending = this.alert(auth).then(
      (result) => {
        if (result.matched === 0 || result.failures.length > 0) this.deps.warn?.(`Break-glass ${auth.stage} alert: ${describeAlertResult(result)}`, { stage: auth.stage });
      },
      (error: unknown) => {
        this.deps.warn?.("Break-glass alert could not be sent", { stage: auth.stage, error: error instanceof Error ? error.message : String(error) });
      }
    );
    this.pendingAlerts.add(sending);
    // promise-ok: removing a settled send from the test seam set cannot fail
    void sending.finally(() => this.pendingAlerts.delete(sending));
    return sending;
  }

  private readonly pendingAlerts = new Set<Promise<void>>();

  /** Test seam: waits for the alerts sent in the background so far. */
  async settleAlerts(): Promise<void> {
    await Promise.all([...this.pendingAlerts]);
  }

  /**
   * Mints a one-time link for an admin (the command on the host). Audits `auth.break_glass_issued`; the alert is the
   * caller's to send (`sendIssuedAlert`), so the command can report what happened and still print the link.
   */
  async mintLink(input: { email: string; minutes: number; origin: string; baseUrl: string }): Promise<MintedLink> {
    const email = input.email.trim().toLowerCase();
    const stored = await this.deps.store.getUserByEmail(email);
    const refusal = breakGlassTargetRefusal(stored);
    if (refusal) {
      await this.deps.audit({
        category: "auth",
        eventType: "auth.break_glass_issued",
        action: "issue",
        outcome: "denied",
        actor: { type: "system" },
        metadata: { email, reason: refusal.code, origin: input.origin }
      });
      throw refusal;
    }
    const user: TargetUser = { id: stored!.id, email: stored!.email, role: stored!.role };
    const minutes = Math.min(Math.max(input.minutes, BREAK_GLASS_LINK_MINUTES.min), BREAK_GLASS_LINK_MINUTES.max);
    const token = `bg_${crypto.randomBytes(32).toString("base64url")}`;
    const issuedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + minutes * 60_000).toISOString();
    await this.deps.challenges.issue<BreakGlassLinkPayload>({
      kind: "break_glass",
      id: token,
      userId: user.id,
      payload: { email: user.email, origin: input.origin, issuedAt },
      ttlMs: minutes * 60_000
    });
    await this.deps.audit({
      category: "auth",
      eventType: "auth.break_glass_issued",
      action: "issue",
      outcome: "success",
      actor: { type: "system" },
      resourceType: "user",
      resourceId: user.id,
      metadata: { email: user.email, origin: input.origin, minutes, expiresAt }
    });
    // The token rides in the fragment: browsers never send it to a server, a proxy log or a Referer.
    const fragment = new URLSearchParams({ [BREAK_GLASS_FRAGMENT_KEY]: token, email: user.email }).toString();
    return { link: `${input.baseUrl.replace(/\/+$/, "")}/#${fragment}`, token, expiresAt, user };
  }

  /** The "link issued" alert, awaited (bounded by the notifier), so the command can say who was alerted. */
  async sendIssuedAlert(minted: MintedLink, origin: string): Promise<NotifyResult> {
    return await this.alert({ stage: "issued", email: minted.user.email, userId: minted.user.id, origin, expiresAt: minted.expiresAt });
  }

  /**
   * Opens a link (the confirm page's POST): takes it out (once, across every instance), checks the admin again,
   * issues the one-hour session and records the claim for its end alert. Audits the use (a refusal, or a failure
   * after the link was taken, as a failure row); the alert goes out in the background.
   */
  async redeem(
    token: string,
    request: SessionRequestInfo,
    sessions: SessionService,
    actor: { ipAddress: string | null; userAgent: string | null }
  ): Promise<RedeemResult> {
    const refuse = async (reason: Exclude<RedeemResult, { ok: true }>["reason"], user: TargetUser | null): Promise<RedeemResult> => {
      await this.deps.audit({
        category: "auth",
        eventType: "auth.break_glass_used",
        action: "login",
        outcome: reason === "invalid" || reason === "expired" ? "failure" : "denied",
        actor: { type: user ? "user" : "system", userId: user?.id ?? null, email: user?.email ?? null, ...actor },
        ...(user ? { resourceType: "user", resourceId: user.id } : {}),
        metadata: { reason }
      });
      return { ok: false, reason, user };
    };
    if (!BREAK_GLASS_TOKEN_FORMAT.test(token)) return await refuse("invalid", null);
    const entry = await this.deps.challenges.consume<BreakGlassLinkPayload>("break_glass", token);
    if (!entry || !entry.userId) return await refuse("invalid", null);

    // From here the link is spent: anything that fails is recorded as a failed use before it is rethrown.
    let user: TargetUser | null = null;
    try {
      const stored = await this.deps.store.getUserById(entry.userId);
      user = stored ? { id: stored.id, email: stored.email, role: stored.role } : null;
      if (entry.expired) return await refuse("expired", user);
      // The account may have changed since the link was minted (demoted, deleted, turned into a service account).
      const refusal = breakGlassTargetRefusal(stored);
      if (refusal) return await refuse(refusal.code, user);
      const target = user!;

      // breakGlassTargetRefusal let only an admin through, so the session is issued for the admin role.
      const issued = await sessions.issueSession({
        user: { id: target.id, role: "admin" },
        method: "break_glass",
        request,
        ttlHours: BREAK_GLASS_SESSION_HOURS
      });
      const lifetimeMs = new Date(issued.expiresAt).getTime() - this.now();
      try {
        await this.deps.challenges.issue<BreakGlassSessionClaim>({
          kind: "break_glass_session",
          id: issued.sessionId,
          userId: target.id,
          payload: { sessionId: issued.sessionId, email: target.email, expiresAt: issued.expiresAt },
          ttlMs: Math.max(0, lifetimeMs) + END_CLAIM_GRACE_MS
        });
      } catch (error) {
        // Without the claim only the end alert is lost; the session and its audit trail stand.
        this.deps.warn?.("Break-glass end-alert claim not stored", { error: error instanceof Error ? error.message : String(error) });
      }
      await this.deps.audit({
        category: "auth",
        eventType: "auth.break_glass_used",
        action: "login",
        outcome: "success",
        actor: { type: "user", userId: target.id, email: target.email, ...actor },
        resourceType: "user",
        resourceId: target.id,
        metadata: { sessionRef: sessionReference(issued.sessionId), expiresAt: issued.expiresAt, origin: entry.payload.origin, issuedAt: entry.payload.issuedAt }
      });
      // promise-ok: alertInBackground handles its own failures; the sign-in does not wait for the channels
      void this.alertInBackground({ stage: "used", email: target.email, userId: target.id, ipAddress: actor.ipAddress, expiresAt: issued.expiresAt });
      return { ok: true, user: target, session: issued.session, sessionId: issued.sessionId, expiresAt: issued.expiresAt };
    } catch (error) {
      await this.deps
        .audit({
          category: "auth",
          eventType: "auth.break_glass_used",
          action: "login",
          outcome: "failure",
          actor: { type: user ? "user" : "system", userId: user?.id ?? entry.userId, email: user?.email ?? null, ...actor },
          resourceType: "user",
          resourceId: entry.userId,
          metadata: { reason: "error", error: error instanceof Error ? error.message : String(error) }
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * The end of a break-glass session (logout, expiry, ended by an admin): audits `auth.break_glass_ended` and alerts
   * (in the background), once across every caller and instance. False when the end was already reported (or the
   * session was not one).
   */
  async reportEnded(session: Pick<LoginSession, "id" | "userId" | "endedReason">, reason?: string): Promise<boolean> {
    const claim = await this.deps.challenges.consume<BreakGlassSessionClaim>("break_glass_session", session.id);
    if (!claim) return false;
    const why = reason ?? session.endedReason ?? "expired";
    const stored = await this.deps.store.getUserById(session.userId);
    const email = stored?.email ?? claim.payload.email;
    await this.deps.audit({
      category: "auth",
      eventType: "auth.break_glass_ended",
      action: "logout",
      outcome: "success",
      actor: { type: "system" },
      resourceType: "user",
      resourceId: session.userId,
      metadata: { sessionRef: sessionReference(session.id), reason: why, email }
    });
    // promise-ok: alertInBackground handles its own failures; the caller does not wait for the channels
    void this.alertInBackground({ stage: "ended", email, userId: session.userId, reason: why });
    return true;
  }

  /**
   * Cleanup sweep: reads the end claims (at most SWEEP_BATCH, oldest first; one indexed query on the claims' kind,
   * nothing when break-glass was never used) and reports each session that has ended: revoked, past its expiry, or
   * already deleted. Returns how many were reported.
   */
  async sweepEnded(): Promise<number> {
    const now = this.now();
    let reported = 0;
    for (const claim of await this.deps.challenges.list<BreakGlassSessionClaim>("break_glass_session", SWEEP_BATCH)) {
      const sessionId = claim.payload.sessionId;
      if (!sessionId || !claim.userId) continue;
      const session = await this.deps.store.getSession(sessionId);
      const expired = new Date(session?.expiresAt ?? claim.payload.expiresAt).getTime() <= now;
      if (session && session.revokedAt === null && !expired) continue;
      // A row already deleted (an admin purge) before its expiry counts as ended.
      const reason = session?.revokedAt ? (session.endedReason ?? "ended") : expired ? "expired" : "ended";
      if (await this.reportEnded({ id: sessionId, userId: claim.userId, endedReason: session?.endedReason ?? null }, reason)) reported += 1;
    }
    return reported;
  }
}
