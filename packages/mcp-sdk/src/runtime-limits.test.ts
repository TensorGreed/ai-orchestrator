import { describe, expect, it } from "vitest";
import type { McpBreakerTransition, McpRuntimeLimits, MCPServerConfig, MCPToolResult } from "@ai-orchestrator/shared";
import { MCPRegistry } from "./registry";
import { McpJsonRpcError, McpTimeoutError } from "./errors";
import { invokeDirectMCPTool, resolveMCPTools } from "./tool-resolution";
import {
  CircuitBreaker,
  ConcurrencyGate,
  McpRuntimeGuard,
  TokenBucket,
  parseMcpRuntimeRejection,
  withRuntimeLimits,
  type McpRuntimeClock
} from "./runtime-limits";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

class FakeClock implements McpRuntimeClock {
  private current = 1_700_000_000_000;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Move time forward, firing due timers in order and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = due.at;
      due.callback();
    }
    this.current = target;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

const context = (): MCPExecutionContext => ({ resolveSecret: async () => undefined });

function config(limits: Partial<McpRuntimeLimits> = {}, registryServerId = "mcp_1"): MCPServerConfig {
  return {
    serverId: "fake",
    registryServerId,
    label: "Fake",
    connection: {},
    limits: limits as McpRuntimeLimits
  };
}

const ok: MCPToolResult = { ok: true, output: "fine" };
const down: MCPToolResult = { ok: false, output: null, error: "connect ECONNREFUSED", errorKind: "transport" };

describe("token bucket", () => {
  it("spends the burst, then refuses with the time until the next token, then refills", () => {
    const bucket = new TokenBucket(60, 2, 0);
    expect(bucket.reserve(0, 0)).toEqual({ ok: true, waitMs: 0 });
    expect(bucket.reserve(0, 0)).toEqual({ ok: true, waitMs: 0 });
    expect(bucket.reserve(0, 0)).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(bucket.reserve(500, 0)).toEqual({ ok: false, retryAfterMs: 500 });
    expect(bucket.reserve(1000, 0)).toEqual({ ok: true, waitMs: 0 });
  });

  it("reserves the next token when it comes within the allowed wait", () => {
    const bucket = new TokenBucket(60, 1, 0);
    bucket.reserve(0, 0);
    expect(bucket.reserve(0, 5_000)).toEqual({ ok: true, waitMs: 1000 });
    // The reservation is honoured: the following call waits behind it.
    expect(bucket.reserve(0, 5_000)).toEqual({ ok: true, waitMs: 2000 });
  });
});

describe("concurrency gate", () => {
  it("queues within the bounded wait and fails fast after it", async () => {
    const clock = new FakeClock();
    const gate = new ConcurrencyGate(1, clock);
    const release = await gate.acquire(1_000);
    const queued = gate.acquire(1_000);
    expect(gate.queued).toBe(1);
    release();
    const second = await queued;
    expect(gate.inFlight).toBe(1);
    const third = gate.acquire(1_000);
    await clock.advance(1_000);
    await expect(third).rejects.toThrow(/queue wait ran out/);
    second();
    expect(gate.inFlight).toBe(0);
  });

  it("leaves the queue when the caller aborts", async () => {
    const gate = new ConcurrencyGate(1, new FakeClock());
    await gate.acquire(1_000);
    const controller = new AbortController();
    const waiting = gate.acquire(10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/canceled/);
    expect(gate.queued).toBe(0);
  });
});

describe("circuit breaker", () => {
  it("opens after consecutive failures, half-opens after the cool-down with one probe, closes on success", () => {
    const clock = new FakeClock();
    const transitions: McpBreakerTransition[] = [];
    const breaker = new CircuitBreaker(
      "mcp_1",
      { enabled: true, failureThreshold: 3, errorRatePercent: 100, windowMs: 60_000, minimumCalls: 100, cooldownMs: 30_000 },
      clock,
      (transition) => transitions.push(transition)
    );
    for (let index = 0; index < 3; index += 1) {
      expect(breaker.admit(clock.now())).toEqual({ ok: true, probe: false });
      breaker.record("failure", false, "boom");
    }
    expect(breaker.state).toBe("open");
    expect(transitions.map((entry) => `${entry.from}>${entry.to}`)).toEqual(["closed>open"]);
    expect(transitions[0]).toMatchObject({ reason: "3 consecutive failures.", lastError: "boom" });
    expect(breaker.admit(clock.now() + 29_999)).toMatchObject({ ok: false, retryAfterMs: 1 });

    const probe = breaker.admit(clock.now() + 30_000);
    expect(probe).toEqual({ ok: true, probe: true });
    expect(breaker.state).toBe("half_open");
    // Only one probe at a time.
    expect(breaker.admit(clock.now() + 30_001)).toMatchObject({ ok: false, probing: true });
    breaker.record("success", true);
    expect(breaker.state).toBe("closed");
    expect(transitions.map((entry) => `${entry.from}>${entry.to}`)).toEqual(["closed>open", "open>half_open", "half_open>closed"]);
  });

  it("re-opens when the probe fails", async () => {
    const clock = new FakeClock();
    const transitions: string[] = [];
    const breaker = new CircuitBreaker("s", { enabled: true, failureThreshold: 1, errorRatePercent: 100, windowMs: 1_000, minimumCalls: 100, cooldownMs: 5_000 }, clock, (t) => transitions.push(t.to));
    breaker.record("failure", false, "x");
    await clock.advance(5_000);
    expect(breaker.admit(clock.now())).toEqual({ ok: true, probe: true });
    breaker.record("failure", true, "still down");
    expect(breaker.state).toBe("open");
    expect(transitions).toEqual(["open", "half_open", "open"]);
    expect(breaker.retryAt).toBe(clock.now() + 5_000);
  });

  it("opens on the error rate over the window once enough calls were made", () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker("s", { enabled: true, failureThreshold: 100, errorRatePercent: 50, windowMs: 60_000, minimumCalls: 4, cooldownMs: 1_000 }, clock, () => undefined);
    breaker.record("success", false);
    breaker.record("failure", false, "a");
    breaker.record("success", false);
    expect(breaker.state).toBe("closed");
    breaker.record("failure", false, "b");
    expect(breaker.state).toBe("open");
  });

  it("does nothing when disabled", () => {
    const breaker = new CircuitBreaker("s", { enabled: false, failureThreshold: 1, errorRatePercent: 1, windowMs: 1_000, minimumCalls: 1, cooldownMs: 1_000 }, new FakeClock(), () => undefined);
    breaker.record("failure", false, "x");
    expect(breaker.admit(0)).toEqual({ ok: true, probe: false });
  });
});

function fakeAdapter(handler: (toolName: string, args: Record<string, unknown>, context: MCPExecutionContext) => Promise<MCPToolResult>): MCPServerAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    definition: { id: "fake", label: "Fake", description: "", configSchema: {}, authSchema: {} },
    discoverTools: async () => [{ serverId: "fake", serverLabel: "Fake", name: "echo", description: "", inputSchema: {} }],
    invokeTool: async (toolName: string, args: Record<string, unknown>, _config: MCPServerConfig, ctx: MCPExecutionContext) => {
      adapter.calls += 1;
      return handler(toolName, args, ctx);
    }
  };
  return adapter;
}

describe("runtime guard", () => {
  it("refuses over the rate limit with a retry hint the model can read", async () => {
    const clock = new FakeClock();
    const guard = new McpRuntimeGuard({ clock });
    const adapter = withRuntimeLimits(fakeAdapter(async () => ok), guard);
    const limited = config({ requestsPerMinute: 2, maxQueueWaitMs: 0 });
    expect((await adapter.invokeTool("echo", {}, limited, context())).ok).toBe(true);
    expect((await adapter.invokeTool("echo", {}, limited, context())).ok).toBe(true);
    const refused = await adapter.invokeTool("echo", {}, limited, context());
    expect(refused).toMatchObject({ ok: false, errorKind: "rate_limited", retryAfterMs: 30_000 });
    expect(refused.error).toBe("Rate limited: MCP server 'Fake' allows 2 calls per minute. Retry in 30 s.");
    expect(parseMcpRuntimeRejection(refused.error)).toBe("rate_limited");
    expect(guard.snapshot("mcp_1").rejected.rate_limited).toBe(1);
  });

  it("waits for a token when one comes within the queue wait", async () => {
    const clock = new FakeClock();
    const guard = new McpRuntimeGuard({ clock });
    const inner = fakeAdapter(async () => ok);
    const adapter = withRuntimeLimits(inner, guard);
    const limited = config({ requestsPerMinute: 60, burst: 1, maxQueueWaitMs: 5_000 });
    await adapter.invokeTool("echo", {}, limited, context());
    const second = adapter.invokeTool("echo", {}, limited, context());
    await clock.advance(999);
    expect(inner.calls).toBe(1);
    await clock.advance(1);
    expect((await second).ok).toBe(true);
    expect(inner.calls).toBe(2);
  });

  it("applies per-tool rules on top of the server's limits", async () => {
    const guard = new McpRuntimeGuard({ clock: new FakeClock() });
    const adapter = withRuntimeLimits(fakeAdapter(async () => ok), guard);
    const limited = config({ maxQueueWaitMs: 0, tools: [{ pattern: "create_*", requestsPerMinute: 1 }] });
    expect((await adapter.invokeTool("create_issue", {}, limited, context())).ok).toBe(true);
    const refused = await adapter.invokeTool("create_issue", {}, limited, context());
    expect(refused.errorKind).toBe("rate_limited");
    expect(refused.error).toContain("for tool 'create_issue' (rule 'create_*')");
    // Another matching tool has its own budget, and other tools are not limited.
    expect((await adapter.invokeTool("create_label", {}, limited, context())).ok).toBe(true);
    expect((await adapter.invokeTool("list_issues", {}, limited, context())).ok).toBe(true);
    expect((await adapter.invokeTool("list_issues", {}, limited, context())).ok).toBe(true);
  });

  it("caps concurrent calls with a bounded queue, then fails fast", async () => {
    const clock = new FakeClock();
    const guard = new McpRuntimeGuard({ clock });
    const releases: Array<() => void> = [];
    const adapter = withRuntimeLimits(
      fakeAdapter(() => new Promise<MCPToolResult>((resolve) => releases.push(() => resolve(ok)))),
      guard
    );
    const limited = config({ maxConcurrent: 1, maxQueueWaitMs: 2_000 });
    const first = adapter.invokeTool("slow", {}, limited, context());
    const second = adapter.invokeTool("slow", {}, limited, context());
    const third = adapter.invokeTool("slow", {}, limited, context());
    await flush();
    expect(releases).toHaveLength(1);
    expect(guard.snapshot("mcp_1")).toMatchObject({ inFlight: 1, queued: 2 });
    releases[0]!();
    expect((await first).ok).toBe(true);
    await flush();
    expect(releases).toHaveLength(2);
    await clock.advance(2_000);
    const refused = await third;
    expect(refused).toMatchObject({ ok: false, errorKind: "concurrency_limited" });
    expect(refused.error).toMatch(/^Concurrency limit: MCP server 'Fake' already has 1 calls in flight and none finished within 2 s/);
    releases[1]!();
    expect((await second).ok).toBe(true);
  });

  it("opens the breaker on server failures, rejects while open, probes once and closes", async () => {
    const clock = new FakeClock();
    const transitions: McpBreakerTransition[] = [];
    const guard = new McpRuntimeGuard({ clock, onBreakerTransition: (t) => transitions.push(t) });
    let healthy = false;
    const inner = fakeAdapter(async () => (healthy ? ok : down));
    const adapter = withRuntimeLimits(inner, guard);
    const limited = config({ breaker: { enabled: true, failureThreshold: 2, errorRatePercent: 100, windowMs: 60_000, minimumCalls: 100, cooldownMs: 10_000 } });
    await adapter.invokeTool("echo", {}, limited, context());
    await adapter.invokeTool("echo", {}, limited, context());
    expect(guard.snapshot("mcp_1").breaker.state).toBe("open");
    const rejected = await adapter.invokeTool("echo", {}, limited, context());
    expect(rejected).toMatchObject({ ok: false, errorKind: "circuit_open", retryAfterMs: 10_000 });
    expect(rejected.error).toMatch(/^Circuit open: MCP server 'Fake' is paused after repeated failures\. Retry in 10 s/);
    expect(inner.calls).toBe(2);
    await clock.advance(10_000);
    healthy = true;
    expect((await adapter.invokeTool("echo", {}, limited, context())).ok).toBe(true);
    expect(guard.snapshot("mcp_1").breaker.state).toBe("closed");
    expect(transitions.map((t) => t.to)).toEqual(["open", "half_open", "closed"]);
    expect(guard.snapshot("mcp_1").rejected.circuit_open).toBe(1);
  });

  it("does not count rejected arguments, tool errors, cancellations or missing credentials as server failures", async () => {
    const guard = new McpRuntimeGuard({ clock: new FakeClock() });
    const results: MCPToolResult[] = [
      { ok: false, output: null, error: "Invalid params", errorKind: "invalid_arguments" },
      { ok: false, output: "nope", content: "nope", error: "nope", errorKind: "tool" },
      { ok: false, output: null, error: "canceled", errorKind: "canceled" },
      { ok: false, output: null, error: "connect your account", errorKind: "credentials" },
      { ok: false, output: null, error: "sandbox refused", errorKind: "sandbox" },
      { ok: false, output: "x", content: "x", error: "x" }
    ];
    let index = 0;
    const adapter = withRuntimeLimits(fakeAdapter(async () => results[index++]!), guard);
    const limited = config({ breaker: { failureThreshold: 1 } as McpRuntimeLimits["breaker"] });
    for (let call = 0; call < results.length; call += 1) {
      await adapter.invokeTool("echo", {}, limited, context());
    }
    expect(guard.snapshot("mcp_1").breaker).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("does not count calls the tool policy blocked: they never reach the adapter", async () => {
    const guard = new McpRuntimeGuard({ clock: new FakeClock() });
    const inner = fakeAdapter(async () => ok);
    const registry = new MCPRegistry();
    registry.register(withRuntimeLimits(inner, guard));
    const tools = await resolveMCPTools([config({ breaker: { failureThreshold: 1 } as McpRuntimeLimits["breaker"] })], registry, context(), {
      accessCheck: () => ({ allowed: false, message: "Denied by policy", hidden: { name: "echo", serverId: "fake", reason: "policy", message: "Denied by policy" } }) as never
    });
    await expect(tools.invokeByExposedName("fake__echo", {})).rejects.toThrow(/Denied by policy/);
    expect(inner.calls).toBe(0);
    expect(guard.snapshot("mcp_1").breaker.consecutiveFailures).toBe(0);
  });

  it("classifies adapter errors: JSON-RPC invalid params does not count, protocol errors and timeouts do", async () => {
    const { classifyMcpError } = await import("./errors");
    expect(classifyMcpError(new McpJsonRpcError("Invalid params", -32602))).toBe("invalid_arguments");
    expect(classifyMcpError(new McpJsonRpcError("Internal error", -32603))).toBe("protocol");
    expect(classifyMcpError(new McpTimeoutError("timed out"))).toBe("timeout");
    const aborted = new AbortController();
    aborted.abort();
    expect(classifyMcpError(new Error("whatever"), aborted.signal)).toBe("canceled");
    expect(classifyMcpError(new Error("ECONNRESET"))).toBe("transport");
  });

  it("enforces a per-call timeout override and counts it against the server", async () => {
    const clock = new FakeClock();
    const guard = new McpRuntimeGuard({ clock });
    let seenTimeout: number | undefined;
    const adapter = withRuntimeLimits(
      fakeAdapter(
        (_tool, _args, ctx) =>
          new Promise<MCPToolResult>((resolve) => {
            seenTimeout = ctx.callTimeoutMs;
            ctx.signal?.addEventListener("abort", () => resolve({ ok: false, output: null, error: "aborted", errorKind: "canceled" }));
          })
      ),
      guard
    );
    const limited = config({ timeoutMs: 2_000, tools: [{ pattern: "slow", timeoutMs: 5_000 }] });
    const pending = adapter.invokeTool("slow", {}, limited, context());
    await flush();
    expect(seenTimeout).toBe(5_000);
    await clock.advance(6_000);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, errorKind: "timeout" });
    expect(result.error).toBe("MCP tool 'slow' on 'Fake' timed out after 5 s (the server's call timeout).");
    expect(guard.snapshot("mcp_1").breaker.consecutiveFailures).toBe(1);
  });

  it("passes inline servers and probe calls straight through", async () => {
    const guard = new McpRuntimeGuard({ clock: new FakeClock() });
    const inner = fakeAdapter(async () => down);
    const adapter = withRuntimeLimits(inner, guard);
    const inline: MCPServerConfig = { serverId: "fake", connection: {}, limits: { requestsPerMinute: 1 } as McpRuntimeLimits };
    for (let call = 0; call < 3; call += 1) {
      expect((await invokeDirectMCPTool(inline, "echo", {}, (() => {
        const registry = new MCPRegistry();
        registry.register(adapter);
        return registry;
      })(), context())).errorKind).toBe("transport");
    }
    await adapter.invokeTool("echo", {}, config({ breaker: { failureThreshold: 1 } as McpRuntimeLimits["breaker"] }), { ...context(), bypassRuntimeLimits: true });
    expect(guard.snapshots()).toEqual([]);
  });

  it("keeps state per registry server", async () => {
    const guard = new McpRuntimeGuard({ clock: new FakeClock() });
    const adapter = withRuntimeLimits(fakeAdapter(async () => down), guard);
    await adapter.invokeTool("echo", {}, config({ breaker: { failureThreshold: 1 } as McpRuntimeLimits["breaker"] }, "mcp_a"), context());
    expect(guard.snapshot("mcp_a").breaker.state).toBe("open");
    expect(guard.snapshot("mcp_b").breaker.state).toBe("closed");
    expect(guard.resetBreaker("mcp_a")).toBe(true);
    expect(guard.snapshot("mcp_a").breaker.state).toBe("closed");
  });
});
