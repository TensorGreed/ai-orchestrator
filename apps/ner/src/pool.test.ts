import { afterEach, describe, expect, it } from "vitest";
import { fakeModel } from "../test/helpers.js";
import { GlinerCancelled, type RawSpan } from "./gliner.js";
import { inlineExecutor, NerPool, NerStoppedError, workerExecutorFactory, type NerExecutor } from "./pool.js";

const pools: NerPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
});

/** An executor whose runs finish when the test says so. */
function manualExecutor() {
  const runs = new Map<number, { resolve: (spans: RawSpan[]) => void; reject: (error: Error) => void; text: string }>();
  const cancelled: number[] = [];
  let exit: ((reason: string) => void) | undefined;
  const executor: NerExecutor = {
    run: (id, job) => new Promise((resolve, reject) => runs.set(id, { resolve, reject, text: job.text })),
    cancel: (id) => {
      cancelled.push(id);
      runs.get(id)?.reject(new GlinerCancelled());
    },
    close: async () => undefined,
    onExit: (listener) => {
      exit = listener;
    }
  };
  return { executor, runs, cancelled, crash: (reason: string) => exit?.(reason) };
}

const job = (text: string) => ({ text, cuts: [{ prompt: "name", cutoff: 0.5 }] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("NerPool", () => {
  it("runs texts first in, first out on the free executors", async () => {
    const a = manualExecutor();
    const b = manualExecutor();
    const executors = [a.executor, b.executor];
    const pool = new NerPool(2, async () => executors.shift()!);
    pools.push(pool);
    await pool.start();
    const results = ["one", "two", "three"].map((text) => pool.run(job(text)));
    await tick();
    expect([...a.runs.values()].map((run) => run.text)).toEqual(["one"]);
    expect([...b.runs.values()].map((run) => run.text)).toEqual(["two"]);
    expect(pool.queued).toBe(1);
    a.runs.get(1)!.resolve([{ start: 0, end: 3, prompt: 0, score: 0.9 }]);
    await expect(results[0]).resolves.toHaveLength(1);
    await tick();
    expect([...a.runs.values()].map((run) => run.text)).toEqual(["one", "three"]);
    b.runs.get(2)!.resolve([]);
    a.runs.get(3)!.resolve([]);
    await expect(Promise.all(results)).resolves.toHaveLength(3);
  });

  it("drops a queued text when its request stops, and cancels a running one", async () => {
    const a = manualExecutor();
    const pool = new NerPool(1, async () => a.executor);
    pools.push(pool);
    await pool.start();
    const running = new AbortController();
    const queued = new AbortController();
    const first = pool.run(job("running"), running.signal);
    const second = pool.run(job("queued"), queued.signal);
    await tick();
    queued.abort();
    await expect(second).rejects.toBeInstanceOf(NerStoppedError);
    expect(pool.queued).toBe(0);
    running.abort();
    await expect(first).rejects.toBeInstanceOf(NerStoppedError);
    expect(a.cancelled).toEqual([1]);
    await expect(pool.run(job("late"), AbortSignal.abort())).rejects.toBeInstanceOf(NerStoppedError);
  });

  it("fails the running text when an executor dies and starts a new one", async () => {
    const first = manualExecutor();
    const second = manualExecutor();
    const executors = [first.executor, second.executor];
    const warnings: string[] = [];
    const pool = new NerPool(1, async () => executors.shift()!, { warn: (message) => warnings.push(message) });
    pools.push(pool);
    await pool.start();
    const lost = pool.run(job("lost"));
    await tick();
    first.crash("exit code 3");
    await expect(lost).rejects.toThrow(/worker stopped/);
    expect(pool.liveExecutors).toBe(0);
    expect(pool.error).toMatch(/exit code 3/);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(pool.liveExecutors).toBe(1);
    const next = pool.run(job("next"));
    await tick();
    second.runs.get(2)!.resolve([]);
    await expect(next).resolves.toEqual([]);
    expect(warnings[0]).not.toContain("lost");
  });

  it("closes the executors that started when another fails to load", async () => {
    let closed = 0;
    let calls = 0;
    const pool = new NerPool(2, async () => {
      calls += 1;
      if (calls === 2) throw new Error("no model");
      return { ...manualExecutor().executor, close: async () => void (closed += 1) };
    });
    await expect(pool.start()).rejects.toThrow("no model");
    expect(closed).toBe(1);
  });

  it("stops queued and running texts on close", async () => {
    const a = manualExecutor();
    const pool = new NerPool(1, async () => a.executor);
    await pool.start();
    const running = pool.run(job("a"));
    const queued = pool.run(job("b"));
    await tick();
    await pool.close();
    await expect(running).rejects.toBeInstanceOf(NerStoppedError);
    await expect(queued).rejects.toBeInstanceOf(NerStoppedError);
    await expect(pool.run(job("c"))).rejects.toThrow(/shutting down/);
  });

  it("runs inline through a core and cancels between windows", async () => {
    const pool = new NerPool(1, async () =>
      inlineExecutor({
        recognize: async (text, _cuts, isCancelled) => {
          await tick();
          if (isCancelled?.()) throw new GlinerCancelled();
          return [{ start: 0, end: text.length, prompt: 0, score: 0.9 }];
        }
      })
    );
    pools.push(pool);
    await pool.start();
    await expect(pool.run(job("Anna"))).resolves.toEqual([{ start: 0, end: 4, prompt: 0, score: 0.9 }]);
    const stop = new AbortController();
    const stopped = pool.run(job("Anna"), stop.signal);
    stop.abort();
    await expect(stopped).rejects.toBeInstanceOf(NerStoppedError);
  });
});

describe("worker executors", () => {
  const workerUrl = new URL("../test/fixtures/fake-worker.mjs", import.meta.url);

  it("run texts in worker threads, cancel them, and replace a crashed worker", async () => {
    const { model, modelsDir } = fakeModel();
    const pool = new NerPool(1, workerExecutorFactory({ folder: modelsDir, model, intraOpThreads: 1, workerUrl }));
    pools.push(pool);
    await pool.start();
    await expect(pool.run(job("Anna Lee"))).resolves.toEqual([{ start: 0, end: 4, prompt: 0, score: 0.9 }]);
    await expect(pool.run(job("fail"))).rejects.toThrow("the model run failed");
    const stop = new AbortController();
    const slow = pool.run(job("slow"), stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await expect(slow).rejects.toBeInstanceOf(NerStoppedError);
    // The worker answers the cancel and is free again.
    await expect(pool.run(job("again"))).resolves.toHaveLength(1);
    await expect(pool.run(job("crash"))).rejects.toThrow(/worker stopped/);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(pool.run(job("after"))).resolves.toHaveLength(1);
  });

  it("report a model that does not load", async () => {
    const { model, modelsDir } = fakeModel({ id: "example/load-fails" });
    const pool = new NerPool(1, workerExecutorFactory({ folder: modelsDir, model, intraOpThreads: 1, workerUrl }));
    await expect(pool.start()).rejects.toThrow("fake load failure");
  });
});
