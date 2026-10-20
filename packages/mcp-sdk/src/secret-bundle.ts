import type { MCPServerConfig } from "@ai-orchestrator/shared";
import type { MCPExecutionContext, MCPServerAdapter } from "./types";

/**
 * Phase 10.6 — servers that need more than one credential.
 *
 * A registry server references one secret. When a stdio server needs several
 * secret env vars (or a remote server several secret headers), that secret
 * holds a JSON object mapping each name to its value, and the connection lists
 * the names it may inject:
 *
 *   connection.secretEnvVars = ["API_KEY", "API_SECRET"]   (stdio: child env)
 *   connection.secretHeaders = ["X-Api-Key", "X-Tenant"]   (http: request headers)
 *
 * `withSecretBundle` wraps an adapter so that, for such a config, the bundle is
 * resolved at call time and merged into `connection.env` / `connection.headers`
 * of the config the adapter sees. The stored connection never carries a value.
 */

export const SECRET_ENV_VARS_KEY = "secretEnvVars";
export const SECRET_HEADERS_KEY = "secretHeaders";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Parse a bundle secret; null when the value is not a JSON object of strings. */
export function parseSecretBundle(raw: string | undefined): Record<string, string> | null {
  if (typeof raw !== "string" || !raw.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

/** True when the config asks for bundle injection. */
export function usesSecretBundle(config: MCPServerConfig): boolean {
  const connection = toRecord(config.connection);
  return (
    Boolean(config.secretRef) &&
    (nameList(connection[SECRET_ENV_VARS_KEY]).length > 0 || nameList(connection[SECRET_HEADERS_KEY]).length > 0)
  );
}

/**
 * The individual values a resolved secret stands for: every bundle value for a
 * bundle, else the raw value. Callers scrub these from tool output and errors.
 */
export function secretValuesForScrub(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const bundle = parseSecretBundle(raw);
  const values = bundle ? Object.values(bundle) : [raw];
  return values.filter((value) => value.length >= 4);
}

/** The config an adapter should see: bundle values merged in, bundle keys removed. */
export async function expandSecretBundle(config: MCPServerConfig, context: MCPExecutionContext): Promise<MCPServerConfig> {
  if (!usesSecretBundle(config)) return config;
  const connection = toRecord(config.connection);
  const envNames = nameList(connection[SECRET_ENV_VARS_KEY]);
  const headerNames = nameList(connection[SECRET_HEADERS_KEY]);
  const bundle = parseSecretBundle(await context.resolveSecret(config.secretRef));
  if (!bundle) {
    throw new Error(
      `MCP server '${config.label ?? config.serverId}' lists secret ${envNames.length ? "env vars" : "headers"} but its secret is not a JSON object of values.`
    );
  }
  const { [SECRET_ENV_VARS_KEY]: _env, [SECRET_HEADERS_KEY]: _headers, secretEnvVar: _single, ...rest } = connection;
  const next: Record<string, unknown> = { ...rest };
  if (envNames.length > 0) {
    const env: Record<string, unknown> = { ...toRecord(connection.env) };
    for (const name of envNames) {
      if (bundle[name] !== undefined) env[name] = bundle[name];
    }
    next.env = env;
  }
  if (headerNames.length > 0) {
    const headers: Record<string, unknown> = { ...toRecord(connection.headers) };
    for (const name of headerNames) {
      if (bundle[name] !== undefined) headers[name] = bundle[name];
    }
    next.headers = headers;
  }
  // The secret was consumed here; the adapter must not inject the JSON blob itself.
  return { ...config, connection: next, secretRef: undefined };
}

function isServerConfig(value: unknown): value is MCPServerConfig {
  const record = toRecord(value);
  return typeof record.serverId === "string" && "connection" in record;
}

function isContext(value: unknown): value is MCPExecutionContext {
  return typeof toRecord(value).resolveSecret === "function";
}

/**
 * Wrap an adapter so every method that receives a server config and an
 * execution context sees the expanded config. Methods without a config
 * (`closeSessions`) pass through untouched, as do configs without a bundle.
 */
export function withSecretBundle<T extends MCPServerAdapter>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "constructor") return value;
      return function wrapped(this: unknown, ...args: unknown[]) {
        const configIndex = args.findIndex(isServerConfig);
        const context = args.find(isContext);
        if (configIndex < 0 || !context || !usesSecretBundle(args[configIndex] as MCPServerConfig)) {
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        }
        return expandSecretBundle(args[configIndex] as MCPServerConfig, context).then((expanded) => {
          const nextArgs = [...args];
          nextArgs[configIndex] = expanded;
          return (value as (...input: unknown[]) => unknown).apply(target, nextArgs);
        });
      };
    }
  });
}
