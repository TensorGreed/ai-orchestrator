/**
 * Python execution support for the code_node.
 * Spawns a python subprocess and pipes JSON over stdin/stdout.
 *
 * The user's code runs in a small wrapper that exposes:
 *   - `items`: the list of input items (in runOnceForAllItems mode)
 *   - `item`:  the current item (in runOnceForEachItem mode)
 *   - `log(*args)`: collects logs returned to the caller
 *   - `result`: the variable the user assigns to to return data
 *
 * If the python binary is missing, rejects with a WorkflowError tagged
 * ErrorCategory.CONFIGURATION so callers can surface a clean error.
 *
 * The child never inherits the API's environment (which holds
 * SECRET_MASTER_KEY_BASE64 and provider keys): it gets the `env` it is given,
 * or PATH alone. Where it runs (host or container) is decided by
 * code-sandbox.ts.
 */
import { spawn } from "node:child_process";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";

export interface PythonExecutionInput {
  code: string;
  items: unknown[];
  mode: "runOnceForAllItems" | "runOnceForEachItem";
  timeoutMs?: number;
  pythonBin?: string;
  /** The child's whole environment. Defaults to PATH only; never inherits the API's. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child. */
  cwd?: string;
  /** Run with `python -I` (isolated: ignores PYTHON* variables and the user site directory). Default true. */
  isolated?: boolean;
  /** Run the child as this uid / gid (the API needs CAP_SETUID / CAP_SETGID, e.g. root in a container). */
  uid?: number;
  gid?: number;
}

export interface PythonExecutionResult {
  result: unknown;
  logs: string[];
}

export const PY_RUNNER = [
  "import json, sys, traceback",
  "data = json.loads(sys.stdin.read())",
  "items = data['items']",
  "mode = data['mode']",
  "USER_CODE = data['code']",
  "logs = []",
  "def log(*args):",
  "    logs.append(' '.join(str(a) for a in args))",
  "def _run_for_all(items):",
  "    local = {'items': items, 'log': log, 'json': json}",
  "    exec(USER_CODE, local)",
  "    return local.get('result', None)",
  "def _run_each(items):",
  "    out = []",
  "    for item in items:",
  "        local = {'item': item, 'log': log, 'json': json}",
  "        exec(USER_CODE, local)",
  "        out.append(local.get('result', None))",
  "    return out",
  "try:",
  "    result = _run_for_all(items) if mode == 'runOnceForAllItems' else _run_each(items)",
  "    sys.stdout.write(json.dumps({'ok': True, 'result': result, 'logs': logs}))",
  "except Exception as e:",
  "    sys.stdout.write(json.dumps({'ok': False, 'error': str(e), 'trace': traceback.format_exc(), 'logs': logs}))"
].join("\n");

/** The runner's JSON reply as a result, or its error as a WorkflowError. */
export function parsePythonRunnerOutput(stdout: string, stderr: string): PythonExecutionResult {
  let parsed: { ok: boolean; result?: unknown; error?: string; trace?: string; logs?: string[] };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new WorkflowError(`Python output was not valid JSON: ${stdout || stderr}`, ErrorCategory.UNKNOWN, false);
  }
  if (parsed.ok) return { result: parsed.result, logs: parsed.logs ?? [] };
  throw new WorkflowError(`Python error: ${parsed.error ?? "unknown"}`, ErrorCategory.UNKNOWN, false, { trace: parsed.trace });
}

/** How long to keep reading output after Python exits, before its pipes are dropped. */
const EXIT_OUTPUT_GRACE_MS = 100;

export async function executePythonCodeNode(input: PythonExecutionInput): Promise<PythonExecutionResult> {
  const timeoutMs = input.timeoutMs ?? 15000;
  const pythonBin =
    input.pythonBin ||
    process.env.PYTHON_BIN ||
    (process.platform === "win32" ? "python" : "python3");
  // Never the API's own environment: callers pass a minimal one, and without one the child gets PATH only.
  const env = input.env ?? { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  const args = [...(input.isolated === false ? [] : ["-I"]), "-c", PY_RUNNER];

  const spawnFailure = (err: NodeJS.ErrnoException): WorkflowError => {
    if (err.code === "EPERM" && (input.uid !== undefined || input.gid !== undefined)) {
      return new WorkflowError(
        `CODE_SANDBOX_PYTHON_UID/GID is set (uid ${input.uid ?? "unchanged"}, gid ${input.gid ?? "unchanged"}) but the API is not allowed to switch to it (${err.message}); the API needs CAP_SETUID and CAP_SETGID, or unset both.`,
        ErrorCategory.CONFIGURATION,
        false
      );
    }
    return new WorkflowError(`Python runtime '${pythonBin}' is not available: ${err.message}`, ErrorCategory.CONFIGURATION, false);
  };
  return new Promise<PythonExecutionResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: input.cwd,
        windowsHide: true,
        // Its own process group, so a timeout also kills what the code started (unless it calls setsid).
        detached: process.platform !== "win32",
        ...(input.uid !== undefined ? { uid: input.uid } : {}),
        ...(input.gid !== undefined ? { gid: input.gid } : {})
      });
    } catch (err) {
      reject(spawnFailure(err as NodeJS.ErrnoException));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finalize = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      fn();
    };
    const timer = setTimeout(() => {
      finalize(() =>
        reject(
          new WorkflowError(
            `Python execution timed out after ${timeoutMs}ms`,
            ErrorCategory.WORKFLOW_TIMEOUT,
            false
          )
        )
      );
    }, timeoutMs);

    child.on("error", (err) => {
      finalize(() => reject(spawnFailure(err as NodeJS.ErrnoException)));
    });
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    // Settle when Python itself exits, not when its pipes close: a process the code detached (setsid)
    // keeps them open. Output still in flight is read during a short grace, then the pipes are dropped.
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const settleExit = (code: number | null) => {
      if (exitTimer) clearTimeout(exitTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finalize(() => {
        if (code !== 0 && !stdout) {
          reject(
            new WorkflowError(
              `Python exited with code ${code}: ${stderr}`,
              ErrorCategory.UNKNOWN,
              false
            )
          );
          return;
        }
        try {
          resolve(parsePythonRunnerOutput(stdout, stderr));
        } catch (error) {
          reject(error);
        }
      });
    };
    child.on("exit", (code) => {
      exitTimer = setTimeout(() => settleExit(code), EXIT_OUTPUT_GRACE_MS);
    });
    child.on("close", (code) => settleExit(code));
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(JSON.stringify({ items: input.items, mode: input.mode, code: input.code }));
    child.stdin?.end();
  });
}

export async function isPythonAvailable(pythonBin?: string): Promise<boolean> {
  const bin = pythonBin || process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
