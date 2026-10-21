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
      throw new Error(`Unknown MCP server adapter: ${serverId}`);
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
