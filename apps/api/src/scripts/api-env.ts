/**
 * The API's .env rule (index.ts), for the CLIs that must resolve the same settings the API would: the repo root's
 * .env first, without overriding what the environment already sets, then apps/api/.env **with** override, so
 * apps/api/.env beats both the root .env and the environment. Same loader (dotenv.config), same order, same files.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

/** Loads the two .env files into `env` (process.env by default) as index.ts does; returns the files it read. */
export function loadApiEnvFiles(apiRoot: string, env: Record<string, string | undefined> = process.env): string[] {
  const rootEnvPath = path.resolve(apiRoot, "..", "..", ".env");
  const apiEnvPath = path.resolve(apiRoot, ".env");
  const loaded: string[] = [];
  const processEnv = env as dotenv.DotenvPopulateInput;
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath, processEnv, quiet: true });
    loaded.push(rootEnvPath);
  }
  if (fs.existsSync(apiEnvPath)) {
    dotenv.config({ path: apiEnvPath, processEnv, override: true, quiet: true });
    loaded.push(apiEnvPath);
  }
  return loaded;
}
