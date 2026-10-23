/**
 * Regression tests for the re-review of the QuickJS sandbox (REREVIEW-A12):
 * each proof of concept from it is replayed here.
 *
 *   N1  the memory limit held only for single large allocations; many small
 *       ones grew the WebAssembly heap (and API RSS) to 2 GB, results were
 *       uncapped, and an in-process code node's timeout had no ceiling.
 *   N2  a guest could retire instances on purpose (toJSON poison, a setter on
 *       a prelude global, a deeply nested result), and while the pool was
 *       empty every tenant's templates rendered "" with no error, which sent
 *       IF nodes down the wrong branch.
 *   L-e one template could hold the event loop for N x the expression timeout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import type { Workflow } from "@ai-orchestrator/shared";
import { IN_PROCESS_CODE_SANDBOX, inProcessTimeout, runJavaScriptCode } from "./code-sandbox";
import { executeWorkflow, type WorkflowExecutionDependencies } from "./executor";
import { EXPRESSION_SANDBOX_DEFAULTS, ExpressionSandboxError, configureExpressionSandbox, evaluateInSandbox, serializeExpressionPayload } from "./expression-sandbox";
import { evaluateExpression, renderExpressionTemplate } from "./expression";
import {
  QUICKJS_STACK_BYTES,
  SANDBOX_BREAKER_MESSAGE,
  quickJsActiveHeapBytes,
  recycleQuickJsInstanceForTesting,
  quickJsRecycledInstances,
  quickJsRetiredInstances,
  quickJsSandboxReady,
  resetSandboxBreakerForTesting,
  runWithSandboxOwner,
  withQuickJs
} from "./quickjs-sandbox";
import { renderTemplate } from "./template";
import { sortItems } from "./transformations";

const MB = 1024 * 1024;
const payload = (input: unknown) =>
  serializeExpressionPayload({ input, workflow: { id: "w", name: "w" }, execution: { id: "e", customData: {} }, env: {}, vars: {}, itemIndex: 0, nodeOutputs: {} });

/**
 * Source nested 100k levels deep: the QuickJS parser exhausts the host stack on every runtime we support, so
 * the instance is always retired. (The reviewer's cheaper trigger, a result nested 5000 levels deep, depends
 * on how deep the host stack already is: QuickJS's own check sometimes catches it first. See NESTED_RESULT.)
 */
const CRASH = "(".repeat(100_000) + "1" + ")".repeat(100_000);
const NESTED_RESULT = "(()=>{let a=1;for(let i=0;i<5000;i++)a=[a];return a})()";
const GLOBAL = "(function(){return this})()";

afterEach(async () => {
  configureExpressionSandbox({ ...EXPRESSION_SANDBOX_DEFAULTS });
  resetSandboxBreakerForTesting();
  await quickJsSandboxReady();
});

describe("N1: memory is bounded for many small allocations, results are capped, timeouts are clamped", () => {
  // Each memory test starts on a fresh instance, whatever earlier tests left in the heap.
  beforeEach(async () => {
    await recycleQuickJsInstanceForTesting();
  });

  it("the heap measurement this relies on is available (tripwire for a quickjs-emscripten upgrade)", () => {
    expect(quickJsActiveHeapBytes()).toBeGreaterThanOrEqual(16 * MB);
  });

  it("many small strings hit the expression limit, and the heap grows by at most the limit plus slack (mem2 PoC)", { timeout: 60_000 }, () => {
    // A long deadline, so the memory limit is what stops each run even on a slow machine (filling 64 MB takes about 1 s on Node 20).
    configureExpressionSandbox({ ...EXPRESSION_SANDBOX_DEFAULTS, timeoutMs: 20_000 });
    for (const body of ["a.push('x'.repeat(1000))", "a.push(String(a.length).padStart(1000, 'x'))", "a.push('x'.repeat(1000) + a.length)"]) {
      const before = quickJsActiveHeapBytes();
      const started = Date.now();
      expect(() => evaluateExpression(`(() => { const a = []; for (;;) ${body}; })()`, {})).toThrow(/out of memory \(limit 64 MB\)/);
      // Before the fix this ran to the deadline after growing the heap to over 1 GB.
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(quickJsActiveHeapBytes() - before).toBeLessThanOrEqual(64 * MB + 32 * MB);
    }
  });

  it("a raw session reports the memory stop as out of memory, not a timeout", () => {
    expect(() =>
      withQuickJs({ memoryBytes: 8 * MB, stackBytes: QUICKJS_STACK_BYTES, timeoutMs: 5000 }, (session) => {
        session.evaluateTrusted("globalThis.f = () => { const a = []; for (;;) a.push('y'.repeat(500)); }", "t.js");
        return session.callGlobal("f", []);
      })
    ).toThrow(/out of memory/);
  });

  it("a code node with a 15 s timeout and 32 MB stops at the limit and API RSS stays bounded (m1 PoC)", async () => {
    const before = process.memoryUsage().rss;
    const started = Date.now();
    await expect(
      runJavaScriptCode({ kind: "in_process", memoryMb: 32 }, "const a = []; for (;;) a.push('x'.repeat(4000));", [{}], 15000)
    ).rejects.toThrow(/out of memory \(limit 32 MB\)/);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Before the fix RSS reached 2.27 GB. Generous bound: RSS also moves with V8 and test-runner noise.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MB);
  });

  it("an async code node is stopped by the memory limit too", async () => {
    await expect(
      runJavaScriptCode({ kind: "in_process", memoryMb: 16 }, "await null; const a = []; for (;;) a.push({ n: a.length, s: 'x'.repeat(100) });", [{}], 10000)
    ).rejects.toThrow(/out of memory \(limit 16 MB\)/);
  });

  it("an instance whose heap has grown past the threshold is recycled, so its linear memory is released", async () => {
    const recycled = quickJsRecycledInstances();
    const retired = quickJsRetiredInstances();
    // The threshold is the larger of 256 MB and the largest limit used so far; growing the heap past 300 MB crosses it.
    await expect(
      runJavaScriptCode({ kind: "in_process", memoryMb: 300 }, "const a = []; for (;;) a.push('x'.repeat(1000) + a.length);", [{}], 20000)
    ).rejects.toThrow(/out of memory/);
    expect(quickJsRecycledInstances()).toBe(recycled + 1);
    // A recycle is not a crash: it never counts towards the failure counter or a circuit breaker.
    expect(quickJsRetiredInstances()).toBe(retired);
    expect(quickJsActiveHeapBytes()).toBeLessThan(64 * MB);
  }, 60_000);

  it("a large code-node result no longer retires the instance (QuickJS leaked objects when it was serialized inside a promise job)", async () => {
    const retired = quickJsRetiredInstances();
    const [out] = await runJavaScriptCode(IN_PROCESS_CODE_SANDBOX, "await null; return { a: 'z'.repeat(5e6) };", [{}], 5000);
    expect((out!.result as { a: string }).a.length).toBe(5e6);
    expect(quickJsRetiredInstances()).toBe(retired);
  });

  it("an expression result over EXPRESSION_MAX_RESULT_MB is refused inside the sandbox", () => {
    configureExpressionSandbox({ maxResultMb: 1 });
    expect(() => evaluateExpression("'x'.repeat(2 * 1024 * 1024)", {})).toThrow(/too large/);
    expect(evaluateExpression("'x'.repeat(1000).length", {})).toBe(1000);
  });

  it("a code-node result over CODE_SANDBOX_MAX_RESULT_MB is refused, per item and for all items together (rss PoC)", async () => {
    const plan = { kind: "in_process", maxResultMb: 1 } as const;
    await expect(runJavaScriptCode(plan, "return 'z'.repeat(2 * 1024 * 1024);", [{}], 5000)).rejects.toThrow(/too large/);
    // Logs count too.
    await expect(runJavaScriptCode(plan, "for (let i = 0; i < 300; i++) console.log('l'.repeat(5000)); return 1;", [{}], 5000)).rejects.toThrow(/too large/);
    // Each item is under the cap, together they are not.
    await expect(runJavaScriptCode(plan, "return 'z'.repeat(400 * 1024);", [{}, {}, {}, {}], 5000)).rejects.toThrow(/too large together/);
    const outs = await runJavaScriptCode(plan, "return 'ok';", [{}, {}], 5000);
    expect(outs.map((out) => out.result)).toEqual(["ok", "ok"]);
  });

  it("an in-process code node's timeout is clamped to CODE_SANDBOX_MAX_TIMEOUT_MS", async () => {
    const plan = { kind: "in_process", maxTimeoutMs: 200 } as const;
    const started = Date.now();
    await expect(runJavaScriptCode(plan, "while (true) {}", [{}], 60_000)).rejects.toThrow(/timed out after 200ms/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(inProcessTimeout(plan, 50, 1)).toBe(50);
    expect(inProcessTimeout({ kind: "in_process" }, 10 * 60_000, 1)).toBe(30_000);
  });

  it("refuses a per-item node whose items together could hold the event loop past 4 x the ceiling", async () => {
    const plan = { kind: "in_process", maxTimeoutMs: 200 } as const;
    await expect(runJavaScriptCode(plan, "return 1;", Array.from({ length: 5 }, () => ({})), 200)).rejects.toThrow(/4 x CODE_SANDBOX_MAX_TIMEOUT_MS/);
    const outs = await runJavaScriptCode(plan, "return 1;", Array.from({ length: 4 }, () => ({})), 200);
    expect(outs).toHaveLength(4);
  });
});

describe("N2: guest output cannot retire an instance", () => {
  it("an Object.prototype.toJSON poison is a guest error, not a retirement (poison2 PoC)", () => {
    const retired = quickJsRetiredInstances();
    for (const poison of ["() => 'x'", "() => null", "() => [1]", "() => ({ d: 5 })", "() => ({})"]) {
      expect(() => evaluateInSandbox(`(Object.prototype.toJSON = ${poison}, 1)`, payload({}))).toThrow(/invalid result/);
    }
    expect(() => sortItems([{ v: 2 }, { v: 1 }], { expression: "(Object.prototype.toJSON = () => 'x', item.v)" })).toThrow(/invalid result/);
    expect(quickJsRetiredInstances()).toBe(retired);
    expect(evaluateExpression("1 + 1", {})).toBe(2);
  });

  it("a setter planted on the jmespath hand-off cannot break or retire a later $jmespath (setter PoC)", () => {
    const retired = quickJsRetiredInstances();
    const rendered = renderExpressionTemplate(
      `{{ (Object.defineProperty(${GLOBAL}, '__l2mJmes', { set() { throw 1; }, get() { return 'x'; } }), '') }}v={{ $jmespath($json, 'a.b') }}`,
      { $json: { a: { b: "ok" } } }
    );
    expect(rendered).toBe("v=ok");
    expect(quickJsRetiredInstances()).toBe(retired);
  });

  it("__l2mRun is non-writable: an earlier expression cannot rewrite a later result in the same template", () => {
    expect(renderTemplate(`{{ (${GLOBAL}.__l2mRun = () => JSON.stringify({ v: 'evil' }), '') }}user={{ $json.user.toUpperCase() }}`, { user: "bob" })).toBe(
      "user=BOB"
    );
    expect(renderExpressionTemplate(`{{ (Object.defineProperty(${GLOBAL}, '__l2mRun', { get() { throw 1; } }), '') }}x={{ 1 + 1 }}`, {})).toBe("x=2");
  });
});

describe("N2: a sandbox failure never renders as an empty value", () => {
  it("a result that crashes the instance throws ExpressionSandboxError from templates instead of rendering ''", () => {
    const retired = quickJsRetiredInstances();
    expect(() => renderTemplate(`{{ ${CRASH} }}`, {})).toThrow(ExpressionSandboxError);
    expect(() => renderExpressionTemplate(`{{ ${CRASH} }}`, {})).toThrow(ExpressionSandboxError);
    expect(quickJsRetiredInstances()).toBe(retired + 2);
    // The expression's own errors and timeouts still render "".
    expect(renderTemplate("a{{ null.x }}b", {})).toBe("ab");
  });

  it("the reviewer's nested-result trigger is either the expression's own error or a sandbox error, never a quiet retire", () => {
    const retired = quickJsRetiredInstances();
    let caught: unknown;
    let result: unknown;
    try {
      result = evaluateExpression(NESTED_RESULT, {});
    } catch (error) {
      caught = error;
    }
    if (quickJsRetiredInstances() > retired) expect(caught).toBeInstanceOf(ExpressionSandboxError);
    else if (caught !== undefined) expect((caught as Error).message).toMatch(/stack/i);
    else {
      // Whether 5000 levels fit the stack depends on the host; when they do, the whole value must come back.
      let depth = 0;
      let value = result;
      while (Array.isArray(value)) {
        value = value[0];
        depth += 1;
      }
      expect([depth, value]).toEqual([5000, 1]);
    }
  });

  it("with the pool drained, a victim's IF condition throws a retryable error instead of rendering '' (ifmisroute PoC)", async () => {
    const victim = () => renderTemplate("{{ !$json.user.isAdmin }}", { user: { isAdmin: false } });
    expect(victim()).toBe("true");
    // The active instance and all spares, synchronously, so no reload can land in between.
    for (let i = 0; i < 5; i += 1) expect(() => renderTemplate(`{{ ${CRASH} }}`, {})).toThrow(ExpressionSandboxError);
    let caught: unknown;
    try {
      victim();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExpressionSandboxError);
    expect((caught as ExpressionSandboxError).retryable).toBe(true);
    expect((caught as Error).message).toMatch(/restarting/);
    await quickJsSandboxReady();
    expect(victim()).toBe("true");
  });

  it("an IF node whose condition hits a sandbox failure fails the node; neither branch runs", async () => {
    const workflow: Workflow = {
      id: "wf-if-sandbox",
      name: "IF on a sandbox failure",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "n1", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
        { id: "n2", type: "if_node", name: "IF", position: { x: 200, y: 0 }, config: { condition: `{{ ${CRASH} }}` } },
        { id: "n3", type: "output", name: "True Output", position: { x: 400, y: -50 }, config: { responseTemplate: "was true" } },
        { id: "n4", type: "output", name: "False Output", position: { x: 400, y: 50 }, config: { responseTemplate: "was false" } }
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2" },
        { id: "e2", source: "n2", sourceHandle: "true", target: "n3" },
        { id: "e3", source: "n2", sourceHandle: "false", target: "n4" }
      ]
    };
    const deps: WorkflowExecutionDependencies = {
      providerRegistry: new ProviderRegistry(),
      connectorRegistry: createDefaultConnectorRegistry(),
      mcpRegistry: createDefaultMCPRegistry(),
      agentRuntime: { id: "none", run: async () => { throw new Error("unused"); } } as never,
      resolveSecret: async () => undefined
    };
    const result = await executeWorkflow({ workflow }, deps);
    const status = (id: string) => result.nodeResults.find((entry) => entry.nodeId === id)?.status;
    expect(status("n2")).toBe("error");
    expect(result.nodeResults.find((entry) => entry.nodeId === "n2")?.error).toMatch(/expression sandbox error/);
    expect(status("n3")).not.toBe("success");
    expect(status("n4")).not.toBe("success");
  });
});

describe("N2: per-workflow circuit breaker", () => {
  it("an owner that retires three instances in a minute is refused without touching the pool; others are unaffected", () => {
    const retired = quickJsRetiredInstances();
    runWithSandboxOwner("workflow:attacker", () => {
      for (let i = 0; i < 3; i += 1) expect(() => renderTemplate(`{{ ${CRASH} }}`, {})).toThrow(ExpressionSandboxError);
      // Now even a harmless expression from this owner is refused, and no further instance is spent.
      for (let i = 0; i < 10; i += 1) expect(() => renderTemplate(`{{ ${CRASH} }}`, {})).toThrow(SANDBOX_BREAKER_MESSAGE);
      expect(() => renderTemplate("{{ 1 + 1 }}", {})).toThrow(SANDBOX_BREAKER_MESSAGE);
    });
    expect(quickJsRetiredInstances()).toBe(retired + 3);
    // Another workflow, and code with no owner, still evaluate (a spare took over).
    expect(runWithSandboxOwner("workflow:victim", () => renderTemplate("{{ 2 + 2 }}", {}))).toBe("4");
    expect(renderTemplate("{{ 3 + 3 }}", {})).toBe("6");
  });

  it("the breaker follows the owner across awaits, and a workflow run sets its own owner", async () => {
    await runWithSandboxOwner("workflow:async-attacker", async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(() => evaluateExpression(CRASH, {})).toThrow(ExpressionSandboxError);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(() => evaluateExpression("1", {})).toThrow(SANDBOX_BREAKER_MESSAGE);
    });
  });
});

describe("L-e: one template's expressions share a time budget", () => {
  it("ten spinning expressions stop at EXPRESSION_TEMPLATE_BUDGET_MS, not at 10 x the timeout", () => {
    configureExpressionSandbox({ timeoutMs: 200, templateBudgetMs: 400 });
    const started = Date.now();
    const rendered = renderExpressionTemplate(Array.from({ length: 10 }, (_, i) => `{{ (() => { while (true) {} })() }}${i}`).join(""), {});
    expect(rendered).toBe("0123456789");
    // Before: about 2000 ms (10 x 200). Generous upper bound for slow machines.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a single expression always gets its own timeout, even above the template budget", () => {
    configureExpressionSandbox({ timeoutMs: 600, templateBudgetMs: 100 });
    expect(evaluateExpression("(() => { const end = Date.now() + 300; while (Date.now() < end) {} return 'done'; })()", {})).toBe("done");
  });
});
