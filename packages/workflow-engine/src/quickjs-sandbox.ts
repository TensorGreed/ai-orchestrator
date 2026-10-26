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
 * Memory: QuickJS's own malloc limit does not count everything (many small
 * strings grow the heap far past it), so the interrupt handler also measures
 * the instance's linear memory and stops the session once it has grown by
 * more than the limit. WebAssembly memory never shrinks, so an instance whose
 * heap has grown past a threshold is recycled after the session: a fresh one
 * takes over and the old one is garbage-collected. Free heap an earlier session
 * grew is reusable without further growth, so a session whose memory limit is
 * smaller than that free space starts on a fresh instance too (when a spare is
 * ready), which keeps the limit exact.
 *
 * The WebAssembly module is compiled once; instances of it are reused. Some
 * deep recursions inside the engine's C code (the parser, for one) exhaust the
 * host's native stack before QuickJS's own stack check fires; the host then
 * throws out of the WebAssembly call and the instance's state can no longer be
 * trusted. Any such host-level failure retires the instance: a pre-loaded
 * spare takes over at once and new spares are loaded in the background. So
 * does a runtime that cannot be freed cleanly (QuickJS leaks objects when the
 * time limit interrupts a promise job, and then refuses to free the runtime).
 * Loading an instance is asynchronous in this package, so spares are what
 * keeps the pool from running dry; a workflow that keeps crashing instances
 * is cut off by a per-owner circuit breaker (see `runWithSandboxOwner`)
 * before it can drain them for everyone else.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { createRequire } from "node:module";
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
  /** Wall-clock budget for the session's first evaluation, in ms (`resetDeadline` starts a new one). */
  timeoutMs: number;
  /**
   * Upper bound on the whole session, in ms, however often `resetDeadline` is
   * called (one template's expressions together). Default: no bound beyond
   * each evaluation's own limit.
   */
  sessionBudgetMs?: number;
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

/**
 * The sandbox itself failed (host stack exhausted, WebAssembly trap), had no
 * instance ready, or refused the owner (circuit breaker). `retryable` is true
 * when the same call may well succeed a moment later (no instance was ready).
 */
export class SandboxFailureError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "SandboxFailureError";
    this.retryable = retryable;
  }
}

const silentGlue = { print: () => undefined, printErr: () => undefined } as never;

/** Compiles the WebAssembly module once, so loading an instance only instantiates it. Falls back to the package's own loader. */
function compileModule(): WebAssembly.Module | null {
  try {
    const require = createRequire(import.meta.url);
    return new WebAssembly.Module(fs.readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")));
  } catch {
    return null;
  }
}

const compiled = compileModule();
// Emscripten prints aborts to stderr; a retired instance is expected and logged by its caller, not by the WebAssembly glue.
const variant = newVariant(releaseSyncVariant, compiled ? { wasmModule: compiled, emscriptenModule: silentGlue } : { emscriptenModule: silentGlue });

const loadModule = (): Promise<QuickJSWASMModule> => newQuickJSWASMModuleFromVariant(variant);

/**
 * Bytes of linear memory an instance holds. This reads the emscripten
 * module's heap view, an internal of quickjs-emscripten-core 0.32.0 (the
 * version is pinned in package.json; a test fails if the field moves).
 */
export function quickJsHeapBytes(module: QuickJSWASMModule): number {
  const heap = (module as unknown as { module?: { HEAPU8?: Uint8Array } }).module?.HEAPU8;
  return heap ? heap.byteLength : 0;
}

/** Pre-loaded instances that take over when the active one is retired (each reserves 16 MB of linear memory, ~1 MB resident). */
const SPARE_INSTANCES = 4;

/**
 * An instance whose heap has grown past this is recycled after its session
 * (raised to the largest memory limit in use, so a recycle follows any session
 * that came close to a large limit). Resident memory per active instance is
 * then at most about this threshold plus one session's limit.
 */
const MIN_RECYCLE_HEAP_BYTES = 256 * 1024 * 1024;

let active: QuickJSWASMModule | null = await loadModule();
/** Linear memory a fresh instance holds; heap beyond this is space an earlier session grew and a new one can reuse without growing the heap. */
const FRESH_HEAP_BYTES = quickJsHeapBytes(active);
const spares: QuickJSWASMModule[] = [];
for (let i = 0; i < SPARE_INSTANCES; i += 1) spares.push(await loadModule());
let loading = 0;
let retiredCount = 0;
let recycledCount = 0;
let largestLimitBytes = 0;

function refill(): void {
  const missing = (active ? 0 : 1) + SPARE_INSTANCES - spares.length - loading;
  for (let i = 0; i < missing; i += 1) {
    loading += 1;
    void loadModule()
      .then((loaded) => {
        if (!active) active = loaded;
        else spares.push(loaded);
      })
      .catch(() => undefined)
      .finally(() => {
        loading -= 1;
        if (!active || spares.length + loading < SPARE_INSTANCES) setTimeout(refill, active ? 0 : 50).unref?.();
      });
  }
}

/** Takes an instance out of service. `failed` counts it as a crash; a recycle (heap too big) does not. */
function retire(module: QuickJSWASMModule, failed: boolean): void {
  if (active === module) {
    active = spares.shift() ?? null;
    if (failed) retiredCount += 1;
    else recycledCount += 1;
  }
  refill();
}

/** Resolves once an instance and all spares are ready again after retirements. For tests and startup. */
export async function quickJsSandboxReady(): Promise<void> {
  while (!active || spares.length < SPARE_INSTANCES) {
    refill();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Swaps in a fresh instance (counted as a recycle) and waits for the pool. For
 * tests: the memory check measures heap growth, so a session on an instance an
 * earlier session already grew can reuse that space without tripping it.
 */
export async function recycleQuickJsInstanceForTesting(): Promise<void> {
  await quickJsSandboxReady();
  if (active) retire(active, false);
  await quickJsSandboxReady();
}

/** How many WebAssembly instances have been retired after a failure since start (tests, diagnostics). */
export function quickJsRetiredInstances(): number {
  return retiredCount;
}

/** How many instances were recycled because their heap had grown too large (tests, diagnostics). */
export function quickJsRecycledInstances(): number {
  return recycledCount;
}

/** Heap bytes of the instance the next session will use (tests, diagnostics). */
export function quickJsActiveHeapBytes(): number {
  return active ? quickJsHeapBytes(active) : 0;
}

// ---------------------------------------------------------------------------
// Per-owner circuit breaker
// ---------------------------------------------------------------------------

const ownerStorage = new AsyncLocalStorage<string>();

/** Crashes by one owner within this window that open its breaker. */
const BREAKER_CRASHES = 3;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_OPEN_MS = 5 * 60_000;
const BREAKER_MAX_OWNERS = 10_000;

const crashLog = new Map<string, { crashes: number[]; openUntil: number }>();

export const SANDBOX_BREAKER_MESSAGE = "this workflow keeps crashing the JavaScript sandbox, so its expressions and code are refused for a few minutes";

/**
 * Runs `fn` with `owner` (a workflow id, or `user:<id>` for previews) as the
 * owner of every sandbox session it starts, including across awaits. An
 * owner whose sessions retire BREAKER_CRASHES instances within a minute is
 * refused for five minutes without touching the shared pool, so one author
 * cannot keep it empty for every other tenant.
 */
export function runWithSandboxOwner<T>(owner: string, fn: () => T): T {
  return ownerStorage.run(owner, fn);
}

/** The owner of sessions started here, if any. */
export function currentSandboxOwnerId(): string | undefined {
  return ownerStorage.getStore();
}

function breakerOpen(owner: string | undefined, now: number): boolean {
  if (!owner) return false;
  const entry = crashLog.get(owner);
  return entry !== undefined && entry.openUntil > now;
}

function recordCrash(owner: string | undefined, now: number): void {
  if (!owner) return;
  let entry = crashLog.get(owner);
  if (!entry) {
    if (crashLog.size >= BREAKER_MAX_OWNERS) {
      for (const [key, value] of crashLog) {
        if (value.openUntil <= now && value.crashes.every((at) => now - at > BREAKER_WINDOW_MS)) crashLog.delete(key);
      }
      if (crashLog.size >= BREAKER_MAX_OWNERS) crashLog.delete(crashLog.keys().next().value as string);
    }
    entry = { crashes: [], openUntil: 0 };
    crashLog.set(owner, entry);
  }
  entry.crashes = entry.crashes.filter((at) => now - at <= BREAKER_WINDOW_MS);
  entry.crashes.push(now);
  if (entry.crashes.length >= BREAKER_CRASHES) {
    entry.openUntil = now + BREAKER_OPEN_MS;
    entry.crashes = [];
  }
}

/** Clears the circuit breaker (tests). */
export function resetSandboxBreakerForTesting(): void {
  crashLog.clear();
}

/** The handles a session body works with. */
export interface QuickJsSession {
  runtime: QuickJSRuntime;
  context: QuickJSContext;
  /** Milliseconds left before the deadline (may be negative). */
  remainingMs(): number;
  /** Starts a new time budget (one session can serve several evaluations, each with its own limit), capped by the session budget. */
  resetDeadline(timeoutMs: number): void;
  /** True once the session has been stopped for growing the heap past its memory limit. */
  memoryExceeded(): boolean;
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
  const owner = ownerStorage.getStore();
  const startedAt = Date.now();
  if (breakerOpen(owner, startedAt)) throw new SandboxFailureError(SANDBOX_BREAKER_MESSAGE);
  // The memory check measures heap growth, so free space an earlier session grew is usable without tripping it. When that
  // space alone exceeds this session's limit, start on a fresh instance (only while a spare is ready: never run the pool dry).
  if (active && spares.length > 0 && quickJsHeapBytes(active) - FRESH_HEAP_BYTES > limits.memoryBytes) retire(active, false);
  const module = active;
  if (!module) {
    refill();
    throw new SandboxFailureError("The JavaScript sandbox is restarting; try again in a moment.", true);
  }
  largestLimitBytes = Math.max(largestLimitBytes, limits.memoryBytes);
  const sessionEnd = limits.sessionBudgetMs !== undefined ? startedAt + Math.max(limits.sessionBudgetMs, limits.timeoutMs) : Number.POSITIVE_INFINITY;
  let deadline = Math.min(startedAt + limits.timeoutMs, sessionEnd);
  let budgetMs = limits.timeoutMs;
  let cutBySession = false;
  const heapBase = quickJsHeapBytes(module);
  let overMemory = false;
  let runtime: QuickJSRuntime | null = null;
  let context: QuickJSContext | null = null;
  let healthy = true;
  const fail = (error: unknown): never => {
    if (healthy) {
      healthy = false;
      retire(module, true);
      recordCrash(owner, Date.now());
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
  const timeoutError = (): SandboxTimeoutError => {
    const error = new SandboxTimeoutError(budgetMs);
    if (cutBySession) error.message = `timed out: the ${limits.sessionBudgetMs}ms budget for this template is used up`;
    return error;
  };
  const memoryError = (): GuestError => new GuestError(`out of memory (limit ${Math.round(limits.memoryBytes / (1024 * 1024))} MB)`);
  try {
    guarded(() => {
      runtime = module.newRuntime();
      runtime.setMemoryLimit(limits.memoryBytes);
      runtime.setMaxStackSize(limits.stackBytes);
      // QuickJS's malloc limit misses much of what many small allocations cost, so the heap's real growth is checked too.
      runtime.setInterruptHandler(() => {
        if (Date.now() >= deadline) return true;
        if (quickJsHeapBytes(module) - heapBase > limits.memoryBytes) {
          overMemory = true;
          return true;
        }
        return false;
      });
      // The module loader is never set, so `import()` rejects inside QuickJS without touching the host.
      context = runtime.newContext();
    });
    const ctx = context as unknown as QuickJSContext;
    const rt = runtime as unknown as QuickJSRuntime;
    const describe = (handle: QuickJSHandle): string => {
      try {
        const dumped = ctx.dump(handle) as unknown;
        if (dumped && typeof dumped === "object" && typeof (dumped as { message?: unknown }).message === "string") {
          return (dumped as { message: string }).message.slice(0, 2000);
        }
        return String(dumped).slice(0, 2000);
      } catch {
        return "error";
      }
    };
    const guestFailure = (handle: QuickJSHandle): Error => {
      const message = describe(handle);
      handle.dispose();
      // QuickJS's own malloc limit can fire before the heap-growth check; both are the same stop.
      if (overMemory || message === "out of memory") return memoryError();
      return Date.now() >= deadline ? timeoutError() : new GuestError(message);
    };
    const session: QuickJsSession = {
      runtime: rt,
      context: ctx,
      remainingMs: () => deadline - Date.now(),
      resetDeadline(timeoutMs) {
        budgetMs = timeoutMs;
        const wanted = Date.now() + timeoutMs;
        cutBySession = wanted > sessionEnd;
        deadline = Math.min(wanted, sessionEnd);
      },
      memoryExceeded: () => overMemory,
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
          if (overMemory) throw memoryError();
          if (Date.now() >= deadline) throw timeoutError();
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
        // Linear memory never shrinks: an instance that grew past the threshold is swapped for a fresh one.
        if (quickJsHeapBytes(module) > Math.max(MIN_RECYCLE_HEAP_BYTES, largestLimitBytes)) retire(module, false);
      } catch {
        // A leaked object or a corrupted instance: never reuse it.
        healthy = false;
        retire(module, true);
      }
    }
  }
}
