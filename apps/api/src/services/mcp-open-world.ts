import { resolveToolOpenWorld, serverOpenWorldDestination } from "@ai-orchestrator/mcp-sdk";
import type { DataDestinationRow, McpOpenWorldResolution, McpToolAnnotations, McpToolOpenWorldOverride, McpToolPolicyRule } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";

/**
 * Phase 12.2 — the API side of open-world resolution: what an admin overrode, and the destination rows that classify
 * a server's endpoint. The engine resolves the same way for run calls (see `buildRunToolPolicy`).
 */
export interface McpOpenWorldContext {
  overrides: readonly McpToolOpenWorldOverride[];
  destinations: readonly DataDestinationRow[];
}

/** True when an enabled rule reads the open-world hint, so a tool's open-world value must be resolved. */
export function rulesReadOpenWorld(rules: readonly McpToolPolicyRule[]): boolean {
  return rules.some((rule) => rule.enabled && (rule.annotationHint === "open_world" || rule.annotationHint === "not_open_world"));
}

export async function loadMcpOpenWorldContext(store: Pick<Store, "listMcpToolOpenWorldOverrides" | "listDataDestinations">, registryServerId?: string): Promise<McpOpenWorldContext> {
  return {
    overrides: await store.listMcpToolOpenWorldOverrides(registryServerId),
    destinations: await store.listDataDestinations()
  };
}

export function openWorldOverrideFor(overrides: readonly McpToolOpenWorldOverride[], registryServerId: string | null | undefined, toolName: string): boolean | null {
  if (!registryServerId) return null;
  return overrides.find((entry) => entry.registryServerId === registryServerId && entry.toolName === toolName)?.openWorld ?? null;
}

/** A tool's resolved open-world value on a server (a registry entry, or an inline adapter with its connection). */
export function resolveOpenWorldFor(
  context: McpOpenWorldContext,
  server: { adapterId: string; registryServerId?: string | null; connection?: unknown },
  toolName: string,
  annotations?: McpToolAnnotations | null
): McpOpenWorldResolution {
  return resolveToolOpenWorld({
    override: openWorldOverrideFor(context.overrides, server.registryServerId, toolName),
    destination: serverOpenWorldDestination(server, context.destinations),
    annotations: annotations ?? null
  });
}

/**
 * The open-world part of a marking context (`McpToolMarkingContext.openWorld`) for tools of one server: undefined
 * when no rule reads the open-world hint, so nothing is loaded and nothing changes. `loaded` reuses a context read
 * once for several servers.
 */
export async function openWorldMarking(
  store: Pick<Store, "listMcpToolOpenWorldOverrides" | "listDataDestinations">,
  rules: readonly McpToolPolicyRule[],
  server: { connection?: unknown } | null | undefined,
  loaded?: McpOpenWorldContext
): Promise<(McpOpenWorldContext & { connection?: unknown }) | undefined> {
  if (!rulesReadOpenWorld(rules)) return undefined;
  return { ...(loaded ?? (await loadMcpOpenWorldContext(store))), connection: server?.connection };
}
