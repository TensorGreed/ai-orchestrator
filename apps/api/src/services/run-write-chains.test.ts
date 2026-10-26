import { describe, expect, it } from "vitest";
import { RunWriteChains } from "./run-write-chains.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RunWriteChains", () => {
  it("runs one run's writes in the order they were queued, even when an earlier one is slower", async () => {
    const chains = new RunWriteChains(() => undefined);
    const chain = chains.open("run-1");
    const order: number[] = [];
    void chain.enqueue(async () => {
      await tick(30);
      order.push(1);
    });
    void chain.enqueue(async () => {
      order.push(2);
    });
    await chains.settle("run-1");
    expect(order).toEqual([1, 2]);
  });

  it("a write that rejects is reported and the chain goes on: later writes run and settle does not throw", async () => {
    const errors: unknown[] = [];
    const chains = new RunWriteChains((_id, error) => errors.push(error));
    const chain = chains.open("run-1");
    const ran: string[] = [];
    await expect(chain.enqueue(async () => {
      throw new Error("pool says no");
    })).resolves.toBeUndefined();
    await chain.enqueue(async () => {
      ran.push("after");
    });
    await expect(chains.settle("run-1")).resolves.toBeUndefined();
    expect(ran).toEqual(["after"]);
    expect(errors).toHaveLength(1);
  });

  it("settle waits for queued writes, then drops later ones and keeps nothing for the run", async () => {
    const chains = new RunWriteChains(() => undefined);
    const chain = chains.open("run-1");
    const ran: string[] = [];
    void chain.enqueue(async () => {
      await tick(20);
      ran.push("queued");
    });
    expect(chains.size).toBe(1);
    await chains.settle("run-1");
    expect(ran).toEqual(["queued"]);
    expect(chains.size).toBe(0);
    await chain.enqueue(async () => {
      ran.push("late");
    });
    expect(ran).toEqual(["queued"]);
    await chains.settle("run-1");
  });

  it("a logger that throws does not break the chain: later writes run and settle does not throw", async () => {
    const chains = new RunWriteChains(() => {
      throw new Error("logger down");
    });
    const chain = chains.open("run-1");
    const ran: string[] = [];
    await expect(chain.enqueue(async () => {
      throw new Error("pool says no");
    })).resolves.toBeUndefined();
    await chain.enqueue(async () => {
      ran.push("after");
    });
    await expect(chains.settle("run-1")).resolves.toBeUndefined();
    expect(ran).toEqual(["after"]);
  });
});
