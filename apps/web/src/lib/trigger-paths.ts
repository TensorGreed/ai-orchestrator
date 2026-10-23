/**
 * Phase 15.4 — a new webhook, form or MCP trigger node gets its own default
 * path. Production paths are unique across workflows, so a shared constant
 * default (the node catalog's sample path) would make the second workflow
 * that keeps it unsaveable. Saved workflows keep the paths they have.
 */
const TRIGGER_PATH_NODE_TYPES = new Set(["webhook_input", "form_trigger", "mcp_server_trigger"]);

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 6);
}

/** A new node's config: the sample config, with a short random suffix on a trigger node's path. */
export function newNodeConfig(nodeType: string, sampleConfig: Record<string, unknown> | undefined, suffix: () => string = randomSuffix): Record<string, unknown> {
  const config = { ...(sampleConfig ?? {}) };
  if (!TRIGGER_PATH_NODE_TYPES.has(nodeType)) return config;
  const base = typeof config.path === "string" && config.path.trim() ? config.path.trim().replace(/^\/+|\/+$/g, "") : nodeType === "webhook_input" ? "webhook" : nodeType === "form_trigger" ? "form" : "tool";
  config.path = `${base}-${suffix()}`;
  return config;
}
