/**
 * Generate a tiny bird's-eye SVG thumbnail of a workflow from its node
 * positions + edges. Used in the Template Gallery so cards become visual
 * without requiring a headless browser at build time.
 *
 * Trade-offs vs a real canvas screenshot:
 *   + Zero deps, zero build-time tooling.
 *   + Deterministic — same workflow JSON always renders the same SVG.
 *   + Themeable via CSS (we control the colour palette here).
 *   - Stylised, not pixel-perfect: nodes become colored rounded rects, not
 *     the full canvas card chrome. That's fine — the goal is "this template
 *     has 5 nodes in a roughly linear shape", not "show me the canvas".
 */

const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 96;
const NODE_WIDTH = 18;
const NODE_HEIGHT = 12;
const PADDING = 12;
const EDGE_STROKE = "#c8d3e0";
const NODE_FILL = "#dceaf6";
const NODE_STROKE = "#7aa2c2";
const TRIGGER_FILL = "#fbf5e8";
const TRIGGER_STROKE = "#d4a657";
const AGENT_FILL = "#f3eefa";
const AGENT_STROKE = "#9b6dd8";
const MCP_FILL = "#ecf7f0";
const MCP_STROKE = "#5cb888";
const OUTPUT_FILL = "#eef3fb";
const OUTPUT_STROKE = "#5b8ad6";

interface NodeShape {
  id: string;
  x: number;
  y: number;
  type: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unwrapWorkflow(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw);
  if (root.workflow && typeof root.workflow === "object") {
    return asRecord(root.workflow);
  }
  return root;
}

function colorForNode(type: string): { fill: string; stroke: string } {
  if (type.includes("trigger") || type.includes("webhook_input") || type === "manual_trigger") {
    return { fill: TRIGGER_FILL, stroke: TRIGGER_STROKE };
  }
  if (type === "agent_orchestrator" || type === "agent_supervisor" || type === "supervisor_node") {
    return { fill: AGENT_FILL, stroke: AGENT_STROKE };
  }
  if (type === "mcp_tool" || type === "mcp_server_trigger") {
    return { fill: MCP_FILL, stroke: MCP_STROKE };
  }
  if (type === "output" || type === "webhook_response" || type === "helper_chat_response") {
    return { fill: OUTPUT_FILL, stroke: OUTPUT_STROKE };
  }
  return { fill: NODE_FILL, stroke: NODE_STROKE };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Returns an SVG string sized to VIEWPORT_WIDTH × VIEWPORT_HEIGHT showing
 * a normalized layout of the workflow's nodes and edges. Intended to be
 * embedded inline in the Template Gallery card via `dangerouslySetInnerHTML`
 * (the SVG is generated server-side from a workflow we control, no XSS risk).
 *
 * Returns an empty string if there are no nodes — the gallery card hides
 * the thumbnail slot in that case.
 */
export function buildTemplateThumbnail(rawWorkflow: unknown): string {
  const workflow = unwrapWorkflow(rawWorkflow);
  const rawNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const rawEdges = Array.isArray(workflow.edges) ? workflow.edges : [];

  const nodes: NodeShape[] = [];
  for (const raw of rawNodes) {
    const obj = asRecord(raw);
    const id = String(obj.id ?? "");
    const type = String(obj.type ?? "");
    const position = asRecord(obj.position);
    const x = Number(position.x);
    const y = Number(position.y);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    nodes.push({ id, x, y, type });
  }

  if (nodes.length === 0) return "";

  // Compute bounding box, then scale node positions to fit inside the
  // viewport (with padding so nodes near the edge aren't clipped).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const innerW = VIEWPORT_WIDTH - 2 * PADDING - NODE_WIDTH;
  const innerH = VIEWPORT_HEIGHT - 2 * PADDING - NODE_HEIGHT;

  const positioned = new Map<string, { cx: number; cy: number; type: string }>();
  for (const n of nodes) {
    const nx = PADDING + ((n.x - minX) / spanX) * innerW;
    const ny = PADDING + ((n.y - minY) / spanY) * innerH;
    positioned.set(n.id, { cx: nx + NODE_WIDTH / 2, cy: ny + NODE_HEIGHT / 2, type: n.type });
  }

  // Edges first so node rects render on top.
  const edgeLines: string[] = [];
  for (const raw of rawEdges) {
    const obj = asRecord(raw);
    const source = String(obj.source ?? "");
    const target = String(obj.target ?? "");
    const a = positioned.get(source);
    const b = positioned.get(target);
    if (!a || !b) continue;
    edgeLines.push(
      `<line x1="${a.cx.toFixed(1)}" y1="${a.cy.toFixed(1)}" x2="${b.cx.toFixed(1)}" y2="${b.cy.toFixed(1)}" stroke="${EDGE_STROKE}" stroke-width="1" />`
    );
  }

  const nodeRects: string[] = [];
  for (const [id, pos] of positioned.entries()) {
    const colors = colorForNode(pos.type);
    const x = (pos.cx - NODE_WIDTH / 2).toFixed(1);
    const y = (pos.cy - NODE_HEIGHT / 2).toFixed(1);
    nodeRects.push(
      `<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="3" ry="3" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1"><title>${escapeAttribute(id)} (${escapeAttribute(pos.type)})</title></rect>`
    );
  }

  return [
    `<svg viewBox="0 0 ${VIEWPORT_WIDTH} ${VIEWPORT_HEIGHT}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Workflow preview">`,
    `<rect width="${VIEWPORT_WIDTH}" height="${VIEWPORT_HEIGHT}" fill="#f7fafc" rx="6" ry="6" />`,
    edgeLines.join(""),
    nodeRects.join(""),
    `</svg>`
  ].join("");
}
