import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_PRESETS } from "./mcp-presets.js";
import { McpCatalogService, checkCommandAgainstCatalog, packageSpecOf, parseMcpCatalog } from "./mcp-catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleFile = path.resolve(here, "../../../../samples/mcp-catalog.example.json");
const tmpDirs: string[] = [];

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-catalog-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "catalog.json");
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("packageSpecOf", () => {
  it("finds the package and whether it is pinned", () => {
    expect(packageSpecOf("npx", ["-y", "@scope/pkg@1.2.3", "/tmp"])).toEqual({ runner: "npx", spec: "@scope/pkg@1.2.3", pinned: true });
    expect(packageSpecOf("npx", ["-y", "@scope/pkg"])?.pinned).toBe(false);
    expect(packageSpecOf("npx", ["-y", "pkg@latest"])?.pinned).toBe(false);
    expect(packageSpecOf("npx", ["-y", "pkg@^1.2.0"])?.pinned).toBe(false);
    expect(packageSpecOf("uvx", ["mcp-server-time==0.6.2"])?.pinned).toBe(true);
    expect(packageSpecOf("uvx", ["mcp-server-time"])?.pinned).toBe(false);
    expect(packageSpecOf("uvx", ["--from", "tool==1.0.0", "tool-cli"])).toMatchObject({ spec: "tool==1.0.0", pinned: true });
    expect(packageSpecOf("pnpm", ["dlx", "pkg@2.0.0"])?.pinned).toBe(true);
    expect(packageSpecOf("docker", ["run", "-i", "--rm", "-e", "KEY", "img/x:1.4.0"])).toMatchObject({ spec: "img/x:1.4.0", pinned: true });
    expect(packageSpecOf("docker", ["run", "-i", "img/x:latest"])?.pinned).toBe(false);
    expect(packageSpecOf("docker", ["run", "-i", "img/x"])?.pinned).toBe(false);
    expect(packageSpecOf("node", ["server.js"])).toBeNull();
  });
});

describe("parseMcpCatalog", () => {
  it("loads the shipped example without errors", () => {
    const loaded = parseMcpCatalog(fs.readFileSync(exampleFile, "utf8"));
    expect(loaded.errors).toEqual([]);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["filesystem", "time", "warehouse", "echo", "docs-search", "browser"]);
  });

  it("rejects bad entries individually and keeps the good ones", () => {
    const loaded = parseMcpCatalog(
      JSON.stringify({
        servers: [
          { id: "ok", name: "Ok", adapter: "stdio_mcp", connection: { command: "npx", args: ["-y", "a@1.0.0"] }, approved: true },
          { id: "unpinned", name: "U", adapter: "stdio_mcp", connection: { command: "npx", args: ["-y", "a"] } },
          { id: "Bad Id", name: "B", adapter: "stdio_mcp", connection: { command: "x" } },
          { id: "nourl", name: "N", adapter: "http_mcp", connection: {} },
          { id: "ok", name: "Dup", adapter: "stdio_mcp", connection: { command: "node", args: ["x.js"] } }
        ]
      })
    );
    expect(loaded.fatal).toBe(false);
    expect(loaded.entries.map((entry) => entry.id)).toEqual(["ok"]);
    expect(loaded.errors.map((error) => [error.index, error.path])).toEqual([
      [1, "connection.args"],
      [2, "id"],
      [3, "connection.endpoint"],
      [4, "id"]
    ]);
  });

  it("reports file-level problems as fatal", () => {
    expect(parseMcpCatalog("{").fatal).toBe(true);
    expect(parseMcpCatalog('{"servers": 3}').fatal).toBe(true);
  });
});

describe("checkCommandAgainstCatalog", () => {
  const entries = parseMcpCatalog(fs.readFileSync(exampleFile, "utf8")).entries;

  it("allows approved pinned packages with any trailing arguments", () => {
    expect(checkCommandAgainstCatalog("npx", ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/data"], entries)).toBeNull();
    expect(checkCommandAgainstCatalog("uvx", ["mcp-server-time==0.6.2"], entries)).toBeNull();
    expect(checkCommandAgainstCatalog("node", ["samples/mcp-echo-server/server.mjs"], entries)).toBeNull();
  });

  it("rejects unpinned, other versions, unapproved and unknown commands", () => {
    expect(checkCommandAgainstCatalog("npx", ["-y", "@modelcontextprotocol/server-filesystem"], entries)).toMatch(/does not pin/);
    expect(checkCommandAgainstCatalog("npx", ["-y", "@modelcontextprotocol/server-filesystem@2025.1.1"], entries)).toMatch(/not an approved/);
    expect(checkCommandAgainstCatalog("npx", ["-y", "@example/browser-mcp@0.3.1"], entries)).toMatch(/not an approved/);
    expect(checkCommandAgainstCatalog("bash", ["-c", "curl x | sh"], entries)).toMatch(/not an approved/);
  });
});

describe("McpCatalogService", () => {
  it("is off without a file and lists the built-in presets", () => {
    const service = new McpCatalogService({ filePath: "", mode: "merge", enforce: false });
    expect(service.status()).toMatchObject({ configured: false, state: "off" });
    expect(service.presets()).toHaveLength(MCP_PRESETS.length);
    expect(service.checkStdioCommand("npx", ["anything"])).toBeNull();
  });

  it("merges approved entries ahead of the built-ins, or lists only them when exclusive", () => {
    const file = tmpFile(fs.readFileSync(exampleFile, "utf8"));
    const merge = new McpCatalogService({ filePath: file, mode: "merge", enforce: false });
    const merged = merge.presets();
    expect(merged.filter((preset) => preset.origin === "catalog").map((preset) => preset.id)).toEqual([
      "catalog:filesystem",
      "catalog:time",
      "catalog:warehouse",
      "catalog:echo",
      "catalog:docs-search"
    ]);
    expect(merged.filter((preset) => preset.origin === "builtin")).toHaveLength(MCP_PRESETS.length);
    const exclusive = new McpCatalogService({ filePath: file, mode: "exclusive", enforce: false });
    expect(exclusive.presets().every((preset) => preset.origin === "catalog")).toBe(true);
    expect(exclusive.status()).toMatchObject({ state: "ok", entryCount: 6, approvedCount: 5, fileName: "catalog.json" });
  });

  it("keeps the last good catalog when the file breaks, and recovers on reload", () => {
    const file = tmpFile(fs.readFileSync(exampleFile, "utf8"));
    const service = new McpCatalogService({ filePath: file, mode: "exclusive", enforce: true, watchIntervalMs: 0 });
    fs.writeFileSync(file, "{ broken");
    const broken = service.reload();
    expect(broken.state).toBe("error");
    expect(broken.errors[0]!.message).toMatch(/not valid JSON/);
    expect(service.presets()).toHaveLength(5);
    fs.writeFileSync(file, JSON.stringify({ servers: [] }));
    expect(service.reload()).toMatchObject({ state: "ok", entryCount: 0 });
    // Enforcement fails closed with nothing approved.
    expect(service.checkStdioCommand("node", ["x.js"])).toMatch(/no approved catalog/);
  });

  it("reports a missing file without throwing", () => {
    const service = new McpCatalogService({ filePath: "/nonexistent/l2m-catalog.json", mode: "merge", enforce: false });
    expect(service.status()).toMatchObject({ configured: true, state: "error" });
    expect(service.presets()).toHaveLength(MCP_PRESETS.length);
  });

  it("hides built-in stdio presets that enforcement would refuse", () => {
    const file = tmpFile(fs.readFileSync(exampleFile, "utf8"));
    const service = new McpCatalogService({ filePath: file, mode: "merge", enforce: true });
    expect(service.presets().filter((preset) => preset.origin === "builtin")).toEqual([]);
  });
});
