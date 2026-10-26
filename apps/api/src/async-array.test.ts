import { describe, expect, it } from "vitest";
import { everyAsync, filterAsync, findAsync, mapAsync, someAsync } from "./async-array.js";

describe("async array helpers", () => {
  it("run callbacks one at a time, in order, and stop early where the sync methods do", async () => {
    const seen: number[] = [];
    const slow = async (value: number) => {
      seen.push(value);
      await new Promise((resolve) => setTimeout(resolve, 5 - value));
      return value;
    };
    expect(await mapAsync([1, 2, 3], slow)).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
    seen.length = 0;
    expect(await someAsync([1, 2, 3], async (value) => (await slow(value)) === 2)).toBe(true);
    expect(seen).toEqual([1, 2]);
    seen.length = 0;
    expect(await everyAsync([1, 2, 3], async (value) => (await slow(value)) < 2)).toBe(false);
    expect(seen).toEqual([1, 2]);
    expect(await filterAsync([1, 2, 3, 4], async (value) => value % 2 === 0)).toEqual([2, 4]);
    expect(await findAsync([1, 2, 3], (value) => value > 1)).toBe(2);
    expect(await findAsync([1], () => false)).toBeUndefined();
    expect(await someAsync([], () => true)).toBe(false);
    expect(await everyAsync([], () => false)).toBe(true);
  });
});
