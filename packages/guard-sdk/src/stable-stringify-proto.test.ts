import { describe, expect, it } from "vitest";
import { contentText, stableStringify } from "./types.js";

describe("stableStringify keeps a key named __proto__", () => {
  it("serialises it like any other key", () => {
    const value = JSON.parse('{"b":1,"__proto__":"4111 1111 1111 1111"}') as unknown;
    expect(stableStringify(value)).toBe('{"__proto__":"4111 1111 1111 1111","b":1}');
    expect(contentText({ query: value })).toContain("4111 1111 1111 1111");
  });
});
