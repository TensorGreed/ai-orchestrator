import { describe, expect, it } from "vitest";
import { evalScorerSpecSchema } from "./evals";
import { checkRegexSafety, jsonSchemaPatterns, jsonSchemaRegexProblem } from "./regex-safety";

describe("checkRegexSafety", () => {
  it("rejects nested quantifiers and backreferences", () => {
    for (const pattern of ["^(a+)+$", "(a*)*", "(\\w+\\s?)*$", "(.*,){2,}x", "((ab)*c)+", "(?:x+y?){1,50}", "(?<word>a+)+", "(a)\\1", "(?<w>a)\\k<w>"]) {
      expect(checkRegexSafety(pattern).safe, pattern).toBe(false);
    }
  });

  it("accepts the patterns people write", () => {
    for (const pattern of ["^\\d{3}-\\d{4}$", "(\\d{3}-){2}\\d{4}", "^(foo|bar)+$", "[a-z]+@[a-z]+\\.com", "(?:a+)?b", "(a+){2}", "^[(]+\\)$", "\\(a+\\)+", "[+*]{2,}", "colou?r", "a{2,3}?b", "(?=.*\\d)(?=.*[a-z]).{8,}"]) {
      expect(checkRegexSafety(pattern), pattern).toEqual({ safe: true });
    }
  });
});

describe("JSON Schema patterns", () => {
  it("finds pattern and patternProperties, but not data under const or enum", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string", pattern: "^a+$" }, pattern: { type: "string" } },
      patternProperties: { "^x-": { type: "string" } },
      items: [{ pattern: "b*" }],
      const: { pattern: "(a+)+" },
      enum: [{ pattern: "(a+)+" }]
    };
    expect(jsonSchemaPatterns(schema).sort()).toEqual(["^a+$", "^x-", "b*"]);
    expect(jsonSchemaRegexProblem(schema)).toBeNull();
    expect(jsonSchemaRegexProblem({ patternProperties: { "^(a+)+$": {} } })).toContain("nested quantifiers");
  });

  it("is enforced by the scorer schemas", () => {
    expect(evalScorerSpecSchema.safeParse({ type: "regex", pattern: "(a+)+$" }).success).toBe(false);
    expect(evalScorerSpecSchema.safeParse({ type: "regex", pattern: "^answer \\w+$" }).success).toBe(true);
    const bad = evalScorerSpecSchema.safeParse({ type: "json_schema", schema: { properties: { a: { pattern: "(x*)*" } } } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain("not allowed");
    expect(evalScorerSpecSchema.safeParse({ type: "json_schema", schema: { properties: { a: { pattern: "^x+$" } } } }).success).toBe(true);
  });
});
