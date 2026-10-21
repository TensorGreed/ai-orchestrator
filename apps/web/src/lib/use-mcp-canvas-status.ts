/**
 * Phase 10.3 — probe status and policy state for MCP Tool nodes on the
 * editor canvas.
 *
 * One request per workflow (the servers its MCP Tool nodes reference, with
 * the caller's access to each tool), cached per project and server set and
 * refreshed when the window regains focus. Markers are derived locally.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchMcpToolCatalog, type McpCatalogServer, type McpCatalogTool, type McpToolCatalogResponse } from "./api";
import { deriveCanvasMarker, registryServerIdOf, type McpCanvasMarker } from "./mcp-control-plane";

interface CanvasNodeLike {
  id: string;
  data: { nodeType: string; config?: Record<string, unknown> };
}

/** Keyed by project + sorted server ids; shared across editor mounts so switching pages does not refetch. */
const cache = new Map<string, { at: number; data: McpToolCatalogResponse }>();
const inflight = new Map<string, Promise<McpToolCatalogResponse>>();

/** Cached results younger than this are reused without a request. */
const FRESH_MS = 60_000;

export function clearMcpCanvasStatusCache(): void {
  cache.clear();
  inflight.clear();
}

function load(key: string, projectId: string | null, serverIds: string[], force: boolean): Promise<McpToolCatalogResponse> {
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.data);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = fetchMcpToolCatalog({ projectId, serverIds, detail: false })
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

export function useMcpCanvasStatus(
  nodes: readonly CanvasNodeLike[],
  options: { projectId: string | null | undefined; enabled: boolean }
): Record<string, McpCanvasMarker> {
  const serverIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of nodes) {
      if (node.data.nodeType !== "mcp_tool") continue;
      const id = registryServerIdOf(node.data.config);
      if (id) ids.add(id);
    }
    return [...ids].sort();
  }, [nodes]);
  const projectId = options.projectId ?? null;
  const key = `${projectId ?? ""}|${serverIds.join(",")}`;
  const active = options.enabled && serverIds.length > 0;
  const [data, setData] = useState<McpToolCatalogResponse | null>(() => (active ? cache.get(key)?.data ?? null : null));

  useEffect(() => {
    if (!active) {
      setData(null);
      return;
    }
    let cancelled = false;
    const ids = key.slice(key.indexOf("|") + 1).split(",");
    const run = (force: boolean) => {
      load(key, projectId, ids, force)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch(() => {
          // Markers are a hint; the canvas works without them.
        });
    };
    setData(cache.get(key)?.data ?? null);
    run(false);
    const onFocus = () => run(true);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [active, key, projectId]);

  return useMemo(() => {
    if (!data) return {};
    const servers = new Map<string, McpCatalogServer>(data.servers.map((server) => [server.id, server]));
    const toolsByServer = new Map<string, McpCatalogTool[]>();
    for (const tool of data.tools) {
      const list = toolsByServer.get(tool.serverId) ?? [];
      list.push(tool);
      toolsByServer.set(tool.serverId, list);
    }
    const markers: Record<string, McpCanvasMarker> = {};
    for (const node of nodes) {
      if (node.data.nodeType !== "mcp_tool") continue;
      const marker = deriveCanvasMarker(node.data.config, servers, toolsByServer);
      if (marker) markers[node.id] = marker;
    }
    return markers;
  }, [data, nodes]);
}
