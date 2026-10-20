import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  McpConfigImportError,
  findDuplicateServer,
  isSecretName,
  materializeImportEntry,
  parseMcpClientConfig,
  planMcpConfigImport,
  stripJsonComments,
  summarizeImportEntries,
  type ExistingServerRef
} from "./mcp-config-import.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../../../../samples/mcp-config-imports");
const UPDATE = process.env.UPDATE_MCP_IMPORT_GOLDENS === "1";

/** Every credential the fixtures carry in clear text. None may appear in a preview. */
const LITERAL_SECRETS = [
  "ghp_fixtureTokenValue000000000000000000",
  "wh-key-fixture-1111",
  "wh-secret-fixture-2222",
  "docs-fixture-bearer-3333",
  "tr-fixture-4444",
  "mt-fixture-5555",
  "msk-fixture-6666",
  "pay-fixture-7777",
  "Y3JtOmZpeHR1cmU=",
  "hunter2-fixture"
];

function fixtureFiles(): string[] {
  return fs
    .readdirSync(fixtureDir)
    .filter((name) => /\.(json|jsonc)$/.test(name) && !name.endsWith(".expected.json"))
    .sort();
}

/** Deterministic values for every slot the file cannot fill itself. */
function valuesFor(plan: ReturnType<typeof planMcpConfigImport>) {
  const entries: Record<string, { values: Record<string, string> }> = {};
  for (const entry of plan.entries) {
    const values: Record<string, string> = {};
    for (const slot of entry.view.slots) {
      if (slot.needsValue) values[slot.id] = `value-for-${slot.name}`;
    }
    entries[entry.view.key] = { values };
  }
  return entries;
}

describe("MCP client config import goldens", () => {
  for (const file of fixtureFiles()) {
    it(`converts ${file}`, () => {
      const text = fs.readFileSync(path.join(fixtureDir, file), "utf8");
      const parsed = parseMcpClientConfig(text);
      const preview = planMcpConfigImport(parsed, { existing: [] });
      const serializedPreview = JSON.stringify(preview.entries.map((entry) => entry.view));
      for (const secret of LITERAL_SECRETS) {
        expect(serializedPreview).not.toContain(secret);
      }

      const withValues = planMcpConfigImport(parsed, { existing: [], entries: valuesFor(preview) });
      const materialized = Object.fromEntries(
        withValues.entries
          .filter((entry) => entry.view.decision !== "skip")
          .map((entry) => {
            const result = materializeImportEntry(entry, valuesFor(preview)[entry.view.key]!.values);
            for (const secret of LITERAL_SECRETS) {
              // Credential-looking command arguments are the one documented exception (kept, flagged).
              if (secret !== "hunter2-fixture") expect(JSON.stringify(result.connection)).not.toContain(secret);
            }
            return [
              entry.view.key,
              { connection: result.connection, secretNames: result.secret?.names ?? [], missing: result.missing }
            ];
          })
      );

      const golden = {
        format: preview.format,
        warnings: preview.warnings,
        summary: summarizeImportEntries(preview.entries.map((entry) => entry.view)),
        entries: preview.entries.map((entry) => entry.view),
        materialized
      };
      const goldenPath = path.join(fixtureDir, file.replace(/\.(json|jsonc)$/, ".expected.json"));
      if (UPDATE || !fs.existsSync(goldenPath)) {
        fs.writeFileSync(goldenPath, `${JSON.stringify(golden, null, 2)}\n`);
      }
      expect(golden).toEqual(JSON.parse(fs.readFileSync(goldenPath, "utf8")));
    });
  }
});

describe("parseMcpClientConfig", () => {
  it("detects each supported shape", () => {
    expect(parseMcpClientConfig({ mcpServers: { a: { command: "x" } } }).format).toBe("mcp_servers");
    expect(parseMcpClientConfig({ servers: { a: { type: "stdio", command: "x" } } }).format).toBe("servers_inputs");
    expect(parseMcpClientConfig({ mcp: { servers: { a: { command: "x" } } } }).format).toBe("settings_mcp_servers");
    expect(parseMcpClientConfig({ context_servers: { a: { command: { path: "x" } } } }).format).toBe("context_servers");
    expect(parseMcpClientConfig({ mcp: { a: { type: "local", command: ["x"] } } }).format).toBe("mcp_typed_map");
  });

  it("rejects text that is not JSON and objects without servers", () => {
    expect(() => parseMcpClientConfig("{ nope")).toThrow(McpConfigImportError);
    expect(() => parseMcpClientConfig({ theme: "dark" })).toThrow(/No MCP servers found/);
    expect(() => parseMcpClientConfig("[]")).toThrow(/JSON object/);
  });

  it("strips comments and trailing commas but not inside strings", () => {
    const text = '{ "a": "http://x//y", /* c */ "b": [1, 2,], // t\n "c": "/* keep */", }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: "http://x//y", b: [1, 2], c: "/* keep */" });
  });
});

describe("secret handling", () => {
  it("treats credential-looking names as secrets", () => {
    for (const name of ["GITHUB_TOKEN", "API_KEY", "DB_PASSWORD", "Authorization", "X-Api-Key", "CLIENT_SECRET", "AUTH_HEADER"]) {
      expect(isSecretName(name)).toBe(true);
    }
    for (const name of ["LOG_LEVEL", "REGION", "X-Workspace", "SLACK_TEAM_ID"]) {
      expect(isSecretName(name)).toBe(false);
    }
  });

  it("uses secretEnvVar for one stdio secret and a bundle for several", () => {
    const parsed = parseMcpClientConfig({
      mcpServers: {
        one: { command: "a", env: { API_TOKEN: "t-1-value", MODE: "fast" } },
        two: { command: "b", env: { API_KEY: "k-1-value", API_SECRET: "s-1-value" } }
      }
    });
    const plan = planMcpConfigImport(parsed, { existing: [] });
    const one = materializeImportEntry(plan.entries[0]!);
    expect(one.connection).toEqual({ command: "a", args: [], env: { MODE: "fast" }, secretEnvVar: "API_TOKEN" });
    expect(one.secret?.value).toBe("t-1-value");
    const two = materializeImportEntry(plan.entries[1]!);
    expect(two.connection.secretEnvVars).toEqual(["API_KEY", "API_SECRET"]);
    expect(two.connection.env).toBeUndefined();
    expect(JSON.parse(two.secret!.value)).toEqual({ API_KEY: "k-1-value", API_SECRET: "s-1-value" });
  });

  it("maps a bearer Authorization header to bearer auth and other secret headers to a bundle", () => {
    const parsed = parseMcpClientConfig({
      servers: {
        bearer: { type: "http", url: "https://a.example.com/mcp", headers: { Authorization: "Bearer ${input:tok}" } },
        apikey: { type: "http", url: "https://b.example.com/mcp", headers: { "X-Api-Key": "abc-123-xyz", "X-Team": "core" } }
      },
      inputs: [{ id: "tok", type: "promptString", password: true }]
    });
    const plan = planMcpConfigImport(parsed, { existing: [], entries: { bearer: { values: { "header:Authorization": "tok-value" } } } });
    expect(plan.entries[0]!.view.secretMode).toBe("single");
    const bearer = materializeImportEntry(plan.entries[0]!, { "header:Authorization": "tok-value" });
    expect(bearer.connection.authType).toBe("bearer");
    expect(bearer.secret?.value).toBe("tok-value");
    const apikey = materializeImportEntry(plan.entries[1]!);
    expect(apikey.connection).toMatchObject({ headers: { "X-Team": "core" }, secretHeaders: ["X-Api-Key"] });
    expect(JSON.parse(apikey.secret!.value)).toEqual({ "X-Api-Key": "abc-123-xyz" });
  });

  it("asks for prompted and referenced values and blocks the entry until they are given", () => {
    const parsed = parseMcpClientConfig({
      servers: { t: { command: "x", env: { TOKEN: "${input:t}", PROJECT: "${input:p}", HOME_DIR: "${env:HOME_DIR}" } } },
      inputs: [
        { id: "t", password: true },
        { id: "p", description: "Project" }
      ]
    });
    const preview = planMcpConfigImport(parsed, { existing: [] });
    const slots = preview.entries[0]!.view.slots;
    expect(slots.map((slot) => [slot.id, slot.kind, slot.origin])).toEqual([
      ["env:TOKEN", "secret", "input"],
      ["env:PROJECT", "prompt", "input"],
      ["env:HOME_DIR", "prompt", "env_ref"]
    ]);
    expect(preview.entries[0]!.view.blockedReason).toMatch(/TOKEN, PROJECT, HOME_DIR/);
    const values = { "env:TOKEN": "tv-1234", "env:PROJECT": "OPS", "env:HOME_DIR": "/srv" };
    const ready = planMcpConfigImport(parsed, { existing: [], entries: { t: { values } } });
    expect(ready.entries[0]!.view.blockedReason).toBeNull();
    expect(ready.entries[0]!.view.slots.every((slot) => slot.provided)).toBe(true);
    const result = materializeImportEntry(ready.entries[0]!, values);
    expect(result.connection.env).toEqual({ PROJECT: "OPS", HOME_DIR: "/srv" });
    expect(result.connection.secretEnvVar).toBe("TOKEN");
    expect(result.secret?.value).toBe("tv-1234");
    expect(JSON.stringify(ready.entries[0]!.view)).not.toContain("tv-1234");
  });
});

describe("dedupe", () => {
  const existing: ExistingServerRef[] = [
    { id: "mcp_1", name: "filesystem", adapterId: "stdio_mcp", connection: { command: "npx", args: ["-y", "fs-mcp@1.0.0", "/data"] } },
    { id: "mcp_2", name: "Docs", adapterId: "http_mcp", connection: { endpoint: "https://Docs.Example.com/mcp/" } }
  ];

  it("matches same command+args and same normalized URL", () => {
    expect(findDuplicateServer("stdio_mcp", { command: "npx", args: ["-y", "fs-mcp@1.0.0", "/data"] }, existing)?.serverId).toBe("mcp_1");
    expect(findDuplicateServer("stdio_mcp", { command: "npx", args: ["-y", "fs-mcp@1.0.0", "/other"] }, existing)).toBeNull();
    expect(findDuplicateServer("http_mcp", { endpoint: "https://docs.example.com/mcp" }, existing)).toMatchObject({
      serverId: "mcp_2",
      match: "url"
    });
  });

  it("skips duplicates by default and honours update / copy / create", () => {
    const parsed = parseMcpClientConfig({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "fs-mcp@1.0.0", "/data"] },
        docs: { url: "https://docs.example.com/mcp" },
        fresh: { command: "node", args: ["server.js"] }
      }
    });
    const defaults = planMcpConfigImport(parsed, { existing });
    expect(defaults.entries.map((entry) => entry.view.decision)).toEqual(["skip", "skip", "create"]);

    const chosen = planMcpConfigImport(parsed, {
      existing,
      entries: { filesystem: { decision: "copy" }, docs: { decision: "update" }, fresh: { decision: "update" } }
    });
    expect(chosen.entries[0]!.view).toMatchObject({ decision: "copy", name: "filesystem (imported)" });
    expect(chosen.entries[1]!.view).toMatchObject({ decision: "update", name: "Docs" });
    // Nothing to update: falls back to create, with a warning.
    expect(chosen.entries[2]!.view.decision).toBe("create");
    expect(chosen.warnings.join(" ")).toMatch(/fresh/);
  });

  it("blocks stdio entries the catalog check rejects", () => {
    const parsed = parseMcpClientConfig({ mcpServers: { a: { command: "npx", args: ["-y", "x"] }, b: { url: "https://x.example.com" } } });
    const plan = planMcpConfigImport(parsed, { existing: [], checkStdioCommand: () => "not in catalog" });
    expect(plan.entries[0]!.view.blockedReason).toBe("not in catalog");
    expect(plan.entries[1]!.view.blockedReason).toBeNull();
    expect(summarizeImportEntries(plan.entries.map((entry) => entry.view)).blocked).toBe(1);
  });
});

describe("unsupported fields", () => {
  it("reports each field it cannot represent", () => {
    const parsed = parseMcpClientConfig({
      mcpServers: { a: { command: "x", autoApprove: ["t"], envFile: ".env", somethingNew: 1, headers: { A: "b" } } }
    });
    const report = planMcpConfigImport(parsed, { existing: [] }).entries[0]!.view.report;
    const skipped = report.filter((item) => item.status === "skipped").map((item) => item.field);
    expect(skipped).toEqual(expect.arrayContaining(["autoApprove", "envFile", "somethingNew", "headers"]));
    expect(planMcpConfigImport(parsed, { existing: [] }).entries[0]!.view.status).toBe("approximated");
  });
});
