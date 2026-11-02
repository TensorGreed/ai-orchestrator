/**
 * RSS and SSE trigger URLs are user-configured per node, so they go through
 * the outbound URL guard like HTTP Request does (REREVIEW-A12 L-a): a
 * metadata or link-local URL is refused before any request is sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { DEFAULT_OUTBOUND_GUARD } from "@ai-orchestrator/workflow-engine";
import type { Store } from "../db/store.js";
import { TriggerService } from "./trigger-service";

type Logged = { level: string; message: string; metadata?: unknown };

const workflow = (node: WorkflowNode): Workflow => ({ id: "wf-trigger-guard", name: "Trigger guard", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [node], edges: [] });
const node = (type: string, config: Record<string, unknown>): WorkflowNode => ({ id: "t1", type: type as WorkflowNode["type"], name: "t1", position: { x: 0, y: 0 }, config });

function service(fetchImpl: typeof fetch, resolved: string[] = ["93.184.216.34"]) {
  const logs: Logged[] = [];
  const store = { getTriggerState: () => undefined, saveTriggerState: () => undefined } as unknown as Store;
  const triggers = new TriggerService(store, (level, message, metadata) => logs.push({ level, message, metadata }), fetchImpl);
  triggers.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => resolved);
  return { triggers: triggers as unknown as Record<string, (wf: Workflow, n: WorkflowNode) => () => void>, logs };
}

const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
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

describe("stop() and a concurrent initialize()", () => {
  it("keeps the triggers a restart registers while a slow dispose is still pending", async () => {
    let live = 0;
    const fileNode = { id: "t", type: "file_trigger", name: "t", position: { x: 0, y: 0 }, config: { path: "/tmp/x" } } as WorkflowNode;
    const outNode = { id: "o", type: "output", name: "o", position: { x: 1, y: 0 }, config: {} } as WorkflowNode;
    const wf: Workflow = { id: "w1", name: "w1", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [fileNode, outNode], edges: [{ id: "e", source: "t", target: "o" }] };
    const store = {
      listWorkflows: async () => [{ id: "w1" }],
      getWorkflow: async () => wf,
      deleteTriggerStatesForWorkflow: async () => undefined
    } as unknown as Store;
    const triggers = new TriggerService(store, () => undefined);
    (triggers as unknown as Record<string, unknown>).startFileTrigger = () => {
      live += 1;
      let disposed = false;
      return async () => {
        if (disposed) return;
        disposed = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        live -= 1;
      };
    };
    await triggers.initialize();
    void triggers.stop();
    await triggers.initialize();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(live).toBe(1);
    expect(triggers.isRunning()).toBe(true);
    await triggers.stop();
    expect(live).toBe(0);
    expect(triggers.isRunning()).toBe(false);
  });
});

describe("a fire a budget refused is not counted as delivered (12.6, D13)", () => {
  it("file_trigger keeps the changes of a refused fire for the next poll", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-file-refused-"));
    try {
      fs.writeFileSync(path.join(dir, "old.txt"), "old");
      const states = new Map<string, unknown>();
      const store = {
        getTriggerState: async (workflowId: string, nodeId: string) => states.get(`${workflowId}:${nodeId}`),
        saveTriggerState: async (input: { workflowId: string; nodeId: string; state: unknown }) => {
          states.set(`${input.workflowId}:${input.nodeId}`, input.state);
        }
      } as unknown as Store;
      const triggers = new TriggerService(store, () => undefined);
      const fired: Array<Array<{ path: string; event: string }>> = [];
      const answers: Array<"refused" | "delivered"> = ["refused", "delivered"];
      triggers.setExecutionHandler(async (input) => {
        fired.push(input.input.file_events as Array<{ path: string; event: string }>);
        return answers.shift() ?? "delivered";
      });
      const n = node("file_trigger", { watchPath: dir, pollIntervalSeconds: 3600, events: ["created"] });
      const start = () => (triggers as unknown as Record<string, (wf: Workflow, n: WorkflowNode) => () => void>).startFileTrigger!.call(triggers, workflow(n), n);
      // Baseline: the existing file is known.
      stops.push(start());
      await waitFor(() => states.size > 0);
      fs.writeFileSync(path.join(dir, "new.txt"), "new");
      stops.push(start());
      await waitFor(() => fired.length === 1);
      // Refused: the next poll fires the same change again.
      stops.push(start());
      await waitFor(() => fired.length === 2);
      expect(fired.map((events) => events.map((event) => path.basename(event.path)))).toEqual([["new.txt"], ["new.txt"]]);
      // Delivered: nothing more to fire.
      await waitFor(async () => Object.keys((states.values().next().value ?? {}) as object).some((key) => key.endsWith("new.txt")));
      stops.push(start());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fired).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
