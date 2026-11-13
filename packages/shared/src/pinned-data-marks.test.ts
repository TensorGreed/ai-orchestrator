import { describe, expect, it } from "vitest";
import { keepPinnedDataMarks, pinnedDataMarked } from "./pinned-data-marks";
import type { Workflow } from "./types";

type Pins = Pick<Workflow, "pinnedData" | "pinnedDataSensitive">;

const stored: Pins = { pinnedData: { a: { answer: "card 4242", n: 1 }, b: { x: 1 } }, pinnedDataSensitive: ["a"] };

describe("keepPinnedDataMarks (v74)", () => {
  it("keeps a stored mark while the node stays pinned, whatever the client sent or changed", () => {
    // A client that does not know the field (or drops it) cannot clear the mark, nor can an edit of the data.
    expect(keepPinnedDataMarks<Pins>(stored, { pinnedData: { a: { n: 1, answer: "card 4242" }, b: { x: 1 } } }).pinnedDataSensitive).toEqual(["a"]);
    expect(keepPinnedDataMarks(stored, { pinnedData: stored.pinnedData, pinnedDataSensitive: [] }).pinnedDataSensitive).toEqual(["a"]);
    expect(keepPinnedDataMarks<Pins>(stored, { pinnedData: { a: { answer: "typed" }, b: { x: 1 } } }).pinnedDataSensitive).toEqual(["a"]);
  });

  it("drops a stored mark once the pin is removed", () => {
    expect(keepPinnedDataMarks(stored, { pinnedData: { b: { x: 1 } }, pinnedDataSensitive: ["a"] })).not.toHaveProperty("pinnedDataSensitive");
    expect(keepPinnedDataMarks<Pins>(stored, {})).not.toHaveProperty("pinnedDataSensitive");
  });

  it("keeps marks the saved workflow carries only for pinned nodes, sorted and without duplicates", () => {
    expect(keepPinnedDataMarks(null, { pinnedData: { a: 1, b: 2 }, pinnedDataSensitive: ["b", "missing", "a", "b"] }).pinnedDataSensitive).toEqual(["a", "b"]);
    expect(keepPinnedDataMarks(undefined, { pinnedDataSensitive: ["a"] })).not.toHaveProperty("pinnedDataSensitive");
  });

  it("returns the workflow itself when nothing changes (no field added to workflows without pins)", () => {
    const plain = { pinnedData: { b: { x: 1 } } };
    expect(keepPinnedDataMarks(stored, plain)).toBe(plain);
    const noPins = { id: "wf" } as { id: string; pinnedData?: Record<string, unknown> };
    expect(keepPinnedDataMarks(null, noPins)).toBe(noPins);
    const marked = { pinnedData: stored.pinnedData, pinnedDataSensitive: ["a"] };
    expect(keepPinnedDataMarks(stored, marked)).toBe(marked);
  });

  it("pinnedDataMarked reads the mark", () => {
    expect(pinnedDataMarked(stored, "a")).toBe(true);
    expect(pinnedDataMarked(stored, "b")).toBe(false);
    expect(pinnedDataMarked({}, "a")).toBe(false);
  });
});
