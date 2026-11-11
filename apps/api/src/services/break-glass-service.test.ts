/**
 * 13.2 — break-glass sign-in on the store under test (TEST_STORE): minting, single use, expiry, refusals, the end
 * alert sent once, and the cleanup sweep.
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BREAK_GLASS_SIGN_IN_EVENT } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import { testSql } from "../test-support/test-sql.js";
import type { AuditEventInput } from "./audit-service.js";
import { AuthService } from "./auth-service.js";
import {
  BREAK_GLASS_TOKEN_FORMAT,
  BreakGlassRefusal,
  BreakGlassService,
  breakGlassTargetRefusal,
  describeAlertResult,
  parseLinkMinutes,
  sessionReference
} from "./break-glass-service.js";
import { DbChallengeStore } from "./challenge-store.js";
import { AUTH_NOTIFICATION_EVENTS, type NotificationEvent, type NotifyResult } from "./notification-service.js";
import { SecretService } from "./secret-service.js";
import { isPolicyExempt, SessionService } from "./session-service.js";

const opened: TestStore[] = [];

afterEach(async () => {
  for (const test of opened.splice(0)) await test.cleanup();
});

interface Harness {
  store: Store;
  service: BreakGlassService;
  sessions: SessionService;
  audits: AuditEventInput[];
  alerts: NotificationEvent[];
  clock: { now: number };
}

const DELIVERED: NotifyResult = { matched: 1, delivered: 1, failures: [] };

async function harness(options: { notify?: (event: NotificationEvent) => Promise<NotifyResult> } = {}): Promise<Harness> {
  const test = await createTestStore();
  opened.push(test);
  const store = test.store;
  const secrets = new SecretService(store, crypto.randomBytes(32).toString("base64"));
  const audits: AuditEventInput[] = [];
  const alerts: NotificationEvent[] = [];
  const clock = { now: Date.now() };
  const service = new BreakGlassService({
    store,
    challenges: new DbChallengeStore(store, secrets),
    audit: async (event) => {
      audits.push(event);
    },
    notify:
      options.notify ??
      (async (event) => {
        alerts.push(event);
        return DELIVERED;
      }),
    now: () => clock.now
  });
  return { store, service, sessions: new SessionService(store, { ttlHours: 24 }), audits, alerts, clock };
}

const request = { ip: "203.0.113.9", headers: { "user-agent": "Browser/1.0" } };
const actor = { ipAddress: "203.0.113.9", userAgent: "Browser/1.0" };

async function admin(store: Store, email = "root@example.com") {
  return await new AuthService(store, 24).register({ email, password: "Root-Pass-123!", role: "admin" });
}

describe("break-glass links", () => {
  it("mints a single-use link that opens a one-hour break-glass session", async () => {
    const h = await harness();
    const user = await admin(h.store);
    const minted = await h.service.mintLink({ email: "ROOT@example.com ", minutes: 15, origin: "ops@host", baseUrl: "https://l2m.example.com/" });
    expect(minted.token).toMatch(BREAK_GLASS_TOKEN_FORMAT);
    // The token rides in the fragment, which browsers never send to a server.
    expect(minted.link).toBe(`https://l2m.example.com/#break_glass=${minted.token}&email=root%40example.com`);
    expect(new Date(minted.expiresAt).getTime() - h.clock.now).toBe(15 * 60_000);
    expect(h.audits).toEqual([
      expect.objectContaining({ eventType: "auth.break_glass_issued", outcome: "success", resourceId: user.id, metadata: expect.objectContaining({ origin: "ops@host", minutes: 15 }) })
    ]);
    // Only the hash is stored: the token appears nowhere in the table.
    const rows = await testSql(h.store).all<Record<string, unknown>>(`SELECT * FROM pending_challenges`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(minted.token);

    expect(await h.service.sendIssuedAlert(minted, "ops@host")).toEqual(DELIVERED);
    expect(h.alerts[0]).toMatchObject({ type: BREAK_GLASS_SIGN_IN_EVENT, auth: { stage: "issued", email: "root@example.com", origin: "ops@host" } });
    expect(JSON.stringify(h.alerts)).not.toContain(minted.token);

    const result = await h.service.redeem(minted.token, request, h.sessions, actor);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await h.store.getSession(result.sessionId);
    expect(row).toMatchObject({ userId: user.id, authMethod: "break_glass", breakGlass: true, ipAddress: "203.0.113.9" });
    const lifetime = new Date(row!.expiresAt).getTime() - new Date(row!.createdAt).getTime();
    expect(Math.abs(lifetime - 60 * 60_000)).toBeLessThan(5_000);
    expect(isPolicyExempt(row)).toBe(true);
    expect(h.audits.at(-1)).toMatchObject({ eventType: "auth.break_glass_used", outcome: "success", metadata: { sessionRef: sessionReference(result.sessionId) } });
    expect(JSON.stringify(h.audits)).not.toContain(result.sessionId);
    await h.service.settleAlerts();
    expect(h.alerts.at(-1)).toMatchObject({ auth: { stage: "used", ipAddress: "203.0.113.9", expiresAt: result.expiresAt } });

    // Single use.
    expect(await h.service.redeem(minted.token, request, h.sessions, actor)).toMatchObject({ ok: false, reason: "invalid" });
    expect(h.audits.at(-1)).toMatchObject({ eventType: "auth.break_glass_used", outcome: "failure", metadata: { reason: "invalid" } });
  });

  it("refuses an expired link, a malformed token, and a link whose admin was demoted meanwhile", async () => {
    const h = await harness();
    const user = await admin(h.store);
    const expired = await h.service.mintLink({ email: user.email, minutes: 5, origin: "o", baseUrl: "http://x" });
    await testSql(h.store).run(`UPDATE pending_challenges SET expires_at = ? WHERE kind = 'break_glass'`, "2000-01-01T00:00:00.000Z");
    expect(await h.service.redeem(expired.token, request, h.sessions, actor)).toMatchObject({ ok: false, reason: "expired" });
    expect(await h.service.redeem("bg_short", request, h.sessions, actor)).toMatchObject({ ok: false, reason: "invalid" });

    const demoted = await h.service.mintLink({ email: user.email, minutes: 5, origin: "o", baseUrl: "http://x" });
    const stored = (await h.store.getUserById(user.id))!;
    await h.store.saveUser({ ...stored, role: "builder" });
    expect(await h.service.redeem(demoted.token, request, h.sessions, actor)).toMatchObject({ ok: false, reason: "not_admin" });
    expect(await h.store.listUserSessions(user.id)).toEqual([]);
  });

  it("refuses unknown users, non-admins and service accounts when minting, and audits the refusal", async () => {
    const h = await harness();
    await new AuthService(h.store, 24).register({ email: "dev@example.com", password: "Dev-Pass-123!", role: "builder" });
    await expect(h.service.mintLink({ email: "nobody@example.com", minutes: 15, origin: "o", baseUrl: "http://x" })).rejects.toMatchObject({ code: "unknown_user" });
    await expect(h.service.mintLink({ email: "dev@example.com", minutes: 15, origin: "o", baseUrl: "http://x" })).rejects.toBeInstanceOf(BreakGlassRefusal);
    expect(h.audits.map((event) => [event.eventType, event.outcome, (event.metadata as { reason: string }).reason])).toEqual([
      ["auth.break_glass_issued", "denied", "unknown_user"],
      ["auth.break_glass_issued", "denied", "not_admin"]
    ]);
    expect(await testSql(h.store).all(`SELECT id_hash FROM pending_challenges`)).toEqual([]);
    expect(breakGlassTargetRefusal({ id: "u", email: "bot@x.invalid", role: "admin", kind: "service" } as never)?.code).toBe("service_account");
    expect(breakGlassTargetRefusal({ id: "u", email: "a@x", role: "admin", kind: "human" } as never)).toBeNull();
  });

  it("a failing or hanging alert channel never holds up the sign-in", async () => {
    let release: (() => void) | undefined;
    const warnings: string[] = [];
    const test = await createTestStore();
    opened.push(test);
    const secrets = new SecretService(test.store, crypto.randomBytes(32).toString("base64"));
    const service = new BreakGlassService({
      store: test.store,
      challenges: new DbChallengeStore(test.store, secrets),
      audit: async () => undefined,
      // The used alert hangs until released: redeem must return before it settles.
      notify: (event) =>
        event.auth?.stage === "issued"
          ? Promise.reject(new Error("channel down"))
          : new Promise<NotifyResult>((resolve) => (release = () => resolve({ matched: 1, delivered: 0, failures: [{ channel: "slack", error: "HTTP 404" }] }))),
      warn: (message) => warnings.push(message)
    });
    await admin(test.store);
    const minted = await service.mintLink({ email: "root@example.com", minutes: 15, origin: "o", baseUrl: "http://x" });
    await expect(service.sendIssuedAlert(minted, "o")).rejects.toThrow("channel down");
    expect((await service.redeem(minted.token, request, new SessionService(test.store, { ttlHours: 24 }), actor)).ok).toBe(true);
    expect(release).toBeDefined();
    release!();
    await service.settleAlerts();
    expect(warnings.join("\n")).toMatch(/used alert: Alert delivery failed on 1 of 1 notification channel\(s\) \(slack: HTTP 404\)/);
  });

  it("a failure after the link was taken is audited as a failed use, and the link stays spent", async () => {
    const h = await harness();
    await admin(h.store);
    const minted = await h.service.mintLink({ email: "root@example.com", minutes: 15, origin: "o", baseUrl: "http://x" });
    const broken = { issueSession: async () => Promise.reject(new Error("database is locked")) } as unknown as SessionService;
    await expect(h.service.redeem(minted.token, request, broken, actor)).rejects.toThrow("database is locked");
    expect(h.audits.at(-1)).toMatchObject({ eventType: "auth.break_glass_used", outcome: "failure", metadata: { reason: "error", error: "database is locked" } });
    expect(await h.service.redeem(minted.token, request, h.sessions, actor)).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("the end of a break-glass session", () => {
  it("is reported once, whether by logout or by the sweep", async () => {
    const h = await harness();
    await admin(h.store);
    const minted = await h.service.mintLink({ email: "root@example.com", minutes: 15, origin: "o", baseUrl: "http://x" });
    const result = await h.service.redeem(minted.token, request, h.sessions, actor);
    if (!result.ok) throw new Error("redeem failed");

    // Live: the sweep leaves it alone.
    expect(await h.service.sweepEnded()).toBe(0);
    await h.sessions.endSession(result.sessionId, "logout");
    const ended = (await h.store.getSession(result.sessionId))!;
    expect(await h.service.reportEnded(ended, "logout")).toBe(true);
    expect(await h.service.reportEnded(ended, "logout")).toBe(false);
    expect(await h.service.sweepEnded()).toBe(0);
    await h.service.settleAlerts();
    expect(h.alerts.filter((event) => event.auth?.stage === "ended")).toEqual([expect.objectContaining({ auth: expect.objectContaining({ reason: "logout" }) })]);
    expect(h.audits.filter((event) => event.eventType === "auth.break_glass_ended")).toHaveLength(1);
  });

  it("an expired session is reported by the sweep; two sweeps report it once", async () => {
    const h = await harness();
    await admin(h.store);
    const passwordSession = await h.sessions.issueSession({ user: { id: (await h.store.getUserByEmail("root@example.com"))!.id }, method: "password" });
    const minted = await h.service.mintLink({ email: "root@example.com", minutes: 15, origin: "o", baseUrl: "http://x" });
    const result = await h.service.redeem(minted.token, request, h.sessions, actor);
    if (!result.ok) throw new Error("redeem failed");
    h.clock.now += 61 * 60_000;
    const [first, second] = await Promise.all([h.service.sweepEnded(), h.service.sweepEnded()]);
    expect(first + second).toBe(1);
    await h.service.settleAlerts();
    expect(h.alerts.filter((event) => event.auth?.stage === "ended")).toEqual([expect.objectContaining({ auth: expect.objectContaining({ reason: "expired" }) })]);
    // A session that is not break-glass is never reported.
    expect(await h.service.reportEnded({ ...passwordSession.session, endedReason: null })).toBe(false);
  });
});

describe("the end sweep reads its claims", () => {
  it("reports a session whose admin was demoted, and one whose row is gone; nothing when break-glass was never used", async () => {
    const h = await harness();
    expect(await h.service.sweepEnded()).toBe(0);
    const user = await admin(h.store);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const minted = await h.service.mintLink({ email: user.email, minutes: 15, origin: "o", baseUrl: "http://x" });
      const result = await h.service.redeem(minted.token, request, h.sessions, actor);
      if (!result.ok) throw new Error("redeem failed");
      ids.push(result.sessionId);
    }
    const stored = (await h.store.getUserById(user.id))!;
    await h.store.saveUser({ ...stored, role: "viewer" });
    await h.sessions.endSession(ids[0]!, "admin");
    await testSql(h.store).run(`DELETE FROM sessions WHERE id = ?`, ids[1]!);
    expect(await h.service.sweepEnded()).toBe(2);
    expect(await h.service.sweepEnded()).toBe(0);
    await h.service.settleAlerts();
    expect(h.alerts.filter((event) => event.auth?.stage === "ended").map((event) => event.auth?.reason).sort()).toEqual(["admin", "ended"]);
  });
});

describe("helpers", () => {
  it("parses --minutes within 5 to 60", () => {
    expect(parseLinkMinutes(undefined)).toBe(15);
    expect(parseLinkMinutes("5")).toBe(5);
    expect(parseLinkMinutes("60")).toBe(60);
    for (const bad of ["4", "61", "1.5", "x", ""]) expect(() => parseLinkMinutes(bad)).toThrow(/--minutes/);
  });

  it("the alert event is the shared name and reaches env channels", () => {
    expect(AUTH_NOTIFICATION_EVENTS).toEqual([BREAK_GLASS_SIGN_IN_EVENT]);
  });

  it("says plainly when nobody was alerted or a send failed", () => {
    expect(describeAlertResult({ matched: 0, delivered: 0, failures: [] })).toMatch(/^No notification channel receives auth\.break_glass_used: nobody was alerted\./);
    expect(describeAlertResult({ matched: 2, delivered: 2, failures: [] })).toBe("Alert sent to 2 of 2 notification channel(s).");
    expect(describeAlertResult({ matched: 2, delivered: 1, failures: [{ channel: "teams", error: "Teams webhook answered HTTP 500" }] })).toBe(
      "Alert delivery failed on 1 of 2 notification channel(s) (teams: Teams webhook answered HTTP 500)."
    );
  });
});
