/**
 * RSS and SSE trigger URLs are user-configured per node, so they go through
 * the outbound URL guard like HTTP Request does (REREVIEW-A12 L-a): a
 * metadata or link-local URL is refused before any request is sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { DEFAULT_OUTBOUND_GUARD } from "@ai-orchestrator/workflow-engine";
import type { SqliteStore } from "../db/database";
import { TriggerService } from "./trigger-service";

type Logged = { level: string; message: string; metadata?: unknown };

const workflow = (node: WorkflowNode): Workflow => ({ id: "wf-trigger-guard", name: "Trigger guard", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [node], edges: [] });
const node = (type: string, config: Record<string, unknown>): WorkflowNode => ({ id: "t1", type: type as WorkflowNode["type"], name: "t1", position: { x: 0, y: 0 }, config });

function service(fetchImpl: typeof fetch, resolved: string[] = ["93.184.216.34"]) {
  const logs: Logged[] = [];
  const store = { getTriggerState: () => undefined, saveTriggerState: () => undefined } as unknown as SqliteStore;
  const triggers = new TriggerService(store, (level, message, metadata) => logs.push({ level, message, metadata }), fetchImpl);
  triggers.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => resolved);
  return { triggers: triggers as unknown as Record<string, (wf: Workflow, n: WorkflowNode) => () => void>, logs };
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("trigger URLs go through the outbound guard", () => {
  it("rss_trigger refuses a metadata feed URL without fetching it", async () => {
    const fetchSpy = vi.fn(async () => new Response("<rss></rss>", { status: 200 })) as unknown as typeof fetch;
    const { triggers, logs } = service(fetchSpy);
    const n = node("rss_trigger", { feedUrl: "http://169.254.169.254/latest/meta-data/", pollIntervalSeconds: 3600 });
    stops.push(triggers.startRssTrigger!.call(triggers, workflow(n), n));
    await waitFor(() => logs.length > 0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ level: "error", message: "rss_trigger tick failed" });
    expect(JSON.stringify(logs[0]!.metadata)).toMatch(/metadata|link local/i);
  });

  it("rss_trigger refuses a feed whose name resolves to the metadata address", async () => {
    const fetchSpy = vi.fn(async () => new Response("<rss></rss>", { status: 200 })) as unknown as typeof fetch;
    const { triggers, logs } = service(fetchSpy, ["169.254.169.254"]);
    const n = node("rss_trigger", { feedUrl: "https://feeds.evil.test/rss", pollIntervalSeconds: 3600 });
    stops.push(triggers.startRssTrigger!.call(triggers, workflow(n), n));
    await waitFor(() => logs.length > 0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rss_trigger still fetches an allowed feed", async () => {
    const fetchSpy = vi.fn(async () => new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch;
    const { triggers } = service(fetchSpy);
    const n = node("rss_trigger", { feedUrl: "https://feeds.example.com/rss", pollIntervalSeconds: 3600 });
    stops.push(triggers.startRssTrigger!.call(triggers, workflow(n), n));
    await waitFor(() => (fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);
    expect((fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe("https://feeds.example.com/rss");
  });

  it("sse_trigger refuses a metadata stream URL without connecting", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const { triggers, logs } = service(fetchSpy);
    const n = node("sse_trigger", { url: "http://[fd00:ec2::254]/events", reconnectDelaySeconds: 3600 });
    stops.push(triggers.startSseTrigger!.call(triggers, workflow(n), n));
    await waitFor(() => logs.length > 0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ level: "warn", message: "sse_trigger connection dropped, will reconnect" });
    expect(JSON.stringify(logs[0]!.metadata)).toMatch(/metadata|link local/i);
  });
});
