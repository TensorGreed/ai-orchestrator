import dotenv from "dotenv";
import path from "node:path";
import { getConfig } from "./config";
import { SqliteStore } from "./db/database";
import { createApp } from "./app";
import { seedWorkflowsIfEmpty } from "./services/seed-service";
import { SecretService } from "./services/secret-service";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function bootstrap() {
  const config = getConfig();
  const dbPath = path.resolve(process.cwd(), "apps", "api", "data", "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);

  seedWorkflowsIfEmpty(store);

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
