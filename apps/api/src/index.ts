import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config";
import { SqliteStore } from "./db/database";
import { createApp } from "./app";
import { seedWorkflowsIfEmpty } from "./services/seed-service";
import { SecretService } from "./services/secret-service";
import { AuthService } from "./services/auth-service";
import { SchedulerService } from "./services/scheduler-service";

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
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);

  const bootstrapUser = authService.bootstrapAdmin(config.BOOTSTRAP_ADMIN_EMAIL, config.BOOTSTRAP_ADMIN_PASSWORD);
  if (bootstrapUser) {
    // eslint-disable-next-line no-console
    console.log(`Bootstrapped admin user '${bootstrapUser.email}'`);
  }

  if (config.SEED_SAMPLE_WORKFLOWS) {
    seedWorkflowsIfEmpty(store, workspaceRoot);
  }

  const schedulerService = new SchedulerService(store);
  const app = createApp(config, store, secretService, authService, schedulerService);
  schedulerService.initialize();
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
