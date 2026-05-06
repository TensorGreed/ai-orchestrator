// Smoke test: import the actual adapter and run discoverTools against a real
// MCP server (npx-spawned). This is the test that the unit suite cannot run
// without burning ~10s per case on npm install. Run manually:
//   node scripts/smoke-stdio-spawn.mjs
import { StdioMCPServerAdapter } from "../packages/mcp-sdk/src/adapters/stdio-mcp.ts";

const adapter = new StdioMCPServerAdapter();

const config = {
  serverId: "stdio_mcp",
  label: "everything (test server)",
  connection: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    timeoutMs: 60_000
  }
};

const context = {
  resolveSecret: async () => undefined,
  runtimeState: new Map()
};

console.log("Discovering tools…");
try {
  const tools = await adapter.discoverTools(config, context);
  console.log(`OK — discovered ${tools.length} tools:`);
  for (const tool of tools.slice(0, 10)) {
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 80) ?? ""}`);
  }
  if (tools.length > 10) console.log(`  …and ${tools.length - 10} more`);
} catch (error) {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
}
