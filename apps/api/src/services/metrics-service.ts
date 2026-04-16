import os from "node:os";

export interface MetricsOptions {
  enabled?: boolean;
  prefix?: string;
  includeProcess?: boolean;
  sloSuccessTarget?: number;
  sloP95LatencyMs?: number;
}

interface HistogramBucket {
  le: number;
  count: number;
}

class Histogram {
  private readonly bucketBounds: number[];
  private readonly buckets: HistogramBucket[];
  private sum = 0;
  private count = 0;
  private values: number[] = [];

  constructor(bounds: number[] = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]) {
    this.bucketBounds = [...bounds].sort((a, b) => a - b);
    this.buckets = this.bucketBounds.map((le) => ({ le, count: 0 }));
  }

  observe(value: number): void {
    this.sum += value;
    this.count += 1;
    this.values.push(value);
    if (this.values.length > 10000) this.values.shift();
    for (const bucket of this.buckets) {
      if (value <= bucket.le) bucket.count += 1;
    }
  }

  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(Math.ceil(p * sorted.length) - 1, sorted.length - 1);
    return sorted[Math.max(0, idx)]!;
  }

  getSum(): number {
    return this.sum;
  }

  getCount(): number {
    return this.count;
  }

  getBuckets(): HistogramBucket[] {
    return this.buckets;
  }
}

export interface SloStatus {
  successTarget: number;
  p95LatencyTargetMs: number;
  currentSuccessRate: number;
  currentP95LatencyMs: number;
  successBudgetRemaining: number;
  latencyBudgetRemaining: number;
  healthy: boolean;
}

/**
 * Collects and exposes Prometheus-formatted metrics for the ai-orchestrator.
 * Counter/gauge/histogram state lives in memory — no external deps.
 */
export class MetricsService {
  private readonly prefix: string;
  private readonly includeProcess: boolean;
  private readonly sloSuccessTarget: number;
  private readonly sloP95LatencyMs: number;
  private readonly enabled: boolean;

  private httpRequestsTotal = 0;
  private httpRequestDuration = new Histogram();
  private httpRequestsByMethod = new Map<string, number>();
  private httpRequestsByStatus = new Map<string, number>();

  private executionsTotal = 0;
  private executionsSuccess = 0;
  private executionsFailure = 0;
  private executionDuration = new Histogram();
  private activeExecutionsGauge = 0;
  private nodeExecutionDuration = new Histogram([10, 50, 100, 250, 500, 1000, 5000, 10000]);

  private readonly startTime = Date.now();

  constructor(options: MetricsOptions = {}) {
    this.enabled = options.enabled !== false;
    this.prefix = options.prefix ?? "ao";
    this.includeProcess = options.includeProcess !== false;
    this.sloSuccessTarget = options.sloSuccessTarget ?? 0.99;
    this.sloP95LatencyMs = options.sloP95LatencyMs ?? 30000;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordHttpRequest(method: string, statusCode: number, durationMs: number): void {
    if (!this.enabled) return;
    this.httpRequestsTotal += 1;
    this.httpRequestDuration.observe(durationMs);
    const methodKey = method.toUpperCase();
    this.httpRequestsByMethod.set(methodKey, (this.httpRequestsByMethod.get(methodKey) ?? 0) + 1);
    const statusBucket = `${Math.floor(statusCode / 100)}xx`;
    this.httpRequestsByStatus.set(statusBucket, (this.httpRequestsByStatus.get(statusBucket) ?? 0) + 1);
  }

  recordExecution(status: "success" | "error" | "canceled", durationMs: number): void {
    if (!this.enabled) return;
    this.executionsTotal += 1;
    if (status === "success") this.executionsSuccess += 1;
    else this.executionsFailure += 1;
    this.executionDuration.observe(durationMs);
  }

  recordNodeExecution(durationMs: number): void {
    if (!this.enabled) return;
    this.nodeExecutionDuration.observe(durationMs);
  }

  setActiveExecutions(count: number): void {
    this.activeExecutionsGauge = count;
  }

  getSloStatus(): SloStatus {
    const total = this.executionsTotal || 1;
    const successRate = this.executionsSuccess / total;
    const p95 = this.executionDuration.percentile(0.95);
    return {
      successTarget: this.sloSuccessTarget,
      p95LatencyTargetMs: this.sloP95LatencyMs,
      currentSuccessRate: Math.round(successRate * 10000) / 10000,
      currentP95LatencyMs: Math.round(p95),
      successBudgetRemaining: Math.round((successRate - this.sloSuccessTarget) * 10000) / 10000,
      latencyBudgetRemaining: Math.round(this.sloP95LatencyMs - p95),
      healthy: successRate >= this.sloSuccessTarget && p95 <= this.sloP95LatencyMs
    };
  }

  getSnapshot(): {
    httpRequestsTotal: number;
    executionsTotal: number;
    executionsSuccess: number;
    executionsFailure: number;
    activeExecutions: number;
    executionP50Ms: number;
    executionP95Ms: number;
    executionP99Ms: number;
    httpP50Ms: number;
    httpP95Ms: number;
    slo: SloStatus;
    uptimeSeconds: number;
  } {
    return {
      httpRequestsTotal: this.httpRequestsTotal,
      executionsTotal: this.executionsTotal,
      executionsSuccess: this.executionsSuccess,
      executionsFailure: this.executionsFailure,
      activeExecutions: this.activeExecutionsGauge,
      executionP50Ms: Math.round(this.executionDuration.percentile(0.5)),
      executionP95Ms: Math.round(this.executionDuration.percentile(0.95)),
      executionP99Ms: Math.round(this.executionDuration.percentile(0.99)),
      httpP50Ms: Math.round(this.httpRequestDuration.percentile(0.5)),
      httpP95Ms: Math.round(this.httpRequestDuration.percentile(0.95)),
      slo: this.getSloStatus(),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }

  formatPrometheus(): string {
    const p = this.prefix;
    const lines: string[] = [];

    const g = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    };
    const c = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    };
    const h = (name: string, help: string, hist: Histogram) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const b of hist.getBuckets()) {
        lines.push(`${name}_bucket{le="${b.le}"} ${b.count}`);
      }
      lines.push(`${name}_bucket{le="+Inf"} ${hist.getCount()}`);
      lines.push(`${name}_sum ${hist.getSum()}`);
      lines.push(`${name}_count ${hist.getCount()}`);
    };

    c(`${p}_http_requests_total`, "Total HTTP requests processed", this.httpRequestsTotal);
    for (const [method, count] of this.httpRequestsByMethod) {
      lines.push(`${p}_http_requests_by_method{method="${method}"} ${count}`);
    }
    for (const [status, count] of this.httpRequestsByStatus) {
      lines.push(`${p}_http_requests_by_status{status="${status}"} ${count}`);
    }
    h(`${p}_http_request_duration_ms`, "HTTP request duration in ms", this.httpRequestDuration);

    c(`${p}_workflow_executions_total`, "Total workflow executions", this.executionsTotal);
    c(`${p}_workflow_executions_success_total`, "Successful executions", this.executionsSuccess);
    c(`${p}_workflow_executions_failure_total`, "Failed/canceled executions", this.executionsFailure);
    g(`${p}_workflow_executions_active`, "Currently active workflow executions", this.activeExecutionsGauge);
    h(`${p}_workflow_execution_duration_ms`, "Workflow execution duration in ms", this.executionDuration);
    h(`${p}_node_execution_duration_ms`, "Node execution duration in ms", this.nodeExecutionDuration);

    const slo = this.getSloStatus();
    g(`${p}_slo_success_rate`, "Current execution success rate", slo.currentSuccessRate);
    g(`${p}_slo_success_target`, "Target execution success rate", slo.successTarget);
    g(`${p}_slo_success_budget_remaining`, "Remaining success error budget", slo.successBudgetRemaining);
    g(`${p}_slo_p95_latency_ms`, "Current p95 execution latency in ms", slo.currentP95LatencyMs);
    g(`${p}_slo_p95_latency_target_ms`, "Target p95 latency in ms", slo.p95LatencyTargetMs);
    g(`${p}_slo_latency_budget_remaining_ms`, "Remaining latency budget in ms", slo.latencyBudgetRemaining);
    g(`${p}_slo_healthy`, "1 if SLOs are met, 0 otherwise", slo.healthy ? 1 : 0);

    g(`${p}_uptime_seconds`, "Process uptime in seconds", Math.floor((Date.now() - this.startTime) / 1000));

    if (this.includeProcess) {
      const mem = process.memoryUsage();
      g(`${p}_process_heap_used_bytes`, "Process heap used bytes", mem.heapUsed);
      g(`${p}_process_heap_total_bytes`, "Process heap total bytes", mem.heapTotal);
      g(`${p}_process_rss_bytes`, "Process resident set size bytes", mem.rss);
      g(`${p}_process_external_bytes`, "Process external memory bytes", mem.external);
      const cpus = os.cpus();
      g(`${p}_system_cpu_count`, "Number of logical CPUs", cpus.length);
      g(`${p}_system_memory_total_bytes`, "Total system memory", os.totalmem());
      g(`${p}_system_memory_free_bytes`, "Free system memory", os.freemem());
      g(`${p}_system_load_avg_1m`, "System load average 1m", os.loadavg()[0]!);
    }

    return lines.join("\n") + "\n";
  }
}
