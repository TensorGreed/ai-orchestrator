/**
 * Regression tests for the adversarial review of the first sandbox (node:vm
 * realm): each proof of concept from that review is replayed here and must
 * now fail to escape. Plus the limits the QuickJS sandbox adds: memory,
 * stack and time, and recovery when a WebAssembly instance has to be retired.
 */
import { afterEach, describe, expect, it } from "vitest";
import { runJavaScriptCode } from "./code-sandbox";
import { configureExpressionSandbox, evaluateInSandbox, serializeExpressionPayload } from "./expression-sandbox";
import { evaluateExpression, renderExpressionTemplate } from "./expression";
import { quickJsRetiredInstances, quickJsSandboxReady } from "./quickjs-sandbox";
import { renderTemplate } from "./template";
import { sortItems } from "./transformations";

const payload = (input: unknown) =>
  serializeExpressionPayload({ input, workflow: { id: "w", name: "w" }, execution: { id: "e", customData: {} }, env: {}, vars: {}, itemIndex: 0, nodeOutputs: {} });

const IN_PROCESS = { kind: "in_process" } as const;

afterEach(async () => {
  configureExpressionSandbox({ timeoutMs: 1000, memoryMb: 64 });
  // Some cases below retire an instance on purpose; start each test with the full pool.
  await quickJsSandboxReady();
});

describe("H1: import() no longer yields a host error (review PoC escape1/escape2)", () => {
  it("a code node cannot reach process through a rejected import()", async () => {
    process.env.SECRET_MASTER_KEY_BASE64 = "TOP-SECRET-MASTER-KEY";
    try {
      // The exact PoC body: on node:vm it returned the master key and `id` output.
      const poc = [
        "const e = await import('node:fs').catch((err) => err);",
        "const proc = e.constructor.constructor('return process')();",
        "const cp = proc.getBuiltinModule('node:child_process');",
        "return { key: proc.env.SECRET_MASTER_KEY_BASE64, id: cp.execSync('id').toString().trim() };"
      ].join("\n");
      const outcome = await runJavaScriptCode(IN_PROCESS, poc, [{}], 1000).then(
        (outputs) => JSON.stringify(outputs),
        (error: Error) => error.message
      );
      expect(outcome).not.toContain("TOP-SECRET-MASTER-KEY");
      expect(outcome).not.toMatch(/uid=\d+/);
      // What the escape reaches instead: the sandbox's own Function, where `process` does not exist.
      const [probe] = await runJavaScriptCode(
        IN_PROCESS,
        "const e = await import('node:fs').catch((err) => err); const p = e.constructor.constructor('return typeof process')(); return { p, name: e.name };",
        [{}],
        1000
      );
      expect(probe!.result).toMatchObject({ p: "undefined" });
    } finally {
      delete process.env.SECRET_MASTER_KEY_BASE64;
    }
  });

  it("an expression's rejected import() cannot write to the host process out of band", async () => {
    const host = process as unknown as Record<string, unknown>;
    delete host.__l2m_leak;
    const result = evaluateInSandbox(
      "(import('x').catch((e) => { const P = e.constructor.constructor('return process')(); P.__l2m_leak = P.env.HOME + ' pid=' + P.pid; }), 'returned')",
      payload({})
    );
    expect(result).toBe("returned");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.__l2m_leak).toBeUndefined();
  });

  it("the host Function is unreachable from any built-in's constructor chain", () => {
    for (const expression of [
      "(() => { try { return (import('x')).constructor.constructor('return typeof process')() } catch (e) { return 'threw' } })()",
      "[].constructor.constructor('return typeof process')()",
      "typeof (async () => {}).constructor('return process')",
      "(() => { try { null.x } catch (e) { return e.constructor.constructor('return typeof process')() } })()"
    ]) {
      expect(["undefined", "function", "threw"], expression).toContain(evaluateInSandbox(expression, payload({})));
    }
  });
});

describe("H2: nothing persists between evaluations (review PoC poison)", () => {
  it("a hooked ArrayIterator does not harvest a later evaluation's secrets", () => {
    evaluateInSandbox(
      "(() => { const AIP = Object.getPrototypeOf([][Symbol.iterator]()); AIP.__h = []; const o = AIP.next; AIP.next = function () { const r = o.call(this); if (!r.done) AIP.__h.push(r.value); return r; }; return 1; })()",
      payload({})
    );
    expect(evaluateInSandbox("[...$input.secrets].join(',')", payload({ secrets: ["sk-OTHER-TENANT-key", "db-password-123"] }))).toBe(
      "sk-OTHER-TENANT-key,db-password-123"
    );
    expect(evaluateInSandbox("Object.getPrototypeOf([][Symbol.iterator]()).__h", payload({}))).toBeUndefined();
  });

  it("no hidden intrinsic carries state into the next evaluation", () => {
    const hidden = [
      "Object.getPrototypeOf([][Symbol.iterator]())",
      "Object.getPrototypeOf(''[Symbol.iterator]())",
      "Object.getPrototypeOf(new Map().entries())",
      "Object.getPrototypeOf(new Set().values())",
      "Object.getPrototypeOf('a'.matchAll(/a/g))",
      "Object.getPrototypeOf(function* () {})",
      "Object.getPrototypeOf(async function () {})",
      "Object.getPrototypeOf(async function* () {})",
      "Array.prototype",
      "Object.prototype"
    ];
    for (const target of hidden) {
      evaluateInSandbox(`(${target}.__l2mMark = 'poisoned', 1)`, payload({}));
      expect(evaluateInSandbox(`${target}.__l2mMark`, payload({})), target).toBeUndefined();
    }
  });

  it("a patched built-in does not corrupt a later evaluation's result", () => {
    evaluateInSandbox("(Math.max = () => -1, Array.prototype.map = () => 'hacked', JSON.stringify = () => '{}', 1)", payload({}));
    expect(evaluateInSandbox("Math.max(...[1, 2, 3])", payload({}))).toBe(3);
    expect(evaluateInSandbox("[1, 2].map((x) => x + 1)", payload({}))).toEqual([2, 3]);
  });

  it("templates and sort keys do not share a context either", () => {
    renderTemplate("{{ (Array.prototype.__l2mT = 'x', 1) }}", {});
    expect(evaluateExpression("[].__l2mT", {})).toBeUndefined();
    sortItems([{ v: 2 }, { v: 1 }], { expression: "(Object.prototype.__l2mS = 1, item.v)" });
    expect(evaluateExpression("({}).__l2mS", {})).toBeUndefined();
  });
});

describe("M1: memory is bounded", () => {
  it("an expression that doubles a string fails inside the sandbox instead of growing the API heap", () => {
    const before = process.memoryUsage().heapUsed;
    expect(() => evaluateExpression("(() => { let s = 'x'; while (true) s = s + s; })()", {})).toThrow(/out of memory|too long/i);
    expect(() => evaluateExpression("(() => { const a = []; while (true) a.push({ n: a.length }); })()", {})).toThrow(/out of memory/i);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
    expect(evaluateExpression("1 + 1", {})).toBe(2);
  });

  it("EXPRESSION_MEMORY_MB is enforced", () => {
    configureExpressionSandbox({ memoryMb: 8 });
    expect(() => evaluateExpression("new Array(4 * 1024 * 1024).fill(1.5).length", {})).toThrow(/out of memory/i);
    configureExpressionSandbox({ memoryMb: 64 });
    expect(evaluateExpression("new Array(4 * 1024 * 1024).fill(1.5).length", {})).toBe(4 * 1024 * 1024);
  });

  it("an in-process code node is bounded by its plan's memory limit", async () => {
    await expect(
      runJavaScriptCode({ kind: "in_process", memoryMb: 16 }, "const a = []; while (true) a.push('x'.repeat(1024)); return 1;", [{}], 5000)
    ).rejects.toThrow(/out of memory/i);
    const [out] = await runJavaScriptCode({ kind: "in_process", memoryMb: 16 }, "return [1, 2, 3].length;", [{}], 1000);
    expect(out!.result).toBe(3);
  });
});

describe("stack and time limits", () => {
  it("deep recursion is a catchable stack overflow inside the sandbox", () => {
    expect(evaluateExpression("(() => { const f = (n) => f(n + 1) + 1; try { return f(0); } catch (e) { return e.message; } })()", {})).toMatch(/stack overflow/i);
  });

  it("nesting that would exhaust the host stack retires the instance; the next evaluation still works", async () => {
    const retired = quickJsRetiredInstances();
    // The QuickJS parser recurses natively; this nesting overflows the host stack on every runtime we support.
    const deep = "(".repeat(100_000) + "1" + ")".repeat(100_000);
    expect(() => evaluateExpression(deep, {})).toThrow(/sandbox/i);
    expect(quickJsRetiredInstances()).toBe(retired + 1);
    // The spare instance takes over at once.
    expect(evaluateExpression("2 + 2", {})).toBe(4);
    await quickJsSandboxReady();
    // A second failure in a row is also absorbed once the spare has been reloaded.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => evaluateExpression(deep, {})).toThrow(/sandbox/i);
    await quickJsSandboxReady();
    expect(evaluateExpression("3 + 3", {})).toBe(6);
  });

  it("a catastrophic regular expression is cut off by the time limit", () => {
    configureExpressionSandbox({ timeoutMs: 150 });
    const started = Date.now();
    expect(() => evaluateExpression("/(a+)+b/.test('a'.repeat(40))", {})).toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an interrupted await is reported as a timeout", async () => {
    await expect(runJavaScriptCode(IN_PROCESS, "await null; while (true) {}", [{}], 150)).rejects.toThrow(/timed out after 150ms/);
  });

  it("a promise-job flood in a code node is cut off by the time limit", async () => {
    const started = Date.now();
    await expect(
      runJavaScriptCode(IN_PROCESS, "const f = () => Promise.resolve().then(f); f(); await new Promise(() => {}); return 1;", [{}], 200)
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("each expression in one template has its own time limit", () => {
    configureExpressionSandbox({ timeoutMs: 100 });
    expect(renderExpressionTemplate("{{ (() => { while (true) {} })() }}|{{ 1 + 1 }}", {})).toBe("|2");
  });
});

describe("expression semantics on QuickJS", () => {
  it("keeps dates, $now/$today, BigInt and undefined handling", () => {
    expect(evaluateExpression("new Date(Date.UTC(2024, 0, 15)).toISOString()", {})).toBe("2024-01-15T00:00:00.000Z");
    expect(evaluateExpression("$now", {})).toBeInstanceOf(Date);
    expect(evaluateExpression("$today.getHours()", {})).toBe(0);
    expect(evaluateExpression("10n ** 20n", {})).toBe("100000000000000000000");
    expect(evaluateExpression("undefined", {})).toBeUndefined();
    expect(evaluateExpression("new Date(NaN)", {})).toBeInstanceOf(Date);
  });

  it("modern syntax works: optional chaining, nullish, spread, destructuring, regex groups", () => {
    expect(evaluateExpression("$json.a?.b ?? 'none'", { $json: {} })).toBe("none");
    expect(evaluateExpression("(({ a, ...rest }) => Object.keys(rest))($json)", { $json: { a: 1, b: 2, c: 3 } })).toEqual(["b", "c"]);
    expect(evaluateExpression("'2024-05-06'.match(/(?<y>\\d+)-(?<m>\\d+)/).groups.m", {})).toBe("05");
    expect(evaluateExpression("[3, 1, 2].toSorted ? [3, 1, 2].toSorted() : [3, 1, 2].sort()", {})).toEqual([1, 2, 3]);
  });

  it("documents the one built-in that differs: there is no Intl", () => {
    expect(evaluateExpression("typeof Intl", {})).toBe("undefined");
  });
});
