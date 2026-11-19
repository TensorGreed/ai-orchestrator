import { newNodeBaseConfig } from "@ai-orchestrator/shared";

/**
 * The config a node added in the editor starts with. It is the node catalog's sample config with three kinds of
 * change, all for NEW nodes only (a saved node keeps what it has):
 *
 * - A webhook, form or MCP trigger gets its own default path (Phase 15.4): production paths are unique across
 *   workflows, so a shared constant default would make the second workflow that keeps it unsaveable.
 * - Fields the person has to fill start empty instead of holding example values that look like real config (an
 *   example URL, three sample Set rows, a `status = active` condition, a `documents` loop key). The inspector shows
 *   the examples as grey placeholders.
 * - A Schedule Trigger starts switched off, in the browser's time zone, so a scratch workflow never fires on its own.
 */
const TRIGGER_PATH_NODE_TYPES = new Set(["webhook_input", "form_trigger", "mcp_server_trigger"]);

export interface NewNodeContext {
  /** Makes the random path suffix (tests pass a fixed one). */
  suffix?: () => string;
  /** The browser's IANA time zone (tests pass one); the sample's when unknown. */
  timeZone?: string;
  /** The node is added straight after a Loop body node: a Merge there collects the loop's passes. */
  afterLoopBodyNode?: boolean;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 6);
}

/** The browser's IANA time zone, or undefined when the browser does not say. */
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.trim() ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** A new node's config (see the file comment). Never changes `sampleConfig`. */
export function newNodeConfig(
  nodeType: string,
  sampleConfig: Record<string, unknown> | undefined,
  context: NewNodeContext | (() => string) = {}
): Record<string, unknown> {
  const options: NewNodeContext = typeof context === "function" ? { suffix: context } : context;
  // The blanked fields and the schedule switched off are shared with Describe it (newNodeBaseConfig).
  const config = newNodeBaseConfig(nodeType, sampleConfig);

  if (nodeType === "schedule_trigger") {
    const zone = options.timeZone ?? browserTimeZone();
    if (zone) config.timezone = zone;
  }
  if (nodeType === "merge_node" && options.afterLoopBodyNode) config.mode = "collect_loop_passes";

  if (TRIGGER_PATH_NODE_TYPES.has(nodeType)) {
    const base =
      typeof config.path === "string" && config.path.trim()
        ? config.path.trim().replace(/^\/+|\/+$/g, "")
        : nodeType === "webhook_input"
          ? "webhook"
          : nodeType === "form_trigger"
            ? "form"
            : "tool";
    config.path = `${base}-${(options.suffix ?? randomSuffix)()}`;
  }
  return config;
}

/** Whether `nodeId` runs once per item of a Loop: one of its execution parents is a Loop node (not the Loop's Error output). */
export function isDirectLoopBodyNode(
  nodeId: string,
  nodes: ReadonlyArray<{ id: string; data: { nodeType: string } }>,
  edges: ReadonlyArray<{ source: string; target: string; sourceHandle?: string | null }>
): boolean {
  const typeOf = new Map(nodes.map((node) => [node.id, node.data.nodeType]));
  return edges.some((edge) => edge.target === nodeId && edge.sourceHandle !== "error" && typeOf.get(edge.source) === "loop_node");
}
