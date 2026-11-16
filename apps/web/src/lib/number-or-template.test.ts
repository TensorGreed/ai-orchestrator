import { describe, expect, it } from "vitest";
import { isNumberOrTemplateSchema, numberOrTemplateText, parseNumberOrTemplate } from "./number-or-template";

describe("number-or-template fields", () => {
  it("stores numbers as numbers, templates as text, and empty as nothing", () => {
    expect(parseNumberOrTemplate("42")).toBe(42);
    expect(parseNumberOrTemplate(" 1999 ")).toBe(1999);
    expect(parseNumberOrTemplate("{{pull_request.number}}")).toBe("{{pull_request.number}}");
    expect(parseNumberOrTemplate("  ")).toBeUndefined();
    // Only whole numbers become numbers; the run refuses anything else with a clear message.
    expect(parseNumberOrTemplate("10.5")).toBe("10.5");
  });

  it("shows a stored number or template as text", () => {
    expect(numberOrTemplateText(7)).toBe("7");
    expect(numberOrTemplateText("{{n}}")).toBe("{{n}}");
    expect(numberOrTemplateText(undefined)).toBe("");
  });

  it("recognises a field typed as a number and a string", () => {
    expect(isNumberOrTemplateSchema({ type: ["integer", "string"] })).toBe(true);
    expect(isNumberOrTemplateSchema({ type: "number" })).toBe(false);
    expect(isNumberOrTemplateSchema({ type: ["string", "null"] })).toBe(false);
  });
});
