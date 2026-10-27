/**
 * Scheduler and trigger reloads of one workflow run one after another, and a delete that lands while a reload is
 * loading the workflow wins: a networked store answers loads out of order.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

  type Task = { runner: { onMatch: (date: Date, execution: unknown) => Promise<unknown> } };
  const currentTask = (scheduler: SchedulerService) =>
    (scheduler as unknown as { jobs: Map<string, unknown> }).jobs.get("wf-reload::tick") as Task | undefined;
  /** A task's own callback, as node-cron calls it on each match with the matched second (milliseconds cut). */
  const matchOn = async (task: Task, second: number, id: string) => await task.runner.onMatch(new Date(second * 1000), { id });

  async function everySecond() {
    const scheduler = new SchedulerService({} as Store, quiet);
    services.push(scheduler);
    const fired: string[] = [];
    scheduler.setExecutionHandler(async (input) => void fired.push(input.scheduledFor));
    scheduler.setWorkflowLoader(async () => scheduleWorkflow("tick"));
    await scheduler.reloadWorkflow("wf-reload");
    const task = currentTask(scheduler)!;
    const match = async (second: number, id: string) => await matchOn(task, second, id);
    return { scheduler, fired, match };
  }

  const settle = async () => await new Promise((resolve) => setTimeout(resolve, 10));

  it("is fired once: a second run of the same matched second is skipped", async () => {
    const { fired, match } = await everySecond();
    // node-cron's first match is the second after the one the task was registered in.
    const second = Math.floor(Date.now() / 1000) + 1;
    await match(second, "a");
    await match(second, "b");
    await settle();
    expect(fired).toEqual([new Date(second * 1000).toISOString()]);
  });

  it("a lagging event loop runs two seconds' ticks moments apart: both fire", async () => {
    const { fired, match } = await everySecond();
    const second = Math.floor(Date.now() / 1000) + 1;
    // Tick N ran late (the loop was blocked past the boundary) and tick N + 1 on time: well under a second apart.
    await match(second, "late");
    await match(second + 1, "on-time");
    await settle();
    expect(fired).toHaveLength(2);
  });

  it("a schedule registered again in the second its tick fired does not fire that second again", async () => {
    // A re-registration (a new leader, the old one re-elected, a save) builds a new task; its first timer can wake a
    // moment early, still inside the second it was registered in, and node-cron then matches that second, which the
    // task it replaced (or another instance's) already fired.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00.400Z"));
    const { scheduler, fired, match } = await everySecond();
    const second = Date.parse("2026-10-27T12:00:01.000Z") / 1000;
    vi.setSystemTime(new Date("2026-10-27T12:00:01.004Z"));
    await match(second, "old task");
    vi.setSystemTime(new Date("2026-10-27T12:00:01.090Z"));
    await scheduler.reloadWorkflow("wf-reload");
    const replacement = currentTask(scheduler)!;
    vi.setSystemTime(new Date("2026-10-27T12:00:01.998Z"));
    await matchOn(replacement, second, "early wake");
    vi.setSystemTime(new Date("2026-10-27T12:00:02.001Z"));
    await matchOn(replacement, second + 1, "next");
    await settle();
    expect(fired).toEqual(["2026-10-27T12:00:01.000Z", "2026-10-27T12:00:02.000Z"]);
  });

  it("a tick node-cron had already dispatched when its task was stopped does not fire", async () => {
    // node-cron runs the callback a timer turn after the match, so a stop (the leader stepping down) can land between.
    const { scheduler, fired, match } = await everySecond();
    scheduler.stop();
    await match(Math.floor(Date.now() / 1000) + 1, "after stop");
    await settle();
    expect(fired).toEqual([]);
  });
});
