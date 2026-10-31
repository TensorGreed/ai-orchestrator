import { TRIGGER_TRUST_CONFIG_KEY, triggerTrustOf, type TriggerTrust, type Workflow } from "@ai-orchestrator/shared";

/**
 * 12.2 — a trigger's input trust (`inputTrust` in the trigger node's config) is an admin's call: it decides whether
 * the content a trigger brings in counts as the user's. A builder saving a workflow can neither set it nor change
 * or remove one an admin set; the save is refused instead (copies a builder makes drop it, see `withoutTriggerTrust`).
 */

type NodesOf = { nodes?: ReadonlyArray<{ id: string; config?: unknown }> | null };

/** The nodes of `next` whose trust setting differs from the same node in `previous` (none stored: any setting differs). */
export function triggerTrustChanges(previous: NodesOf | null | undefined, next: NodesOf): string[] {
  const before = new Map<string, TriggerTrust | undefined>();
  for (const node of previous?.nodes ?? []) before.set(node.id, triggerTrustOf(node.config));
  const changed: string[] = [];
  for (const node of next.nodes ?? []) {
    const value = triggerTrustOf(node.config);
    const raw = node.config && typeof node.config === "object" ? (node.config as Record<string, unknown>)[TRIGGER_TRUST_CONFIG_KEY] : undefined;
    // A value the schema would refuse still counts as a change attempt here.
    if ((value ?? raw) !== before.get(node.id)) changed.push(node.id);
  }
  return changed;
}

/** The refusal for a non-admin save that changes a trigger's trust; null when nothing changed or the user is an admin. */
export function triggerTrustDenial(role: string, previous: NodesOf | null | undefined, next: NodesOf): { ok: false; status: 403; error: string } | null {
  if (role === "admin") return null;
  const changed = triggerTrustChanges(previous, next);
  if (changed.length === 0) return null;
  return {
    ok: false,
    status: 403,
    error: `Only an admin can set or change a trigger's input trust (node ${changed.map((id) => `'${id}'`).join(", ")}). Leave it as it is, or ask an admin.`
  };
}

/** A copy without any trust setting: a builder's duplicate or template starts with the default trust of its triggers. */
export function withoutTriggerTrust<T extends Pick<Workflow, "nodes">>(workflow: T): T {
  if (!workflow.nodes.some((node) => Object.prototype.hasOwnProperty.call(node.config ?? {}, TRIGGER_TRUST_CONFIG_KEY))) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (!Object.prototype.hasOwnProperty.call(node.config ?? {}, TRIGGER_TRUST_CONFIG_KEY)) return node;
      const { [TRIGGER_TRUST_CONFIG_KEY]: _dropped, ...config } = node.config;
      return { ...node, config };
    })
  };
}
