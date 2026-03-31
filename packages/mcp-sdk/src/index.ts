import { MockMCPServerAdapter } from "./adapters/mock-mcp";
import { HttpMCPServerAdapter } from "./adapters/http-mcp";
import { MCPRegistry } from "./registry";

export * from "./types";
export * from "./registry";
export * from "./tool-resolution";
export * from "./adapters/mock-mcp";
export * from "./adapters/http-mcp";

export function createDefaultMCPRegistry(): MCPRegistry {
  const registry = new MCPRegistry();
  registry.register(new HttpMCPServerAdapter());
  registry.register(new MockMCPServerAdapter());
  return registry;
}
