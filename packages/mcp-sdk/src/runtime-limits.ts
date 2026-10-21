import {
  normalizeMcpRuntimeLimits,
  type McpBreakerSettings,
  type McpBreakerState,
  type McpBreakerTransition,
  type McpRuntimeLimits,
  type McpRuntimeRejection,
  type McpRuntimeStateView,
  type McpToolErrorKind,
  type McpToolLimitRule,
  type MCPServerConfig,
  type MCPToolResult
} from "@ai-orchestrator/shared";
import { isServerFailureKind, toolResultErrorKind } from "./errors";
import { matchesToolPattern } from "./tool-policy";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

/**
 * Phase 10.7 — rate limits, concurrency caps, per-call timeouts and a
 * circuit breaker for registry MCP servers.
 *
 * One `McpRuntimeGuard` lives in the API process and is shared by every
 * caller of the registry (workflow runs, the gateway, the playground), so a
 * server's budget is the same whoever calls it. State is in memory: limits
 * are per API instance until horizontal scaling (Phase 13.1) shares them.
 *
 * Order for one `tools/call`:
 *   1. breaker: open → refused at once (`circuit_open`); half-open lets one
 *      probe call through and refuses the rest;
 *   2. rate limits: server bucket, then the tool's bucket. A call waits for a
 *      token when one comes within `maxQueueWaitMs`, else it is refused with
 *      the time until the next token (`rate_limited`);
 *   3. concurrency: server slots, then the tool's slots. A call queues for up
 *      to `maxQueueWaitMs`, then fails (`concurrency_limited`);
 *   4. the call, with the timeout override passed to the adapter
 *      (`context.callTimeoutMs`) and enforced here as a backstop;
 *   5. the outcome feeds the breaker: transport, protocol and timeout
 *      failures count; tool errors, rejected arguments and bad structured
 *      output mean the server answered (they count as successes); cancelled
 *      calls, missing credentials and sandbox refusals are not counted.
 *      Policy-blocked calls never reach this wrapper.
 */

export interface McpRuntimeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real time, read at call time so test fake timers apply. */
export const SYSTEM_CLOCK: McpRuntimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
};

const MESSAGE_PREFIX: Record<McpRuntimeRejection, string> = {
  rate_limited: "Rate limited:",
  concurrency_limited: "Concurrency limit:",
  circuit_open: "Circuit open:"
};

/** Which runtime rejection an error message describes, if any (telemetry reads traces with it). */
export function parseMcpRuntimeRejection(message: unknown): McpRuntimeRejection | null {
  if (typeof message !== "string") return null;
  const text = message.trim();
  for (const [kind, prefix] of Object.entries(MESSAGE_PREFIX) as Array<[McpRuntimeRejection, string]>) {
    if (text.startsWith(prefix)) return kind;
  }
  return null;
}

function seconds(ms: number): string {
  const value = Math.max(1, Math.ceil(ms / 1000));
  return `${value} s`;
}

// Token bucket -------------------------------------------------------------------

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private ratePerMinute: number,
    private capacity: number,
    now: number
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  configure(ratePerMinute: number, capacity: number, now: number): void {
    this.refill(now);
    this.ratePerMinute = ratePerMinute;
    this.capacity = capacity;
    this.tokens = Math.min(this.tokens, capacity);
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.ratePerMinute) / 60_000);
  }

  /**
   * Take a token. When none is left, reserve the next one if it comes within
   * `maxWaitMs` (the caller waits `waitMs`); otherwise refuse with the time
   * until a token is free.
   */
  reserve(now: number, maxWaitMs: number): { ok: true; waitMs: number } | { ok: false; retryAfterMs: number } {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, waitMs: 0 };
    }
    const waitMs = Math.ceil(((1 - this.tokens) * 60_000) / this.ratePerMinute);
    if (waitMs <= maxWaitMs) {
      this.tokens -= 1;
      return { ok: true, waitMs };
    }
    return { ok: false, retryAfterMs: waitMs };
  }

  /** Give back a token taken by a call that was then refused elsewhere. */
  refund(): void {
    this.tokens = Math.min(this.capacity, this.tokens + 1);
  }

  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }
}

// Concurrency gate ----------------------------------------------------------------

const MAX_QUEUE_LENGTH = 1_000;

class GateTimeoutError extends Error {}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export class ConcurrencyGate {
  inFlight = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private limit: number,
    private readonly clock: McpRuntimeClock
  ) {}

  setLimit(limit: number): void {
    this.limit = limit;
    this.drain();
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Resolve with a release function once a slot is free; reject after `maxWaitMs` or on abort. */
  acquire(maxWaitMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.inFlight < this.limit && this.queue.length === 0) {
      this.inFlight += 1;
      return Promise.resolve(this.releaser());
    }
    if (maxWaitMs <= 0 || this.queue.length >= MAX_QUEUE_LENGTH) {
      return Promise.reject(new GateTimeoutError("no free slot"));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(this.releaser());
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer: null
      };
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const onAbort = () => {
        remove();
        this.clock.clearTimeout(waiter.timer);
        waiter.reject(new Error("canceled"));
      };
      waiter.timer = this.clock.setTimeout(() => {
        remove();
        waiter.reject(new GateTimeoutError("queue wait ran out"));
      }, maxWaitMs);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.inFlight < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.clock.clearTimeout(next.timer);
      this.inFlight += 1;
      next.resolve();
    }
  }
}

// Circuit breaker -----------------------------------------------------------------

export type BreakerOutcome = "success" | "failure" | "neutral";

export class CircuitBreaker {
  state: McpBreakerState = "closed";
  since: number | null = null;
  consecutiveFailures = 0;
  retryAt: number | null = null;
  lastError: string | null = null;
  lastFailureAt: number | null = null;
  private probeInFlight = false;
  private window: Array<{ at: number; failed: boolean }> = [];

  constructor(
    readonly serverId: string,
    private settings: McpBreakerSettings,
    private readonly clock: McpRuntimeClock,
    private readonly onTransition: (transition: McpBreakerTransition) => void
  ) {}

  configure(settings: McpBreakerSettings): void {
    this.settings = settings;
    if (!settings.enabled && this.state !== "closed") {
      this.transition("closed", "The breaker was turned off.");
    }
  }

  private prune(now: number): void {
    const from = now - this.settings.windowMs;
    while (this.window.length > 0 && this.window[0]!.at < from) this.window.shift();
  }

  windowStats(now: number): { calls: number; failures: number } {
    this.prune(now);
    return { calls: this.window.length, failures: this.window.filter((entry) => entry.failed).length };
  }

  /** Whether a call may go ahead now; `probe` marks the single half-open trial call. */
  admit(now: number): { ok: true; probe: boolean } | { ok: false; retryAfterMs: number; probing: boolean } {
    if (!this.settings.enabled) return { ok: true, probe: false };
    if (this.state === "open") {
      if (this.retryAt !== null && now < this.retryAt) {
        return { ok: false, retryAfterMs: this.retryAt - now, probing: false };
      }
      this.transition("half_open", "Cool-down over; one probe call is let through.");
    }
    if (this.state === "half_open") {
      if (this.probeInFlight) {
        return { ok: false, retryAfterMs: Math.min(this.settings.cooldownMs, 5_000), probing: true };
      }
      this.probeInFlight = true;
      return { ok: true, probe: true };
    }
    return { ok: true, probe: false };
  }

  /** Release a probe slot that never reached the server (refused by a limit). */
  abandonProbe(): void {
    this.probeInFlight = false;
  }

  record(outcome: BreakerOutcome, probe: boolean, error?: string): void {
    if (!this.settings.enabled) return;
    const now = this.clock.now();
    if (probe) this.probeInFlight = false;
    if (outcome === "neutral") return;
    if (outcome === "success") {
      this.consecutiveFailures = 0;
      if (this.state === "half_open" && probe) {
        this.window = [];
        this.transition("closed", "The probe call succeeded.");
        return;
      }
      if (this.state === "closed") this.window.push({ at: now, failed: false });
      return;
    }
    this.consecutiveFailures += 1;
    this.lastError = error ? error.slice(0, 500) : this.lastError;
    this.lastFailureAt = now;
    if (this.state === "half_open") {
      if (probe) this.open(now, "The probe call failed.");
      return;
    }
    if (this.state !== "closed") return;
    this.window.push({ at: now, failed: true });
    if (this.consecutiveFailures >= this.settings.failureThreshold) {
      this.open(now, `${this.consecutiveFailures} consecutive failures.`);
      return;
    }
    const stats = this.windowStats(now);
    if (stats.calls >= this.settings.minimumCalls && (stats.failures / stats.calls) * 100 >= this.settings.errorRatePercent) {
      const percent = Math.round((stats.failures / stats.calls) * 100);
      this.open(now, `${percent}% of ${stats.calls} calls failed in the last ${seconds(this.settings.windowMs)}.`);
    }
  }

  /** Close the breaker by hand (an admin reset). */
  reset(reason: string): void {
    this.consecutiveFailures = 0;
    this.window = [];
    this.probeInFlight = false;
    if (this.state !== "closed") this.transition("closed", reason);
  }

  private open(now: number, reason: string): void {
    this.retryAt = now + this.settings.cooldownMs;
    this.transition("open", reason);
  }

  private transition(to: McpBreakerState, reason: string): void {
    const from = this.state;
    if (from === to) return;
    const now = this.clock.now();
    this.state = to;
    this.since = now;
    if (to === "closed") {
      this.retryAt = null;
      this.consecutiveFailures = 0;
    }
    if (to !== "half_open") this.probeInFlight = false;
    this.onTransition({
      serverId: this.serverId,
      from,
      to,
      at: new Date(now).toISOString(),
      reason,
      consecutiveFailures: this.consecutiveFailures,
      retryAt: this.retryAt !== null && to === "open" ? new Date(this.retryAt).toISOString() : null,
      lastError: this.lastError
    });
  }
}

// Guard ------------------------------------------------------------------------------

const MAX_TOOL_ENTRIES = 500;

interface ToolState {
  bucket?: TokenBucket;
  gate?: ConcurrencyGate;
  rule: McpToolLimitRule;
}

interface ServerState {
  limitsKey: string;
  limits: McpRuntimeLimits;
  bucket?: TokenBucket;
  gate?: ConcurrencyGate;
  breaker: CircuitBreaker;
  tools: Map<string, ToolState>;
  rejected: Record<McpRuntimeRejection, number>;
}

export interface McpRuntimeRejectionEvent {
  serverId: string;
  toolName: string;
  kind: McpRuntimeRejection;
  retryAfterMs: number;
}

export interface McpRuntimeGuardOptions {
  clock?: McpRuntimeClock;
  onBreakerTransition?: (transition: McpBreakerTransition) => void;
  onRejection?: (event: McpRuntimeRejectionEvent) => void;
}

function rejection(kind: McpRuntimeRejection, message: string, retryAfterMs: number): MCPToolResult {
  return { ok: false, output: null, error: message, errorKind: kind, retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) };
}

export class McpRuntimeGuard {
  private readonly servers = new Map<string, ServerState>();
  private readonly clock: McpRuntimeClock;

  constructor(private readonly options: McpRuntimeGuardOptions = {}) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  private stateFor(serverId: string, rawLimits: McpRuntimeLimits | undefined): ServerState {
    const limits = normalizeMcpRuntimeLimits(rawLimits ?? {});
    const limitsKey = JSON.stringify(limits);
    const now = this.clock.now();
    let state = this.servers.get(serverId);
    if (!state) {
      state = {
        limitsKey: "",
        limits,
        breaker: new CircuitBreaker(serverId, limits.breaker, this.clock, (transition) => this.options.onBreakerTransition?.(transition)),
        tools: new Map(),
        rejected: { rate_limited: 0, concurrency_limited: 0, circuit_open: 0 }
      };
      this.servers.set(serverId, state);
    }
    if (state.limitsKey !== limitsKey) {
      state.limitsKey = limitsKey;
      state.limits = limits;
      state.breaker.configure(limits.breaker);
      if (limits.requestsPerMinute) {
        const capacity = limits.burst ?? limits.requestsPerMinute;
        if (state.bucket) state.bucket.configure(limits.requestsPerMinute, capacity, now);
        else state.bucket = new TokenBucket(limits.requestsPerMinute, capacity, now);
      } else {
        delete state.bucket;
      }
      if (limits.maxConcurrent) {
        if (state.gate) state.gate.setLimit(limits.maxConcurrent);
        else state.gate = new ConcurrencyGate(limits.maxConcurrent, this.clock);
      } else {
        delete state.gate;
      }
      // Tool rules may have changed; idle tool budgets start again, busy ones keep their gate.
      for (const [name, tool] of state.tools) {
        if (!tool.gate || tool.gate.inFlight === 0) state.tools.delete(name);
      }
    }
    return state;
  }

  private toolStateFor(state: ServerState, toolName: string): ToolState | null {
    const rule = state.limits.tools.find((entry) => matchesToolPattern(entry.pattern, toolName));
    if (!rule) return null;
    const existing = state.tools.get(toolName);
    if (existing && JSON.stringify(existing.rule) === JSON.stringify(rule)) return existing;
    const now = this.clock.now();
    const next: ToolState = { rule };
    if (rule.requestsPerMinute) next.bucket = new TokenBucket(rule.requestsPerMinute, rule.requestsPerMinute, now);
    if (rule.maxConcurrent) next.gate = existing?.gate ?? new ConcurrencyGate(rule.maxConcurrent, this.clock);
    next.gate?.setLimit(rule.maxConcurrent ?? Number.POSITIVE_INFINITY);
    if (state.tools.size >= MAX_TOOL_ENTRIES && !state.tools.has(toolName)) {
      const oldest = state.tools.keys().next().value;
      if (oldest !== undefined) state.tools.delete(oldest);
    }
    state.tools.set(toolName, next);
    return next;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const handle = this.clock.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clock.clearTimeout(handle);
        reject(new Error("canceled"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private reject(state: ServerState, serverId: string, toolName: string, result: MCPToolResult): MCPToolResult {
    const kind = result.errorKind as McpRuntimeRejection;
    state.rejected[kind] += 1;
    this.options.onRejection?.({ serverId, toolName, kind, retryAfterMs: result.retryAfterMs ?? 0 });
    return result;
  }

  /**
   * Run one tool call under the server's limits. Calls without a registry
   * server id (inline servers) and probe calls pass straight through.
   */
  async run(
    config: MCPServerConfig,
    toolName: string,
    context: MCPExecutionContext,
    invoke: (context: MCPExecutionContext) => Promise<MCPToolResult>
  ): Promise<MCPToolResult> {
    const serverId = config.registryServerId;
    if (!serverId || context.bypassRuntimeLimits) return invoke(context);
    const state = this.stateFor(serverId, config.limits);
    const limits = state.limits;
    const label = config.label ?? serverId;
    const tool = this.toolStateFor(state, toolName);
    const toolScope = tool ? ` for tool '${toolName}' (rule '${tool.rule.pattern}')` : "";

    // 1. Breaker.
    const admitted = state.breaker.admit(this.clock.now());
    if (!admitted.ok) {
      const message = admitted.probing
        ? `${MESSAGE_PREFIX.circuit_open} MCP server '${label}' is paused after repeated failures and one probe call is checking whether it recovered. Retry in ${seconds(admitted.retryAfterMs)}.`
        : `${MESSAGE_PREFIX.circuit_open} MCP server '${label}' is paused after repeated failures. Retry in ${seconds(admitted.retryAfterMs)}; calls are refused until then so the server can recover.`;
      return this.reject(state, serverId, toolName, rejection("circuit_open", message, admitted.retryAfterMs));
    }
    const probe = admitted.probe;
    const releases: Array<() => void> = [];
    try {
      // 2. Rate limits.
      const now = this.clock.now();
      let waitMs = 0;
      let takenFromServer = false;
      if (state.bucket) {
        const reserved = state.bucket.reserve(now, limits.maxQueueWaitMs);
        if (!reserved.ok) {
          if (probe) state.breaker.abandonProbe();
          return this.reject(
            state,
            serverId,
            toolName,
            rejection(
              "rate_limited",
              `${MESSAGE_PREFIX.rate_limited} MCP server '${label}' allows ${limits.requestsPerMinute} calls per minute. Retry in ${seconds(reserved.retryAfterMs)}.`,
              reserved.retryAfterMs
            )
          );
        }
        takenFromServer = true;
        waitMs = Math.max(waitMs, reserved.waitMs);
      }
      if (tool?.bucket) {
        const reserved = tool.bucket.reserve(now, limits.maxQueueWaitMs);
        if (!reserved.ok) {
          if (takenFromServer) state.bucket?.refund();
          if (probe) state.breaker.abandonProbe();
          return this.reject(
            state,
            serverId,
            toolName,
            rejection(
              "rate_limited",
              `${MESSAGE_PREFIX.rate_limited} MCP server '${label}' allows ${tool.rule.requestsPerMinute} calls per minute${toolScope}. Retry in ${seconds(reserved.retryAfterMs)}.`,
              reserved.retryAfterMs
            )
          );
        }
        waitMs = Math.max(waitMs, reserved.waitMs);
      }
      if (waitMs > 0) {
        try {
          await this.sleep(waitMs, context.signal);
        } catch {
          if (probe) state.breaker.abandonProbe();
          return { ok: false, output: null, error: "MCP tool call canceled while waiting for its rate limit.", errorKind: "canceled" };
        }
      }

      // 3. Concurrency.
      const queueStarted = this.clock.now();
      const gates: Array<{ gate: ConcurrencyGate; limit: number; scope: string }> = [];
      if (state.gate && limits.maxConcurrent) gates.push({ gate: state.gate, limit: limits.maxConcurrent, scope: "" });
      if (tool?.gate && tool.rule.maxConcurrent) gates.push({ gate: tool.gate, limit: tool.rule.maxConcurrent, scope: toolScope });
      for (const entry of gates) {
        const remaining = Math.max(0, limits.maxQueueWaitMs - (this.clock.now() - queueStarted));
        try {
          releases.push(await entry.gate.acquire(remaining, context.signal));
        } catch (error) {
          if (probe) state.breaker.abandonProbe();
          if (error instanceof GateTimeoutError) {
            return this.reject(
              state,
              serverId,
              toolName,
              rejection(
                "concurrency_limited",
                `${MESSAGE_PREFIX.concurrency_limited} MCP server '${label}' already has ${entry.limit} calls in flight${entry.scope} and none finished within ${seconds(limits.maxQueueWaitMs)}. Retry in a moment.`,
                1_000
              )
            );
          }
          return { ok: false, output: null, error: "MCP tool call canceled while queued.", errorKind: "canceled" };
        }
      }

      // 4. The call.
      const timeoutMs = tool?.rule.timeoutMs ?? limits.timeoutMs;
      const result = await this.invokeWithTimeout(invoke, context, timeoutMs, label, toolName);

      // 5. Feed the breaker.
      const kind: McpToolErrorKind | undefined = toolResultErrorKind(result);
      const outcome: BreakerOutcome = result.ok
        ? "success"
        : kind === "canceled" || kind === "credentials" || kind === "sandbox"
          ? "neutral"
          : isServerFailureKind(kind)
            ? "failure"
            : "success";
      state.breaker.record(outcome, probe, outcome === "failure" ? result.error : undefined);
      return result;
    } catch (error) {
      // The adapter threw instead of reporting: the server failed.
      state.breaker.record("failure", probe, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      for (const release of releases) release();
    }
  }

  private async invokeWithTimeout(
    invoke: (context: MCPExecutionContext) => Promise<MCPToolResult>,
    context: MCPExecutionContext,
    timeoutMs: number | null,
    label: string,
    toolName: string
  ): Promise<MCPToolResult> {
    if (!timeoutMs) return invoke(context);
    const controller = new AbortController();
    const parent = context.signal;
    const forward = () => controller.abort(parent?.reason);
    if (parent?.aborted) forward();
    parent?.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    // The adapter gets the timeout itself; the backstop also covers adapters that ignore it.
    const handle = this.clock.setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs + 1_000);
    try {
      const result = await invoke({ ...context, signal: controller.signal, callTimeoutMs: timeoutMs });
      if (!result.ok && (timedOut || result.errorKind === "timeout")) {
        return {
          ...result,
          error: `MCP tool '${toolName}' on '${label}' timed out after ${seconds(timeoutMs)} (the server's call timeout).`,
          errorKind: "timeout"
        };
      }
      return result;
    } finally {
      this.clock.clearTimeout(handle);
      parent?.removeEventListener("abort", forward);
    }
  }

  /** The runtime state of one server on this instance (closed and idle when never called). */
  snapshot(serverId: string): McpRuntimeStateView {
    const state = this.servers.get(serverId);
    const now = this.clock.now();
    if (!state) {
      return {
        serverId,
        breaker: {
          state: "closed",
          since: null,
          consecutiveFailures: 0,
          windowCalls: 0,
          windowFailures: 0,
          retryAt: null,
          lastError: null,
          lastFailureAt: null
        },
        inFlight: 0,
        queued: 0,
        rejected: { rate_limited: 0, concurrency_limited: 0, circuit_open: 0 }
      };
    }
    const breaker = state.breaker;
    const stats = breaker.windowStats(now);
    let toolInFlight = 0;
    let toolQueued = 0;
    for (const tool of state.tools.values()) {
      toolInFlight += tool.gate?.inFlight ?? 0;
      toolQueued += tool.gate?.queued ?? 0;
    }
    return {
      serverId,
      breaker: {
        state: breaker.state,
        since: breaker.since !== null ? new Date(breaker.since).toISOString() : null,
        consecutiveFailures: breaker.consecutiveFailures,
        windowCalls: stats.calls,
        windowFailures: stats.failures,
        retryAt: breaker.state === "open" && breaker.retryAt !== null ? new Date(breaker.retryAt).toISOString() : null,
        lastError: breaker.lastError,
        lastFailureAt: breaker.lastFailureAt !== null ? new Date(breaker.lastFailureAt).toISOString() : null
      },
      inFlight: state.gate ? state.gate.inFlight : toolInFlight,
      queued: (state.gate?.queued ?? 0) + toolQueued,
      rejected: { ...state.rejected }
    };
  }

  /** Every server this instance has state for. */
  snapshots(): McpRuntimeStateView[] {
    return [...this.servers.keys()].map((serverId) => this.snapshot(serverId));
  }

  /** Close a server's breaker by hand. Returns false when it was already closed. */
  resetBreaker(serverId: string, reason = "Reset by an admin."): boolean {
    const state = this.servers.get(serverId);
    if (!state || state.breaker.state === "closed") {
      if (state) state.breaker.reset(reason);
      return false;
    }
    state.breaker.reset(reason);
    return true;
  }

  /** Drop a server's state (it was deleted). */
  forget(serverId: string): void {
    this.servers.delete(serverId);
  }
}

/**
 * Wrap an adapter so its tool calls run under `guard`. Every other method
 * passes through unchanged (discovery, resources and prompts are not
 * limited; probes and cassette replays never reach the guard).
 */
export function withRuntimeLimits<T extends MCPServerAdapter>(adapter: T, guard: McpRuntimeGuard): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "invokeTool" || typeof value !== "function") {
        return typeof value === "function" && property !== "constructor" ? value.bind(target) : value;
      }
      return (toolName: string, args: Record<string, unknown>, config: MCPServerConfig, context: MCPExecutionContext) =>
        guard.run(config, toolName, context, (callContext) =>
          (value as MCPServerAdapter["invokeTool"]).call(target, toolName, args, config, callContext)
        );
    }
  });
}
