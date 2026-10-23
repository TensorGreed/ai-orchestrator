/**
 * The JavaScript sandbox for user code that runs inside the API process:
 * expressions (`{{ }}` templates, Sort keys) and in-process code nodes.
 *
 * Code runs in QuickJS compiled to WebAssembly (quickjs-emscripten). That is a
 * separate engine with its own heap inside a WebAssembly instance: there is no
 * V8 object, host function or host error in it, so nothing the code reaches
 * can lead back to `process`, `require` or the host `Function` (the class of
 * escape that defeats `node:vm`). Every session gets a fresh QuickJS runtime
 * and context with a memory limit, a stack limit and a deadline enforced by
 * the interrupt handler, and is disposed afterwards, so nothing one
 * evaluation does is visible to the next. Data goes in and comes out as
 * strings (JSON); no host function is ever exposed to the guest.
 *
 * The WebAssembly module (one instance) is loaded once and reused. Some deep
 * recursions inside the engine's C code (the parser, for one) exhaust the
 * host's native stack before QuickJS's own stack check fires; the host then
 * throws out of the WebAssembly call and the instance's state can no longer be
 * trusted. Any such host-level failure retires the instance: a pre-loaded
 * spare takes over at once and a new spare is loaded in the background. So
 * does a runtime that cannot be freed cleanly (QuickJS leaks objects when the
 * time limit interrupts a promise job, and then refuses to free the runtime).
 */
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule
} from "quickjs-emscripten-core";

export interface QuickJsLimits {
  /** Heap limit for the session's runtime, in bytes. */
  memoryBytes: number;
  /** QuickJS stack limit, in bytes. */
  stackBytes: number;
  /** Wall-clock budget for the whole session, in ms. */
  timeoutMs: number;
}

/** QuickJS stack limit used by every session. Larger values let deep guest recursion overflow the host stack first (see the module comment). */
export const QUICKJS_STACK_BYTES = 192 * 1024;

/** An error raised by the guest code (a value the sandbox reported), as opposed to a sandbox failure. */
export class GuestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestError";
  }
}

/** The session ran past its deadline. */
export class SandboxTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = "SandboxTimeoutError";
  }
}

/** The sandbox itself failed (host stack exhausted, WebAssembly trap, no instance ready). */
export class SandboxFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxFailureError";
  }
}

// Emscripten prints aborts to stderr; a retired instance is expected and logged by its caller, not by the WebAssembly glue.
const variant = newVariant(releaseSyncVariant, { emscriptenModule: { print: () => undefined, printErr: () => undefined } as never });

const loadModule = (): Promise<QuickJSWASMModule> => newQuickJSWASMModuleFromVariant(variant);

/** Pre-loaded instances that take over when the active one is retired (each reserves 16 MB of linear memory, ~1 MB resident). */
const SPARE_INSTANCES = 2;

let active: QuickJSWASMModule | null = await loadModule();
const spares: QuickJSWASMModule[] = [];
for (let i = 0; i < SPARE_INSTANCES; i += 1) spares.push(await loadModule());
let refilling: Promise<void> | null = null;
let retiredCount = 0;

function refill(): void {
  if (refilling || (active && spares.length >= SPARE_INSTANCES)) return;
  refilling = loadModule()
    .then((loaded) => {
      if (!active) active = loaded;
      else spares.push(loaded);
    })
    .catch(() => undefined)
    .finally(() => {
      refilling = null;
      if (!active || spares.length < SPARE_INSTANCES) setTimeout(refill, active ? 0 : 50).unref?.();
    });
}

function retire(module: QuickJSWASMModule): void {
  if (active === module) {
    active = spares.shift() ?? null;
    retiredCount += 1;
  }
  refill();
}

/** Resolves once an instance and all spares are ready again after retirements. For tests and startup. */
export async function quickJsSandboxReady(): Promise<void> {
  while (!active || spares.length < SPARE_INSTANCES) {
    refill();
    if (refilling) await refilling;
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** How many WebAssembly instances have been retired since start (tests, diagnostics). */
export function quickJsRetiredInstances(): number {
  return retiredCount;
}

/** The handles a session body works with. */
export interface QuickJsSession {
  runtime: QuickJSRuntime;
  context: QuickJSContext;
  /** Milliseconds left before the deadline (may be negative). */
  remainingMs(): number;
  /** Starts a new time budget (one session can serve several evaluations, each with its own limit). */
  resetDeadline(timeoutMs: number): void;
  /** Evaluates trusted source (a prelude); a guest error from it is a sandbox failure. */
  evaluateTrusted(source: string, filename: string): void;
  /**
   * Calls a global function with string arguments and returns its string
   * result, or undefined when it returns anything else. A thrown guest error
   * (only the uncatchable interrupt reaches here, the preludes catch the rest)
   * becomes SandboxTimeoutError when the deadline has passed, else GuestError.
   */
  callGlobal(name: string, args: string[]): string | undefined;
  /** Runs queued promise jobs until none are left, `done()` is true, or the deadline passes. */
  drainJobs(done: () => boolean): void;
}

function failureFrom(error: unknown): SandboxFailureError {
  if (error instanceof SandboxFailureError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SandboxFailureError(/call stack/i.test(message) ? "the code nests too deeply for the sandbox" : `the sandbox failed (${message})`);
}

/**
 * Runs `body` in a fresh QuickJS runtime and context with the given limits,
 * then disposes both. Any failure other than GuestError and
 * SandboxTimeoutError means the WebAssembly instance can no longer be
 * trusted: it is retired at once, the session refuses further calls, and the
 * error surfaces as SandboxFailureError.
 */
export function withQuickJs<T>(limits: QuickJsLimits, body: (session: QuickJsSession) => T): T {
  const module = active;
  if (!module) {
    refill();
    throw new SandboxFailureError("The JavaScript sandbox is restarting; try again in a moment.");
  }
  let deadline = Date.now() + limits.timeoutMs;
  let budgetMs = limits.timeoutMs;
  let runtime: QuickJSRuntime | null = null;
  let context: QuickJSContext | null = null;
  let healthy = true;
  const fail = (error: unknown): never => {
    if (healthy) {
      healthy = false;
      retire(module);
    }
    throw failureFrom(error);
  };
  // Every call into the instance goes through here, so a host-level failure retires it before anything else runs on it.
  const guarded = <R>(call: () => R): R => {
    if (!healthy) throw new SandboxFailureError("the sandbox failed earlier in this evaluation");
    try {
      return call();
    } catch (error) {
      if (error instanceof GuestError || error instanceof SandboxTimeoutError) throw error;
      return fail(error);
    }
  };
  try {
    guarded(() => {
      runtime = module.newRuntime();
      runtime.setMemoryLimit(limits.memoryBytes);
      runtime.setMaxStackSize(limits.stackBytes);
      runtime.setInterruptHandler(() => Date.now() >= deadline);
      // The module loader is never set, so `import()` rejects inside QuickJS without touching the host.
      context = runtime.newContext();
    });
    const ctx = context as unknown as QuickJSContext;
    const rt = runtime as unknown as QuickJSRuntime;
    const describe = (handle: QuickJSHandle): string => {
      try {
        const dumped = ctx.dump(handle) as unknown;
        if (dumped && typeof dumped === "object" && typeof (dumped as { message?: unknown }).message === "string") {
          return (dumped as { message: string }).message;
        }
        return String(dumped);
      } catch {
        return "error";
      }
    };
    const guestFailure = (handle: QuickJSHandle): Error => {
      const message = describe(handle);
      handle.dispose();
      return Date.now() >= deadline ? new SandboxTimeoutError(budgetMs) : new GuestError(message);
    };
    const session: QuickJsSession = {
      runtime: rt,
      context: ctx,
      remainingMs: () => deadline - Date.now(),
      resetDeadline(timeoutMs) {
        budgetMs = timeoutMs;
        deadline = Date.now() + timeoutMs;
      },
      evaluateTrusted(source, filename) {
        guarded(() => {
          const result = ctx.evalCode(source, filename);
          if (result.error) {
            const error = guestFailure(result.error);
            if (error instanceof SandboxTimeoutError) throw error;
            throw new SandboxFailureError(`Sandbox prelude failed: ${error.message}`);
          }
          result.value.dispose();
        });
      },
      callGlobal(name, args) {
        return guarded(() => {
          const fn = ctx.getProp(ctx.global, name);
          const handles = args.map((arg) => ctx.newString(arg));
          try {
            const result = ctx.callFunction(fn, ctx.undefined, ...handles);
            if (result.error) throw guestFailure(result.error);
            const value = result.value;
            try {
              return ctx.typeof(value) === "string" ? ctx.getString(value) : undefined;
            } finally {
              value.dispose();
            }
          } finally {
            for (const handle of handles) handle.dispose();
            fn.dispose();
          }
        });
      },
      drainJobs(done) {
        while (!done() && guarded(() => rt.hasPendingJob())) {
          if (Date.now() >= deadline) throw new SandboxTimeoutError(budgetMs);
          guarded(() => {
            const result = rt.executePendingJobs(256);
            if (result.error) throw guestFailure(result.error);
          });
        }
      }
    };
    return body(session);
  } catch (error) {
    if (error instanceof GuestError || error instanceof SandboxTimeoutError) throw error;
    return fail(error);
  } finally {
    if (healthy) {
      try {
        const rt = runtime as QuickJSRuntime | null;
        // Freeing a runtime with queued promise jobs aborts the instance, so drop them first: with the
        // deadline in the past every job is interrupted at its next check instead of running on.
        if (rt?.hasPendingJob()) {
          deadline = 0;
          for (let round = 0; round < 1000 && rt.hasPendingJob(); round += 1) {
            const flushed = rt.executePendingJobs(-1);
            if (flushed.error) flushed.error.dispose();
          }
          if (rt.hasPendingJob()) throw new Error("promise jobs could not be cleared");
        }
        (context as QuickJSContext | null)?.dispose();
        rt?.dispose();
      } catch {
        // A leaked object or a corrupted instance: never reuse it.
        healthy = false;
        retire(module);
      }
    }
  }
}
