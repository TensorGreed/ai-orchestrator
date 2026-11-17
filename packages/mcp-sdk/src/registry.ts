import type { MCPServerDefinition } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

export class MCPRegistry {
  private readonly adapters = new Map<string, MCPServerAdapter>();

  register(adapter: MCPServerAdapter): void {
    this.adapters.set(adapter.definition.id, adapter);
  }

  get(serverId: string): MCPServerAdapter {
    const adapter = this.adapters.get(serverId);
    if (!adapter) {
      throw new Error(unknownAdapterMessage(serverId));
    }
    return adapter;
  }

  tryGet(serverId: string): MCPServerAdapter | undefined {
    return this.adapters.get(serverId);
  }

  /** Phase 10.8 — every registered adapter, for wrappers that build a derived registry. */
  list(): MCPServerAdapter[] {
    return [...this.adapters.values()];
  }

  listDefinitions(): MCPServerDefinition[] {
    return [...this.adapters.values()].map((adapter) => adapter.definition);
  }

  /**
   * Release every session any registered adapter cached in `context`. Call it
   * once the owner of a short-lived context (an agent node run, a direct tool
   * call, an API probe) is done with it, so stdio servers spawned for that
   * context do not outlive it. Adapter failures are collected, not thrown, so
   * one adapter cannot keep the others from cleaning up.
   */
  async closeSessions(context: MCPExecutionContext): Promise<Error[]> {
    const adapters = [...this.adapters.values()];
    const results = await Promise.allSettled(adapters.map(async (adapter) => adapter.closeSessions?.(context)));
    const errors: Error[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      }
    }
    return errors;
  }
}

/** Ids the API gives registered servers start with `mcp_`; no adapter id does. */
const REGISTERED_SERVER_ID = /^mcp_/;

/**
 * The error for an adapter id no adapter has. A registered server's id in `serverId` gets a hint: it belongs in
 * `registryServerId`. It is never looked up from `serverId`, so a registered server's settings (its connection,
 * credentials, runtime limits, sandbox) and the checks keyed on its registry id always apply.
 */
export function unknownAdapterMessage(serverId: string): string {
  if (REGISTERED_SERVER_ID.test(serverId.trim())) {
    return (
      `Unknown MCP server adapter: ${serverId}. If this is the id of a registered MCP server, ` +
      `set it as registryServerId (pick the server from the registry in the node) instead of serverId.`
    );
  }
  return `Unknown MCP server adapter: ${serverId}`;
}
