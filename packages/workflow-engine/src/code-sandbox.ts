/**
 * Where and how code nodes run.
 *
 * A deployment picks one plan at startup (see `resolveCodeSandboxPlan`):
 *
 *   container   JavaScript and Python run in a throwaway container per node
 *               execution, built like the MCP stdio sandbox (Phase 10.7):
 *               `--network none --read-only --cap-drop ALL`, a non-root user,
 *               memory, CPU and process limits, no host mounts and no
 *               environment. Needs docker or podman and the two images.
 *   in_process  the fallback when no container runtime (or image) is there.
 *               JavaScript runs in QuickJS compiled to WebAssembly inside the
 *               API process (see quickjs-sandbox.ts): no host objects, a
 *               memory limit (CODE_SANDBOX_MEMORY_MB), a stack limit and a
 *               time limit, its result passed out as JSON and capped at
 *               CODE_SANDBOX_MAX_RESULT_MB. It runs synchronously on the API's
 *               event loop, so its timeout is clamped to
 *               CODE_SANDBOX_MAX_TIMEOUT_MS (and items x timeout to four times
 *               that) to bound how long one node can stall it. Python runs as a
 *               host subprocess in isolated mode (`-I`) with an explicit,
 *               minimal environment, a scratch working directory and a hard
 *               kill on timeout -- but that is NOT a sandbox: it can run any
 *               command, open network connections the outbound URL guard
 *               never sees, and read whatever the API user can read. So it is
 *               off unless CODE_SANDBOX_PYTHON_IN_PROCESS=allow, and the API
 *               warns at startup when it is on.
 *   disabled    CODE_NODES_ENABLED=false (or the plan is still being
 *               resolved): every code node fails with a clear error.
 *
 * Both JavaScript paths use the same harness, so code behaves the same in
 * either: `input` holds the node's input, `console.*` is collected into
 * `code_logs`, `return` sets the result (async code may `await`), and there
 * is no `require`, `process`, `fetch`, timers or Buffer. The container runs
 * it on V8 (Node), the in-process path on QuickJS, which has no `Intl`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import { buildContainerRunArgs, currentSandboxOwner, detectContainerRuntime, type RuntimeLocator } from "@ai-orchestrator/mcp-sdk";
import { toSandboxJson } from "./expression-sandbox";
import { GuestError, QUICKJS_STACK_BYTES, SandboxFailureError, SandboxTimeoutError, withQuickJs } from "./quickjs-sandbox";
import { PY_RUNNER, executePythonCodeNode, parsePythonRunnerOutput, type PythonExecutionInput, type PythonExecutionResult } from "./python-runner";

export type CodeSandboxMode = "auto" | "container" | "in_process";

export type CodeSandboxPlan =
  | { kind: "disabled"; reason: string }
  | {
      kind: "in_process";
      reason?: string;
      /** Heap limit for one in-process JavaScript run. Default 256. */
      memoryMb?: number;
      /** Ceiling on one in-process JavaScript run's timeout (CODE_SANDBOX_MAX_TIMEOUT_MS). Default 30000. */
      maxTimeoutMs?: number;
      /** Ceiling on one in-process JavaScript node's results together, in MB (CODE_SANDBOX_MAX_RESULT_MB). Default 32. */
      maxResultMb?: number;
      /** Whether Python code nodes may run as host subprocesses. Default "allow". */
      python?: "allow" | "deny";
      /** Run host Python as this uid/gid (needs the API to hold CAP_SETUID/CAP_SETGID). */
      pythonUid?: number;
      pythonGid?: number;
    }
  | {
      kind: "container";
      runtime: "docker" | "podman";
      runtimePath: string;
      jsImage: string;
      pythonImage: string;
      memoryMb: number;
      cpus: number;
      pidsLimit: number;
      /** Extra time allowed for the container to start, on top of the code's own timeout. */
      startupMs: number;
      /** Label value shared by this deployment's containers, so the startup sweep finds leftovers. */
      instanceLabel: string;
    };

export const IN_PROCESS_CODE_SANDBOX: CodeSandboxPlan = { kind: "in_process" };

/** The engine's plan when the caller supplies none: no code runs. The API always supplies its settled plan. */
export const NO_CODE_SANDBOX_PLAN: CodeSandboxPlan = {
  kind: "disabled",
  reason: "Code nodes cannot run: no code sandbox plan was supplied to the workflow engine."
};

/** The plan in force while the real one is being resolved at startup: nothing runs until it settles. */
export const CODE_SANDBOX_INITIALISING: CodeSandboxPlan = {
  kind: "disabled",
  reason: "The code node sandbox is still starting up; try again in a moment."
};

export const PYTHON_IN_PROCESS_DENIED_MESSAGE =
  "Python code nodes are disabled on this deployment: no container sandbox is available and CODE_SANDBOX_PYTHON_IN_PROCESS=deny. Ask an admin to install docker or podman with the Python image, or to allow in-process Python.";

export const CODE_NODES_DISABLED_MESSAGE = "Code nodes are disabled on this deployment (CODE_NODES_ENABLED=false). Ask an admin to enable them.";

export function codeNodesDisabledError(plan: Extract<CodeSandboxPlan, { kind: "disabled" }>): WorkflowError {
  return new WorkflowError(plan.reason, ErrorCategory.CONFIGURATION, false);
}

export interface CodeRunOutput {
  result: unknown;
  logs: string[];
}

/**
 * The harness, for QuickJS (in process) and V8 (the container): defines
 * `__l2mSet(code, payload JSON)`, `__l2mStart()` (parse the payload into
 * `input`, compile the code as an async function body, run it) and
 * `__l2mResult()` (the outcome as a JSON string once the code has settled,
 * undefined before). The code is compiled by the sandbox's own
 * AsyncFunction, so it cannot break out of a wrapper, and every error is
 * caught and described inside the sandbox.
 */
export function codePreludeSource(maxChars: number): string {
  return String.raw`(() => {
  "use strict";
  const stringify = JSON.stringify, parse = JSON.parse, toText = String, MAX = ${Math.floor(maxChars)};
  const tooLarge = () => stringify({ ok: false, error: "Code node result is too large (over " + MAX + " characters including logs; CODE_SANDBOX_MAX_RESULT_MB).", logs: [] });
  const AsyncFunction = (async function () {}).constructor;
  const logs = [];
  let code = "";
  let payload = "null";
  let out;
  const format = (args) => {
    const parts = [];
    for (const arg of args) {
      if (typeof arg === "string") { parts.push(arg); continue; }
      try {
        const text = stringify(arg);
        parts.push(text === undefined ? toText(arg) : text);
      } catch (error) {
        parts.push(toText(arg));
      }
    }
    return parts.join(" ");
  };
  const logger = (prefix) => (...args) => {
    if (logs.length < 1000) logs.push(prefix + format(args));
  };
  globalThis.console = { log: logger(""), info: logger(""), debug: logger(""), warn: logger("WARN: "), error: logger("ERROR: ") };
  const describe = (error) => {
    try {
      if (error && typeof error === "object") {
        if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
        if (typeof error.name === "string" && error.name.trim()) return error.name.trim();
        const text = stringify(error);
        if (text && text !== "{}") return text;
      }
      return toText(error).trim() || "Code node execution failed.";
    } catch (inner) {
      return "Code node execution failed.";
    }
  };
  // The outcome is only recorded here and serialized in __l2mResult, which the host calls synchronously:
  // QuickJS leaks objects (and then cannot free the runtime) when a large JSON.stringify runs inside a promise job.
  let settled = null;
  const finish = (value) => { if (!settled) settled = { ok: true, value }; };
  const fail = (error) => { if (!settled) settled = { ok: false, error }; };
  const render = () => {
    if (!settled.ok) {
      const text = stringify({ ok: false, error: describe(settled.error).slice(0, 10000), logs });
      return typeof text === "string" && text.length > MAX ? tooLarge() : text;
    }
    const value = settled.value;
    let text;
    try { text = value === undefined ? "null" : stringify(value); } catch (error) { text = stringify(toText(value)); }
    const logText = stringify(logs);
    if ((text === undefined ? 4 : text.length) + (typeof logText === "string" ? logText.length : 0) > MAX) return tooLarge();
    return '{"ok":true,"result":' + (text === undefined ? "null" : text) + ',"logs":' + logText + "}";
  };
  Object.defineProperty(globalThis, "__l2mStart", {
    value: () => {
      try { globalThis.input = parse(payload); } catch (error) { fail(error); return; }
      let fn;
      try { fn = new AsyncFunction(code); } catch (error) { fail(error); return; }
      try { fn().then(finish, fail); } catch (error) { fail(error); }
    }
  });
  Object.defineProperty(globalThis, "__l2mResult", { value: () => (out === undefined && settled ? (out = render()) : out) });
  Object.defineProperty(globalThis, "__l2mSet", { value: (nextCode, nextPayload) => { code = nextCode; payload = nextPayload; } });
})();`;
}

/** Defaults for CODE_SANDBOX_MAX_TIMEOUT_MS and CODE_SANDBOX_MAX_RESULT_MB. */
export const DEFAULT_IN_PROCESS_MAX_TIMEOUT_MS = 30_000;
export const DEFAULT_CODE_MAX_RESULT_MB = 32;

/** The harness with the default result cap (the container runner's copy). */
export const CODE_PRELUDE_SOURCE = codePreludeSource(DEFAULT_CODE_MAX_RESULT_MB * 1024 * 1024);

const preludes = new Map<number, string>([[DEFAULT_CODE_MAX_RESULT_MB * 1024 * 1024, CODE_PRELUDE_SOURCE]]);
function preludeFor(maxChars: number): string {
  let source = preludes.get(maxChars);
  if (!source) {
    source = codePreludeSource(maxChars);
    if (preludes.size < 16) preludes.set(maxChars, source);
  }
  return source;
}

const NEVER_SETTLED = "Code node did not finish: it waits on a promise that never settles (timers and network are not available in the sandbox).";

/** Default heap limit for one in-process JavaScript run (CODE_SANDBOX_MEMORY_MB). */
export const DEFAULT_IN_PROCESS_MEMORY_MB = 256;

function parseHarnessOutput(raw: unknown): CodeRunOutput {
  if (typeof raw !== "string") throw new Error(`Code node sandbox error: ${NEVER_SETTLED}`);
  let parsed: { ok?: unknown; result?: unknown; error?: unknown; logs?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("Code node sandbox error: the sandbox returned an unreadable result.");
  }
  const logs = Array.isArray(parsed.logs) ? parsed.logs.filter((line): line is string => typeof line === "string") : [];
  if (parsed.ok === true) return { result: parsed.result ?? null, logs };
  throw new Error(`Code node sandbox error: ${typeof parsed.error === "string" ? parsed.error : "Code node execution failed."}`);
}

/** The harness's `{ error }` field, or undefined; never throws, whatever the guest made of its result. */
function harnessError(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  } catch {
    return undefined;
  }
}

/** One JavaScript run in a fresh QuickJS runtime and context of this process. */
export function runJavaScriptInProcess(
  code: string,
  input: unknown,
  timeoutMs: number,
  memoryMb: number = DEFAULT_IN_PROCESS_MEMORY_MB,
  maxResultMb: number = DEFAULT_CODE_MAX_RESULT_MB
): CodeRunOutput & { resultChars: number } {
  let raw: string | undefined;
  try {
    raw = withQuickJs({ memoryBytes: Math.floor(memoryMb * 1024 * 1024), stackBytes: QUICKJS_STACK_BYTES, timeoutMs }, (session) => {
      session.evaluateTrusted(preludeFor(Math.floor(maxResultMb * 1024 * 1024)), "l2m-code-prelude.js");
      session.callGlobal("__l2mSet", [code, toSandboxJson(input)]);
      session.callGlobal("__l2mStart", []);
      let result = session.callGlobal("__l2mResult", []);
      session.drainJobs(() => {
        result = session.callGlobal("__l2mResult", []);
        return result !== undefined;
      });
      const final = result ?? session.callGlobal("__l2mResult", []);
      // The interrupt (time or memory) stopping an awaited job reaches the harness as a rejection named "interrupted".
      if (final !== undefined && harnessError(final) === "interrupted") {
        if (session.memoryExceeded()) throw new GuestError(`out of memory (limit ${memoryMb} MB)`);
        if (session.remainingMs() <= 0) throw new SandboxTimeoutError(timeoutMs);
      }
      return final;
    });
  } catch (error) {
    // The harness catches everything the code throws; only a timeout or a sandbox failure reaches here.
    const message = error instanceof SandboxTimeoutError || error instanceof GuestError || error instanceof SandboxFailureError ? error.message : "Code node execution failed.";
    throw new Error(`Code node sandbox error: ${message}`);
  }
  return { ...parseHarnessOutput(raw), resultChars: typeof raw === "string" ? raw.length : 0 };
}

/**
 * The timeout an in-process JavaScript run actually gets: the node's own,
 * clamped to the plan's ceiling, since the run holds the API's event loop.
 * Refuses a node whose items together could hold it more than four times
 * the ceiling.
 */
export function inProcessTimeout(plan: Extract<CodeSandboxPlan, { kind: "in_process" }>, timeoutMs: number, items: number): number {
  const ceiling = plan.maxTimeoutMs ?? DEFAULT_IN_PROCESS_MAX_TIMEOUT_MS;
  const clamped = Math.max(1, Math.min(timeoutMs, ceiling));
  if (items > 1 && clamped * items > ceiling * 4) {
    throw new WorkflowError(
      `This code node would run ${items} items for up to ${clamped}ms each in the API process, more than ${ceiling * 4}ms in all (4 x CODE_SANDBOX_MAX_TIMEOUT_MS). Lower its timeout, run once for all items, or use the container sandbox.`,
      ErrorCategory.NODE_CONFIG,
      false
    );
  }
  return clamped;
}

/** Hardening for the V8 realm the container runner builds (the container is the boundary; this is defence in depth). */
export const REALM_HARDEN_SOURCE = String.raw`(() => {
  "use strict";
  Object.defineProperty(Error, "prepareStackTrace", { value: undefined, writable: false, configurable: false, enumerable: false });
  for (const name of ["WebAssembly", "SharedArrayBuffer", "Atomics", "WeakRef", "FinalizationRegistry"]) {
    try { delete globalThis[name]; } catch (error) { globalThis[name] = undefined; }
  }
  for (const name of ["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "input", "$_", "lastMatch", "$&", "lastParen", "$+", "leftContext", "$\u0060", "rightContext", "$'"]) {
    try { delete RegExp[name]; } catch (error) { /* not configurable on this runtime */ }
  }
})();`;

/** The program a container runs for JavaScript: the same harness, fed from stdin. */
export const CONTAINER_JS_RUNNER = String.raw`"use strict";
const vm = require("node:vm");
const HARDEN = ${JSON.stringify(REALM_HARDEN_SOURCE)};
const PRELUDE = ${JSON.stringify(CODE_PRELUDE_SOURCE)};
const dont = vm.constants && vm.constants.DONT_CONTEXTIFY;
const runOne = (code, payload, timeout) => {
  const options = { microtaskMode: "afterEvaluate", codeGeneration: { strings: true, wasm: false } };
  const context = dont !== undefined ? vm.createContext(dont, options) : vm.createContext(Object.create(null), options);
  vm.runInContext(HARDEN, context);
  vm.runInContext(PRELUDE, context);
  vm.runInContext("__l2mSet", context)(code, payload);
  try {
    vm.runInContext("__l2mStart()", context, { timeout, filename: "code-node.js" });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message), logs: [] });
  }
  const raw = vm.runInContext("__l2mResult()", context, { timeout: 100 });
  return typeof raw === "string" ? raw : null;
};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const job = JSON.parse(raw);
  process.stdout.write(JSON.stringify(job.payloads.map((payload) => runOne(job.code, payload, job.timeoutMs))));
});
`;

interface ContainerRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Spawner seam for tests: by default the real container CLI. */
export type ContainerSpawn = typeof spawn;

let containerSpawn: ContainerSpawn = spawn;

/** Replaces the process spawner (tests only). */
export function setContainerSpawnForTesting(next: ContainerSpawn | null): void {
  containerSpawn = next ?? spawn;
}

const MAX_CONTAINER_OUTPUT_BYTES = 64 * 1024 * 1024;

function runContainer(
  plan: Extract<CodeSandboxPlan, { kind: "container" }>,
  image: string,
  command: string,
  args: string[],
  stdin: string,
  budgetMs: number
): Promise<ContainerRunResult> {
  const name = `l2m-code-${randomUUID().slice(0, 12)}`;
  const runArgs = buildContainerRunArgs({
    settings: { mode: "container", image, memoryMb: plan.memoryMb, cpus: plan.cpus, pidsLimit: plan.pidsLimit, network: "none" },
    command,
    args,
    envNames: [],
    containerName: name,
    instanceLabel: plan.instanceLabel,
    owner: currentSandboxOwner(),
    mounts: []
  });
  return new Promise<ContainerRunResult>((resolve, reject) => {
    // The CLI gets an empty environment apart from PATH/HOME: no API secrets, and none are passed into the container.
    const child = containerSpawn(plan.runtimePath, runArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? os.tmpdir() },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    const remove = () => {
      const cleanup = containerSpawn(plan.runtimePath, ["rm", "-f", name], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" }, windowsHide: true });
      cleanup.on("error", () => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      remove();
    }, budgetMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WorkflowError(`Container runtime '${plan.runtime}' could not start: ${error.message}`, ErrorCategory.CONFIGURATION, false));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTAINER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        remove();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
}

function containerFailure(plan: Extract<CodeSandboxPlan, { kind: "container" }>, image: string, run: ContainerRunResult, budgetMs: number): WorkflowError {
  if (run.timedOut) {
    return new WorkflowError(`Code node container timed out after ${budgetMs}ms`, ErrorCategory.WORKFLOW_TIMEOUT, false);
  }
  const detail = run.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  // 125-127 are the CLI's own failures (daemon, image, command), not the code's.
  if (run.code !== null && run.code >= 125 && run.code <= 127) {
    return new WorkflowError(`Code node container could not run (${plan.runtime}, image ${image}): ${detail || `exit ${run.code}`}`, ErrorCategory.CONFIGURATION, false);
  }
  return new WorkflowError(`Code node container exited with code ${run.code}: ${detail}`, ErrorCategory.UNKNOWN, false);
}

/**
 * Runs JavaScript once per input, all in one sandbox: one container, or one
 * fresh realm per input in this process. Throws on the first failing input.
 */
export async function runJavaScriptCode(plan: CodeSandboxPlan, code: string, inputs: unknown[], timeoutMs: number): Promise<CodeRunOutput[]> {
  if (plan.kind === "disabled") throw codeNodesDisabledError(plan);
  if (plan.kind === "in_process") {
    const timeout = inProcessTimeout(plan, timeoutMs, inputs.length);
    const maxResultMb = plan.maxResultMb ?? DEFAULT_CODE_MAX_RESULT_MB;
    const maxChars = maxResultMb * 1024 * 1024;
    let total = 0;
    return inputs.map((input) => {
      const { resultChars, ...output } = runJavaScriptInProcess(code, input, timeout, plan.memoryMb, maxResultMb);
      total += resultChars;
      // Each run is capped inside the sandbox; this caps the node's items together.
      if (total > maxChars) throw new Error(`Code node sandbox error: the results of this node's items are too large together (over ${maxResultMb} MB; CODE_SANDBOX_MAX_RESULT_MB).`);
      return output;
    });
  }
  const job = JSON.stringify({ code, timeoutMs, payloads: inputs.map((input) => toSandboxJson(input)) });
  const budgetMs = plan.startupMs + timeoutMs * Math.max(1, inputs.length);
  const run = await runContainer(plan, plan.jsImage, "node", ["-e", CONTAINER_JS_RUNNER], job, budgetMs);
  if (run.timedOut || run.code !== 0) throw containerFailure(plan, plan.jsImage, run, budgetMs);
  let outputs: unknown;
  try {
    outputs = JSON.parse(run.stdout);
  } catch {
    throw new Error("Code node sandbox error: the container returned an unreadable result.");
  }
  if (!Array.isArray(outputs) || outputs.length !== inputs.length) {
    throw new Error("Code node sandbox error: the container returned an unexpected result.");
  }
  return outputs.map((raw) => parseHarnessOutput(raw));
}

/** The environment a host Python subprocess gets: enough to start, nothing from the API's own environment. */
export function pythonHostEnv(workdir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workdir,
    TMPDIR: workdir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * The uid/gid host Python runs as. With only a uid set, the gid is the same
 * number: otherwise the child would keep the API's primary group and could
 * read files that group can read.
 */
export function pythonIdentity(plan: Extract<CodeSandboxPlan, { kind: "in_process" }>): { uid?: number; gid?: number } {
  if (plan.pythonUid === undefined) return plan.pythonGid !== undefined ? { gid: plan.pythonGid } : {};
  return { uid: plan.pythonUid, gid: plan.pythonGid ?? plan.pythonUid };
}

/** Runs a Python code node under the plan. */
export async function runPythonCode(plan: CodeSandboxPlan, input: PythonExecutionInput): Promise<PythonExecutionResult> {
  if (plan.kind === "disabled") throw codeNodesDisabledError(plan);
  const timeoutMs = input.timeoutMs ?? 15000;
  if (plan.kind === "in_process") {
    if (plan.python === "deny") throw new WorkflowError(PYTHON_IN_PROCESS_DENIED_MESSAGE, ErrorCategory.CONFIGURATION, false);
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-py-"));
    const { uid: pythonUid, gid: pythonGid } = pythonIdentity(plan);
    try {
      if (pythonUid !== undefined) {
        try {
          fs.chownSync(workdir, pythonUid, pythonGid ?? -1);
        } catch (error) {
          throw new WorkflowError(
            `CODE_SANDBOX_PYTHON_UID is set but the API cannot hand its scratch directory to uid ${plan.pythonUid} (${(error as Error).message}); the API needs CAP_CHOWN and CAP_SETUID.`,
            ErrorCategory.CONFIGURATION,
            false
          );
        }
      }
      return await executePythonCodeNode({
        ...input,
        timeoutMs,
        env: pythonHostEnv(workdir),
        cwd: workdir,
        isolated: true,
        uid: pythonUid,
        gid: pythonGid
      });
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
  const budgetMs = plan.startupMs + timeoutMs;
  const run = await runContainer(plan, plan.pythonImage, "python3", ["-I", "-c", PY_RUNNER], JSON.stringify({ code: input.code, items: input.items, mode: input.mode }), budgetMs);
  if (run.timedOut) throw containerFailure(plan, plan.pythonImage, run, budgetMs);
  if (run.code !== 0 && !run.stdout) throw containerFailure(plan, plan.pythonImage, run, budgetMs);
  return parsePythonRunnerOutput(run.stdout, run.stderr);
}

export interface CodeSandboxSettings {
  enabled: boolean;
  mode: CodeSandboxMode;
  runtime: "auto" | "docker" | "podman";
  jsImage: string;
  pythonImage: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  startupMs: number;
  instanceLabel: string;
  /** Whether Python may run as a host subprocess when there is no container plan. Default "allow". */
  pythonInProcess?: "allow" | "deny";
  /** Optional uid / gid for host Python subprocesses (the gid defaults to the uid). */
  pythonUid?: number;
  pythonGid?: number;
  /** Ceiling on an in-process JavaScript run's timeout (CODE_SANDBOX_MAX_TIMEOUT_MS). */
  maxTimeoutMs?: number;
  /** Ceiling on an in-process JavaScript node's results (CODE_SANDBOX_MAX_RESULT_MB). */
  maxResultMb?: number;
}

/** Checks whether an image is present locally (nothing is pulled). Seam for tests. */
export type ImagePresenceCheck = (runtimePath: string, image: string) => Promise<boolean>;

const defaultImagePresent: ImagePresenceCheck = (runtimePath, image) =>
  new Promise((resolve) => {
    const child = spawn(runtimePath, ["image", "inspect", "--format", "{{.Id}}", image], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" }, windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

/** The startup warning for an in-process plan: what each language can and cannot do on the host. */
export function hostWarning(reason: string, python: "allow" | "deny", pythonUid?: number): string {
  const js = `JavaScript code nodes run in a QuickJS WebAssembly sandbox in the API process (no host access, memory and time limits).`;
  const py =
    python === "deny"
      ? "Python code nodes are disabled (CODE_SANDBOX_PYTHON_IN_PROCESS=deny)."
      : `Python code nodes run as host subprocesses${pythonUid !== undefined ? ` as uid ${pythonUid}` : " as the API user"} and are NOT sandboxed: they can run any OS command, open network connections that bypass the outbound URL guard, and read any file that user can read (the SQLite database, .env)${pythonUid !== undefined ? "" : ", including the API's own environment through /proc/<pid>/environ, which holds SECRET_MASTER_KEY_BASE64"}. Anyone who can author a workflow can do this.`;
  return `Code nodes run on the API host, not in a container: ${reason} ${js} ${py} Install docker or podman with the code images (CODE_SANDBOX_MODE=container), set CODE_SANDBOX_PYTHON_IN_PROCESS=deny, or CODE_NODES_ENABLED=false.`;
}

/**
 * Picks the plan for this deployment, with a warning when code runs on the
 * host. `auto` uses containers only when a runtime is installed and both
 * images are already present locally (so no run waits on a pull); `container`
 * insists on containers (images are pulled on first use) and fails code nodes
 * when no runtime is installed.
 */
export async function resolveCodeSandboxPlan(
  settings: CodeSandboxSettings,
  deps: { locator?: RuntimeLocator; imagePresent?: ImagePresenceCheck } = {}
): Promise<{ plan: CodeSandboxPlan; warning: string | null }> {
  if (!settings.enabled) return { plan: { kind: "disabled", reason: CODE_NODES_DISABLED_MESSAGE }, warning: null };
  const python = settings.pythonInProcess ?? "deny";
  const onHost = (reason: string) => ({
    plan: {
      kind: "in_process",
      reason,
      memoryMb: settings.memoryMb,
      python,
      ...(settings.maxTimeoutMs !== undefined ? { maxTimeoutMs: settings.maxTimeoutMs } : {}),
      ...(settings.maxResultMb !== undefined ? { maxResultMb: settings.maxResultMb } : {}),
      ...(settings.pythonUid !== undefined ? { pythonUid: settings.pythonUid } : {}),
      ...(settings.pythonGid !== undefined ? { pythonGid: settings.pythonGid } : {})
    } as CodeSandboxPlan,
    warning: hostWarning(reason, python, settings.pythonUid)
  });
  if (settings.mode === "in_process") return onHost("CODE_SANDBOX_MODE=in_process.");
  const found = detectContainerRuntime(settings.runtime, deps.locator);
  if (!found) {
    if (settings.mode === "container") {
      return {
        plan: { kind: "disabled", reason: `Code nodes need a container runtime (CODE_SANDBOX_MODE=container) and none was found (${settings.runtime === "auto" ? "docker or podman" : settings.runtime}).` },
        warning: "CODE_SANDBOX_MODE=container but no container runtime was found: code nodes will fail until docker or podman is installed."
      };
    }
    return onHost("no container runtime (docker or podman) was found.");
  }
  if (settings.mode === "auto") {
    const imagePresent = deps.imagePresent ?? defaultImagePresent;
    const [js, py] = await Promise.all([imagePresent(found.path, settings.jsImage), imagePresent(found.path, settings.pythonImage)]);
    if (!js || !py) {
      const missing = [!js ? settings.jsImage : null, !py ? settings.pythonImage : null].filter(Boolean).join(" and ");
      return onHost(`${found.runtime} is installed but ${missing} is not present locally (pull it to enable the container sandbox).`);
    }
  }
  return {
    plan: {
      kind: "container",
      runtime: found.runtime,
      runtimePath: found.path,
      jsImage: settings.jsImage,
      pythonImage: settings.pythonImage,
      memoryMb: settings.memoryMb,
      cpus: settings.cpus,
      pidsLimit: settings.pidsLimit,
      startupMs: settings.startupMs,
      instanceLabel: settings.instanceLabel
    },
    warning: null
  };
}

/** A short description for the editor and logs. */
export function describeCodeSandboxPlan(plan: CodeSandboxPlan): { mode: "container" | "in_process" | "disabled"; detail: string } {
  if (plan.kind === "disabled") return { mode: "disabled", detail: plan.reason };
  if (plan.kind === "in_process") return { mode: "in_process", detail: plan.reason ?? "Code runs on the API host." };
  return { mode: "container", detail: `${plan.runtime}: ${plan.jsImage}, ${plan.pythonImage}` };
}

