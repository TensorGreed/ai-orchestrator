/**
 * 13.3 — the overdue data-subject request notice: channels set in the environment receive it by default, a channel
 * made in the settings receives it once it picks the event, and the message names the request, never the person.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import { NotificationService, type NotificationEvent } from "./notification-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(): Array<{ url: string; body: string }> {
  const sent: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    sent.push({ url, body: init.body });
    return new Response("ok", { status: 200 });
  });
  return sent;
}

const event: NotificationEvent = {
  type: "data.subject_request_due",
  workflowId: "",
  workflowName: "",
  timestamp: "2026-12-11T10:00:00.000Z",
  subjectRequest: { requestId: "dsr_1", type: "export", subjectKind: "end_user", status: "ready", dueAt: "2026-12-10T12:00:00.000Z" }
};

describe("overdue data-subject request notices", () => {
  it("reach the channels set in the environment, naming the request and its due date", async () => {
    const sent = capture();
    const config = parseConfig({ NOTIFICATIONS_ENABLED: "true", NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.slack.test/a" });
    await new NotificationService(config, () => []).notify(event);
    expect(sent).toHaveLength(1);
    const text = (JSON.parse(sent[0]!.body) as { text: string }).text;
    expect(text).toMatch(/Data-subject request overdue/);
    expect(text).toContain("dsr_1");
    expect(text).toContain("2026-12-10T12:00:00.000Z");
    expect(text).toContain("end user");
  });

  it("reach a settings channel only when it picks the event", async () => {
    const sent = capture();
    const config = parseConfig({});
    const picked = new NotificationService(config, () => [
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.slack.test/picked" }, events: ["data.subject_request_due"] },
      { channel: "teams", enabled: true, config: { webhookUrl: "https://teams.test/other" }, events: ["workflow_failure"] }
    ]);
    await picked.notify(event);
    expect(sent.map((entry) => entry.url)).toEqual(["https://hooks.slack.test/picked"]);
  });
});
