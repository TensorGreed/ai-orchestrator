import { describe, expect, it } from "vitest";
import {
  connectionFromDraft,
  connectionTemplate,
  draftFromConnection,
  duplicateEnvNames,
  hasUneditableValues,
  kindForAdapter,
  parseCommandLine,
  parseConnectionJson
} from "./mcpConnection";

const tokens = (input: string) => {
  const result = parseCommandLine(input);
  if (!result.ok) throw new Error(result.error);
  return result.tokens;
};

describe("kindForAdapter and templates", () => {
  it("maps adapters to transports", () => {
    expect(kindForAdapter("http_mcp")).toBe("http");
    expect(kindForAdapter("stdio_mcp")).toBe("stdio");
    expect(kindForAdapter("mock-mcp")).toBe("other");
  });

  it("gives each transport its own template with no shared keys", () => {
    expect(Object.keys(connectionTemplate("http")).sort()).toEqual(["endpoint", "transport"]);
    expect(Object.keys(connectionTemplate("stdio")).sort()).toEqual(["args", "command"]);
    expect(connectionTemplate("other")).toEqual({});
  });
});

describe("parseCommandLine", () => {
  it("splits on whitespace", () => {
    expect(tokens("  npx   -y  pkg ")).toEqual(["npx", "-y", "pkg"]);
  });

  it("keeps spaces inside quotes", () => {
    expect(tokens(`node server.js "/home/me/my docs" 'a  b'`)).toEqual(["node", "server.js", "/home/me/my docs", "a  b"]);
  });

  it("handles escapes inside double quotes and outside quotes", () => {
    expect(tokens(String.raw`echo "say \"hi\" \\ done" a\ b`)).toEqual(["echo", 'say "hi" \\ done', "a b"]);
  });

  it("keeps backslashes literal in single quotes and in double quotes before other characters", () => {
    expect(tokens(String.raw`x 'a\b' "c\d"`)).toEqual(["x", String.raw`a\b`, String.raw`c\d`]);
  });

  it("keeps empty quoted words and joins adjacent quoted parts", () => {
    expect(tokens(`a "" b"c d"e`)).toEqual(["a", "", "bc de"]);
  });

  it("reports unclosed quotes and a trailing backslash", () => {
    expect(parseCommandLine(`a "b`)).toMatchObject({ ok: false });
    expect(parseCommandLine(`a 'b`)).toMatchObject({ ok: false });
    expect(parseCommandLine("a \\")).toMatchObject({ ok: false });
  });

  it("keeps a backslash literal before ordinary characters so Windows paths survive", () => {
    expect(tokens(String.raw`C:\Users\me\server.exe --p C:\tmp`)).toEqual([String.raw`C:\Users\me\server.exe`, "--p", String.raw`C:\tmp`]);
    expect(tokens(String.raw`"C:\Program Files\x.exe" arg`)).toEqual([String.raw`C:\Program Files\x.exe`, "arg"]);
    expect(tokens(String.raw`a\ b \"q\" \'s\' \\`)).toEqual(["a b", '"q"', "'s'", "\\"]);
  });

  it("parses an empty quoted word as an empty argument", () => {
    expect(tokens('cmd ""')).toEqual(["cmd", ""]);
  });

  it("returns no tokens for blank input", () => {
    expect(tokens("   ")).toEqual([]);
  });
});

describe("stdio draft conversion", () => {
  it("round-trips and keeps unrelated keys", () => {
    const base = { command: "npx", args: ["-y", "a b"], cwd: "/srv", env: { A: "1" }, secretEnvVar: "TOKEN", timeoutMs: 5000 };
    const draft = draftFromConnection(base);
    expect(draft.args.map((row) => row.value)).toEqual(["-y", "a b"]);
    expect(connectionFromDraft(base, draft)).toEqual(base);
  });

  it("keeps empty-string arguments loaded from JSON through a load, edit, save round trip", () => {
    const base = { command: "x", args: ["a", "", "b"] };
    const draft = draftFromConnection(base);
    draft.cwd = "/srv";
    expect(connectionFromDraft(base, draft)).toEqual({ command: "x", args: ["a", "", "b"], cwd: "/srv" });
  });

  it("keeps an added blank row only when it is marked as an empty argument", () => {
    const draft = draftFromConnection({ command: "x", args: ["a"] });
    draft.args.push({ id: 90, value: "", allowEmpty: false });
    expect(connectionFromDraft({ command: "x" }, draft).args).toEqual(["a"]);
    draft.args[1] = { id: 90, value: "", allowEmpty: true };
    expect(connectionFromDraft({ command: "x" }, draft).args).toEqual(["a", ""]);
  });

  it("passes args and env through untouched when they hold non-string values", () => {
    const base = { command: "x", args: ["a", 1, { k: 1 }], env: { N: 2 }, secretEnvVar: "T" };
    expect(hasUneditableValues(base)).toBe(true);
    const draft = draftFromConnection(base);
    draft.command = "y";
    expect(connectionFromDraft(base, draft, { keepArgsAndEnv: true })).toEqual({ ...base, command: "y" });
    expect(hasUneditableValues({ command: "x", args: ["a"], env: { A: "1" } })).toBe(false);
    expect(hasUneditableValues({ command: "x", args: "a b" })).toBe(true);
    expect(hasUneditableValues({ command: "x", env: ["A"] })).toBe(true);
  });

  it("finds duplicate environment names", () => {
    const dupes = duplicateEnvNames([
      { id: 1, key: "A", value: "1" },
      { id: 2, key: " A ", value: "2" },
      { id: 3, key: "B", value: "" },
      { id: 4, key: "", value: "" },
      { id: 5, key: "", value: "" }
    ]);
    expect([...dupes]).toEqual(["A"]);
  });

  it("leaves out blank arguments, nameless variables and an empty folder", () => {
    const draft = draftFromConnection({ command: "x" });
    draft.args.push({ id: 1, value: "", allowEmpty: false });
    draft.env.push({ id: 2, key: " ", value: "v" });
    draft.cwd = "  ";
    expect(connectionFromDraft({ command: "x", args: ["old"], cwd: "/old" }, draft)).toEqual({ command: "x" });
  });
});

describe("parseConnectionJson", () => {
  it("accepts objects and blank text, rejects everything else", () => {
    expect(parseConnectionJson("")).toEqual({});
    expect(parseConnectionJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseConnectionJson("[1]")).toBeNull();
    expect(parseConnectionJson("{oops")).toBeNull();
  });
});
