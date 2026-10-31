import {
  storedTriggerTrustBinding,
  TRIGGER_TRUST_BINDING_KEY,
  TRIGGER_TRUST_CONFIG_KEY,
  triggerTrustBindingOf,
  triggerTrustOf,
  type TriggerTrust,
  type Workflow,
  type WorkflowNode
} from "@ai-orchestrator/shared";

/**
 * 12.2 — a trigger's input trust (`inputTrust` in the trigger node's config) is an admin's call: it decides whether
 * the content a trigger brings in counts as the user's. A builder saving a workflow can neither set it nor change
 * or remove one an admin set; the save is refused instead (copies a builder makes drop it, see `withoutTriggerTrust`).
 *
 * The setting is bound to the trigger it was made for (`inputTrustFor`: node type, auth mode, secret, path), which
 * only an admin's save writes. A builder may still change the trigger; a `user` setting then no longer matches and
 * is ignored at run time until an admin sets it again, while an `untrusted_external` one still applies (a reset only
 * tightens). Removing a node that carries a setting is a change too: a builder cannot drop it with the node.
 */

type NodesOf = { nodes?: ReadonlyArray<{ id: string; type?: string; config?: unknown }> | null };

/** The trust part of a node's config (the setting and its binding), as one comparable value. */
function trustPart(config: unknown): string {
  const record = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  // A value the schema would refuse still counts as a change attempt here.
  const trust: unknown = triggerTrustOf(config) ?? record[TRIGGER_TRUST_CONFIG_KEY];
  const binding: unknown = storedTriggerTrustBinding(config) ?? record[TRIGGER_TRUST_BINDING_KEY];
  return JSON.stringify([trust ?? null, binding ?? null]);
}

/**
 * The nodes whose trust setting or its binding differs between `previous` and `next` (none stored: any setting
 * differs), and the nodes of `previous` with a setting that `next` no longer has.
 */
export function triggerTrustChanges(previous: NodesOf | null | undefined, next: NodesOf): string[] {
  const before = new Map<string, string>();
  for (const node of previous?.nodes ?? []) before.set(node.id, trustPart(node.config));
  const unset = trustPart(undefined);
  const changed: string[] = [];
  const nextIds = new Set<string>();
  for (const node of next.nodes ?? []) {
    nextIds.add(node.id);
    if (trustPart(node.config) !== (before.get(node.id) ?? unset)) changed.push(node.id);
  }
  // A node with a setting that the next version no longer has: deleting it (and adding the trigger again under
  // another id) would drop the admin's setting.
  for (const [nodeId, part] of before) if (!nextIds.has(nodeId) && part !== unset) changed.push(nodeId);
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

/**
 * An admin's save: each trust setting the save sets, changes or re-confirms (its binding was removed or edited) is
 * bound to the trigger as saved; an unchanged setting keeps its binding; a binding without a setting is dropped.
 */
export function bindTriggerTrust(previous: NodesOf | null | undefined, nodes: Workflow["nodes"]): Workflow["nodes"] {
  const before = new Map<string, { trust: TriggerTrust | undefined; binding: string }>();
  for (const node of previous?.nodes ?? []) {
    before.set(node.id, { trust: triggerTrustOf(node.config), binding: JSON.stringify(storedTriggerTrustBinding(node.config) ?? null) });
  }
  return nodes.map((node): WorkflowNode => {
    const config = node.config ?? {};
    const trust = triggerTrustOf(config);
    const hasBinding = Object.prototype.hasOwnProperty.call(config, TRIGGER_TRUST_BINDING_KEY);
    if (!trust) {
      if (!hasBinding) return node;
      const { [TRIGGER_TRUST_BINDING_KEY]: _dropped, ...rest } = config;
      return { ...node, config: rest };
    }
    const stored = before.get(node.id);
    const binding = storedTriggerTrustBinding(config);
    const unchanged = stored !== undefined && stored.trust === trust && binding !== undefined && JSON.stringify(binding) === stored.binding;
    if (unchanged) return node;
    return { ...node, config: { ...config, [TRIGGER_TRUST_BINDING_KEY]: triggerTrustBindingOf(node) } };
  });
}

/**
 * A non-admin import over a workflow: its trust settings are the stored workflow's, whatever the file says (an
 * export carries the source's settings, and only an admin sets them).
 */
export function withStoredTriggerTrust<T extends Pick<Workflow, "nodes">>(previous: NodesOf | null | undefined, workflow: T): T {
  const stored = new Map<string, Record<string, unknown>>();
  for (const node of previous?.nodes ?? []) {
    const config = node.config && typeof node.config === "object" && !Array.isArray(node.config) ? (node.config as Record<string, unknown>) : {};
    const part: Record<string, unknown> = {};
    if (config[TRIGGER_TRUST_CONFIG_KEY] !== undefined) part[TRIGGER_TRUST_CONFIG_KEY] = config[TRIGGER_TRUST_CONFIG_KEY];
    if (config[TRIGGER_TRUST_BINDING_KEY] !== undefined) part[TRIGGER_TRUST_BINDING_KEY] = config[TRIGGER_TRUST_BINDING_KEY];
    stored.set(node.id, part);
  }
  const cleared = withoutTriggerTrust(workflow);
  return {
    ...cleared,
    nodes: cleared.nodes.map((node) => {
      const part = stored.get(node.id);
      return part && Object.keys(part).length > 0 ? { ...node, config: { ...node.config, ...part } } : node;
    })
  };
}

/** A copy without any trust setting: a builder's duplicate or template starts with the default trust of its triggers. */
export function withoutTriggerTrust<T extends Pick<Workflow, "nodes">>(workflow: T): T {
  const carries = (config: Record<string, unknown> | undefined) =>
    Object.prototype.hasOwnProperty.call(config ?? {}, TRIGGER_TRUST_CONFIG_KEY) || Object.prototype.hasOwnProperty.call(config ?? {}, TRIGGER_TRUST_BINDING_KEY);
  if (!workflow.nodes.some((node) => carries(node.config))) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (!carries(node.config)) return node;
      const { [TRIGGER_TRUST_CONFIG_KEY]: _trust, [TRIGGER_TRUST_BINDING_KEY]: _binding, ...config } = node.config;
      return { ...node, config };
    })
  };
}
