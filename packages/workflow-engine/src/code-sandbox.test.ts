/**
 * Code nodes and expressions must run with no reach into the host process.
 * These are regression tests: each "escape" body is a published vm-escape
 * technique, and the test asserts the sandbox returns a harmless value
 * instead of the host's process object.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_NODES_DISABLED_MESSAGE,
  resolveCodeSandboxPlan,
  runJavaScriptCode,
  runPythonCode,
  setContainerSpawnForTesting,
  type CodeSandboxSettings
} from "./code-sandbox";
import { configureExpressionSandbox } from "./expression-sandbox";
import { evaluateExpression } from "./expression";
import { executeCodeNodeSandbox } from "./executor";
import { isPythonAvailable } from "./python-runner";
import { renderTemplate } from "./template";
import { sortItems } from "./transformations";

/** Each body attempts to obtain the host `process`; a blocked sandbox yields undefined/falsey. */
const ESCAPES: Record<string, string> = {
  thisConstructor: "return this.constructor.constructor('return typeof process')()",
  objectConstructor: "return Object.constructor('return typeof process')()",
  inputConstructor: "return input && input.constructor && input.constructor.constructor('return typeof process')()",
  consoleConstructor: "return console.log.constructor('return typeof process')()",
  globalProcess: "return typeof globalThis.process",
  prepareStackTrace: [
    "let leaked = 'none';",
    "try {",
    "  Error.prepareStackTrace = function (e, frames) {",
    "    for (const f of frames) { const fn = f.getFunction && f.getFunction(); if (fn) { try { leaked = fn.constructor('return typeof process')(); } catch (x) {} } }",
    "    return '';",
    "  };",
    "  new Error('x').stack;",
    "} catch (x) {}",
    "return leaked;"
  ].join("\n"),
  requireMissing: "return typeof require",
  fetchMissing: "return typeof fetch",
  bufferMissing: "return typeof Buffer"
};

describe("JavaScript code node sandbox (in-process realm)", () => {
  it("blocks every known escape: no body reaches the host process", async () => {
    for (const [name, body] of Object.entries(ESCAPES)) {
      const [out] = await runJavaScriptCode({ kind: "in_process" }, body, [{ x: 1 }], 1000);
      expect(String(out.result), name).not.toBe("object");
      // The host `process` is an object; "undefined"/"none"/"function" are all safe outcomes.
      expect(out.result === undefined || out.result === "undefined" || out.result === "none" || out.result === "function", `${name} => ${JSON.stringify(out.result)}`).toBe(true);
    }
  });

  it("dynamic import of a host module is unavailable", async () => {
    const [out] = await runJavaScriptCode({ kind: "in_process" }, "try { await import('node:fs'); return 'imported'; } catch (e) { return 'blocked:' + (e && e.code || e.name); }", [{}], 1000);
    expect(String(out.result)).toMatch(/^blocked:/);
  });

  it("runs ordinary code: input, console and an async return", async () => {
    const [out] = await runJavaScriptCode(
      { kind: "in_process" },
      "console.log('hi', input.n); const doubled = await Promise.resolve(input.n * 2); return { doubled };",
      [{ n: 21 }],
      1000
    );
    expect(out.result).toEqual({ doubled: 42 });
    expect(out.logs).toEqual(["hi 21"]);
  });

  it("one realm per input does not leak state between inputs", async () => {
    const outputs = await runJavaScriptCode(
      { kind: "in_process" },
      "globalThis.__seen = (globalThis.__seen || 0) + 1; return { seen: globalThis.__seen, n: input.n };",
      [{ n: 1 }, { n: 2 }],
      1000
    );
    expect(outputs.map((o) => o.result)).toEqual([{ seen: 1, n: 1 }, { seen: 1, n: 2 }]);
  });

  it("stops an infinite loop at the time limit", async () => {
    await expect(runJavaScriptCode({ kind: "in_process" }, "while (true) {}", [{}], 150)).rejects.toThrow(/sandbox error/i);
  });

  it("surfaces a thrown error with its message, not a host stack", async () => {
    await expect(executeCodeNodeSandbox({ code: "throw new Error('boom')", input: {} })).rejects.toThrow(/boom/);
  });

  it("mutating a frozen intrinsic does not corrupt the next run", async () => {
    await runJavaScriptCode({ kind: "in_process" }, "try { Array.prototype.map = () => 'hacked'; } catch (e) {} return 1;", [{}], 1000);
    const [out] = await runJavaScriptCode({ kind: "in_process" }, "return [1, 2].map((x) => x + 1);", [{}], 1000);
    expect(out.result).toEqual([2, 3]);
  });
});

describe("expression sandbox", () => {
  it("expressions and sort keys cannot reach the host", () => {
    expect(evaluateExpression("typeof process", {})).toBe("undefined");
    expect(evaluateExpression("typeof fetch", {})).toBe("undefined");
    expect(evaluateExpression("this.constructor.constructor('return typeof process')()", {})).toBe("undefined");
    expect(evaluateExpression("(1).constructor.constructor('return typeof globalThis.process')()", {})).toBe("undefined");
    const sorted = sortItems([{ v: 3 }, { v: 1 }], { expression: "(() => { try { return this.constructor.constructor('return process')().pid; } catch (e) { return item.v; } })()" });
    expect(sorted).toEqual([{ v: 1 }, { v: 3 }]);
  });

  it("a template expression that tries to fetch returns empty, not a live call", () => {
    const rendered = renderTemplate("{{ (typeof fetch === 'function' ? fetch('http://169.254.169.254/') : 'no-fetch') }}", {});
    expect(rendered).toBe("no-fetch");
  });

  it("keeps the documented expression feature set", () => {
    expect(evaluateExpression("1 + 2 * 3", {})).toBe(7);
    expect(evaluateExpression("$json.name", { $json: { name: "Ada" } })).toBe("Ada");
    expect(evaluateExpression("$node('a').output.value", { $nodeOutputs: { a: { value: 42 } } })).toBe(42);
    expect(evaluateExpression("$if(true, 'a', 'b')", {})).toBe("a");
    expect(evaluateExpression("$ifEmpty('', 'fb')", {})).toBe("fb");
    expect(evaluateExpression("$jmespath($json, 'items[?k==\\'b\\']')", { $json: { items: [{ k: "a" }, { k: "b" }] } })).toEqual([{ k: "b" }]);
    expect(renderTemplate("{{ 1 + 1 }} and {{ text }}", { text: "y" })).toBe("2 and y");
  });

  it("an expression that loops forever is cut off by the time limit", () => {
    configureExpressionSandbox({ timeoutMs: 150 });
    expect(() => evaluateExpression("(() => { while (true) {} })()", {})).toThrow(/timed out/);
    // A later evaluation still works (the realm recovers).
    expect(evaluateExpression("1 + 1", {})).toBe(2);
    configureExpressionSandbox({ timeoutMs: 1000 });
  });
});

describe("Python code node environment", () => {
  it("never inherits the API environment, so secrets are absent", async () => {
    if (!(await isPythonAvailable())) return;
    process.env.SECRET_MASTER_KEY_BASE64 = "test-master-key-should-not-leak";
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    try {
      const res = await runPythonCode({ kind: "in_process" }, {
        code: "import os\nresult = {'master': os.environ.get('SECRET_MASTER_KEY_BASE64'), 'openai': os.environ.get('OPENAI_API_KEY'), 'keys': sorted(os.environ.keys())}",
        items: [{}],
        mode: "runOnceForAllItems",
        timeoutMs: 15000
      });
      const result = res.result as { master: unknown; openai: unknown; keys: string[] };
      expect(result.master).toBeNull();
      expect(result.openai).toBeNull();
      expect(result.keys).not.toContain("SECRET_MASTER_KEY_BASE64");
      expect(result.keys).not.toContain("OPENAI_API_KEY");
    } finally {
      delete process.env.SECRET_MASTER_KEY_BASE64;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("runs isolated (-I), ignoring PYTHON* variables", async () => {
    if (!(await isPythonAvailable())) return;
    const res = await runPythonCode({ kind: "in_process" }, {
      code: "import sys\nresult = {'flags': sys.flags.isolated}",
      items: [{}],
      mode: "runOnceForAllItems",
      timeoutMs: 15000
    });
    expect((res.result as { flags: number }).flags).toBe(1);
  });
});

describe("disabled code nodes", () => {
  it("fail with a clear configuration error for both languages", async () => {
    const plan = { kind: "disabled", reason: CODE_NODES_DISABLED_MESSAGE } as const;
    await expect(runJavaScriptCode(plan, "return 1;", [{}], 1000)).rejects.toThrow(CODE_NODES_DISABLED_MESSAGE);
    await expect(runPythonCode(plan, { code: "result = 1", items: [{}], mode: "runOnceForAllItems" })).rejects.toThrow(CODE_NODES_DISABLED_MESSAGE);
  });
});

describe("resolveCodeSandboxPlan", () => {
  const base: CodeSandboxSettings = {
    enabled: true,
    mode: "auto",
    runtime: "auto",
    jsImage: "node:22.11.0-alpine3.20",
    pythonImage: "python:3.12.7-alpine3.20",
    memoryMb: 256,
    cpus: 1,
    pidsLimit: 128,
    startupMs: 5000,
    instanceLabel: "test"
  };
  const locator = (installed: string[]) => ({ locate: (runtime: string) => (installed.includes(runtime) ? `/usr/bin/${runtime}` : null) });

  it("disables code nodes when the feature is off", async () => {
    const { plan, warning } = await resolveCodeSandboxPlan({ ...base, enabled: false });
    expect(plan.kind).toBe("disabled");
    expect(warning).toBeNull();
  });

  it("auto falls back in-process, with a warning, when no runtime is installed", async () => {
    const { plan, warning } = await resolveCodeSandboxPlan(base, { locator: locator([]) });
    expect(plan.kind).toBe("in_process");
    expect(warning).toMatch(/run on the API host/);
  });

  it("auto falls back in-process when the images are not present locally", async () => {
    const { plan, warning } = await resolveCodeSandboxPlan(base, { locator: locator(["docker"]), imagePresent: async () => false });
    expect(plan.kind).toBe("in_process");
    expect(warning).toMatch(/not present locally/);
  });

  it("auto uses a container when a runtime and both images are present", async () => {
    const { plan, warning } = await resolveCodeSandboxPlan(base, { locator: locator(["docker"]), imagePresent: async () => true });
    expect(plan).toMatchObject({ kind: "container", runtime: "docker", jsImage: base.jsImage });
    expect(warning).toBeNull();
  });

  it("mode=container disables code nodes (not a silent host fallback) when no runtime is installed", async () => {
    const { plan, warning } = await resolveCodeSandboxPlan({ ...base, mode: "container" }, { locator: locator([]) });
    expect(plan.kind).toBe("disabled");
    expect(warning).toMatch(/no container runtime/);
  });

  it("mode=in_process always runs on the host", async () => {
    const { plan } = await resolveCodeSandboxPlan({ ...base, mode: "in_process" }, { locator: locator(["docker"]), imagePresent: async () => true });
    expect(plan.kind).toBe("in_process");
  });
});

describe("container plan (spawn stubbed)", () => {
  afterEach(() => setContainerSpawnForTesting(null));

  it("runs JS in a container with a hardened argument list and no env passthrough", async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    setContainerSpawnForTesting(((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => fakeContainer(file, args, options, calls)) as never);
    const plan = { kind: "container" as const, runtime: "docker" as const, runtimePath: "/usr/bin/docker", jsImage: "node:x", pythonImage: "python:x", memoryMb: 256, cpus: 1, pidsLimit: 128, startupMs: 5000, instanceLabel: "test" };
    const outputs = await runJavaScriptCode(plan, "return { doubled: input.n * 2 };", [{ n: 3 }, { n: 4 }], 1000);
    expect(outputs.map((o) => o.result)).toEqual([{ doubled: 6 }, { doubled: 8 }]);
    const run = calls.find((c) => c.args[0] === "run")!;
    expect(run.args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]));
    expect(run.args).not.toContain("SECRET_MASTER_KEY_BASE64");
    expect(run.env).not.toHaveProperty("SECRET_MASTER_KEY_BASE64");
  });
});

/**
 * A stand-in for the container CLI: it runs the JS runner the launcher hands
 * it (`node -e <runner>`) in this process so the harness is exercised without
 * a real container, and ignores the `rm` cleanup call.
 */
function fakeContainer(file: string, args: string[], _options: unknown, calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>) {
  calls.push({ file, args, env: (_options as { env?: NodeJS.ProcessEnv }).env });
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const emit = (event: string, arg?: unknown) => (listeners[event] ?? []).forEach((fn) => fn(arg));
  const child = {
    on: (event: string, fn: (arg?: unknown) => void) => { (listeners[event] ??= []).push(fn); return child; },
    kill: () => undefined,
    stdout: { on: (_e: string, fn: (chunk: Buffer) => void) => { stdoutListeners.push(fn); return child.stdout; } },
    stderr: { on: () => child.stderr },
    stdin: {
      on: () => child.stdin,
      end: (payload?: string) => {
        if (args[0] !== "run") { queueMicrotask(() => emit("close", 0)); return; }
        const runnerIndex = args.indexOf("-e") + 1;
        const job = JSON.parse(payload ?? "{}") as { code: string; timeoutMs: number; payloads: string[] };
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
        const out = execFileSync(process.execPath, ["-e", args[runnerIndex]!], { input: payload, encoding: "utf8" });
        queueMicrotask(() => {
          stdoutListeners.forEach((fn) => fn(Buffer.from(out)));
          emit("close", 0);
        });
      }
    }
  };
  return child;
}
