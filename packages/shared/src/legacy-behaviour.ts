import { filterModeOf, isSetValueType } from "./item-nodes";
import { httpErrorStatusMode } from "./node-retry";

/**
 * Behaviours a node keeps from before a newer default existed. New nodes start on the newer behaviour, so the switch
 * that chooses between them is shown only on a node saved with the older one, next to a one-click upgrade.
 *
 * - `loop_collect`: a Loop without Collect results (no `collected` in its output).
 * - `loop_route`: a Loop whose branches do not route inside its body.
 * - `http_fail`: an HTTP Request that does not fail on every HTTP error status.
 * - `filter_gate`: a Filter that passes or stops its whole input instead of keeping the matching items of a list.
 * - `set_text`: a Set node with fields saved without a type (their values become text).
 *
 * `behavioursOffDefault` lists the ones a node uses, whether stored before the option existed or chosen on purpose
 * (an explicit `false`, a Filter's `mode: "gate"`, as an import may set): the switch is shown for each. Only the ones
 * stored without the option (`legacyBehaviours`) get the "earlier behaviour" notice and its upgrade.
 */
export type LegacyBehaviour = "loop_collect" | "loop_route" | "http_fail" | "filter_gate" | "set_text";

interface RetrySettings {
  retryOnFail?: boolean;
  maxRetries?: number;
}

function assignmentsOf(config: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(config.assignments)
    ? config.assignments.map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}))
    : [];
}

/** The older behaviours this node uses, chosen or not, in the order they are listed to the user. */
export function behavioursOffDefault(nodeType: string, config: Record<string, unknown>, errorConfig?: RetrySettings): LegacyBehaviour[] {
  switch (nodeType) {
    case "loop_node":
      return [
        ...(config.collectResults === true ? [] : (["loop_collect"] as const)),
        ...(config.routeBranches === true ? [] : (["loop_route"] as const))
      ];
    case "http_request":
      return httpErrorStatusMode(config, errorConfig) === "all" ? [] : ["http_fail"];
    case "filter_node":
      return filterModeOf(config) === "gate" ? ["filter_gate"] : [];
    case "set_node":
      return assignmentsOf(config).some((entry) => !isSetValueType(entry.type)) ? ["set_text"] : [];
    default:
      return [];
  }
}

/** True when the node's config names the older behaviour on purpose rather than lacking the option. */
function chosen(behaviour: LegacyBehaviour, config: Record<string, unknown>): boolean {
  switch (behaviour) {
    case "loop_collect":
      return typeof config.collectResults === "boolean";
    case "loop_route":
      return typeof config.routeBranches === "boolean";
    case "http_fail":
      return typeof config.failOnHttpError === "boolean";
    case "filter_gate":
      return config.mode === "gate";
    case "set_text":
      return false;
  }
}

/** The older behaviours this node keeps only because it was stored before the option existed. */
export function legacyBehaviours(nodeType: string, config: Record<string, unknown>, errorConfig?: RetrySettings): LegacyBehaviour[] {
  return behavioursOffDefault(nodeType, config, errorConfig).filter((behaviour) => !chosen(behaviour, config));
}

/**
 * The config with every older behaviour switched to the newer one (or only those in `only`). Other settings are kept.
 */
export function upgradeToNewBehaviour(nodeType: string, config: Record<string, unknown>, only?: LegacyBehaviour[]): Record<string, unknown> {
  switch (nodeType) {
    case "loop_node":
      return {
        ...config,
        ...(!only || only.includes("loop_collect") ? { collectResults: true } : {}),
        ...(!only || only.includes("loop_route") ? { routeBranches: true } : {})
      };
    case "http_request":
      return { ...config, failOnHttpError: true };
    case "filter_node":
      return { ...config, mode: "items" };
    case "set_node":
      return {
        ...config,
        assignments: assignmentsOf(config).map((entry) => (isSetValueType(entry.type) ? entry : { ...entry, type: "auto" }))
      };
    default:
      return config;
  }
}

/**
 * The config with the fields an upgrade changes put back as they were in `saved`. Used to undo an upgrade before the
 * node is saved; the node's other edits are kept.
 */
export function restoreOldBehaviour(nodeType: string, config: Record<string, unknown>, saved: Record<string, unknown>): Record<string, unknown> {
  const restore = (next: Record<string, unknown>, key: string) => {
    if (key in saved) next[key] = saved[key];
    else delete next[key];
  };
  const next = { ...config };
  switch (nodeType) {
    case "loop_node":
      restore(next, "collectResults");
      restore(next, "routeBranches");
      return next;
    case "http_request":
      restore(next, "failOnHttpError");
      return next;
    case "filter_node":
      restore(next, "mode");
      return next;
    case "set_node": {
      // Fields are matched by position and key: a field the user added or renamed since keeps its type.
      const savedAssignments = assignmentsOf(saved);
      next.assignments = assignmentsOf(config).map((entry, index) => {
        const before = savedAssignments[index];
        if (!before || before.key !== entry.key || isSetValueType(before.type) || entry.type !== "auto") return entry;
        const { type: _type, ...rest } = entry;
        return rest;
      });
      return next;
    }
    default:
      return next;
  }
}
