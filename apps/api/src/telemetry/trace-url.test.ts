import { describe, expect, it } from "vitest";
import { traceUrlFor, traceUrlTemplateProblem } from "./trace-url.js";

const ID = "0123456789abcdef0123456789abcdef";

describe("trace URL template", () => {
  it("fills {traceId} everywhere it appears", () => {
    expect(traceUrlFor("https://t.example.com/trace/{traceId}?q={traceId}", ID)).toBe(`https://t.example.com/trace/${ID}?q=${ID}`);
  });

  it("gives no link without a template, an id, or a well-formed id", () => {
    expect(traceUrlFor(undefined, ID)).toBeNull();
    expect(traceUrlFor("https://t.example.com/{traceId}", null)).toBeNull();
    expect(traceUrlFor("https://t.example.com/{traceId}", "../../evil")).toBeNull();
  });

  it("reports unusable templates", () => {
    expect(traceUrlTemplateProblem("https://t.example.com/")).toMatch(/\{traceId\}/);
    expect(traceUrlTemplateProblem("not a url {traceId}")).toMatch(/absolute/);
    expect(traceUrlTemplateProblem("javascript:alert({traceId})")).toMatch(/absolute/);
    expect(traceUrlTemplateProblem("http://t.example.com/{traceId}")).toBeNull();
  });
});
