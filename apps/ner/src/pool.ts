import { Worker } from "node:worker_threads";
import type { GlinerCore, GlinerPromptCut, RawSpan } from "./gliner.js";
import { GlinerCancelled } from "./gliner.js";
import type { NerModel } from "./models/manifest.js";

/**
 * A pool of model executors (worker threads by default, each with its own ONNX Runtime session) and a FIFO queue of
 * texts. One text runs on one executor; the texts of a request spread over the free executors. A stopped request
 * (timeout, client gone) leaves the queue at once, and a text already running stops after its current window.
 * An executor that dies is replaced, with a growing pause between attempts.
 */

export interface NerJob {
  text: string;
  cuts: GlinerPromptCut[];
}

export interface NerExecutor {
  run(id: number, job: NerJob): Promise<RawSpan[]>;
  cancel(id: number): void;
  close(): Promise<void>;
  /** Called once if the executor stops on its own (a crashed worker). */
  onExit(listener: (reason: string) => void): void;
}

export type NerExecutorFactory = () => Promise<NerExecutor>;

export class NerStoppedError extends Error {
  constructor(message = "stopped") {
    super(message);
    this.name = "NerStoppedError";
  }
}

interface Pending {
  id: number;
  job: NerJob;
  resolve: (spans: RawSpan[]) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface Slot {
  executor: NerExecutor;
  current: Pending | undefined;
}

export interface NerPoolLogger {
  warn(message: string): void;
}

export class NerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  private respawnDelayMs = 1_000;
  private respawnTimer: NodeJS.Timeout | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly size: number,
    private readonly factory: NerExecutorFactory,
    private readonly logger: NerPoolLogger = { warn: () => undefined }
  ) {
    if (!Number.isInteger(size) || size < 1) throw new Error("The pool needs at least one executor");
  }

  /** Starts every executor; rejects (after closing the ones that started) if any fails to load. */
  async start(): Promise<void> {
    const results = await Promise.allSettled(Array.from({ length: this.size }, () => this.factory()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const started = results.filter((result): result is PromiseFulfilledResult<NerExecutor> => result.status === "fulfilled").map((result) => result.value);
    if (failed) {
      await Promise.allSettled(started.map((executor) => executor.close()));
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
    for (const executor of started) this.addSlot(executor);
  }

  /** Executors running now (for health). */
  get liveExecutors(): number {
    return this.slots.length;
  }

  get queued(): number {
    return this.queue.length;
  }

  get error(): string | undefined {
    return this.slots.length === 0 ? this.lastError : undefined;
  }

  run(job: NerJob, signal?: AbortSignal): Promise<RawSpan[]> {
    if (this.closed) return Promise.reject(new NerStoppedError("the service is shutting down"));
    if (signal?.aborted) return Promise.reject(new NerStoppedError());
    return new Promise<RawSpan[]>((resolve, reject) => {
      const pending: Pending = { id: this.nextId++, job, resolve, reject, signal, onAbort: undefined };
      if (signal) {
        pending.onAbort = () => this.abort(pending);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.dispatch();
    });
  }

  private abort(pending: Pending): void {
    const queued = this.queue.indexOf(pending);
    if (queued >= 0) this.queue.splice(queued, 1);
    const slot = this.slots.find((candidate) => candidate.current === pending);
    if (slot) slot.executor.cancel(pending.id);
    this.settle(pending, new NerStoppedError());
  }

  private settle(pending: Pending, outcome: RawSpan[] | Error): void {
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.onAbort = undefined;
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome);
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.current || this.queue.length === 0) continue;
      const pending = this.queue.shift()!;
      slot.current = pending;
      slot.executor.run(pending.id, pending.job).then(
        (spans) => {
          if (slot.current === pending) slot.current = undefined;
          this.settle(pending, spans);
          this.dispatch();
        },
        (error: unknown) => {
          if (slot.current === pending) slot.current = undefined;
          this.settle(pending, error instanceof GlinerCancelled ? new NerStoppedError() : error instanceof Error ? error : new Error("the model run failed"));
          this.dispatch();
        }
      );
    }
  }

  private addSlot(executor: NerExecutor): void {
    const slot: Slot = { executor, current: undefined };
    this.slots.push(slot);
    executor.onExit((reason) => {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      if (slot.current) {
        const pending = slot.current;
        slot.current = undefined;
        this.settle(pending, new Error("the model worker stopped"));
      }
      if (this.closed) return;
      this.lastError = `model worker stopped (${reason})`;
      this.logger.warn(`l2m-ner: a model worker stopped (${reason}); starting a new one`);
      this.scheduleRespawn();
    });
    this.dispatch();
  }

  private scheduleRespawn(): void {
    if (this.respawnTimer || this.closed) return;
    const delay = this.respawnDelayMs;
    this.respawnDelayMs = Math.min(30_000, this.respawnDelayMs * 2);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      if (this.closed) return;
      this.factory().then(
        (executor) => {
          if (this.closed) {
            void executor.close();
            return;
          }
          this.respawnDelayMs = 1_000;
          this.addSlot(executor);
          if (this.slots.length < this.size) this.scheduleRespawn();
        },
        (error: unknown) => {
          this.lastError = error instanceof Error ? error.message : "the model worker did not start";
          this.logger.warn(`l2m-ner: a model worker did not start: ${this.lastError}`);
          this.scheduleRespawn();
        }
      );
    }, delay);
    this.respawnTimer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    for (const pending of this.queue.splice(0)) this.settle(pending, new NerStoppedError("the service is shutting down"));
    const slots = this.slots.splice(0);
    for (const slot of slots) {
      if (slot.current) this.settle(slot.current, new NerStoppedError("the service is shutting down"));
      slot.current = undefined;
    }
    await Promise.allSettled(slots.map((slot) => slot.executor.close()));
  }
}

/** Runs the model on the calling thread (NER_WORKERS=0, and tests). */
export function inlineExecutor(core: Pick<GlinerCore, "recognize">): NerExecutor {
  const cancelled = new Set<number>();
  return {
    async run(id, job) {
      try {
        return await core.recognize(job.text, job.cuts, () => cancelled.has(id));
      } finally {
        cancelled.delete(id);
      }
    },
    cancel(id) {
      cancelled.add(id);
    },
    async close() {
      return undefined;
    },
    onExit() {
      return undefined;
    }
  };
}

/** Messages between the pool and a worker thread. */
export type WorkerRequest = { type: "run"; id: number; job: NerJob } | { type: "cancel"; id: number };
export type WorkerReply =
  | { type: "ready" }
  | { type: "load_failed"; message: string }
  | { type: "result"; id: number; spans: RawSpan[] }
  | { type: "cancelled"; id: number }
  | { type: "failed"; id: number; message: string };

export interface WorkerExecutorOptions {
  folder: string;
  model: NerModel;
  intraOpThreads: number;
  /** How long a worker may take to load the model (default 120 s). */
  loadTimeoutMs?: number;
  /** Another worker script speaking the same messages (tests). */
  workerUrl?: URL;
}

/** The worker script next to this module: `worker.js` when built, `worker.ts` (through tsx) from source. */
function defaultWorker(): { url: URL; execArgv: string[] } {
  const fromSource = import.meta.url.endsWith(".ts");
  return { url: new URL(fromSource ? "./worker.ts" : "./worker.js", import.meta.url), execArgv: fromSource ? ["--import", "tsx"] : [] };
}

export function workerExecutorFactory(options: WorkerExecutorOptions): NerExecutorFactory {
  return () =>
    new Promise<NerExecutor>((resolve, reject) => {
      const script = options.workerUrl ? { url: options.workerUrl, execArgv: options.workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : [] } : defaultWorker();
      const worker = new Worker(script.url, {
        execArgv: script.execArgv,
        workerData: { folder: options.folder, model: options.model, intraOpThreads: options.intraOpThreads },
        stdout: false,
        stderr: false
      });
      const waiting = new Map<number, { resolve: (spans: RawSpan[]) => void; reject: (error: Error) => void }>();
      const exitListeners: Array<(reason: string) => void> = [];
      let ready = false;
      let closing = false;
      const loadTimer = setTimeout(() => {
        if (!ready) {
          void worker.terminate();
          reject(new Error("the model did not load in time"));
        }
      }, options.loadTimeoutMs ?? 120_000);
      const executor: NerExecutor = {
        run(id, job) {
          return new Promise<RawSpan[]>((resolveRun, rejectRun) => {
            waiting.set(id, { resolve: resolveRun, reject: rejectRun });
            worker.postMessage({ type: "run", id, job } satisfies WorkerRequest);
          });
        },
        cancel(id) {
          worker.postMessage({ type: "cancel", id } satisfies WorkerRequest);
        },
        async close() {
          closing = true;
          await worker.terminate();
        },
        onExit(listener) {
          exitListeners.push(listener);
        }
      };
      worker.on("message", (message: WorkerReply) => {
        switch (message.type) {
          case "ready":
            ready = true;
            clearTimeout(loadTimer);
            resolve(executor);
            return;
          case "load_failed":
            clearTimeout(loadTimer);
            void worker.terminate();
            reject(new Error(message.message));
            return;
          case "result":
          case "cancelled":
          case "failed": {
            const entry = waiting.get(message.id);
            if (!entry) return;
            waiting.delete(message.id);
            if (message.type === "result") entry.resolve(message.spans);
            else if (message.type === "cancelled") entry.reject(new GlinerCancelled());
            else entry.reject(new Error(message.message));
            return;
          }
        }
      });
      worker.on("error", () => {
        // The exit handler below reports it; the error itself is not logged (it could name input).
      });
      worker.on("exit", (code) => {
        clearTimeout(loadTimer);
        for (const entry of waiting.values()) entry.reject(new Error("the model worker stopped"));
        waiting.clear();
        if (!ready) {
          reject(new Error(`the model worker exited while loading (code ${code})`));
          return;
        }
        if (!closing) for (const listener of exitListeners) listener(`exit code ${code}`);
      });
    });
}
