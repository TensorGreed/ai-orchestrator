/**
 * Scheduler and trigger reloads of one workflow run one after another, and a delete that lands while a reload is
 * loading the workflow wins: a networked store answers loads out of order.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import { SchedulerService } from "./scheduler-service.js";
import { TriggerService } from "./trigger-service.js";
import { DEFAULT_OUTBOUND_GUARD } from "@ai-orchestrator/workflow-engine";

const quiet = () => undefined;

function scheduleWorkflow(nodeId: string): Workflow {
  return {
    id: "wf-reload",
    name: "Reload",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: nodeId, type: "schedule_trigger", name: nodeId, position: { x: 0, y: 0 }, config: { cronExpression: "0 0 1 1 *", timezone: "UTC", active: true } },
      { id: "out", type: "output", name: "out", position: { x: 0, y: 0 }, config: {} }
    ] as WorkflowNode[],
    edges: [{ id: "e1", source: nodeId, target: "out" }]
  };
}

function rssWorkflow(nodeId: string): Workflow {
  return {
    ...scheduleWorkflow(nodeId),
    nodes: [
      { id: nodeId, type: "rss_trigger", name: nodeId, position: { x: 0, y: 0 }, config: { feedUrl: "https://feeds.example.com/rss", pollIntervalSeconds: 3600 } },
      { id: "out", type: "output", name: "out", position: { x: 0, y: 0 }, config: {} }
    ] as WorkflowNode[]
  };
}

/** A loader whose answers are released by hand, in any order. */
function heldLoader(versions: Workflow[]) {
  const pending: Array<() => void> = [];
  let calls = 0;
  const load = async (): Promise<Workflow | null> => {
    const version = versions[Math.min(calls, versions.length - 1)]!;
    calls += 1;
    await new Promise<void>((resolve) => pending.push(resolve));
    return version;
  };
  const release = async (index: number) => {
    for (let i = 0; i < 20 && !pending[index]; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    pending[index]!();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { load, release };
}

const services: Array<{ stop: () => unknown }> = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
});

const jobKeys = (scheduler: SchedulerService) => [...(scheduler as unknown as { jobs: Map<string, unknown> }).jobs.keys()];
const triggerKeys = (triggers: TriggerService) => [...(triggers as unknown as { active: Map<string, unknown> }).active.keys()];

describe("scheduler reloads", () => {
  it("two saves in a row: the later save's schedule is the one registered, even when its load answers last", async () => {
    const scheduler = new SchedulerService({} as Store, quiet);
    services.push(scheduler);
    const loader = heldLoader([scheduleWorkflow("tick-old"), scheduleWorkflow("tick-new")]);
    scheduler.setWorkflowLoader(loader.load);
    const first = scheduler.reloadWorkflow("wf-reload");
    const second = scheduler.reloadWorkflow("wf-reload");
    await loader.release(0);
    await loader.release(1);
    await Promise.all([first, second]);
    expect(jobKeys(scheduler)).toEqual(["wf-reload::tick-new"]);
  });

  it("a delete while a reload is loading the workflow: nothing is registered for it afterwards", async () => {
    const scheduler = new SchedulerService({} as Store, quiet);
    services.push(scheduler);
    const loader = heldLoader([scheduleWorkflow("tick")]);
    scheduler.setWorkflowLoader(loader.load);
    const reload = scheduler.reloadWorkflow("wf-reload");
    scheduler.removeWorkflow("wf-reload");
    await loader.release(0);
    await reload;
    expect(jobKeys(scheduler)).toEqual([]);
  });
});

describe("trigger reloads", () => {
  const triggerService = () => {
    const store = { getTriggerState: async () => null, saveTriggerState: async () => undefined, deleteTriggerStatesForWorkflow: async () => 0 } as unknown as Store;
    const fetchStub = (async () => new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch;
    const triggers = new TriggerService(store, quiet, fetchStub);
    triggers.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => ["93.184.216.34"]);
    services.push(triggers);
    return triggers;
  };

  it("two saves in a row: the later save's trigger is the one registered, even when its load answers last", async () => {
    const triggers = triggerService();
    const loader = heldLoader([rssWorkflow("rss-old"), rssWorkflow("rss-new")]);
    triggers.setWorkflowLoader(loader.load);
    const first = triggers.reloadWorkflow("wf-reload");
    const second = triggers.reloadWorkflow("wf-reload");
    await loader.release(0);
    await loader.release(1);
    await Promise.all([first, second]);
    expect(triggerKeys(triggers)).toEqual(["wf-reload::rss-new"]);
  });

  it("a delete while a reload is loading the workflow: nothing is registered for it afterwards", async () => {
    const triggers = triggerService();
    const loader = heldLoader([rssWorkflow("rss")]);
    triggers.setWorkflowLoader(loader.load);
    const reload = triggers.reloadWorkflow("wf-reload");
    const removed = triggers.removeWorkflow("wf-reload");
    await loader.release(0);
    await Promise.all([reload, removed]);
    expect(triggerKeys(triggers)).toEqual([]);
  });
});

describe("what reloads keep in memory", () => {
  const tracked = (service: SchedulerService | TriggerService) => (service as unknown as { reloads: { tracked: number } }).reloads.tracked;

  it("nothing is kept for a workflow once its reloads are done, however often it was removed", async () => {
    const scheduler = new SchedulerService({} as Store, quiet);
    services.push(scheduler);
    const loader = heldLoader([scheduleWorkflow("tick")]);
    scheduler.setWorkflowLoader(loader.load);
    for (let i = 0; i < 3; i += 1) scheduler.removeWorkflow(`wf-gone-${i}`);
    const reload = scheduler.reloadWorkflow("wf-reload");
    expect(tracked(scheduler)).toBe(1);
    scheduler.removeWorkflow("wf-reload");
    await loader.release(0);
    await reload;
    expect(jobKeys(scheduler)).toEqual([]);
    expect(tracked(scheduler)).toBe(0);

    const store = { getTriggerState: async () => null, saveTriggerState: async () => undefined, deleteTriggerStatesForWorkflow: async () => 0 } as unknown as Store;
    const triggers = new TriggerService(store, quiet, (async () => new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch);
    triggers.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => ["93.184.216.34"]);
    services.push(triggers);
    const triggerLoader = heldLoader([rssWorkflow("rss")]);
    triggers.setWorkflowLoader(triggerLoader.load);
    for (let i = 0; i < 3; i += 1) await triggers.removeWorkflow(`wf-gone-${i}`);
    const triggerReload = triggers.reloadWorkflow("wf-reload");
    await triggerLoader.release(0);
    await triggerReload;
    expect(triggerKeys(triggers)).toEqual(["wf-reload::rss"]);
    expect(tracked(triggers)).toBe(0);
  });

  it("a reload asked for after a removal registers the workflow (the removal only overtakes earlier reloads)", async () => {
    const scheduler = new SchedulerService({} as Store, quiet);
    services.push(scheduler);
    const loader = heldLoader([scheduleWorkflow("tick-a"), scheduleWorkflow("tick-b")]);
    scheduler.setWorkflowLoader(loader.load);
    const first = scheduler.reloadWorkflow("wf-reload");
    scheduler.removeWorkflow("wf-reload");
    const second = scheduler.reloadWorkflow("wf-reload");
    await loader.release(0);
    await loader.release(1);
    await Promise.all([first, second]);
    expect(jobKeys(scheduler)).toEqual(["wf-reload::tick-b"]);
    expect(tracked(scheduler)).toBe(0);
  });
});
