import { describe, expect, it } from "vitest";
import { AppLifecycle } from "./app-lifecycle.js";

describe("AppLifecycle exit flush", () => {
  it("has none until one is set, and flushing without one returns at once", async () => {
    const lifecycle = new AppLifecycle();
    expect(lifecycle.hasExitFlush()).toBe(false);
    await lifecycle.flushBeforeExit(10);
  });

  it("runs the flush and waits for it", async () => {
    const lifecycle = new AppLifecycle();
    let flushed = false;
    lifecycle.setExitFlush(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      flushed = true;
    });
    expect(lifecycle.hasExitFlush()).toBe(true);
    await lifecycle.flushBeforeExit(5000);
    expect(flushed).toBe(true);
  });

  it("stops waiting after the budget and never throws", async () => {
    const lifecycle = new AppLifecycle();
    const warnings: string[] = [];
    lifecycle.setLogger({ info: () => undefined, warn: (message) => warnings.push(message) });
    lifecycle.setExitFlush(() => new Promise<void>(() => undefined));
    const started = Date.now();
    await lifecycle.flushBeforeExit(30);
    expect(Date.now() - started).toBeLessThan(1000);

    lifecycle.setExitFlush(async () => {
      throw new Error("collector down");
    });
    await lifecycle.flushBeforeExit(1000);
    expect(warnings).toEqual(["Flushing before exit failed"]);
  });
});
