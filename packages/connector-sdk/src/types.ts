import type { ConnectorDefinition, ConnectorFetchResult, SecretReference } from "@ai-orchestrator/shared";

export interface ConnectorExecutionContext {
  resolveSecret: (secretRef?: SecretReference) => Promise<string | undefined>;
}

export interface ConnectorAdapter {
  definition: ConnectorDefinition;
  testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<{ ok: boolean; message: string }>;
  fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorFetchResult>;
  sync?(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<{ synced: number }>;
}