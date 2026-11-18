import { afterEach, describe, expect, it, vi } from "vitest";
import { runAfterPointerRelease } from "./pointer-release";

function press(type: "pointerdown" | "pointerup" | "pointercancel") {
  document.body.dispatchEvent(new Event(type, { bubbles: true }));
}

describe("runAfterPointerRelease", () => {
  afterEach(() => {
    press("pointerup");
    vi.useRealTimers();
  });

  it("runs at once when no pointer button is down", () => {
    const fn = vi.fn();
    runAfterPointerRelease(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits for the pointer to be released (so the click that caused a blur lands first)", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    runAfterPointerRelease(() => undefined); // installs the tracking
    press("pointerdown");
    runAfterPointerRelease(fn);
    expect(fn).not.toHaveBeenCalled();
    press("pointerup");
    expect(fn).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("also runs when the press is cancelled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    press("pointerdown");
    runAfterPointerRelease(fn);
    press("pointercancel");
    vi.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
