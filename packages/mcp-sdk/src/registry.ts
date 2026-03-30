import type { MCPServerDefinition } from "@ai-orchestrator/shared";
import type { MCPServerAdapter } from "./types";

export class MCPRegistry {
  private readonly adapters = new Map<string, MCPServerAdapter>();

  register(adapter: MCPServerAdapter): void {
    this.adapters.set(adapter.definition.id, adapter);
  }

  get(serverId: string): MCPServerAdapter {
    const adapter = this.adapters.get(serverId);
    if (!adapter) {
      throw new Error(`Unknown MCP server adapter: ${serverId}`);
    }
    return adapter;
  }

  tryGet(serverId: string): MCPServerAdapter | undefined {
    return this.adapters.get(serverId);
  }

  listDefinitions(): MCPServerDefinition[] {
    return [...this.adapters.values()].map((adapter) => adapter.definition);
  }
}