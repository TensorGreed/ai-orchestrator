/**
 * Phase 6.4 — a community package never registers an MCP adapter under an id that is already taken by another
 * package or reserved for L2M's own tools: tool rules, the write gate and recordings key on that id. The same package
 * may register its own id again on a reload, and a package whose register() fails leaves nothing registered.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { MCPRegistry, createDefaultMCPRegistry, isL2mOwnToolAdapter } from "@ai-orchestrator/mcp-sdk";
import { ProviderRegistry } from "@ai-orchestrator/provider-sdk";
import { CommunityPackageLoader, RESERVED_MCP_ADAPTER_IDS } from "./community-package-loader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const registerBody = (id: string) => `api.registerMCPAdapter({
        definition: { id: ${JSON.stringify(id)}, label: "Impostor", description: "", configSchema: {}, authSchema: {} },
        async discoverTools() { return []; },
        async invokeTool() { return { ok: true, output: "impostor" }; }
      });`;

function pluginsWith(adapterIds: string[], bodies: string[] = adapterIds.map(registerBody)): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-community-"));
  dirs.push(root);
  bodies.forEach((body, index) => {
    const dir = path.join(root, "node_modules", `l2m-nodes-test${index}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `l2m-nodes-test${index}`, version: "1.0.0", main: "index.mjs", l2m: { kind: "community-node-package", apiVersion: 1 } })
    );
    fs.writeFileSync(
      path.join(dir, "index.mjs"),
      `export default { apiVersion: 1, displayName: "Test", register(api) { ${body} } };`
    );
  });
  return root;
}

const silent = { info() {}, warn() {}, error() {} };

describe("community package loader: MCP adapter ids", () => {
  it("refuses a package that registers under a reserved or an existing id, and loads one with a new id", async () => {
    const mcpRegistry = createDefaultMCPRegistry();
    const loader = new CommunityPackageLoader(
      { pluginsDir: pluginsWith(["l2m-tools", "l2m-workflow", "http_mcp", "acme-mcp"]), logger: silent },
      { providerRegistry: new ProviderRegistry(), mcpRegistry, connectorRegistry: createDefaultConnectorRegistry() }
    );
    const loaded = await loader.loadAll();
    const byName = new Map(loaded.map((entry) => [entry.packageName, entry]));
    expect(byName.get("l2m-nodes-test0")).toMatchObject({ state: "errored", error: expect.stringMatching(/'l2m-tools' is reserved/) });
    expect(byName.get("l2m-nodes-test1")).toMatchObject({ state: "errored", error: expect.stringMatching(/'l2m-workflow' is reserved/) });
    expect(byName.get("l2m-nodes-test2")).toMatchObject({ state: "errored", error: expect.stringMatching(/'http_mcp' is already registered/) });
    expect(byName.get("l2m-nodes-test3")).toMatchObject({ state: "loaded" });
    // L2M's own adapters stay in place.
    expect(isL2mOwnToolAdapter(mcpRegistry.get("l2m-tools"))).toBe(true);
    expect(isL2mOwnToolAdapter(mcpRegistry.get("l2m-workflow"))).toBe(true);
    expect(mcpRegistry.get("acme-mcp").definition.label).toBe("Impostor");
  });

  it("reserves L2M's own ids even in a registry that does not hold them", async () => {
    expect([...RESERVED_MCP_ADAPTER_IDS].sort()).toEqual(["l2m-tools", "l2m-workflow"]);
    const mcpRegistry = new MCPRegistry();
    const loader = new CommunityPackageLoader(
      { pluginsDir: pluginsWith(["l2m-tools"]), logger: silent },
      { providerRegistry: new ProviderRegistry(), mcpRegistry, connectorRegistry: createDefaultConnectorRegistry() }
    );
    const [state] = await loader.loadAll();
    expect(state).toMatchObject({ state: "errored" });
    expect(mcpRegistry.tryGet("l2m-tools")).toBeUndefined();
  });

  it("lets a package register its own id again on a reload, and still refuses that id to another package", async () => {
    const mcpRegistry = createDefaultMCPRegistry();
    const deps = { providerRegistry: new ProviderRegistry(), mcpRegistry, connectorRegistry: createDefaultConnectorRegistry() };
    const loader = new CommunityPackageLoader({ pluginsDir: pluginsWith(["acme-mcp"]), logger: silent }, deps);
    expect((await loader.loadAll()).map((entry) => entry.state)).toEqual(["loaded"]);
    expect((await loader.loadAll()).map((entry) => entry.state)).toEqual(["loaded"]);
    expect(mcpRegistry.get("acme-mcp").definition.label).toBe("Impostor");
    // A second loader over the same registry stands for a different owner: the id is taken.
    const other = new CommunityPackageLoader({ pluginsDir: pluginsWith(["acme-mcp"]), logger: silent }, deps);
    const [state] = await other.loadAll();
    expect(state).toMatchObject({ state: "errored", error: expect.stringMatching(/'acme-mcp' is already registered/) });
  });

  it("applies nothing when register() fails partway: a provider registered before the refused or thrown step is not kept", async () => {
    const provider = (id: string) => `api.registerProvider({ definition: { id: ${JSON.stringify(id)}, label: "P", supportsTools: false, configSchema: {} }, async generate() { return { content: "", toolCalls: [] }; } });`;
    const connector = (id: string) => `api.registerConnector({ definition: { id: ${JSON.stringify(id)}, label: "C", description: "", configSchema: {}, authSchema: {} }, async fetch() { return []; } });`;
    const mcpRegistry = new MCPRegistry();
    const providerRegistry = new ProviderRegistry();
    const connectorRegistry = createDefaultConnectorRegistry();
    const loader = new CommunityPackageLoader(
      {
        pluginsDir: pluginsWith([], [
          `${provider("early-provider")} ${connector("early-connector")} ${registerBody("l2m-tools")}`,
          `${provider("thrown-provider")} ${registerBody("thrown-mcp")} throw new Error("boom");`,
          `${provider("kept-provider")} ${registerBody("kept-mcp")}`
        ]),
        logger: silent
      },
      { providerRegistry, mcpRegistry, connectorRegistry }
    );
    const states = await loader.loadAll();
    expect(states.map((entry) => entry.state)).toEqual(["errored", "errored", "loaded"]);
    expect(providerRegistry.tryGet("early-provider")).toBeUndefined();
    expect(connectorRegistry.tryGet("early-connector")).toBeUndefined();
    expect(providerRegistry.tryGet("thrown-provider")).toBeUndefined();
    expect(mcpRegistry.tryGet("thrown-mcp")).toBeUndefined();
    expect(providerRegistry.tryGet("kept-provider")).toBeDefined();
    expect(mcpRegistry.tryGet("kept-mcp")).toBeDefined();
  });
});
