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

describe("a standby instance and the leader's sync (Phase 13.1)", () => {
  const withCron = (workflow: Workflow, cronExpression: string): Workflow => ({
    ...workflow,
    nodes: workflow.nodes.map((n) => (n.type === "schedule_trigger" ? { ...n, config: { ...n.config, cronExpression } } : n))
  });
  const storeOf = (workflows: () => Workflow[]) =>
    ({
      listWorkflows: async () => workflows().map((w) => ({ id: w.id })),
      getTriggerState: async () => null,
      saveTriggerState: async () => undefined,
      deleteTriggerStatesForWorkflow: async () => 0
    }) as unknown as Store;

  it("after stop() a save registers nothing until initialize(); initialize registers what the database holds", async () => {
    let current = [scheduleWorkflow("tick")];
    const scheduler = new SchedulerService(storeOf(() => current), quiet);
    services.push(scheduler);
    scheduler.setWorkflowLoader(async (id) => current.find((w) => w.id === id) ?? null);
    scheduler.stop();
    await scheduler.reloadWorkflow("wf-reload");
    await scheduler.syncAllSchedules();
    expect(jobKeys(scheduler)).toEqual([]);
    await scheduler.initialize();
    expect(jobKeys(scheduler)).toEqual(["wf-reload::tick"]);
    current = [];
    scheduler.stop();
    expect(jobKeys(scheduler)).toEqual([]);
  });

  it("sync keeps an unchanged schedule's job, replaces a changed one and drops a removed one", async () => {
    let current = [scheduleWorkflow("tick")];
    const scheduler = new SchedulerService(storeOf(() => current), quiet);
    services.push(scheduler);
    scheduler.setWorkflowLoader(async (id) => current.find((w) => w.id === id) ?? null);
    await scheduler.initialize();
    const jobs = (scheduler as unknown as { jobs: Map<string, unknown> }).jobs;
    const before = jobs.get("wf-reload::tick");
    await scheduler.syncAllSchedules();
    expect(jobs.get("wf-reload::tick")).toBe(before);
    current = [withCron(scheduleWorkflow("tick"), "0 0 2 1 *")];
    await scheduler.syncAllSchedules();
    expect(jobKeys(scheduler)).toEqual(["wf-reload::tick"]);
    expect(jobs.get("wf-reload::tick")).not.toBe(before);
    current = [{ ...scheduleWorkflow("other"), id: "wf-2" }];
    await scheduler.syncAllSchedules();
    expect(jobKeys(scheduler)).toEqual(["wf-2::other"]);
  });

  it("triggers: a standby registers nothing; sync keeps an unchanged trigger and restarts a changed one", async () => {
    let current = [rssWorkflow("feed")];
    const fetchStub = (async () => new Response("<rss><channel></channel></rss>", { status: 200 })) as unknown as typeof fetch;
    const triggers = new TriggerService(storeOf(() => current), quiet, fetchStub);
    triggers.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => ["93.184.216.34"]);
    services.push(triggers);
    triggers.setWorkflowLoader(async (id) => current.find((w) => w.id === id) ?? null);
    await triggers.stop();
    await triggers.reloadWorkflow("wf-reload");
    await triggers.syncAllWorkflows();
    expect(triggerKeys(triggers)).toEqual([]);
    await triggers.initialize();
    const active = (triggers as unknown as { active: Map<string, unknown> }).active;
    const before = active.get("wf-reload::feed");
    expect(before).toBeDefined();
    await triggers.syncAllWorkflows();
    expect(active.get("wf-reload::feed")).toBe(before);
    current = [{ ...rssWorkflow("feed"), nodes: rssWorkflow("feed").nodes.map((n) => (n.type === "rss_trigger" ? { ...n, config: { ...n.config, pollIntervalSeconds: 7200 } } : n)) }];
    await triggers.syncAllWorkflows();
    expect(active.get("wf-reload::feed")).toBeDefined();
    expect(active.get("wf-reload::feed")).not.toBe(before);
    current = [];
    await triggers.syncAllWorkflows();
    expect(triggerKeys(triggers)).toEqual([]);
  });
});

describe("a tick node-cron runs twice (an early timer)", () => {
  it("is fired once: a second fire within half a second of the last is skipped", async () => {
    const scheduler = new SchedulerService({} as Store, quiet);
    services.push(scheduler);
    const fired: string[] = [];
    scheduler.setExecutionHandler(async (input) => void fired.push(input.firedAt));
    scheduler.setWorkflowLoader(async () => scheduleWorkflow("tick"));
    await scheduler.reloadWorkflow("wf-reload");
    const task = (scheduler as unknown as { jobs: Map<string, { options?: unknown }> }).jobs.get("wf-reload::tick") as unknown as {
      runner: { onMatch: (date: Date, execution: unknown) => Promise<unknown> };
    };
    // The task's own callback, as node-cron calls it on each match.
    await task.runner.onMatch(new Date(), { id: "a" });
    await task.runner.onMatch(new Date(), { id: "b" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fired).toHaveLength(1);
  });
});
