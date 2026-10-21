// Pure stage / orbit computations for the Orbit editor canvas.
//
// A workflow is split into two kinds of edges:
//   - DAG edges: walked by the executor as steps (topological depth → stages).
//   - Attachment edges: chat_model / memory / tool / worker ports of an agent
//     hub. These are consumed by the agent runtime at node execution time and
//     are never walked as steps, so they are excluded from stage computation.
//     Their targets ("attached nodes") are laid out on rings around the hub.
//
// Everything here is deterministic and framework-free so it can be unit
// tested without React Flow.

import { AGENT_ATTACHMENT_HANDLES, type AgentAttachmentHandle } from "./agent-attachments";

export interface StageNodeInput {
  id: string;
  /** Workflow node type (e.g. `llm_call`). Accepts either `type` or `data.nodeType`. */
  type?: string;
  position?: { x: number; y: number };
  data?: { nodeType?: string; label?: string; config?: unknown };
}

export interface StageEdgeInput {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface AttachmentSlots {
  chat_model: string[];
  memory: string[];
  tool: string[];
  worker: string[];
  /** Phase 12.1 — the hub's guard node (0..1). */
  guard?: string[];
  /** Phase 12.1 — protection providers attached to a Guard node. */
  protection?: string[];
  /** Set on Guard node entries: they carry protection attachments and are not hubs. */
  carrier?: "guard";
}

export type AttachmentSlotMap = Record<string, AttachmentSlots>;

export interface StageComputation {
  /** Stage index → ordered node ids (DAG nodes only, attached + sticky excluded). */
  stages: string[][];
  /** Node id → stage index. */
  depth: Record<string, number>;
  preds: Record<string, string[]>;
  succs: Record<string, string[]>;
  /** Ids of nodes that are attached to a hub (not part of the DAG walk). */
  attached: Set<string>;
}

export interface RingSlot {
  port: AgentAttachmentHandle;
  /** Attached node id, or `null` for an empty "+" placeholder. */
  nodeId: string | null;
  /** Radians, 0 = east, clockwise (screen coordinates). */
  angle: number;
  radius: number;
}

export const HUB_TYPES = new Set(["agent_orchestrator", "supervisor_node"]);
export const ATTACHMENT_HANDLE_SET = new Set<string>(AGENT_ATTACHMENT_HANDLES);

/** Geometry shared by the hub component, the satellite nodes and the layout. */
export const ORBIT = {
  hubSize: 150,
  satelliteSize: 60,
  innerRadius: 112,
  outerRadius: 196,
  workerRadius: 380,
  miniRadius: 104,
  cardWidth: 240,
  cardHeight: 96
} as const;

export function nodeTypeOf(node: StageNodeInput): string {
  return node.type && node.type !== "workflowNode" && node.type !== "stickyNote"
    ? node.type
    : node.data?.nodeType ?? node.type ?? "";
}

export function isHubType(type: string): boolean {
  return HUB_TYPES.has(type);
}

export function isAttachmentEdge(edge: StageEdgeInput): AgentAttachmentHandle | null {
  if (edge.sourceHandle && ATTACHMENT_HANDLE_SET.has(edge.sourceHandle)) {
    return edge.sourceHandle as AgentAttachmentHandle;
  }
  if (edge.targetHandle && ATTACHMENT_HANDLE_SET.has(edge.targetHandle)) {
    return edge.targetHandle as AgentAttachmentHandle;
  }
  return null;
}

export function emptySlots(): AttachmentSlots {
  return { chat_model: [], memory: [], tool: [], worker: [] };
}

/**
 * Agent id → attached node ids per port. Every hub node is present in the
 * result (with empty arrays) so the canvas can draw empty "+" slots.
 */
export function computeAttachmentSlots(nodes: StageNodeInput[], edges: StageEdgeInput[]): AttachmentSlotMap {
  const slots: AttachmentSlotMap = {};
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (isHubType(nodeTypeOf(node))) {
      slots[node.id] = emptySlots();
    }
  }
  for (const edge of edges) {
    const port = isAttachmentEdge(edge);
    if (!port) continue;
    const source = byId.get(edge.source);
    if (!source || !byId.has(edge.target)) continue;
    const sourceType = nodeTypeOf(source);
    // Protection providers hang off a Guard node; every other port off a hub.
    if (port === "protection" ? sourceType !== "guard" : !isHubType(sourceType)) continue;
    const entry = (slots[edge.source] ??= port === "protection" ? { ...emptySlots(), carrier: "guard" } : emptySlots());
    const bucket = (entry[port] ??= []);
    if (!bucket.includes(edge.target)) {
      bucket.push(edge.target);
    }
  }
  return slots;
}

/** True for a slot entry that belongs to an agent hub (not a Guard node carrying protection). */
export function isHubEntry(entry: AttachmentSlots | undefined): entry is AttachmentSlots {
  return Boolean(entry) && entry!.carrier !== "guard";
}

export function attachedNodeIds(slots: AttachmentSlotMap): Set<string> {
  const attached = new Set<string>();
  for (const entry of Object.values(slots)) {
    for (const port of AGENT_ATTACHMENT_HANDLES) {
      for (const id of entry[port] ?? []) attached.add(id);
    }
  }
  return attached;
}

/** Hub (or Guard node, for protection) an attached node belongs to, or null. */
export function findHubOf(nodeId: string, slots: AttachmentSlotMap): { hubId: string; port: AgentAttachmentHandle } | null {
  for (const [hubId, entry] of Object.entries(slots)) {
    for (const port of AGENT_ATTACHMENT_HANDLES) {
      if ((entry[port] ?? []).includes(nodeId)) {
        return { hubId, port };
      }
    }
  }
  return null;
}

/**
 * Topological depth over DAG edges only. Attached nodes and sticky notes are
 * excluded. Cycles (loop_node back-edges) are tolerated: a back-edge does not
 * increase depth.
 */
export function computeStages(nodes: StageNodeInput[], edges: StageEdgeInput[]): StageComputation {
  const slots = computeAttachmentSlots(nodes, edges);
  const attached = attachedNodeIds(slots);
  const dagNodes = nodes.filter((node) => !attached.has(node.id) && nodeTypeOf(node) !== "sticky_note");
  const dagIds = new Set(dagNodes.map((node) => node.id));
  const order = new Map(dagNodes.map((node, index) => [node.id, index]));

  const preds: Record<string, string[]> = {};
  const succs: Record<string, string[]> = {};
  for (const node of dagNodes) {
    preds[node.id] = [];
    succs[node.id] = [];
  }
  for (const edge of edges) {
    if (isAttachmentEdge(edge)) continue;
    if (!dagIds.has(edge.source) || !dagIds.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    if (!preds[edge.target]!.includes(edge.source)) preds[edge.target]!.push(edge.source);
    if (!succs[edge.source]!.includes(edge.target)) succs[edge.source]!.push(edge.target);
  }

  // Classify back-edges with a DFS in source order (white / gray / black) so
  // loop_node cycles don't feed into the depth computation.
  const backEdges = new Set<string>();
  const colour = new Map<string, 0 | 1 | 2>();
  const classify = (id: string) => {
    colour.set(id, 1);
    for (const next of succs[id] ?? []) {
      const c = colour.get(next) ?? 0;
      if (c === 1) backEdges.add(`${id}->${next}`);
      else if (c === 0) classify(next);
    }
    colour.set(id, 2);
  };
  for (const node of dagNodes) {
    if ((colour.get(node.id) ?? 0) === 0) classify(node.id);
  }

  const depth: Record<string, number> = {};
  const visit = (id: string): number => {
    if (id in depth) return depth[id]!;
    depth[id] = 0;
    let max = -1;
    for (const pred of preds[id] ?? []) {
      if (backEdges.has(`${pred}->${id}`)) continue;
      const d = visit(pred);
      if (d > max) max = d;
    }
    depth[id] = max + 1;
    return depth[id]!;
  };
  for (const node of dagNodes) visit(node.id);

  const maxDepth = dagNodes.reduce((acc, node) => Math.max(acc, depth[node.id] ?? 0), -1);
  const stages: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const node of dagNodes) {
    stages[depth[node.id]!]!.push(node.id);
  }
  // Order within a stage: barycenter of predecessors' row index, then source order.
  const rowIndex = new Map<string, number>();
  stages.forEach((stage) => {
    const keyed = stage.map((id) => {
      const rows = (preds[id] ?? []).map((pred) => rowIndex.get(pred)).filter((v): v is number => v !== undefined);
      const bary = rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.POSITIVE_INFINITY;
      return { id, bary, order: order.get(id) ?? 0 };
    });
    keyed.sort((a, b) => (a.bary === b.bary ? a.order - b.order : a.bary - b.bary));
    stage.splice(0, stage.length, ...keyed.map((k) => k.id));
    stage.forEach((id, index) => rowIndex.set(id, index));
  });

  return { stages, depth, preds, succs, attached };
}

/**
 * Ring geometry for one hub: which port sits where. Includes placeholder
 * entries (`nodeId: null`) for empty chat_model / memory slots and one "+"
 * slot after the tools (and after the workers for supervisors).
 */
export function ringGeometry(slots: AttachmentSlots, options: { allowWorkers?: boolean } = {}): RingSlot[] {
  const out: RingSlot[] = [];
  const model = slots.chat_model[0] ?? null;
  out.push({ port: "chat_model", nodeId: model, angle: -Math.PI / 2, radius: ORBIT.innerRadius });
  for (const extra of slots.chat_model.slice(1)) {
    out.push({ port: "chat_model", nodeId: extra, angle: -Math.PI / 2 + Math.PI / 4, radius: ORBIT.innerRadius });
  }
  const memory = slots.memory[0] ?? null;
  out.push({ port: "memory", nodeId: memory, angle: Math.PI / 2, radius: ORBIT.innerRadius });
  for (const extra of slots.memory.slice(1)) {
    out.push({ port: "memory", nodeId: extra, angle: Math.PI / 2 + Math.PI / 4, radius: ORBIT.innerRadius });
  }

  // Phase 12.1 — the guard slot sits on the inner ring, up and to the left,
  // clear of the model / memory axis, the DAG edges and the tool bearings.
  const guards = slots.guard ?? [];
  out.push({ port: "guard", nodeId: guards[0] ?? null, angle: GUARD_ANGLE, radius: ORBIT.innerRadius });
  for (const [index, extra] of guards.slice(1).entries()) {
    out.push({ port: "guard", nodeId: extra, angle: GUARD_ANGLE - (Math.PI / 7) * (index + 1), radius: ORBIT.innerRadius });
  }

  const tools: Array<string | null> = [...slots.tool, null];
  tools.forEach((id, index) => {
    out.push({ port: "tool", nodeId: id, angle: ringAngle(TOOL_ANGLES_DEG, index, tools.length), radius: ORBIT.outerRadius });
  });

  if (options.allowWorkers || slots.worker.length > 0) {
    const workers: Array<string | null> = options.allowWorkers ? [...slots.worker, null] : [...slots.worker];
    workers.forEach((id, index) => {
      out.push({ port: "worker", nodeId: id, angle: ringAngle(WORKER_ANGLES_DEG, index, workers.length), radius: ORBIT.workerRadius });
    });
  }
  return out;
}

/**
 * Preferred slot angles (degrees, clockwise from east). Tools avoid the
 * vertical axis where model / memory and their labels sit; workers take the
 * axis and the diagonals so they never share a bearing with a tool.
 */
const TOOL_ANGLES_DEG = [30, 150, 330, 210, 60, 120, 300, 240];
const WORKER_ANGLES_DEG = [90, 270, 200, 340, 160, 20];
export const GUARD_ANGLE = (235 * Math.PI) / 180;
/** Protection providers of a guard satellite fan out beyond it on the outer ring (offsets in degrees). */
const PROTECTION_FAN_DEG = [0, 16, -16, 32, -32];
/** How far below a Guard card its protection providers hang. */
const PROTECTION_DROP = 64;

/** Positions for the protection providers attached to a Guard node. */
function protectionPositions(
  guardId: string,
  slots: AttachmentSlotMap,
  placement: { kind: "card"; position: Point } | { kind: "satellite"; hubCenter: Point; angle: number; scale: number }
): Record<string, Point> {
  const out: Record<string, Point> = {};
  const ids = slots[guardId]?.protection ?? [];
  const s = ORBIT.satelliteSize / 2;
  ids.forEach((id, index) => {
    if (placement.kind === "card") {
      const centerX = placement.position.x + ORBIT.cardWidth / 2 + (index - (ids.length - 1) / 2) * (ORBIT.satelliteSize + 44);
      const centerY = placement.position.y + ORBIT.cardHeight + PROTECTION_DROP + s;
      out[id] = { x: Math.round(centerX - s), y: Math.round(centerY - s) };
    } else {
      const offset = ((PROTECTION_FAN_DEG[index] ?? index * 16) * Math.PI) / 180;
      const point = polar(placement.hubCenter, placement.angle + offset, ORBIT.outerRadius * placement.scale);
      out[id] = { x: Math.round(point.x - s), y: Math.round(point.y - s) };
    }
  });
  return out;
}

/** Height a Guard card needs for its protection providers below it (used by tidy). */
function guardCardHeight(guardId: string, slots: AttachmentSlotMap): number {
  return (slots[guardId]?.protection ?? []).length > 0 ? ORBIT.cardHeight + PROTECTION_DROP + ORBIT.satelliteSize + 48 : ORBIT.cardHeight;
}

function ringAngle(preferred: number[], index: number, count: number): number {
  if (count <= preferred.length) {
    return (preferred[index]! * Math.PI) / 180;
  }
  return (preferred[0]! * Math.PI) / 180 + (index * Math.PI * 2) / count;
}

function polar(center: Point, angle: number, radius: number): Point {
  return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
}

/**
 * Deterministic top-left positions for every node attached to `hubId`
 * (recursively including worker hubs and their own attachments).
 * `hubPosition` is the hub's top-left React Flow position.
 */
export function orbitPositions(
  hubId: string,
  slots: AttachmentSlotMap,
  hubPosition: Point,
  options: { allowWorkers?: boolean; depth?: number; visited?: Set<string> } = {}
): Record<string, Point> {
  const out: Record<string, Point> = {};
  const entry = slots[hubId];
  if (!entry) return out;
  if (entry.carrier === "guard") {
    // A Guard card on DAG edges: its protection providers hang below it.
    return protectionPositions(hubId, slots, { kind: "card", position: hubPosition });
  }
  const visited = options.visited ?? new Set<string>();
  if (visited.has(hubId)) return out;
  visited.add(hubId);
  const depth = options.depth ?? 0;
  const half = ORBIT.hubSize / 2;
  const center = { x: hubPosition.x + half, y: hubPosition.y + half };
  const scale = depth === 0 ? 1 : ORBIT.miniRadius / ORBIT.innerRadius;

  for (const slot of ringGeometry(entry, { allowWorkers: options.allowWorkers ?? entry.worker.length > 0 })) {
    if (!slot.nodeId) continue;
    const radius = slot.port === "worker" ? slot.radius : slot.radius * scale;
    const point = polar(center, slot.angle, radius);
    if (slot.port === "worker") {
      const workerPos = { x: Math.round(point.x - half), y: Math.round(point.y - half) };
      out[slot.nodeId] = workerPos;
      Object.assign(out, orbitPositions(slot.nodeId, slots, workerPos, { depth: depth + 1, visited }));
    } else {
      const s = ORBIT.satelliteSize / 2;
      out[slot.nodeId] = { x: Math.round(point.x - s), y: Math.round(point.y - s) };
      if (slot.port === "guard") {
        Object.assign(out, protectionPositions(slot.nodeId, slots, { kind: "satellite", hubCenter: center, angle: slot.angle, scale }));
      }
    }
  }
  return out;
}

/** Radius a hub needs around its centre to fit its rings (used by tidy). */
export function hubReach(hubId: string, slots: AttachmentSlotMap): number {
  const entry = slots[hubId];
  if (!entry) return ORBIT.hubSize / 2;
  let reach = ORBIT.outerRadius + ORBIT.satelliteSize / 2;
  if (entry.worker.length > 0) {
    let workerReach = ORBIT.hubSize / 2;
    for (const worker of entry.worker) {
      const sub = slots[worker];
      const subHasRings = sub && (sub.chat_model.length || sub.memory.length || sub.tool.length);
      workerReach = Math.max(workerReach, subHasRings ? ORBIT.miniRadius * (ORBIT.outerRadius / ORBIT.innerRadius) + ORBIT.satelliteSize : ORBIT.hubSize / 2);
    }
    reach = Math.max(reach, ORBIT.workerRadius + workerReach);
  }
  return reach;
}

export interface TidyOptions {
  columnGap?: number;
  rowGap?: number;
  origin?: Point;
}

/**
 * Stage columns left → right, nodes within a stage stacked top → bottom and
 * centred on a common axis. Hubs reserve room for their rings; their attached
 * nodes are placed with `orbitPositions`. Sticky notes keep their position.
 * Returns top-left positions for every node that was moved.
 */
export function tidyLayout(nodes: StageNodeInput[], edges: StageEdgeInput[], options: TidyOptions = {}): Record<string, Point> {
  const columnGap = options.columnGap ?? 140;
  const rowGap = options.rowGap ?? 48;
  const origin = options.origin ?? { x: 80, y: 80 };
  const slots = computeAttachmentSlots(nodes, edges);
  const { stages } = computeStages(nodes, edges);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: Record<string, Point> = {};

  const extent = (id: string): { w: number; h: number } => {
    const node = byId.get(id);
    if (node && isHubType(nodeTypeOf(node))) {
      const reach = hubReach(id, slots);
      return { w: reach * 2, h: reach * 2 };
    }
    return { w: ORBIT.cardWidth, h: guardCardHeight(id, slots) };
  };

  let x = origin.x;
  const columns = stages.map((stage) => {
    const items = stage.map((id) => ({ id, ...extent(id) }));
    const width = items.reduce((acc, item) => Math.max(acc, item.w), 0);
    const height = items.reduce((acc, item) => acc + item.h, 0) + rowGap * Math.max(items.length - 1, 0);
    return { items, width, height };
  });
  const tallest = columns.reduce((acc, column) => Math.max(acc, column.height), 0);
  const axisY = origin.y + tallest / 2;

  for (const column of columns) {
    let y = axisY - column.height / 2;
    for (const item of column.items) {
      const node = byId.get(item.id)!;
      const cx = x + column.width / 2;
      const cy = y + item.h / 2;
      if (isHubType(nodeTypeOf(node))) {
        const pos = { x: Math.round(cx - ORBIT.hubSize / 2), y: Math.round(cy - ORBIT.hubSize / 2) };
        out[item.id] = pos;
        Object.assign(out, orbitPositions(item.id, slots, pos));
      } else {
        const pos = { x: Math.round(cx - item.w / 2), y: Math.round(cy - item.h / 2) };
        out[item.id] = pos;
        if (slots[item.id]?.carrier === "guard") Object.assign(out, orbitPositions(item.id, slots, pos));
      }
      y += item.h + rowGap;
    }
    x += column.width + columnGap;
  }
  return out;
}

/**
 * True when a saved layout would put a hub's ring area on top of something
 * else: a hub's reach circle intersects any non-attached, non-sticky node's
 * box, or two top-level hubs' reach circles intersect.
 */
export function hasOrbitOverlap(nodes: StageNodeInput[], edges: StageEdgeInput[]): boolean {
  const slots = computeAttachmentSlots(nodes, edges);
  const attached = attachedNodeIds(slots);
  const half = ORBIT.hubSize / 2;
  const hubs = nodes
    .filter((node) => isHubEntry(slots[node.id]) && !attached.has(node.id) && node.position)
    .map((node) => ({
      id: node.id,
      cx: node.position!.x + half,
      cy: node.position!.y + half,
      reach: hubReach(node.id, slots)
    }));
  if (hubs.length === 0) return false;

  const others = nodes.filter((node) => !isHubEntry(slots[node.id]) && !attached.has(node.id) && nodeTypeOf(node) !== "sticky_note" && node.position);
  for (const hub of hubs) {
    for (const node of others) {
      const left = node.position!.x;
      const top = node.position!.y;
      const right = left + ORBIT.cardWidth;
      const bottom = top + ORBIT.cardHeight;
      const nearestX = Math.max(left, Math.min(hub.cx, right));
      const nearestY = Math.max(top, Math.min(hub.cy, bottom));
      if (Math.hypot(hub.cx - nearestX, hub.cy - nearestY) < hub.reach) return true;
    }
  }
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      const a = hubs[i]!;
      const b = hubs[j]!;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.reach + b.reach) return true;
    }
  }
  return false;
}

/** True when the workflow has no usable positions (all nodes at one point / missing). */
export function hasUsablePositions(nodes: StageNodeInput[]): boolean {
  if (nodes.length < 2) return true;
  const first = nodes[0]!.position;
  if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.y)) return false;
  return nodes.some((node) => {
    const p = node.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    return Math.abs(p.x - first.x) > 1 || Math.abs(p.y - first.y) > 1;
  });
}

// ---------------------------------------------------------------------------
// Node summaries — one mono line per node type.
// ---------------------------------------------------------------------------

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, max = 36): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function join(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

function temp(config: Record<string, unknown>): string | null {
  return typeof config.temperature === "number" ? `t=${config.temperature}` : null;
}

export function summarizeNode(node: { type: string; config?: unknown }): string {
  const c = rec(node.config);
  const provider = rec(c.provider);
  switch (node.type) {
    case "llm_call":
      return join([str(provider.providerId), str(provider.model), temp(provider)]) || "model not set";
    case "openai_chat_model":
      return join(["openai", str(c.model), temp(c)]);
    case "anthropic_chat_model":
      return join(["anthropic", str(c.model), temp(c)]);
    case "ollama_chat_model":
      return join(["ollama", str(c.model), temp(c)]);
    case "openai_compatible_chat_model":
      return join(["openai-compatible", str(c.model), temp(c)]);
    case "ai_gateway_chat_model":
      return join(["gateway", str(c.model), temp(c)]);
    case "azure_openai_chat_model":
      return join(["azure", str(c.deployment), temp(c)]);
    case "google_gemini_chat_model":
      return join(["gemini", str(c.model), temp(c)]);
    case "agent_orchestrator":
      return join([str(c.agentType) ?? "tools", typeof c.maxIterations === "number" ? `max ${c.maxIterations} iter` : null]);
    case "supervisor_node":
      return join(["supervisor", typeof c.maxIterations === "number" ? `max ${c.maxIterations} iter` : null]);
    case "mcp_tool":
      return join([str(c.serverId), str(c.toolName)]) || "no tool selected";
    case "local_memory":
      return join([`ns ${str(c.namespace) ?? "default"}`, typeof c.maxMessages === "number" ? `${c.maxMessages} msgs` : null]);
    case "http_request":
      return join([str(c.method) ?? "GET", str(c.urlTemplate ?? c.url, 48)]);
    case "web_browse":
      return join(["chromium", str(c.urlTemplate ?? c.url, 48)]);
    case "code_node":
      return join(["js", typeof c.timeout === "number" ? `${c.timeout}ms` : null, str(c.code, 40)]);
    case "python_code":
      return join(["python", str(c.code, 40)]);
    case "webhook_input":
      return join([str(c.method) ?? "POST", c.path ? `/webhook/${String(c.path)}` : null, str(c.authMode) ? `auth ${String(c.authMode)}` : null]);
    case "webhook_response":
      return join([typeof c.statusCode === "number" ? `status ${c.statusCode}` : null, str(c.bodyTemplate, 40)]);
    case "schedule_trigger":
      return join([str(c.cronExpression ?? c.cron), str(c.timezone)]);
    case "form_trigger":
    case "chat_trigger":
      return join([c.path ? `/${String(c.path)}` : null, str(c.authMode)]);
    case "text_input":
    case "system_prompt":
    case "user_prompt":
      return str(c.text, 56) ?? "empty";
    case "prompt_template":
      return join([str(c.template, 44), c.outputKey ? `→ ${String(c.outputKey)}` : null]);
    case "if_node":
      return str(c.condition, 48) ?? "no condition";
    case "switch_node": {
      const cases = Array.isArray(c.cases) ? c.cases.length : 0;
      return join([str(c.switchValue, 32), `${cases} case${cases === 1 ? "" : "s"}`]);
    }
    case "try_catch":
      return "try → catch";
    case "chat_intent_router":
      return join(["report | code | message", str(c.inputTemplate, 24)]);
    case "loop_node":
      return join([str(c.itemsKey ?? c.itemsTemplate ?? c.listKey, 32), typeof c.maxIterations === "number" ? `max ${c.maxIterations}` : null]) || "loop";
    case "wait_node":
      return join([str(c.resumeMode), typeof c.delayMs === "number" ? `${c.delayMs}ms` : null]);
    case "merge_node":
      return join([str(c.mode), c.combineKey ? `key ${String(c.combineKey)}` : null]);
    case "set_node": {
      const n = Array.isArray(c.assignments) ? c.assignments.length : 0;
      return `${n} assignment${n === 1 ? "" : "s"}`;
    }
    case "rag_retrieve":
      return join([typeof c.topK === "number" ? `top ${c.topK}` : null, str(c.vectorStoreId), str(c.queryTemplate, 24)]);
    case "qdrant_vector_store":
      return join([str(c.operation), str(c.collectionName), typeof c.topK === "number" ? `top ${c.topK}` : null]);
    case "document_chunker":
      return join([typeof c.chunkSize === "number" ? `${c.chunkSize} chars` : null, typeof c.chunkOverlap === "number" ? `overlap ${c.chunkOverlap}` : null, str(c.strategy)]);
    case "output_parser":
      return join([str(c.mode), str(c.parsingMode), typeof c.maxRetries === "number" ? `retries ${c.maxRetries}` : null]);
    case "output_guardrail":
      return join([Array.isArray(c.checks) ? c.checks.map(String).join(", ") : null, str(c.onFail) ? `on fail ${String(c.onFail)}` : null]);
    case "guard":
      return join([
        !c.profileId || c.profileId === "effective" ? "effective profile" : `profile ${String(c.profileId)}`,
        str(c.channel) ?? "prompt",
        c.inputField && c.inputField !== "user_prompt" ? `field ${String(c.inputField)}` : null
      ]);
    case "guard_protection":
      return join([str(c.providerId) ?? "mask", Array.isArray(c.dataClasses) ? c.dataClasses.map(String).join(", ") : "all classes"]);
    case "input_validator": {
      const n = Array.isArray(c.rules) ? c.rules.length : 0;
      return join([`${n} rule${n === 1 ? "" : "s"}`, str(c.onFail) ? `on fail ${String(c.onFail)}` : null]);
    }
    case "human_approval":
      return join([str(c.approvalMessage, 36), typeof c.timeoutMinutes === "number" ? `${c.timeoutMinutes} min` : null]);
    case "execute_workflow":
      return join([str(c.workflowId, 24) ?? "no workflow", str(c.mode)]);
    case "output":
      return join([str(c.responseTemplate, 36), c.outputKey ? `→ ${String(c.outputKey)}` : null]);
    case "helper_chat_response":
      return join([str(c.codeLanguage), c.outputKey ? `→ ${String(c.outputKey)}` : null]);
    case "pdf_output":
      return join([str(c.renderMode) ? `${String(c.renderMode)} render` : null, str(c.inputKey)]);
    case "chart_node":
      return join([str(c.chartType ?? c.mark), str(c.title, 28)]);
    case "sticky_note":
      return str(c.content, 48) ?? "note";
    default: {
      const keys = Object.keys(c).filter((key) => {
        const v = c[key];
        return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
      });
      const parts = keys.slice(0, 2).map((key) => `${key} ${str(c[key], 20)}`);
      return parts.length ? parts.join(" · ") : node.type.replace(/_/g, " ");
    }
  }
}
