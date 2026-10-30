import { describe, expect, it } from "vitest";
import { parseToolArgumentSummary, type ToolArgumentSummary } from "@ai-orchestrator/shared";
import {
  summarizeToolArguments,
  toolArgumentLengthBucket,
  TOOL_ARGUMENT_SUMMARY_LIMITS,
  type ToolArgumentDetector
} from "./tool-argument-summary";

/**
 * A stand-in for the production-capture DLP scan (the API injects the real
 * one; apps/api tests it end to end): emails, 13-19 digit runs, `sk-` keys
 * and `+` phone numbers.
 */
const fakeDetect: ToolArgumentDetector = (text) => {
  const classes: string[] = [];
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) classes.push("email");
  if (/\b\d{13,19}\b/.test(text.replace(/[ -]/g, ""))) classes.push("card_number");
  if (/\bsk-[A-Za-z0-9]{10,}/.test(text)) classes.push("credential");
  if (/\+\d{10,14}\b/.test(text)) classes.push("phone");
  return classes;
};

const summarize = (args: unknown, inputSchema?: unknown) => summarizeToolArguments(args, { detect: fakeDetect, inputSchema });

/** Every string in the summary, to check that no argument text leaked. */
function allText(summary: ToolArgumentSummary): string {
  return JSON.stringify(summary);
}

describe("summarizeToolArguments: kept values", () => {
  it("keeps numbers, booleans, null and short enum-like strings", () => {
    const summary = summarize({ state: "open", per_page: 30, draft: false, milestone: null, region: "us-east-1" });
    expect(summary).toEqual({
      v: 1,
      fields: {
        draft: { type: "boolean", values: [false] },
        milestone: { type: "null" },
        per_page: { type: "number", values: [30], min: 30, max: 30 },
        region: { type: "string", values: ["us-east-1"] },
        state: { type: "string", values: ["open"] }
      }
    });
  });

  it("is deterministic and independent of key order", () => {
    const a = summarize({ b: 1, a: { y: "x", x: [3, 1, 2] } });
    const b = summarize({ a: { x: [2, 3, 1], y: "x" }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.fields)).toEqual(["a", "a.x", "a.x[]", "a.y", "b"]);
  });

  it("keeps the empty string and normalises -0", () => {
    const summary = summarize({ s: "", n: -0 });
    expect(summary.fields.s).toEqual({ type: "string", values: [""] });
    expect(summary.fields.n).toEqual({ type: "number", values: [0], min: 0, max: 0 });
  });

  it("drops non-finite numbers but keeps their type", () => {
    expect(summarize({ n: Number.NaN }).fields.n).toEqual({ type: "number" });
    expect(summarize({ n: Infinity }).fields.n).toEqual({ type: "number" });
  });

  it("keeps a schema enum value even when it would not look enum-like", () => {
    const schema = { type: "object", properties: { mode: { enum: ["Fast and loose", "slow"] }, kind: { anyOf: [{ const: "x y" }, { type: "string" }] } } };
    const summary = summarize({ mode: "Fast and loose", kind: "x y", other: "Fast and loose" }, schema);
    expect(summary.fields.mode).toEqual({ type: "string", values: ["Fast and loose"] });
    expect(summary.fields.kind).toEqual({ type: "string", values: ["x y"] });
    expect(summary.fields.other).toEqual({ type: "string", len: "9-32" });
  });

  it("reads enums through array items and additionalProperties", () => {
    const schema = {
      properties: {
        labels: { type: "array", items: { enum: ["bug fix", "needs review"] } },
        meta: { type: "object", additionalProperties: { enum: ["very high"] } }
      }
    };
    const summary = summarize({ labels: ["bug fix", "needs review", "free text here"], meta: { level: "very high" } }, schema);
    expect(summary.fields["labels[]"]).toEqual({ type: "string", count: 3, values: ["bug fix", "needs review"], len: "9-32" });
    expect(summary.fields["meta.level"]).toEqual({ type: "string", values: ["very high"] });
  });

  it("ignores a hostile schema", () => {
    const schema = { properties: { __proto__: { enum: ["a b"] }, x: 5 }, anyOf: "nope", items: [1] };
    expect(() => summarize({ x: "a b", list: ["a b"] }, schema)).not.toThrow();
    expect(summarize({ x: "a b" }, schema).fields.x).toEqual({ type: "string", len: "1-8" });
  });
});

describe("summarizeToolArguments: identifiers and free text", () => {
  it("reduces identifiers to stable prefixes", () => {
    const summary = summarize({
      repo: "octo-org/hello-world",
      url: "https://api.Example.com:8443/v1/items?token=abc#frag",
      basic: "https://user:pw@internal.example.net/x",
      file: "/home/alice/projects/secret-plan.md",
      win: "C:\\Users\\bob\\Documents\\report.docx",
      short: "/etc/passwd",
      rel: "./src/index.ts"
    });
    expect(summary.fields.repo).toEqual({ type: "string", prefixes: ["octo-org/"] });
    expect(summary.fields.url).toEqual({ type: "string", prefixes: ["https://api.example.com"] });
    expect(summary.fields.file).toEqual({ type: "string", prefixes: ["/home/alice/"] });
    expect(summary.fields.win).toEqual({ type: "string", prefixes: ["C:/Users/bob/"] });
    expect(summary.fields.short).toEqual({ type: "string", prefixes: ["/etc/"] });
    expect(summary.fields.rel).toEqual({ type: "string", prefixes: ["./src/"] });
    // A URL with credentials in it is flagged (here as an email by the stand-in detector) and kept by class only.
    expect(summary.fields.basic?.prefixes).toBeUndefined();
    const text = allText(summary);
    for (const secret of ["hello-world", "pw", "token=abc", "secret-plan", "report", "passwd", "index.ts", "8443"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps only the domain and class of an email", () => {
    const summary = summarize({ reviewer_email: "Jane.Doe@Example.COM" });
    expect(summary.fields.reviewer_email).toEqual({ type: "string", prefixes: ["@example.com"], classes: ["email"] });
    expect(allText(summary)).not.toContain("Jane");
  });

  it("keeps free text only as type and length bucket", () => {
    const summary = summarize({ comment: "Please merge this before Friday", long: "x".repeat(70), title: "Release" });
    expect(summary.fields.comment).toEqual({ type: "string", len: "9-32" });
    expect(summary.fields.long).toEqual({ type: "string", len: "33-128" });
    // One word under a free-text key is still free text.
    expect(summary.fields.title).toEqual({ type: "string", len: "1-8" });
    expect(allText(summary)).not.toMatch(/Friday|Release|xxxx/);
  });

  it("does not keep random-looking ids, hashes or long digit runs", () => {
    const summary = summarize({
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
      account: "acct-0012345678",
      blob: "QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVu"
    });
    for (const field of Object.values(summary.fields)) {
      expect(field.values).toBeUndefined();
      expect(field.len).toBeDefined();
    }
  });

  it("summarises data a detector flags by its class only", () => {
    const summary = summarize({
      card: "4111 1111 1111 1111",
      phone: "+14155550100",
      note: "call me on +14155550100 or mail a@b.co",
      api: "sk-abcdefghijklmnop"
    });
    expect(summary.fields.card).toEqual({ type: "string", classes: ["card_number"], len: "9-32" });
    expect(summary.fields.phone).toEqual({ type: "string", classes: ["phone"] });
    expect(summary.fields.note).toEqual({ type: "string", classes: ["email", "phone"], len: "33-128" });
    expect(summary.fields.api).toEqual({ type: "string", classes: ["credential"] });
    expect(allText(summary)).not.toMatch(/4111|4155550100|a@b|sk-abc/);
  });

  it("checks long integers with the detector", () => {
    const summary = summarize({ card: 4111111111111111, id: 123456789, small: 42 });
    expect(summary.fields.card).toEqual({ type: "number", classes: ["card_number"] });
    expect(summary.fields.id).toEqual({ type: "number", values: [123456789], min: 123456789, max: 123456789 });
    expect(allText(summary)).not.toContain("4111111111111111");
  });

  it("hides strings under credential-like keys but keeps their numbers and booleans", () => {
    const summary = summarize({ password: "hunter2", apiKey: "abc", max_tokens: 1000, use_auth: true, auth: { token: "plain" } });
    expect(summary.fields.password).toEqual({ type: "string", classes: ["credential"] });
    expect(summary.fields.apiKey).toEqual({ type: "string", classes: ["credential"] });
    expect(summary.fields.max_tokens).toEqual({ type: "number", values: [1000], min: 1000, max: 1000 });
    expect(summary.fields.use_auth).toEqual({ type: "boolean", values: [true] });
    expect(summary.fields["auth.token"]).toEqual({ type: "string", classes: ["credential"] });
    expect(allText(summary)).not.toMatch(/hunter2|"abc"|plain/);
  });

  it("writes keys that are data or odd as *", () => {
    const summary = summarize({ "alice@example.com": "yes", "has space": 1, "a.b": 2, "4111111111111111": 3, ok_key: 4 });
    expect(Object.keys(summary.fields)).toEqual(["*", "ok_key"]);
    expect(summary.fields["*"]).toMatchObject({ type: "mixed", types: ["number", "string"], count: 4 });
    expect(allText(summary)).not.toMatch(/alice|space|4111/);
  });
});

describe("summarizeToolArguments: arrays and objects", () => {
  it("merges array elements per path with counts", () => {
    const summary = summarize({ files: [{ path: "/repo/a/b.ts", lines: 3 }, { path: "/repo/c/d.ts", lines: 10 }], tags: ["a", 1, null] });
    expect(summary.fields.files).toEqual({ type: "array", items: 2 });
    expect(summary.fields["files[]"]).toEqual({ type: "object", count: 2, keys: 2 });
    expect(summary.fields["files[].path"]).toEqual({ type: "string", count: 2, prefixes: ["/repo/a/", "/repo/c/"] });
    expect(summary.fields["files[].lines"]).toEqual({ type: "number", count: 2, values: [3, 10], min: 3, max: 10 });
    expect(summary.fields["tags[]"]).toEqual({ type: "mixed", types: ["null", "number", "string"], count: 3, values: [1, "a"], min: 1, max: 1 });
  });

  it("drops the value list past the cap but keeps min and max", () => {
    const values = Array.from({ length: 40 }, (_, index) => index);
    const summary = summarize({ ids: values, names: values.map((index) => `n${index}`) });
    expect(summary.fields["ids[]"]).toEqual({ type: "number", count: 40, min: 0, max: 39, more: true });
    expect(summary.fields["names[]"]).toEqual({ type: "string", count: 40, more: true });
  });

  it("summarises a non-object root under $", () => {
    expect(summarize(["a", "b"]).fields).toEqual({ $: { type: "array", items: 2 }, "$[]": { type: "string", count: 2, values: ["a", "b"] } });
    expect(summarize("hello").fields).toEqual({ $: { type: "string", values: ["hello"] } });
    expect(summarize(null)).toEqual({ v: 1, fields: {} });
    expect(summarize(undefined)).toEqual({ v: 1, fields: {} });
  });

  it("handles a __proto__ key as data, without touching prototypes", () => {
    const args = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": "x"}') as unknown;
    const summary = summarize(args);
    expect(Object.keys(summary.fields)).toEqual(["*", "*.polluted", "constructor"]);
    expect(summary.fields["*.polluted"]).toEqual({ type: "string", values: ["yes"] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parseToolArgumentSummary(JSON.stringify(summary))).toEqual(summary);
  });
});

describe("summarizeToolArguments: adversarial input", () => {
  it("caps depth on deeply nested and cyclic objects", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let index = 0; index < 500; index += 1) deep = { a: deep };
    const summary = summarize(deep);
    expect(summary.truncated).toBe(true);
    expect(Object.keys(summary.fields).length).toBeLessThanOrEqual(TOOL_ARGUMENT_SUMMARY_LIMITS.maxDepth + 1);

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, cyclic];
    const cycled = summarize(cyclic);
    expect(cycled.truncated).toBe(true);
    expect(JSON.stringify(cycled).length).toBeLessThan(100_000);
  });

  it("caps paths, keys and array items on huge input", () => {
    const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`k${index}`, { [`n${index}`]: index }]));
    const summary = summarize(wide);
    expect(summary.truncated).toBe(true);
    expect(Object.keys(summary.fields).length).toBeLessThanOrEqual(TOOL_ARGUMENT_SUMMARY_LIMITS.maxFields);

    const long = summarize({ items: Array.from({ length: 100_000 }, (_, index) => index) });
    expect(long.truncated).toBe(true);
    expect(long.fields.items).toMatchObject({ type: "array", items: 100_000 });
    expect(long.fields["items[]"]?.count).toBe(TOOL_ARGUMENT_SUMMARY_LIMITS.maxArrayItems);
  });

  it("bounds detector work and never keeps an unscanned string", () => {
    let scannedChars = 0;
    const counting: ToolArgumentDetector = (text) => {
      scannedChars += text.length;
      return [];
    };
    // Key `a` and 32 strings of 8191 characters leave 31 characters of budget: key `b` fits, its value does not.
    const args = { a: Array.from({ length: 40 }, () => "y".repeat(8_191)), b: "word-word-word-word-word-word-word-word" };
    const summary = summarizeToolArguments(args, { detect: counting });
    expect(scannedChars).toBeLessThanOrEqual(TOOL_ARGUMENT_SUMMARY_LIMITS.scanBudgetChars);
    expect(summary.truncated).toBe(true);
    expect(summary.fields["a[]"]).toEqual({ type: "string", count: 40, len: "2049+" });
    // The enum-like value of `b` was not scanned, so it is not kept.
    expect(summary.fields.b).toEqual({ type: "string", len: "33-128" });
    // Without the huge array the same value is kept.
    expect(summarizeToolArguments({ b: args.b }, { detect: counting }).fields.b).toEqual({ type: "string", values: [args.b] });
  });

  it("treats a detector that throws as not scanned", () => {
    const summary = summarizeToolArguments({ state: "open", n: 5 }, {
      detect: () => {
        throw new Error("boom");
      }
    });
    // Keys could not be checked either, so both are written `*`; the string is not kept.
    expect(summary.fields).toEqual({
      "*": { type: "mixed", types: ["number", "string"], count: 2, values: [5], min: 5, max: 5, len: "1-8" }
    });
  });

  it("survives getters that throw, functions, symbols and bigints", () => {
    const hostile = {
      get boom() {
        throw new Error("nope");
      },
      fn: () => 1,
      sym: Symbol("s"),
      big: 10n,
      date: new Date(0),
      missing: undefined
    };
    const summary = summarize(hostile);
    expect(summary.truncated).toBe(true);
    expect(summary.fields.big).toEqual({ type: "number" });
    expect(summary.fields.date).toEqual({ type: "object", keys: 0 });
    expect(summary.fields).not.toHaveProperty("fn");
    expect(summary.fields).not.toHaveProperty("sym");
    expect(summary.fields).not.toHaveProperty("missing");
  });

  it("produces a summary the shared schema accepts", () => {
    const summary = summarize({ a: [1, "two", { three: true }], b: "https://x.io/y", c: "free text value" });
    expect(parseToolArgumentSummary(summary)).toEqual(summary);
    expect(parseToolArgumentSummary("not json")).toBeNull();
    expect(parseToolArgumentSummary({ v: 2, fields: {} })).toBeNull();
  });
});

describe("toolArgumentLengthBucket", () => {
  it("buckets lengths", () => {
    expect([0, 1, 8, 9, 32, 33, 128, 129, 512, 513, 2048, 2049].map(toolArgumentLengthBucket)).toEqual([
      "0",
      "1-8",
      "1-8",
      "9-32",
      "9-32",
      "33-128",
      "33-128",
      "129-512",
      "129-512",
      "513-2048",
      "513-2048",
      "2049+"
    ]);
  });
});
