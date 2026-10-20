import { MockMCPServerAdapter } from "./adapters/mock-mcp";
import { HttpMCPServerAdapter } from "./adapters/http-mcp";
import { StdioMCPServerAdapter } from "./adapters/stdio-mcp";
import { MCPRegistry } from "./registry";
import { withSecretBundle } from "./secret-bundle";

export * from "./types";
export * from "./registry";
export * from "./tool-resolution";
export * from "./schema-diff";
export * from "./tool-policy";
export * from "./tool-annotations";
export * from "./gateway-naming";
export * from "./secret-bundle";
export * from "./adapters/mock-mcp";
export * from "./adapters/http-mcp";
export * from "./adapters/stdio-mcp";

export function createDefaultMCPRegistry(): MCPRegistry {
  const registry = new MCPRegistry();
  // Phase 10.6 — servers with several credentials keep them in one JSON secret bundle.
  registry.register(withSecretBundle(new HttpMCPServerAdapter()));
  registry.register(withSecretBundle(new StdioMCPServerAdapter()));
  registry.register(new MockMCPServerAdapter());
  return registry;
}
