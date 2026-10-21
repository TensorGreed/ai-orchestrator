import { MockMCPServerAdapter } from "./adapters/mock-mcp";
import { SnapshotMockMCPServerAdapter, type McpSnapshotSource } from "./snapshot-mock";
import { HttpMCPServerAdapter } from "./adapters/http-mcp";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { MCPRegistry } from "./registry";
import { withSecretBundle } from "./secret-bundle";
import type { McpOAuthTokenProvider } from "./types";

export * from "./types";
export * from "./registry";
export * from "./tool-resolution";
export * from "./schema-diff";
export * from "./tool-policy";
export * from "./tool-annotations";
export * from "./structured-output";
export * from "./progress";
export * from "./client-features";
export * from "./oauth";
export * from "./gateway-naming";
export * from "./secret-bundle";
export * from "./cassette";
export * from "./snapshot-mock";
export * from "./mock-stdio-server";
export * from "./adapters/mock-mcp";
export * from "./adapters/http-mcp";
export * from "./adapters/stdio-mcp";

export function createDefaultMCPRegistry(options?: { oauth?: McpOAuthTokenProvider; snapshots?: McpSnapshotSource }): MCPRegistry {
  const registry = new MCPRegistry();
  // Phase 10.6 — servers with several credentials keep them in one JSON secret bundle.
  registry.register(withSecretBundle(new HttpMCPServerAdapter(options?.oauth ? { oauth: options.oauth } : undefined)));
  registry.register(withSecretBundle(new StdioMCPServerAdapter()));
  registry.register(new MockMCPServerAdapter());
  // Phase 10.8 — offline stubs generated from a server's accepted snapshot.
  registry.register(new SnapshotMockMCPServerAdapter(options?.snapshots));
  return registry;
}
