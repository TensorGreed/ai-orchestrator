import { describe, expect, it } from "vitest";
import { DeliveryDedupe } from "./delivery-dedupe.js";

describe("DeliveryDedupe", () => {
  it("answers true for a key seen within the window and false once it has passed", () => {
    let now = 1_000;
    const dedupe = new DeliveryDedupe(60_000, 100, () => now);
    expect(dedupe.seen("a")).toBe(false);
    expect(dedupe.seen("a")).toBe(true);
    expect(dedupe.seen("b")).toBe(false);
    now += 59_999;
    expect(dedupe.seen("a")).toBe(true);
    now += 1;
    expect(dedupe.seen("a")).toBe(false);
    // "b" expired too and was pruned when "a" was recorded again.
    expect(dedupe.size).toBe(1);
  });

  it("drops the oldest keys past the cap and forgets a key on request", () => {
    const dedupe = new DeliveryDedupe(60_000, 2, () => 0);
    dedupe.seen("1");
    dedupe.seen("2");
    dedupe.seen("3");
    expect(dedupe.size).toBe(2);
    expect(dedupe.seen("3")).toBe(true);
    dedupe.forget("3");
    expect(dedupe.seen("3")).toBe(false);
  });
});
