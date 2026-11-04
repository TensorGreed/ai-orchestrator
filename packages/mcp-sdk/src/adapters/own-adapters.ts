import type { MCPServerAdapter } from "../types";

/**
 * Phase 6.4 — L2M's own in-process tool adapters (built-in tools, workflow
 * tools). The write gate trusts what they declare only for these instances:
 * another adapter registered under the same id is not one of them. Wrappers
 * (runtime limits, recording) keep the adapter's definition object, so the
 * mark is that object.
 */
const OWN_DEFINITIONS = new WeakSet<object>();

export function markL2mOwnToolAdapter(definition: object): void {
  OWN_DEFINITIONS.add(definition);
}

export function isL2mOwnToolAdapter(adapter: Pick<MCPServerAdapter, "definition"> | undefined): boolean {
  return adapter !== undefined && OWN_DEFINITIONS.has(adapter.definition);
}
