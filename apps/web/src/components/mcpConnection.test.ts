import { describe, expect, it } from "vitest";
import {
  connectionFromDraft,
  connectionTemplate,
  draftFromConnection,
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

  it("leaves out blank arguments, nameless variables and an empty folder", () => {
    const draft = draftFromConnection({ command: "x" });
    draft.args.push({ id: 1, value: "" });
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
