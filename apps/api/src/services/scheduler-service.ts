import cron, { type ScheduledTask } from "node-cron";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { isExecutionEdge } from "@ai-orchestrator/workflow-engine";
import type { Store } from "../db/store.js";
import { SerialReloads } from "./serial-by-key.js";

export interface SchedulerExecutionInput {
  workflowId: string;
  workflowName: string;
  scheduleNodeId: string;
  cronExpression: string;
  timezone: string;
  firedAt: string;
  /** The second the cron matched (ISO, milliseconds zero): the tick this run is for. */
  scheduledFor: string;
}

type SchedulerExecutionHandler = (input: SchedulerExecutionInput) => Promise<void>;
type SchedulerLogLevel = "info" | "warn" | "error";
type SchedulerLogger = (level: SchedulerLogLevel, message: string, metadata?: unknown) => void;

interface ScheduleRegistration {
  node: WorkflowNode;
  cronExpression: string;
  timezone: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function signatureOf(schedule: ScheduleRegistration): string {
  return `${schedule.cronExpression}|${schedule.timezone}`;
}

export class SchedulerService {
  private readonly jobs = new Map<string, ScheduledTask>();
  /** What each registered job was built from (cron and timezone), so a sync can tell a changed schedule. */
  private readonly signatures = new Map<string, string>();
  /** Stopped (a standby instance, or after stop()): nothing registers until initialize(). */
  private standby = false;
  /** Reloads one at a time per workflow; a removal asked for meanwhile wins. */
  private readonly reloads = new SerialReloads();
  private executeHandler: SchedulerExecutionHandler | null = null;
  private loadWorkflow: (workflowId: string) => Promise<Workflow | null> = async (workflowId) => await this.store.getWorkflow(workflowId);

  constructor(
    private readonly store: Store,
    private readonly logger: SchedulerLogger = (level, message, metadata) => {
      const suffix = metadata === undefined ? "" : ` ${JSON.stringify(metadata)}`;
      // eslint-disable-next-line no-console
      console[level](`[scheduler] ${message}${suffix}`);
    }
  ) {}

  setExecutionHandler(handler: SchedulerExecutionHandler): void {
    this.executeHandler = handler;
  }

  /**
   * Phase 15.4 — which version a schedule registers from: the published one
   * when the workflow has one (production traffic), else the draft.
   */
  setWorkflowLoader(loader: (workflowId: string) => Promise<Workflow | null>): void {
    this.loadWorkflow = loader;
  }

  async initialize(): Promise<void> {
    this.standby = false;
    await this.reloadAllSchedules();
  }

  /**
   * Phase 13.1 — brings the registered schedules in line with the database without dropping the ones that did not
   * change (a full reload would miss a tick that falls in between). The leader runs it on an interval when several
   * instances share the database, so a schedule saved through another instance is picked up here.
   */
  async syncAllSchedules(): Promise<void> {
    if (this.standby) return;
    const desired = new Map<string, { workflow: Workflow; schedule: ScheduleRegistration }>();
    for (const summary of await this.store.listWorkflows()) {
      const workflow = await this.loadWorkflow(summary.id);
      if (!workflow) continue;
      for (const schedule of this.findValidScheduleNodes(workflow, { quiet: true })) {
        desired.set(this.buildScheduleKey(workflow.id, schedule.node.id), { workflow, schedule });
      }
    }
    if (this.standby) return;
    for (const [key, task] of this.jobs.entries()) {
      const want = desired.get(key);
      if (want && this.signatures.get(key) === signatureOf(want.schedule)) continue;
      this.stopTask(task);
      this.jobs.delete(key);
      this.signatures.delete(key);
    }
    for (const [key, { workflow, schedule }] of desired) {
      if (!this.jobs.has(key)) this.registerSchedule(workflow, schedule);
    }
  }

  async reloadAllSchedules(): Promise<void> {
    this.clearAllSchedules();

    for (const workflowSummary of await this.store.listWorkflows()) {
      const workflow = await this.loadWorkflow(workflowSummary.id);
      if (!workflow) {
        continue;
      }
      this.registerWorkflow(workflow);
    }
  }

  /**
   * Reloads of one workflow run one after another, so the last save's schedule is the one registered; a delete
   * that lands while the workflow is loading wins (it is not registered again).
   */
  async reloadWorkflow(workflowId: string): Promise<void> {
    await this.reloads.reload(workflowId, async (removedSince) => {
      this.unregisterWorkflow(workflowId);
      const workflow = await this.loadWorkflow(workflowId);
      if (!workflow || removedSince()) {
        return;
      }
      this.registerWorkflow(workflow);
    });
  }

  removeWorkflow(workflowId: string): void {
    this.reloads.removed(workflowId);
    this.unregisterWorkflow(workflowId);
  }

  /** Phase 13.1 — started (initialize() since the last stop()) or still holding a registered job. */
  isRunning(): boolean {
    return !this.standby || this.jobs.size > 0;
  }

  /** Unregisters everything; saves register nothing until the next initialize() (a standby instance). */
  stop(): void {
    this.standby = true;
    this.clearAllSchedules();
  }

  private registerWorkflow(workflow: Workflow): void {
    for (const schedule of this.findValidScheduleNodes(workflow)) this.registerSchedule(workflow, schedule);
  }

  private registerSchedule(workflow: Workflow, schedule: ScheduleRegistration): void {
    if (this.standby) return;
    const key = this.buildScheduleKey(workflow.id, schedule.node.id);
    if (this.jobs.has(key)) {
      return;
    }

    // node-cron 4 can run one tick twice when its timer wakes a moment early: it runs the second that is ending (which
    // already fired) again, then the one starting, a few milliseconds apart (seen with crons that match every second).
    // A repeat of the matched second that last fired is skipped. Keyed on the matched second, not on the time between fires: a blocked
    // event loop can run two different seconds' ticks moments apart, and both must fire.
    //
    // A new task's first timer can wake early the same way, still inside the second it was registered in, and node-cron
    // then runs that second, whose tick the task it replaced (a re-registration on a save or a sync, this instance
    // re-elected) or the previous leader already ran. node-cron's first match is always after the second the task was
    // registered in, so a match at or before it is that early wake and is skipped.
    let lastFiredSecond = Math.floor(Date.now() / 1000);
    const task = cron.schedule(
      schedule.cronExpression,
      (context) => {
        const second = Math.floor(context.date.getTime() / 1000);
        if (second <= lastFiredSecond) return;
        // node-cron runs the callback a timer turn after the match: the task may have been stopped (this instance
        // stepped down) or replaced since, and a job no longer registered must not run.
        if (this.jobs.get(key) !== task) return;
        lastFiredSecond = second;
        void this.handleScheduledTick(workflow, schedule, second);
      },
      {
        timezone: schedule.timezone
      }
    );

    this.jobs.set(key, task);
    this.signatures.set(key, signatureOf(schedule));
    this.logger("info", "Registered schedule", {
      workflowId: workflow.id,
      workflowName: workflow.name,
      scheduleNodeId: schedule.node.id,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone
    });
  }

  private findValidScheduleNodes(workflow: Workflow, options: { quiet?: boolean } = {}): ScheduleRegistration[] {
    const warn = (message: string, metadata: unknown) => {
      if (!options.quiet) this.logger("warn", message, metadata);
    };
    const incomingExecution = new Map<string, number>();
    const outgoingExecution = new Map<string, number>();

    for (const node of workflow.nodes) {
      incomingExecution.set(node.id, 0);
      outgoingExecution.set(node.id, 0);
    }

    for (const edge of workflow.edges) {
      if (!isExecutionEdge(edge)) {
        continue;
      }

      incomingExecution.set(edge.target, (incomingExecution.get(edge.target) ?? 0) + 1);
      outgoingExecution.set(edge.source, (outgoingExecution.get(edge.source) ?? 0) + 1);
    }

    const matches: ScheduleRegistration[] = [];
    for (const node of workflow.nodes) {
      if (node.type !== "schedule_trigger") {
        continue;
      }

      const config = asRecord(node.config);
      const active = config.active === true;
      if (!active) {
        continue;
      }

      const cronExpression = typeof config.cronExpression === "string" ? config.cronExpression.trim() : "";
      if (!cronExpression || !cron.validate(cronExpression)) {
        warn("Skipped invalid schedule cron expression", {
          workflowId: workflow.id,
          scheduleNodeId: node.id,
          cronExpression
        });
        continue;
      }

      const timezone = typeof config.timezone === "string" && config.timezone.trim() ? config.timezone.trim() : "UTC";
      if (!isValidTimeZone(timezone)) {
        warn("Skipped invalid schedule timezone", {
          workflowId: workflow.id,
          scheduleNodeId: node.id,
          timezone
        });
        continue;
      }

      const isEntrypoint = (incomingExecution.get(node.id) ?? 0) === 0;
      const hasOutgoing = (outgoingExecution.get(node.id) ?? 0) > 0;
      if (!isEntrypoint || !hasOutgoing) {
        warn("Skipped schedule node that is not a connected entrypoint", {
          workflowId: workflow.id,
          scheduleNodeId: node.id
        });
        continue;
      }

      matches.push({
        node,
        cronExpression,
        timezone
      });
    }

    return matches;
  }

  private async handleScheduledTick(workflow: Workflow, schedule: ScheduleRegistration, second: number): Promise<void> {
    if (!this.executeHandler) {
      this.logger("warn", "Schedule fired before execution handler was configured", {
        workflowId: workflow.id,
        scheduleNodeId: schedule.node.id
      });
      return;
    }

    try {
      await this.executeHandler({
        workflowId: workflow.id,
        workflowName: workflow.name,
        scheduleNodeId: schedule.node.id,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone,
        firedAt: new Date().toISOString(),
        scheduledFor: new Date(second * 1000).toISOString()
      });
    } catch (error) {
      this.logger("error", "Scheduled execution failed", {
        workflowId: workflow.id,
        scheduleNodeId: schedule.node.id,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  private unregisterWorkflow(workflowId: string): void {
    for (const [key, task] of this.jobs.entries()) {
      if (!key.startsWith(`${workflowId}::`)) {
        continue;
      }
      this.stopTask(task);
      this.jobs.delete(key);
      this.signatures.delete(key);
    }
  }

  private clearAllSchedules(): void {
    for (const task of this.jobs.values()) {
      this.stopTask(task);
    }
    this.jobs.clear();
    this.signatures.clear();
  }

  private stopTask(task: ScheduledTask): void {
    // promise-ok: node-cron stops the task synchronously; the returned promise only reports that it did
    task.stop();
    const maybeDestroy = task as ScheduledTask & { destroy?: () => void };
    // promise-ok: as above, for destroy
    maybeDestroy.destroy?.();
  }

  private buildScheduleKey(workflowId: string, scheduleNodeId: string): string {
    return `${workflowId}::${scheduleNodeId}`;
  }
}
