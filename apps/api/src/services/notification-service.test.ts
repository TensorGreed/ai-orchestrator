import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_EVENT_TYPES } from "@ai-orchestrator/shared";
import { NotificationService, type NotificationEvent } from "./notification-service.js";

const config = { NOTIFICATIONS_ENABLED: false } as never;

const failure: NotificationEvent = {
  type: "execution.failure",
  workflowId: "wf-1",
  workflowName: "Flow",
  executionId: "ex-1",
  error: "boom",
  timestamp: "2026-11-09T00:00:00.000Z"
};

afterEach(() => vi.restoreAllMocks());

describe("NotificationService event names", () => {
  it("sends an execution failure to channels using the old UI name and the server name", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const service = new NotificationService(config, () => [
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.example.test/old" }, events: ["workflow_failure"] },
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.example.test/new" }, events: ["execution.failure"] },
      { channel: "slack", enabled: true, config: { webhookUrl: "https://hooks.example.test/other" }, events: ["approval.requested"] }
    ]);
    await service.notify(failure);
    const urls = fetchMock.mock.calls.map((call) => String(call[0])).sort();
    expect(urls).toEqual(["https://hooks.example.test/new", "https://hooks.example.test/old"]);
  });

  it("offers only names the server emits", () => {
    expect([...NOTIFICATION_EVENT_TYPES]).toContain("execution.failure");
    expect(NOTIFICATION_EVENT_TYPES).not.toContain("workflow_failure" as never);
  });
});
