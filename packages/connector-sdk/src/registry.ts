import type { ConnectorDefinition } from "@ai-orchestrator/shared";
import type { ConnectorAdapter } from "./types";

export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): void {
    this.adapters.set(adapter.definition.id, adapter);
  }

  get(connectorId: string): ConnectorAdapter {
    const adapter = this.adapters.get(connectorId);
    if (!adapter) {
      throw new Error(`Unknown connector adapter: ${connectorId}`);
    }
    return adapter;
  }

  tryGet(connectorId: string): ConnectorAdapter | undefined {
    return this.adapters.get(connectorId);
  }

  listDefinitions(): ConnectorDefinition[] {
    return [...this.adapters.values()].map((adapter) => adapter.definition);
  }
}