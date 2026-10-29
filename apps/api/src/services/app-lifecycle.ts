/**
 * Phase 13.1 — readiness and graceful shutdown for one API process.
 *
 * `/ready` answers 503 while the process drains for shutdown or while any registered readiness check reports a reason
 * (the cluster bus adds one while it is disconnected). `/health` stays the liveness probe and does not change.
 *
 * `drain()` runs once, on SIGTERM/SIGINT (index.ts): readiness turns false at once, then each registered step runs in
 * order with what is left of the time budget (stop claiming and resign leadership, then let queue jobs finish and give
 * back the rest). The caller closes the app afterwards.
 */

export type ReadinessCheck = () => string | null;
export type DrainStep = (budgetMs: number) => Promise<void>;

export interface DrainLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

export class AppLifecycle {
  private draining = false;
  private drainRun: Promise<void> | null = null;
  private readonly checks = new Map<string, ReadinessCheck>();
  private readonly steps: Array<{ name: string; run: DrainStep }> = [];
  private logger: DrainLogger | null = null;

  setLogger(logger: DrainLogger): void {
    this.logger = logger;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** A named check: it returns why the process is not ready, or null. A later check of the same name replaces it. */
  addReadinessCheck(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  readiness(): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (this.draining) reasons.push("draining");
    for (const [name, check] of this.checks) {
      try {
        const reason = check();
        if (reason) reasons.push(reason);
      } catch (error) {
        reasons.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ready: reasons.length === 0, reasons };
  }

  /** A step of the shutdown drain; steps run in the order they were added. */
  onDrain(name: string, run: DrainStep): void {
    this.steps.push({ name, run });
  }

  /** Runs the drain once (later calls wait for the same run). Never throws: a failing step is logged and skipped. */
  async drain(timeoutMs: number): Promise<void> {
    if (!this.drainRun) {
      this.draining = true;
      this.drainRun = this.runSteps(Math.max(0, timeoutMs));
    }
    await this.drainRun;
  }

  private async runSteps(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const step of this.steps) {
      const budgetMs = Math.max(0, deadline - Date.now());
      try {
        await step.run(budgetMs);
      } catch (error) {
        this.logger?.warn("A shutdown step failed", { step: step.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
