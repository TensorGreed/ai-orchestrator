import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config";
import { SqliteStore } from "./db/database";
import { createApp } from "./app";
import { seedWorkflowsIfEmpty } from "./services/seed-service";
import { SecretService } from "./services/secret-service";

const currentFilePath = fileURLToPath(import.meta.url);
const apiRoot = path.resolve(path.dirname(currentFilePath), "..");
const workspaceRoot = path.resolve(apiRoot, "..", "..");
const rootEnvPath = path.resolve(workspaceRoot, ".env");
const apiEnvPath = path.resolve(apiRoot, ".env");

if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
}
if (fs.existsSync(apiEnvPath)) {
  dotenv.config({ path: apiEnvPath, override: true });
}

async function bootstrap() {
  const config = getConfig();
  const dbPath = path.resolve(apiRoot, "data", "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);

  seedWorkflowsIfEmpty(store, workspaceRoot);

  const app = createApp(config, store, secretService);
  await app.listen({
    host: config.API_HOST,
    port: config.API_PORT
  });

  app.log.info(`API listening on http://${config.API_HOST}:${config.API_PORT}`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
