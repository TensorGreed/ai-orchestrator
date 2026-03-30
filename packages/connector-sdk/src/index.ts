import { GoogleDriveConnectorAdapter } from "./adapters/google-drive";
import { NoSQLConnectorAdapter } from "./adapters/nosql";
import { SQLConnectorAdapter } from "./adapters/sql";
import { ConnectorRegistry } from "./registry";

export * from "./types";
export * from "./registry";
export * from "./adapters/google-drive";
export * from "./adapters/sql";
export * from "./adapters/nosql";

export function createDefaultConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new GoogleDriveConnectorAdapter());
  registry.register(new SQLConnectorAdapter());
  registry.register(new NoSQLConnectorAdapter());
  return registry;
}