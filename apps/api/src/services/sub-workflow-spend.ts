/**
 * The model spend of a run's sub-workflows (Execute Workflow nodes and Workflow Tools).
 *
 * A child runs inside its parent's run and has no execution of its own, so its spend is the run's: it is recorded in
 * the top-level run's usage row (that run's workflow, project, user and gateway client) and counts toward the budgets
 * that run is matched against. A child's own workflow and project budgets do not count it (the caller pays).
 *
 * The engine reports each finished child through `onSubWorkflowUsage` (grandchildren report themselves; a Workflow
 * Tool's child is reported here instead of in its agent node's `_childTelemetry`). What arrives while the run is going
 * joins the run's row when the run is recorded. What cannot join it is written at once as a row of its own for the
 * same execution and attribution (trigger type `sub_workflow`, not counted as an execution in the usage views): an
 * async child that ends after the run's row was written, what the run held when it paused for an approval (the
 * resumed run is recorded apart), and what a run held that stopped without a row (`abandon`, or a tracker replaced or
 * dropped, each with a warning).
 *
 * `pending()` is what a budget check before the next child adds to the recorded usage: the spend reported and not
 * recorded yet (so the run's earlier children count), plus a reservation for each child still running beside the
 * caller (async children, and Workflow Tool children whose call timed out). Sync and tool children run one at a time
 * and count once they finish; a child's own ancestors are not reserved against it. A reservation is the largest spend
 * a finished child of the execution reported, and at least RESERVATION_FLOOR before any has finished. All of this
 * spans the execution's segments: children still running from before an approval pause, or from a queue attempt that
 * lost its lease, are reserved against the resumed or retried segment too.
 *
 * `admitIf()` makes a check and the child's reservation one step: an execution's checks run one after another, so
 * children admitted at the same time each see the others. This holds within one process, which is where all of a
 * segment's children run; separate runs (and segments on separate instances) are matched only through recorded usage.
 * A check that takes longer than SUB_WORKFLOW_BUDGET_CHECK_TIMEOUT_MS (a budget read that hangs) refuses that child
 * and lets the next check go on, so a stuck read cannot stall the run's other children.
 *
 * The same record holds a streamed model call of the run (or of one of its children) that failed, was cancelled or
 * timed out (`reportModelUsage`): no node output carries it, so it joins the run's row, or a row of its own, the same
 * way.
 */
import type { GatewayRunUsage } from "@ai-orchestrator/shared";
import type { SubWorkflowAdmission, SubWorkflowAdmissionRequest, SubWorkflowUsage } from "@ai-orchestrator/workflow-engine";
import { SUB_WORKFLOW_USAGE_TRIGGER } from "../db/usage-sql.js";
import type { BudgetService } from "./budget-service.js";
import type { UsageService } from "./usage-service.js";

/** Who a run's usage row is recorded for (as persistExecutionHistory records it). */
export interface RunUsageAttribution {
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  projectId: string | null;
  triggeredBy?: string;
  gatewayUsage?: GatewayRunUsage;
}

/** The user columns of a run's usage row: the gateway client for a gateway call's run, else who triggered it. */
export function usageUserOf(triggeredBy: string | undefined, gatewayUsage: GatewayRunUsage | undefined): { email: string | null; id: string | null } {
  if (gatewayUsage) return { email: null, id: `mcp-client:${gatewayUsage.clientName}` };
  return {
    email: typeof triggeredBy === "string" && triggeredBy.includes("@") ? triggeredBy : null,
    id: typeof triggeredBy === "string" && !triggeredBy.includes("@") ? triggeredBy : null
  };
}

type Logger = { warn: (fields: Record<string, unknown>, message: string) => void };

/** Runs whose spend is still open; a run whose history is never recorded must not grow the map forever. */
export const SUB_WORKFLOW_SPEND_MAX_OPEN_RUNS = 5_000;

export type Spend = { costUsd: number; totalTokens: number };

const ZERO: Spend = { costUsd: 0, totalTokens: 0 };
const add = (a: Spend, b: Spend): Spend => ({ costUsd: a.costUsd + b.costUsd, totalTokens: a.totalTokens + b.totalTokens });

/** How long one budget check before a child may take; a longer one refuses the child (the budgets could not be read). */
export const SUB_WORKFLOW_BUDGET_CHECK_TIMEOUT_MS = 15_000;

/** Spend held for a run's row: a finished child's, or a failed model call's. */
type HeldUsage = Pick<SubWorkflowUsage, "workflowId" | "status" | "durationMs" | "telemetry">;

/** Thrown when a budget check before a child did not finish in time. */
export class BudgetCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The budgets could not be read within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "BudgetCheckTimeoutError";
  }
}

/** `check`, or a BudgetCheckTimeoutError once `timeoutMs` has passed (a late answer is ignored). */
export async function withinBudgetCheckTime<T>(check: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetCheckTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([check, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a running child is reserved at before any child of the run has finished: one cent, or 1,000 tokens. */
export const RESERVATION_FLOOR: Spend = { costUsd: 0.01, totalTokens: 1_000 };

/** A child the run admitted; settled when it stops running. */
class ChildAdmission implements SubWorkflowAdmission {
  concurrent: boolean;
  constructor(
    private readonly run: RunSubWorkflowSpend,
    readonly parent: ChildAdmission | undefined,
    mode: SubWorkflowAdmissionRequest["mode"]
  ) {
    this.concurrent = mode === "async";
  }
  settle(): void {
    this.run.release(this);
  }
  detach(): void {
    this.concurrent = true;
  }
}

/**
 * Every segment of one execution that may still count: the running segment, and earlier ones (before an approval
 * pause, or a queue attempt that lost its lease) whose async children still run or whose spend is being written.
 * Checks before a child see them all, and are serialized here so a check and its reservation are one step.
 */
class ExecutionSpend {
  readonly runs = new Set<RunSubWorkflowSpend>();
  largest: Spend = ZERO;
  private tail: Promise<unknown> = Promise.resolve();

  /** Runs `step` once the steps queued before it have finished (in this process). */
  exclusive<T>(step: () => Promise<T>): Promise<T> {
    const result = this.tail.then(step);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class RunSubWorkflowSpend {
  private usages: Array<{ usage: HeldUsage; spend: Spend }> = [];
  private held: Spend = ZERO;
  /** Joined to the run's row, which is being written. */
  private recording: Spend = ZERO;
  private readonly running = new Set<ChildAdmission>();
  private closed = false;

  constructor(
    readonly attribution: RunUsageAttribution,
    private readonly owner: SubWorkflowSpendTracker,
    private execution: ExecutionSpend = new ExecutionSpend(),
    /** The attempt that started this segment (a queue job), so stopping one attempt never closes another's. */
    readonly attempt?: object
  ) {
    execution.runs.add(this);
  }

  /**
   * A segment that left its execution's record (it was closed early, for example dropped from the open runs, while
   * its run goes on) joins it again before it admits a child, so its own children are counted, and a later segment
   * of the execution sees them.
   */
  private rejoin(): void {
    if (this.execution.runs.has(this)) return;
    this.execution = this.owner.executionFor(this.attribution.executionId, this.execution);
    this.execution.runs.add(this);
  }

  /** A child starts (no check: see `admitIf`). */
  admit(request: SubWorkflowAdmissionRequest): SubWorkflowAdmission {
    this.rejoin();
    const parent = request.parent instanceof ChildAdmission ? request.parent : undefined;
    const admission = new ChildAdmission(this, parent, request.mode);
    this.running.add(admission);
    return admission;
  }

  /**
   * Checks and admits a child as one step: `fits` gets the pending spend (this execution's unrecorded spend and
   * reservations) and says whether the child may start; it is admitted, and reserved for the next check, before any
   * other check of the execution runs. Undefined when it does not fit.
   */
  async admitIf(request: SubWorkflowAdmissionRequest, fits: (pending: () => Spend) => Promise<boolean>): Promise<SubWorkflowAdmission | undefined> {
    this.rejoin();
    const timeoutMs = this.owner.checkTimeoutMs;
    return await this.execution.exclusive(async () =>
      (await withinBudgetCheckTime(fits(() => this.pending(request)), timeoutMs)) ? this.admit(request) : undefined
    );
  }

  release(admission: ChildAdmission): void {
    this.running.delete(admission);
    this.leaveWhenDone();
  }

  /** The children running beside the caller of a new child, in every segment of the execution: not its own ancestors. */
  concurrentRunning(request?: SubWorkflowAdmissionRequest): number {
    const ancestors = new Set<ChildAdmission>();
    for (let at = request?.parent instanceof ChildAdmission ? request.parent : undefined; at; at = at.parent) ancestors.add(at);
    let count = 0;
    for (const run of this.segments()) for (const admission of run.running) if (admission.concurrent && !ancestors.has(admission)) count += 1;
    return count;
  }

  /** A finished child's usage: held for the run's row, or recorded at once once that row is written. */
  async report(usage: SubWorkflowUsage): Promise<void> {
    const spend = this.owner.price(usage.telemetry);
    const largest = this.execution.largest;
    this.execution.largest = { costUsd: Math.max(largest.costUsd, spend.costUsd), totalTokens: Math.max(largest.totalTokens, spend.totalTokens) };
    await this.hold(usage, spend);
  }

  /**
   * A model call of the run (or of a child) that failed, was cancelled or timed out: its estimated usage, which no
   * node output carries. Held and recorded like a child's spend; it does not change a child's reservation.
   */
  async reportModelUsage(telemetry: Record<string, unknown>): Promise<void> {
    const latency = typeof telemetry.latencyMs === "number" && Number.isFinite(telemetry.latencyMs) ? telemetry.latencyMs : 0;
    const usage: HeldUsage = { workflowId: this.attribution.workflowId, status: "error", durationMs: latency, telemetry: [telemetry] };
    await this.hold(usage, this.owner.price(usage.telemetry));
  }

  private async hold(usage: HeldUsage, spend: Spend): Promise<void> {
    if (!this.closed) {
      this.usages.push({ usage, spend });
      this.held = add(this.held, spend);
      return;
    }
    await this.owner.recordDetached(this.attribution, [usage]);
  }

  /** This execution's segments that count, this one always among them (it is asking, so its run goes on). */
  private segments(): Set<RunSubWorkflowSpend> {
    return this.execution.runs.has(this) ? this.execution.runs : new Set([...this.execution.runs, this]);
  }

  /**
   * What a check before a new child adds to the recorded usage: the execution's unrecorded spend, and a reservation
   * for each child running beside the caller.
   */
  pending(request?: SubWorkflowAdmissionRequest): Spend {
    const largest = this.execution.largest;
    const reserve: Spend = {
      costUsd: Math.max(largest.costUsd, RESERVATION_FLOOR.costUsd),
      totalTokens: Math.max(largest.totalTokens, RESERVATION_FLOOR.totalTokens)
    };
    const running = this.concurrentRunning(request);
    let unrecorded = ZERO;
    for (const run of this.segments()) unrecorded = add(unrecorded, add(run.held, run.recording));
    return add(unrecorded, { costUsd: reserve.costUsd * running, totalTokens: reserve.totalTokens * running });
  }

  /** A closed segment stops counting once nothing of it runs or is being written. */
  private leaveWhenDone(): void {
    if (!this.closed || this.running.size > 0 || this.recording.costUsd !== 0 || this.recording.totalTokens !== 0) return;
    this.execution.runs.delete(this);
    if (this.execution.runs.size === 0) this.owner.forget(this.attribution.executionId, this.execution);
  }

  /** Whether spend is held that nobody has recorded yet. */
  holdsSpend(): boolean {
    return this.usages.length > 0;
  }

  /**
   * The run is being recorded: what it held joins its row (counted as pending until `recorded()`); later reports get
   * rows of their own.
   */
  closeIntoRun(): Record<string, unknown>[] {
    this.closed = true;
    const held = this.usages.flatMap((entry) => entry.usage.telemetry);
    this.recording = this.held;
    this.usages = [];
    this.held = ZERO;
    this.leaveWhenDone();
    return held;
  }

  /** The run's row was written (or failed to be). */
  recorded(): void {
    this.recording = ZERO;
    this.leaveWhenDone();
  }

  /** The run paused or stopped without its row: what it held is recorded now, as are later reports. */
  async closeDetached(): Promise<void> {
    this.closed = true;
    const held = this.usages.map((entry) => entry.usage);
    this.usages = [];
    this.held = ZERO;
    this.leaveWhenDone();
    if (held.length > 0) await this.owner.recordDetached(this.attribution, held);
  }
}

export class SubWorkflowSpendTracker {
  private readonly open = new Map<string, RunSubWorkflowSpend>();
  /** Each attempt's segment, so a stopped attempt closes its own (not a retry's that started since). */
  private readonly byAttempt = new WeakMap<object, RunSubWorkflowSpend>();
  /** Per execution id, the segments that still count (bounded by the runs open and the children still running). */
  private readonly executions = new Map<string, ExecutionSpend>();

  constructor(
    private readonly deps: {
      usageService: Pick<UsageService, "recordExecution" | "totalTelemetry">;
      budgetService: Pick<BudgetService, "recordExecution">;
      logger: Logger;
      maxOpenRuns?: number;
      budgetCheckTimeoutMs?: number;
    }
  ) {}

  get checkTimeoutMs(): number {
    return this.deps.budgetCheckTimeoutMs ?? SUB_WORKFLOW_BUDGET_CHECK_TIMEOUT_MS;
  }

  /** The execution's shared record: the one tracked for the id, else `mine`, which is tracked from now on. */
  executionFor(executionId: string, mine: ExecutionSpend): ExecutionSpend {
    const tracked = this.executions.get(executionId);
    if (tracked) {
      if (tracked !== mine) {
        tracked.largest = {
          costUsd: Math.max(tracked.largest.costUsd, mine.largest.costUsd),
          totalTokens: Math.max(tracked.largest.totalTokens, mine.largest.totalTokens)
        };
      }
      return tracked;
    }
    this.executions.set(executionId, mine);
    return mine;
  }

  /**
   * Starts tracking a run (a resumed or re-run one starts afresh under the same execution id). Spend an earlier
   * tracker of the id, or one dropped to keep the map bounded, still held is recorded on its own, with a warning.
   */
  start(attribution: RunUsageAttribution, attempt?: object): RunSubWorkflowSpend {
    // A resumed or retried segment shares its execution's earlier segments' running children and reservations.
    let execution = this.executions.get(attribution.executionId);
    if (!execution) {
      execution = new ExecutionSpend();
      this.executions.set(attribution.executionId, execution);
    }
    this.flushDropped(this.open.get(attribution.executionId), "replaced by a new run of the same execution");
    const spend = new RunSubWorkflowSpend(attribution, this, execution, attempt);
    if (attempt) this.byAttempt.set(attempt, spend);
    this.open.delete(attribution.executionId);
    if (this.open.size >= (this.deps.maxOpenRuns ?? SUB_WORKFLOW_SPEND_MAX_OPEN_RUNS)) {
      const oldest = this.open.keys().next().value!;
      this.flushDropped(this.open.get(oldest), "dropped to keep the open runs bounded");
      this.open.delete(oldest);
    }
    this.open.set(attribution.executionId, spend);
    return spend;
  }

  /** An execution none of whose segments counts any more. */
  forget(executionId: string, execution: ExecutionSpend): void {
    if (this.executions.get(executionId) === execution) this.executions.delete(executionId);
  }

  /** Executions with segments that still count (for tests). */
  get trackedExecutions(): number {
    return this.executions.size;
  }

  /** The run's spend, no longer tracked by id (its own hook keeps it for late async children). */
  take(executionId: string): RunSubWorkflowSpend | undefined {
    const spend = this.open.get(executionId);
    this.open.delete(executionId);
    return spend;
  }

  /**
   * A run that stops without a usage row of its own (a queue that stopped it, a failed resume): records what it held.
   * With `attempt`, only that attempt's segment: a retry of the execution that started since keeps its own, and its
   * children still join its row.
   */
  async abandon(executionId: string, reason: string, attempt?: object): Promise<void> {
    let spend: RunSubWorkflowSpend | undefined;
    if (attempt) {
      spend = this.byAttempt.get(attempt);
      this.byAttempt.delete(attempt);
      if (spend && this.open.get(executionId) === spend) this.open.delete(executionId);
    } else {
      spend = this.take(executionId);
    }
    if (!spend) return;
    if (spend.holdsSpend()) {
      this.deps.logger.warn({ executionId, reason }, "A run stopped without its usage row; its sub-workflows' spend is recorded on its own");
    }
    await spend.closeDetached();
  }

  private flushDropped(spend: RunSubWorkflowSpend | undefined, reason: string): void {
    if (!spend) return;
    const holds = spend.holdsSpend();
    if (holds) {
      this.deps.logger.warn(
        { executionId: spend.attribution.executionId, reason },
        "A run's sub-workflow spend was still held; it is recorded on its own"
      );
    }
    spend.closeDetached().catch((error: unknown) => {
      this.deps.logger.warn(
        { executionId: spend.attribution.executionId, error: error instanceof Error ? error.message : String(error) },
        "Failed to record a run's held sub-workflow spend"
      );
    });
  }

  price(telemetry: Record<string, unknown>[]): Spend {
    const totals = this.deps.usageService.totalTelemetry(telemetry);
    return { costUsd: totals.costUsd, totalTokens: totals.totalTokens };
  }

  /** One usage row per child, for the run's execution and attribution, then the budget alerts it crossed. */
  async recordDetached(attribution: RunUsageAttribution, usages: HeldUsage[]): Promise<void> {
    const user = usageUserOf(attribution.triggeredBy, attribution.gatewayUsage);
    const gateway = attribution.gatewayUsage;
    for (const usage of usages) {
      try {
        const totals = await this.deps.usageService.recordExecution({
          executionId: attribution.executionId,
          workflowId: attribution.workflowId,
          workflowName: attribution.workflowName,
          userEmail: user.email,
          userId: user.id,
          projectId: attribution.projectId,
          triggerType: SUB_WORKFLOW_USAGE_TRIGGER,
          ...(gateway ? { clientId: gateway.clientId, toolsetId: gateway.toolsetId } : {}),
          status: usage.status,
          durationMs: usage.durationMs,
          nodeResults: {},
          subWorkflowTelemetry: usage.telemetry
        });
        await this.deps.budgetService.recordExecution({
          executionId: attribution.executionId,
          workflowId: attribution.workflowId,
          projectId: attribution.projectId,
          userEmail: user.email,
          userId: user.id,
          ...(gateway ? { client: { id: gateway.clientId, name: gateway.clientName }, toolsetProjectId: gateway.toolsetProjectId } : {}),
          spentUsd: totals.costUsd,
          spentTokens: totals.totalTokens
        });
      } catch (error) {
        this.deps.logger.warn(
          { executionId: attribution.executionId, subWorkflowId: usage.workflowId, error: error instanceof Error ? error.message : String(error) },
          "Failed to record a sub-workflow's usage"
        );
      }
    }
  }
}
