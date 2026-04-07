import { GoogleDriveConnectorAdapter } from "./adapters/google-drive";
import { NoSQLConnectorAdapter } from "./adapters/nosql";
import { SQLConnectorAdapter } from "./adapters/sql";
import { AzureStorageConnectorAdapter } from "./adapters/azure-storage";
import { AzureCosmosDbConnectorAdapter } from "./adapters/azure-cosmos-db";
import { AzureMonitorConnectorAdapter } from "./adapters/azure-monitor";
import { AzureAiSearchConnectorAdapter } from "./adapters/azure-ai-search";
import { QdrantConnectorAdapter } from "./adapters/qdrant";
import { ConnectorRegistry } from "./registry";

export * from "./types";
export * from "./registry";
export * from "./adapters/google-drive";
export * from "./adapters/sql";
export * from "./adapters/nosql";
export * from "./adapters/azure-storage";
export * from "./adapters/azure-cosmos-db";
export * from "./adapters/azure-monitor";
export * from "./adapters/azure-ai-search";
export * from "./adapters/qdrant";

export function createDefaultConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new GoogleDriveConnectorAdapter());
  registry.register(new SQLConnectorAdapter());
  registry.register(new NoSQLConnectorAdapter());
  registry.register(new AzureStorageConnectorAdapter());
  registry.register(new AzureCosmosDbConnectorAdapter());
  registry.register(new AzureMonitorConnectorAdapter());
  registry.register(new AzureAiSearchConnectorAdapter());
  registry.register(new QdrantConnectorAdapter());
  return registry;
}
