/**
 * 13.2 — credential.expiring: which keys and gateway clients are announced, at most once a day each, only on the
 * leader and only when a channel listens; and how the alert reads. The sweep runs on SQLite and, with
 * TEST_POSTGRES_URL, on Postgres (including two instances sweeping at once).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_EXPIRING_EVENT, NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENT_TYPES, daysUntilExpiry } from "@ai-orchestrator/shared";
import { parseConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore } from "../test-support/test-store.js";
import { CredentialExpiryService } from "./credential-expiry-service.js";
import { NotificationService, type NotificationEvent } from "./notification-service.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const kinds = testPostgresUrl() ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
if (!testPostgresUrl()) noticePostgresSkipped("credential expiry sweep");

const opened: TestStore[] = [];
const extra: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (extra.length > 0) await extra.pop()!.close();
  while (opened.length > 0) await opened.pop()!.cleanup();
});

async function seed(store: Store, now: number) {
  await store.saveUser({ id: "u1", email: "ana@example.com", passwordHash: "h", role: "builder" });
  await store.createServiceAccount({ id: "svc1", email: "ci+0@service.invalid", role: "operator", description: null, createdBy: "u1" });
  const at = (ms: number) => new Date(now + ms).toISOString();
  await store.saveApiKey({ id: "soon", userId: "u1", name: "deploy", keyPrefix: "ao_soon", keyHash: "h", expiresAt: at(3 * DAY) });
  await store.saveApiKey({ id: "later", userId: "u1", name: "later", keyPrefix: "ao_later", keyHash: "h", expiresAt: at(30 * DAY) });
  await store.saveApiKey({ id: "never", userId: "u1", name: "never", keyPrefix: "ao_never", keyHash: "h" });
  await store.saveApiKey({ id: "gone", userId: "u1", name: "gone", keyPrefix: "ao_gone", keyHash: "h", expiresAt: at(-HOUR) });
  await store.saveApiKey({ id: "revoked", userId: "u1", name: "revoked", keyPrefix: "ao_rev", keyHash: "h", expiresAt: at(DAY) });
  await store.revokeApiKey("revoked");
  await store.saveApiKey({ id: "svckey", userId: "svc1", name: "ci", keyPrefix: "ao_svc", keyHash: "h", expiresAt: at(6 * DAY) });
  // Two rotated keys in their grace window: one still used after the rotation, one not.
  for (const id of ["used", "idle"]) {
    await store.saveApiKey({ id, userId: "u1", name: id, keyPrefix: `ao_${id}`, keyHash: "h" });
    await store.rotateApiKey({
      id,
      userId: "u1",
      next: { id: `${id}2`, keyPrefix: `ao_${id}2`, keyHash: "h2", expiresAt: null },
      graceUntil: at(10 * HOUR),
      now: at(-2 * HOUR)
    });
  }
  await store.touchApiKey("used");
  await store.createMcpClient({ id: "c1", name: "agent", tokenPrefix: "l2m_mcp_a", tokenHash: "h", toolsetIds: [], role: "viewer", createdBy: "u1", createdByEmail: "ana@example.com", expiresAt: at(2 * DAY) });
  await store.createMcpClient({ id: "c2", name: "other", tokenPrefix: "l2m_mcp_b", tokenHash: "h", toolsetIds: [], role: "viewer", createdBy: null, createdByEmail: null, expiresAt: null });
}

describe.each(kinds)("credential expiry sweep [%s]", (kind) => {
  it("announces keys and clients expiring within 7 days and old keys still in use, once a day each", async () => {
    const test = await createTestStore({ kind });
    opened.push(test);
    const now = Date.now();
    await seed(test.store, now);
    const sent: NotificationEvent[] = [];
    let leader = true;
    let listening = false;
    const service = new CredentialExpiryService({
      store: test.store,
      notify: async (event) => {
        sent.push(event);
      },
      subscribed: async () => listening,
      isLeader: () => leader
    });

    const due = await service.due(new Date(now));
    expect(due.map((warning) => `${warning.kind}:${warning.id}:${warning.reason}`).sort()).toEqual([
      "api_key:soon:expiry",
      "api_key:used:rotation_grace",
      "mcp_client:c1:expiry",
      "service_account_key:svckey:expiry"
    ]);
    expect(due.find((warning) => warning.id === "soon")).toMatchObject({ name: "deploy", prefix: "ao_soon", owner: "ana@example.com" });
    expect(due.find((warning) => warning.id === "c1")).toMatchObject({ prefix: "l2m_mcp_a", owner: "ana@example.com" });

    // No channel listens: nothing is claimed or sent, so a channel added later still hears about these.
    expect(await service.sweep(new Date(now))).toBe(0);
    listening = true;
    // Not the leader: nothing.
    leader = false;
    expect(await service.sweep(new Date(now))).toBe(0);
    leader = true;
    expect(await service.sweep(new Date(now))).toBe(4);
    expect(sent.every((event) => event.type === CREDENTIAL_EXPIRING_EVENT)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("keyHash");
    // An hour later: nothing again. A day later: each is announced once more.
    expect(await service.sweep(new Date(now + HOUR))).toBe(0);
    expect(await service.sweep(new Date(now + DAY + HOUR))).toBeGreaterThanOrEqual(3);
  });

  it("two instances sweeping at once send each warning once", async () => {
    const test = await createTestStore({ kind });
    opened.push(test);
    const now = Date.now();
    await seed(test.store, now);
    const twin = kind === "postgres" ? await openTestStoreTwin(test) : test.store;
    if (twin !== test.store) extra.push(twin);
    const sent: string[] = [];
    const make = (store: Store) =>
      new CredentialExpiryService({
        store,
        notify: async (event) => {
          sent.push(event.credential!.id);
        },
        subscribed: async () => true,
        isLeader: () => true
      });
    const counts = await Promise.all([make(test.store).sweep(new Date(now)), make(twin).sweep(new Date(now))]);
    expect(counts[0]! + counts[1]!).toBe(4);
    expect(sent.sort()).toEqual(["c1", "soon", "svckey", "used"]);
  });
});

describe("credential.expiring alert", () => {
  const event = (overrides: Partial<NonNullable<NotificationEvent["credential"]>> = {}): NotificationEvent => ({
    type: CREDENTIAL_EXPIRING_EVENT,
    workflowId: "",
    workflowName: "",
    timestamp: "2026-11-10T10:00:00.000Z",
    credential: { kind: "api_key", reason: "expiry", id: "apk_1", name: "deploy", prefix: "ao_abc", expiresAt: "2026-11-13T10:00:00.000Z", owner: "ana@example.com", ...overrides }
  });

  function capture(): Array<{ url: string; body: string }> {
    const sent: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      sent.push({ url, body: init.body });
      return new Response("ok", { status: 200 });
    });
    return sent;
  }

  it("reaches environment channels only with NOTIFICATIONS_CREDENTIAL_EVENTS=true", async () => {
    const env = { NOTIFICATIONS_ENABLED: "true", NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.test/a" };
    const sent = capture();
    const quiet = new NotificationService(parseConfig(env), () => []);
    expect(await quiet.subscribes(CREDENTIAL_EXPIRING_EVENT)).toBe(false);
    await quiet.notify(event());
    expect(sent).toHaveLength(0);

    const on = new NotificationService(parseConfig({ ...env, NOTIFICATIONS_CREDENTIAL_EVENTS: "true" }), () => []);
    expect(await on.subscribes(CREDENTIAL_EXPIRING_EVENT)).toBe(true);
    await on.notify(event());
    await on.notify(event({ kind: "mcp_client", name: "agent", prefix: "l2m_mcp_x", reason: "expiry" }));
    await on.notify(event({ reason: "rotation_grace" }));
    const texts = sent.map((entry) => (JSON.parse(entry.body) as { text: string }).text);
    expect(texts[0]).toMatch(/API key expiring: deploy/);
    expect(texts[0]).toMatch(/ao_abc/);
    expect(texts[0]).toMatch(/ana@example.com/);
    expect(texts[1]).toMatch(/Gateway client expiring: agent/);
    expect(texts[2]).toMatch(/Rotated key still in use: deploy/);
  });

  it("a channel made in the settings receives it once it picks the event", async () => {
    const sent = capture();
    const service = new NotificationService(parseConfig({}), () => [
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/c" }, events: [CREDENTIAL_EXPIRING_EVENT] }
    ]);
    expect(await service.subscribes(CREDENTIAL_EXPIRING_EVENT)).toBe(true);
    await service.notify(event());
    expect(sent).toHaveLength(1);
  });

  it("the settings picker offers it", () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain(CREDENTIAL_EXPIRING_EVENT);
    expect(NOTIFICATION_EVENT_LABELS[CREDENTIAL_EXPIRING_EVENT]).toBe("Credential expiring");
  });

  it("daysUntilExpiry counts whole days and ignores past or missing dates", () => {
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    expect(daysUntilExpiry("2026-11-13T12:00:00.000Z", now)).toBe(3);
    expect(daysUntilExpiry("2026-11-10T05:00:00.000Z", now)).toBe(0);
    expect(daysUntilExpiry("2026-11-09T00:00:00.000Z", now)).toBeNull();
    expect(daysUntilExpiry(null, now)).toBeNull();
  });
});
