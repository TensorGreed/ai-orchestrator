import { describe, expect, it } from "vitest";
import { executionIdsHeldByQueue, payloadExecutionIdPatterns } from "./cluster-queue-guard.js";

describe("cluster queue guard", () => {
  it("escapes LIKE wildcards and backslashes in the preselection patterns", () => {
    expect(payloadExecutionIdPatterns(["a_b%c"])).toEqual(['%"executionId":"a\\_b\\%c"%']);
    expect(payloadExecutionIdPatterns(['q"\\'])).toEqual(['%"executionId":"q\\\\"\\\\\\\\"%']);
  });

  it("holds ids named by a live job's payload or row id, not by lookalikes", () => {
    const held = executionIdsHeldByQueue(["e1", "e2", "e3", "e4"], [
      { id: "e1:req:1", payloadJson: JSON.stringify({ executionId: "e1" }) },
      { id: "e2", payloadJson: JSON.stringify({}) },
      { id: "x", payloadJson: JSON.stringify({ executionId: "e3x", input: { executionId: "e4" } }) }
    ]);
    expect([...held].sort()).toEqual(["e1", "e2"]);
  });

  it("treats a malformed payload that names an id as holding it (the safe side)", () => {
    expect([...executionIdsHeldByQueue(["e1", "e2"], [{ id: "j", payloadJson: '{"executionId":"e1"' }])]).toEqual(["e1"]);
  });
});
