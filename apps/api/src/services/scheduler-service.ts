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

export class SchedulerService {
  private readonly jobs = new Map<string, ScheduledTask>();
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
    await this.reloadAllSchedules();
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

  stop(): void {
    this.clearAllSchedules();
  }

  private registerWorkflow(workflow: Workflow): void {
    const schedules = this.findValidScheduleNodes(workflow);
    for (const schedule of schedules) {
      const key = this.buildScheduleKey(workflow.id, schedule.node.id);
      if (this.jobs.has(key)) {
        continue;
      }

      const task = cron.schedule(
        schedule.cronExpression,
        () => {
          void this.handleScheduledTick(workflow, schedule);
        },
        {
          timezone: schedule.timezone
        }
      );

      this.jobs.set(key, task);
      this.logger("info", "Registered schedule", {
        workflowId: workflow.id,
        workflowName: workflow.name,
        scheduleNodeId: schedule.node.id,
        cronExpression: schedule.cronExpression,
        timezone: schedule.timezone
      });
    }
  }

  private findValidScheduleNodes(workflow: Workflow): ScheduleRegistration[] {
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
        this.logger("warn", "Skipped invalid schedule cron expression", {
          workflowId: workflow.id,
          scheduleNodeId: node.id,
          cronExpression
        });
        continue;
      }

      const timezone = typeof config.timezone === "string" && config.timezone.trim() ? config.timezone.trim() : "UTC";
      if (!isValidTimeZone(timezone)) {
        this.logger("warn", "Skipped invalid schedule timezone", {
          workflowId: workflow.id,
          scheduleNodeId: node.id,
          timezone
        });
        continue;
      }

      const isEntrypoint = (incomingExecution.get(node.id) ?? 0) === 0;
      const hasOutgoing = (outgoingExecution.get(node.id) ?? 0) > 0;
      if (!isEntrypoint || !hasOutgoing) {
        this.logger("warn", "Skipped schedule node that is not a connected entrypoint", {
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

  private async handleScheduledTick(workflow: Workflow, schedule: ScheduleRegistration): Promise<void> {
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
        firedAt: new Date().toISOString()
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
    }
  }

  private clearAllSchedules(): void {
    for (const task of this.jobs.values()) {
      this.stopTask(task);
    }
    this.jobs.clear();
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
