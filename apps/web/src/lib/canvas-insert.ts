/**
 * Where a node added from the palette goes and what it is connected to: after the selected node (or the output whose
 * `+` was clicked), to the right of it and clear of other nodes, joined by an edge from that node's first free output.
 */
import { ORBIT, isHubType } from "./stages";
import { validateConnection, type RuleEdge, type RuleNode } from "./connection-rules";
import { ERROR_OUTPUT_HANDLE } from "./error-output";

export interface InsertNode {
  id: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  data: { nodeType: string; config?: Record<string, unknown> };
}

export interface InsertEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface Point {
  x: number;
  y: number;
}

/** Horizontal gap between a node and the node inserted after it. */
export const INSERT_GAP_X = 80;
/** Vertical step between rows (one card plus a gap). */
export const INSERT_ROW_STEP = ORBIT.cardHeight + 24;
const OVERLAP_MARGIN = 16;

const FIXED_SOURCE_HANDLES: Record<string, string[]> = {
  if_node: ["true", "false"],
  try_catch: ["success", "error"],
  guard: ["pass", "blocked", "review"],
  approval_gate: ["approved", "rejected", "timed_out"],
  // Pass / Stopped (Pass or stop), Kept / Rejected (items mode): the same two handles, so a mode change keeps edges.
  filter_node: ["pass", "filtered"],
  chat_intent_router: ["report", "code", "message", "missing_context"]
};

/** Node types that sit on an agent's ports (model, memory, tools, content rules) rather than in its steps. */
const AGENT_PORT_TYPES = new Set([
  "llm_call",
  "openai_chat_model",
  "anthropic_chat_model",
  "ollama_chat_model",
  "openai_compatible_chat_model",
  "ai_gateway_chat_model",
  "azure_openai_chat_model",
  "google_gemini_chat_model",
  "local_memory",
  "mcp_tool",
  "workflow_tool",
  "guard",
  "guard_protection"
]);

/** Start nodes: they take no incoming step edge. */
const INPUT_TYPES = new Set(["webhook_input", "text_input", "system_prompt", "user_prompt", "mcp_server_trigger"]);

function isInputType(type: string): boolean {
  return INPUT_TYPES.has(type) || type.endsWith("_trigger");
}

/** The node's output handles in the order the canvas draws them; `null` is the single main output. */
export function sourceHandleIds(node: InsertNode): Array<string | null> {
  const type = node.data.nodeType;
  const fixed = FIXED_SOURCE_HANDLES[type];
  if (fixed) return [...fixed];
  if (type === "switch_node") {
    const cases = Array.isArray(node.data.config?.cases) ? (node.data.config?.cases as unknown[]) : [];
    const ids = cases.map((entry, index) => {
      const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
      const raw = typeof entry === "string" ? entry : (record?.label ?? record?.value ?? `Case ${index + 1}`);
      return String(raw ?? "").trim() || `case_${index}`;
    });
    return [...ids, "default"];
  }
  return [null];
}

/** The first output of `node` with no outgoing edge, else its first output. */
export function chooseSourceHandle(node: InsertNode, edges: readonly InsertEdge[]): string | null {
  const handles = sourceHandleIds(node);
  // A Filter's edge saved without a handle (from before it had two outputs) is drawn from its first output.
  const unlabeled = node.data.nodeType === "filter_node" && !handles.includes(null) ? handles[0] ?? null : null;
  const used = new Set(edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle ?? unlabeled));
  return handles.find((handle) => !used.has(handle)) ?? handles[0] ?? null;
}

/**
 * Whether a node of `targetType` added after a node of `sourceType` is offered an edge at all (start nodes, sticky
 * notes and an agent's port nodes are simply placed). An offered edge still goes through the editor's connection
 * rules (`validateConnection`), which may refuse it with a notice.
 */
export function canAutoConnect(sourceType: string, targetType: string, sourceHandle: string | null = null): boolean {
  if (sourceType === "sticky_note" || targetType === "sticky_note") return false;
  if (isInputType(targetType)) return false;
  // A node added after an agent's Error output is a step (the fallback), never one of its ports.
  if (isHubType(sourceType) && AGENT_PORT_TYPES.has(targetType) && sourceHandle !== ERROR_OUTPUT_HANDLE) return false;
  return true;
}

function sizeOf(node: InsertNode): { width: number; height: number } {
  const hub = isHubType(node.data.nodeType);
  return {
    width: node.width ?? (hub ? ORBIT.hubSize : ORBIT.cardWidth),
    height: node.height ?? (hub ? ORBIT.hubSize : ORBIT.cardHeight)
  };
}

function overlaps(spot: Point, nodes: readonly InsertNode[]): boolean {
  return nodes.some((other) => {
    const size = sizeOf(other);
    return (
      spot.x < other.position.x + size.width + OVERLAP_MARGIN &&
      spot.x + ORBIT.cardWidth + OVERLAP_MARGIN > other.position.x &&
      spot.y < other.position.y + size.height + OVERLAP_MARGIN &&
      spot.y + ORBIT.cardHeight + OVERLAP_MARGIN > other.position.y
    );
  });
}

/** `candidate`, or the first spot below it (one row at a time) that no node covers. */
export function findFreePosition(candidate: Point, nodes: readonly InsertNode[]): Point {
  let spot = { ...candidate };
  for (let step = 0; step < 200 && overlaps(spot, nodes); step += 1) {
    spot = { x: spot.x, y: spot.y + INSERT_ROW_STEP };
  }
  return spot;
}

/** Where a node inserted after `source`'s `handle` goes: to its right, on that output's row, clear of `nodes`. */
export function insertPositionAfter(source: InsertNode, handle: string | null, nodes: readonly InsertNode[]): Point {
  const handles = sourceHandleIds(source);
  // The Error output sits below the node's other outputs, so its node goes on the row after theirs.
  const index = handle === ERROR_OUTPUT_HANDLE && !handles.includes(handle) ? handles.length : Math.max(0, handles.indexOf(handle));
  const candidate = {
    x: source.position.x + sizeOf(source).width + INSERT_GAP_X,
    y: source.position.y + index * INSERT_ROW_STEP
  };
  return findFreePosition(candidate, nodes);
}

export type InsertConnectionPlan =
  | { kind: "connect"; sourceHandle: string | null }
  | { kind: "place" }
  | { kind: "refused"; message: string };

/**
 * Whether a node inserted after `source`'s `handle` gets an edge: none for nodes that are only placed, else the
 * verdict of the editor's connection rules (the same ones a dragged connection goes through).
 */
export function planInsertConnection(
  source: RuleNode,
  handle: string | null,
  inserted: RuleNode,
  nodes: readonly RuleNode[],
  edges: readonly RuleEdge[]
): InsertConnectionPlan {
  if (!canAutoConnect(source.data.nodeType, inserted.data.nodeType, handle)) return { kind: "place" };
  const verdict = validateConnection({ source: source.id, target: inserted.id, sourceHandle: handle }, [...nodes, inserted], edges);
  return verdict.ok ? { kind: "connect", sourceHandle: verdict.sourceHandle } : { kind: "refused", message: verdict.message };
}
