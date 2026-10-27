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

/** Where one setting comes from once the API's .env rule is applied. */
export interface SettingOrigin {
  /** The value the API would run with (undefined when nothing sets it). */
  value: string | undefined;
  /** apps/api/.env beats the environment, which beats the root .env (index.ts's rule). */
  source: "apps/api/.env" | "environment" | "root .env" | "unset";
}

/**
 * Which of apps/api/.env, the environment or the root .env decides each of `keys`, **before** loadApiEnvFiles runs
 * (it fills the environment, which would hide where a value came from). Same files, same parser, same precedence.
 */
export function resolveSettingOrigins(
  apiRoot: string,
  env: Record<string, string | undefined>,
  keys: readonly string[]
): Record<string, SettingOrigin> {
  const read = (file: string): Record<string, string> => {
    try {
      return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
    } catch {
      return {};
    }
  };
  const root = read(path.resolve(apiRoot, "..", "..", ".env"));
  const api = read(path.resolve(apiRoot, ".env"));
  const out: Record<string, SettingOrigin> = {};
  for (const key of keys) {
    if (api[key] !== undefined) out[key] = { value: api[key], source: "apps/api/.env" };
    else if (env[key] !== undefined) out[key] = { value: env[key], source: "environment" };
    else if (root[key] !== undefined) out[key] = { value: root[key], source: "root .env" };
    else out[key] = { value: undefined, source: "unset" };
  }
  return out;
}
