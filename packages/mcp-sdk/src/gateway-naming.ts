/**
 * Phase 10.4 — names of the tools the MCP gateway re-exposes.
 *
 * A registry server's tools are published as `<server-slug>__<tool>`. The slug
 * comes from the server's name, so it reads well in a client's tool list and
 * stays the same across restarts. Two servers whose names slug to the same
 * value are told apart by creation order: the oldest keeps the plain slug,
 * the next gets `_2`, then `_3`, and so on.
 */

export const GATEWAY_TOOL_SEPARATOR = "__";

const MAX_SLUG_LENGTH = 32;

/** Lowercase letters, digits and single underscores; `server` when nothing usable is left. */
export function slugifyServerName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/_+$/g, "");
  return slug || "server";
}

export interface SluggableServer {
  id: string;
  name: string;
  createdAt: string;
}

/**
 * Slug for every server, keyed by server id. Deterministic for a given set of
 * servers: ordered by creation time, then id, before collisions are numbered.
 */
export function assignServerSlugs(servers: readonly SluggableServer[]): Map<string, string> {
  const ordered = [...servers].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const taken = new Set<string>();
  const slugs = new Map<string, string>();
  for (const server of ordered) {
    const base = slugifyServerName(server.name);
    let candidate = base;
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter += 1;
    }
    taken.add(candidate);
    slugs.set(server.id, candidate);
  }
  return slugs;
}

export function gatewayToolName(serverSlug: string, toolName: string): string {
  return `${serverSlug}${GATEWAY_TOOL_SEPARATOR}${toolName}`;
}

/**
 * Give each name in `names` a unique variant, in order: the first keeps its
 * name, later duplicates get `_2`, `_3`, ... (skipping names already used).
 */
export function dedupeToolNames(names: readonly string[], reserved: Iterable<string> = []): string[] {
  const taken = new Set<string>(reserved);
  return names.map((name) => {
    let candidate = name;
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = `${name}_${counter}`;
      counter += 1;
    }
    taken.add(candidate);
    return candidate;
  });
}
