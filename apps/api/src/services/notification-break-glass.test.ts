/**
 * 13.2 — the break-glass sign-in alert: channels set in the environment receive it by default, a channel made in the
 * settings receives it once it picks the event, and the message names the stage and the admin (never a link).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BREAK_GLASS_NOTIFICATION_OPTIONS, BREAK_GLASS_SIGN_IN_EVENT } from "@ai-orchestrator/shared";
import { parseConfig } from "../config.js";
import { NotificationService, type NotificationEvent } from "./notification-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(status: (url: string) => number = () => 200): Array<{ url: string; body: string }> {
  const sent: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    sent.push({ url, body: init.body });
    return new Response("ok", { status: status(url) });
  });
  return sent;
}

const event = (stage: "issued" | "used" | "ended"): NotificationEvent => ({
  type: BREAK_GLASS_SIGN_IN_EVENT,
  workflowId: "",
  workflowName: "",
  timestamp: "2026-11-09T10:00:00.000Z",
  auth: {
    stage,
    email: "root@example.com",
    userId: "usr_1",
    ...(stage === "issued" ? { origin: "ops@host (admin:break-glass)", expiresAt: "2026-11-09T10:15:00.000Z" } : {}),
    ...(stage === "used" ? { ipAddress: "203.0.113.9", expiresAt: "2026-11-09T11:00:00.000Z" } : {}),
    ...(stage === "ended" ? { reason: "logout" } : {})
  }
});

describe("break-glass sign-in alerts", () => {
  it("reach the Slack and Teams channels set in the environment by default", async () => {
    const sent = capture();
    const config = parseConfig({
      NOTIFICATIONS_ENABLED: "true",
      NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.test/a",
      NOTIFICATION_TEAMS_WEBHOOK_URL: "https://teams.test/b"
    });
    const service = new NotificationService(config, () => []);
    await service.notify(event("issued"));
    await service.notify(event("used"));
    await service.notify(event("ended"));
    expect(sent.map((entry) => entry.url)).toEqual([
      "https://hooks.slack.test/a",
      "https://teams.test/b",
      "https://hooks.slack.test/a",
      "https://teams.test/b",
      "https://hooks.slack.test/a",
      "https://teams.test/b"
    ]);
    const slack = sent.filter((entry) => entry.url.includes("slack")).map((entry) => (JSON.parse(entry.body) as { text: string }).text);
    expect(slack[0]).toMatch(/Break-glass sign-in link issued/);
    expect(slack[0]).toMatch(/ops@host \(admin:break-glass\)/);
    expect(slack[1]).toMatch(/Break-glass sign-in used[\s\S]*203\.0\.113\.9/);
    expect(slack[2]).toMatch(/Break-glass session ended[\s\S]*Reason:\* logout/);
    const teams = JSON.parse(sent[1]!.body) as { title: string; themeColor: string };
    expect(teams).toMatchObject({ title: "Break-glass sign-in link issued", themeColor: "FF0000" });
  });

  it("reach a stored channel only when it picked the event", async () => {
    const sent = capture();
    const config = parseConfig({});
    const picked = new NotificationService(config, () => [
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/picked" }, events: [BREAK_GLASS_SIGN_IN_EVENT] },
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/other" }, events: ["execution.failure"] }
    ]);
    await picked.notify(event("used"));
    expect(sent.map((entry) => entry.url)).toEqual(["https://hooks.slack.test/picked"]);
  });

  it("notifyWithResults counts deliveries and reports non-2xx answers, missing settings and timeouts as failures", async () => {
    capture((url) => (url.includes("gone") ? 404 : url.includes("broken") ? 500 : 200));
    const config = parseConfig({});
    const channels = [
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/ok" }, events: [BREAK_GLASS_SIGN_IN_EVENT] },
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/gone" }, events: [BREAK_GLASS_SIGN_IN_EVENT] },
      { channel: "teams", enabled: true, config: { webhookUrl: "https://teams.test/broken" }, events: [BREAK_GLASS_SIGN_IN_EVENT] },
      { channel: "email", enabled: true, config: {}, events: [BREAK_GLASS_SIGN_IN_EVENT] },
      { channel: "slack", enabled: false, config: { webhookUrl: "https://hooks.slack.test/off" }, events: [BREAK_GLASS_SIGN_IN_EVENT] }
    ];
    const result = await new NotificationService(config, () => channels).notifyWithResults(event("used"), { timeoutMs: 2_000 });
    expect(result).toEqual({
      matched: 4,
      delivered: 1,
      failures: [
        { channel: "slack", error: "Slack webhook answered HTTP 404" },
        { channel: "teams", error: "Teams webhook answered HTTP 500" },
        { channel: "email", error: "Email channel has no SMTP host or recipient" }
      ]
    });
    expect(await new NotificationService(config, () => []).notifyWithResults(event("used"), { timeoutMs: 2_000 })).toEqual({ matched: 0, delivered: 0, failures: [] });

    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    const hung = await new NotificationService(config, () => [channels[0]!]).notifyWithResults(event("used"), { timeoutMs: 50 });
    expect(hung).toMatchObject({ matched: 1, delivered: 0, failures: [{ channel: "slack", error: expect.stringMatching(/did not answer/) }] });
  });

  it("the settings picker offers it", () => {
    expect(BREAK_GLASS_NOTIFICATION_OPTIONS).toEqual([{ value: "auth.break_glass_used", label: "Break-glass sign-in" }]);
  });
});
