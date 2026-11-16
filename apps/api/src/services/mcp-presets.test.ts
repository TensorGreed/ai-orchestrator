import { describe, expect, it } from "vitest";
import { packageSpecOf } from "./mcp-catalog.js";
import { MCP_PRESETS } from "./mcp-presets.js";

/** Packages that are archived, deprecated or were never published on npm. A preset must not start any of them. */
const RETIRED_PACKAGES = [
  "@modelcontextprotocol/server-github",
  "@modelcontextprotocol/server-postgres",
  "@modelcontextprotocol/server-puppeteer",
  "@modelcontextprotocol/server-brave-search",
  "@modelcontextprotocol/server-slack",
  "@modelcontextprotocol/server-sqlite",
  "@modelcontextprotocol/server-fetch",
  "@modelcontextprotocol/server-time",
  "@modelcontextprotocol/server-git",
  "mcp-server-sqlite"
];

function argsOf(connection: Record<string, unknown>): string[] {
  return Array.isArray(connection.args) ? connection.args.map(String) : [];
}

function packageName(spec: string): string {
  if (spec.includes("==")) return spec.slice(0, spec.indexOf("=="));
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

describe("built-in MCP presets", () => {
  it("have unique ids and the fields the registration form needs", () => {
    const ids = MCP_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of MCP_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]+$/);
      expect(preset.name.trim()).not.toBe("");
      expect(preset.category.trim()).not.toBe("");
      expect(preset.description.trim()).not.toBe("");
      expect(preset.source).toMatch(/^https:\/\/github\.com\//);
      expect(["stdio_mcp", "http_mcp"]).toContain(preset.serverAdapter);
    }
  });

  it("start a pinned package or image with a known runner", () => {
    for (const preset of MCP_PRESETS.filter((entry) => entry.serverAdapter === "stdio_mcp")) {
      const command = String(preset.connection.command);
      expect(["npx", "uvx", "docker"], preset.id).toContain(command);
      const spec = packageSpecOf(command, argsOf(preset.connection));
      expect(spec, preset.id).not.toBeNull();
      expect(spec!.spec, preset.id).not.toBe("");
      expect(spec!.pinned, `${preset.id} must pin an exact version (${spec!.spec})`).toBe(true);
      expect(spec!.spec, preset.id).not.toMatch(/(@|:)latest$/);
    }
  });

  it("never start an archived or unpublished server package", () => {
    for (const preset of MCP_PRESETS) {
      const spec = packageSpecOf(String(preset.connection.command ?? ""), argsOf(preset.connection));
      if (!spec) continue;
      expect(RETIRED_PACKAGES, preset.id).not.toContain(packageName(spec.spec));
    }
  });

  it("say which runtime a Python or Docker preset needs", () => {
    for (const preset of MCP_PRESETS) {
      const command = String(preset.connection.command ?? "");
      if (command === "uvx") expect(preset.notes, preset.id).toMatch(/needs uv \(uvx\)/);
      if (command === "docker") expect(preset.notes, preset.id).toMatch(/needs Docker/);
      if (command === "npx") expect(preset.notes, preset.id).toMatch(/Needs Node\.js \(npx\)/);
    }
  });

  it("wire credentials through secretEnvVar, never through literal values", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.credentialHint?.secretEnvVar) {
        expect(preset.connection.secretEnvVar, preset.id).toBe(preset.credentialHint.secretEnvVar);
      }
      const env = (preset.connection.env ?? {}) as Record<string, string>;
      for (const name of Object.keys(env)) {
        expect(name, preset.id).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/i);
      }
      if (preset.connection.command === "docker") {
        const args = argsOf(preset.connection);
        args.forEach((arg, index) => {
          if (args[index - 1] === "-e") expect(arg, `${preset.id} passes env into the container by name only`).not.toContain("=");
        });
        if (typeof preset.connection.secretEnvVar === "string") {
          expect(args, preset.id).toContain(preset.connection.secretEnvVar);
        }
      }
    }
  });

  it("make no read-only claim about a server", () => {
    for (const preset of MCP_PRESETS) {
      expect(`${preset.description} ${preset.notes ?? ""}`, preset.id).not.toMatch(/read-only by design/i);
    }
  });
});
