/**
 * Generates one recipe page per sample workflow listed in apps/docs/recipes.config.json:
 *
 *   pnpm --filter @ai-orchestrator/docs gen:recipes   (the docs build and dev server run it)
 *
 * Output:
 *   docs/recipes/<slug>.md                 the page: summary, a diagram of the nodes and edges
 *                                          (inline SVG, no scripts), the nodes with links to the node
 *                                          reference, how to import it, further reading
 *   docs/public/recipes/files/<sample>     the workflow JSON to download, at /docs/recipes/files/<sample>
 *
 * A sample that the live demo also carries (apps/web/src/demo/fixtures/workflows.json) gets an
 * "Open in the demo" link, and plays its recorded run when the demo has one (fixtures/runs.json).
 * Recipe pages that are no longer in the config are removed. The generated pages carry a
 * "DO NOT EDIT BY HAND" banner: change the config or the sample instead.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDefinitions } from "@ai-orchestrator/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_APP = path.resolve(here, "..");
const REPO = path.resolve(DOCS_APP, "..", "..");
const CONFIG = path.join(DOCS_APP, "recipes.config.json");
const SAMPLES = path.join(REPO, "samples", "workflows");
const OUT_DIR = path.join(DOCS_APP, "docs", "recipes");
const FILES_DIR = path.join(DOCS_APP, "docs", "public", "recipes", "files");
const DEMO_FIXTURES = path.join(REPO, "apps", "web", "src", "demo", "fixtures");

const PORTS = new Set(["chat_model", "memory", "tool", "worker"]);
const PORT_LABELS: Record<string, string> = { chat_model: "chat model", memory: "memory", tool: "tool", worker: "worker" };

export interface RecipeConfig {
  sample: string;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  summary: string;
  related?: string[];
  docs?: Array<{ text: string; link: string }>;
}

interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  position?: { x: number; y: number };
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** The same slugs VitePress gives headings (@mdit-vue/shared), so links can name a node's section. */
export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}

/** The node reference page and section for a node type, or null when the type has no definition. */
export function referenceLink(type: string): string | null {
  const definition = nodeDefinitions.find((node) => node.type === type);
  if (!definition) return null;
  const page = definition.category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `/nodes/reference/${page}#${headingSlug(`${definition.type} — ${definition.label}`)}`;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Text for Markdown tables and Vue templates: no pipes, no mustaches. */
const escapeMd = (value: string) => value.replace(/\|/g, "\\|").replace(/\{\{/g, "{ {").replace(/</g, "&lt;");

function kindOf(type: string): string {
  if (type === "agent_orchestrator" || type === "supervisor_node") return "agent";
  if (type === "llm_call" || type.endsWith("_chat_model")) return "model";
  if (type === "mcp_tool" || type === "workflow_tool") return "tool";
  if (type === "local_memory") return "memory";
  return "step";
}

const isPortEdge = (edge: WorkflowEdge) => edge.sourceHandle !== undefined && PORTS.has(edge.sourceHandle);

/** DAG nodes in run order (Kahn), ignoring attachment edges. */
export function runOrder(workflow: Workflow): WorkflowNode[] {
  const attached = new Set(workflow.edges.filter(isPortEdge).map((edge) => edge.target));
  const nodes = workflow.nodes.filter((node) => !attached.has(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  const edges = workflow.edges.filter((edge) => !isPortEdge(edge) && ids.has(edge.source) && ids.has(edge.target));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  const queue = nodes.filter((node) => incoming.get(node.id) === 0);
  const order: WorkflowNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const edge of edges.filter((item) => item.source === node.id)) {
      incoming.set(edge.target, incoming.get(edge.target)! - 1);
      if (incoming.get(edge.target) === 0) queue.push(nodes.find((item) => item.id === edge.target)!);
    }
  }
  return order.length === nodes.length ? order : nodes;
}

const BOX_W = 190;
const BOX_H = 54;
const PAD = 24;

const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The workflow as an inline SVG: run-order edges solid with arrows, attachment edges dashed. */
export function diagramSvg(workflow: Workflow, titleId: string): string {
  const nodes = workflow.nodes.map((node, index) => ({ ...node, x: node.position?.x ?? index * 240, y: node.position?.y ?? 0 }));
  const minX = Math.min(...nodes.map((node) => node.x)) - PAD;
  const minY = Math.min(...nodes.map((node) => node.y)) - PAD;
  const width = Math.max(...nodes.map((node) => node.x)) + BOX_W + PAD - minX;
  const height = Math.max(...nodes.map((node) => node.y)) + BOX_H + PAD - minY;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const names = (id: string) => byId.get(id)?.name ?? id;

  const edges = workflow.edges
    .map((edge) => {
      const from = byId.get(edge.source);
      const to = byId.get(edge.target);
      if (!from || !to) return "";
      if (isPortEdge(edge)) {
        const below = to.y >= from.y + BOX_H;
        const above = to.y + BOX_H <= from.y;
        const [x1, y1] = below ? [from.x + BOX_W / 2, from.y + BOX_H] : above ? [from.x + BOX_W / 2, from.y] : [from.x + BOX_W, from.y + BOX_H / 2];
        const [x2, y2] = below ? [to.x + BOX_W / 2, to.y] : above ? [to.x + BOX_W / 2, to.y + BOX_H] : [to.x, to.y + BOX_H / 2];
        const bend = below || above ? `C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}` : `C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`;
        return `<path class="rd-edge is-port" d="M${x1} ${y1} ${bend}"/>`;
      }
      const x1 = from.x + BOX_W;
      const y1 = from.y + BOX_H / 2;
      const x2 = to.x - 2;
      const y2 = to.y + BOX_H / 2;
      const mid = (x1 + x2) / 2;
      return `<path class="rd-edge" d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" marker-end="url(#${titleId}-arrow)"/>`;
    })
    .join("");

  const boxes = nodes
    .map(
      (node) =>
        `<g class="rd-node" data-kind="${kindOf(node.type)}" transform="translate(${node.x} ${node.y})"><title>${escapeXml(`${node.name} (${node.type})`)}</title>` +
        `<rect width="${BOX_W}" height="${BOX_H}" rx="10"/>` +
        `<text class="rd-name" x="12" y="22">${escapeXml(truncate(node.name, 24))}</text>` +
        `<text class="rd-type" x="12" y="40">${escapeXml(truncate(node.type, 26))}</text></g>`
    )
    .join("");

  const steps = runOrder(workflow).map((node) => node.name).join(", then ");
  const attachments = workflow.edges
    .filter(isPortEdge)
    .map((edge) => `${names(edge.target)} is attached to ${names(edge.source)} as its ${PORT_LABELS[edge.sourceHandle!]}`)
    .join("; ");
  const description = `Runs ${steps}.${attachments ? ` ${attachments}.` : ""}`;

  return (
    `<svg viewBox="${minX} ${minY} ${width} ${height}" role="img" aria-labelledby="${titleId}-title ${titleId}-desc" xmlns="http://www.w3.org/2000/svg">` +
    `<title id="${titleId}-title">${escapeXml(`Diagram of the ${workflow.name} workflow`)}</title>` +
    `<desc id="${titleId}-desc">${escapeXml(description)}</desc>` +
    `<defs><marker id="${titleId}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="rd-arrow" d="M0 0 L10 5 L0 10 z"/></marker></defs>` +
    edges +
    boxes +
    "</svg>"
  );
}

function roleOf(node: WorkflowNode, workflow: Workflow): string {
  const edge = workflow.edges.find((item) => item.target === node.id && isPortEdge(item));
  if (!edge) return "Step in the run";
  const owner = workflow.nodes.find((item) => item.id === edge.source);
  return `Attached to ${escapeMd(owner?.name ?? edge.source)} on its \`${edge.sourceHandle}\` port`;
}

export interface DemoSupport {
  workflows: Set<string>;
  recorded: Set<string>;
}

export function readDemoSupport(dir = DEMO_FIXTURES): DemoSupport {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
  const workflows = new Set<string>();
  const recorded = new Set<string>();
  try {
    const fixtures = read("workflows.json") as { workflows?: unknown };
    const list = Array.isArray(fixtures.workflows) ? fixtures.workflows : Object.values(fixtures.workflows ?? {});
    for (const item of list as Array<Record<string, unknown>>) {
      const workflow = (item.workflow ?? item) as { id?: unknown };
      if (typeof workflow.id === "string") workflows.add(workflow.id);
    }
    for (const id of Object.keys(read("runs.json"))) recorded.add(id);
  } catch (error) {
    console.warn(`[recipes] could not read the demo fixtures (${(error as Error).message}); no recipe links to the demo`);
  }
  return { workflows, recorded };
}

export function renderRecipe(recipe: RecipeConfig, workflow: Workflow, demo: DemoSupport): string {
  const inDemo = demo.workflows.has(workflow.id);
  const recorded = inDemo && demo.recorded.has(workflow.id);
  const fm = [
    "---",
    `title: ${JSON.stringify(recipe.title)}`,
    `description: ${JSON.stringify(recipe.description)}`,
    `tags: ${JSON.stringify(recipe.tags)}`,
    `nodeCount: ${workflow.nodes.length}`,
    `sample: ${JSON.stringify(recipe.sample)}`,
    ...(inDemo ? [`demo: ${JSON.stringify(workflow.id)}`, `demoRecorded: ${recorded}`] : []),
    ...(recipe.related && recipe.related.length > 0 ? [`related: ${JSON.stringify(recipe.related)}`] : []),
    "---",
    ""
  ];

  const download = `/docs/recipes/files/${recipe.sample}`;
  const demoUrl = `/demo/?${new URLSearchParams({ mode: "editor", workflowId: workflow.id, ...(recorded ? { demoRun: "recorded" } : {}) }).toString()}`;
  const nodes = [...workflow.nodes].sort((a, b) => {
    const order = runOrder(workflow).map((node) => node.id);
    const rank = (node: WorkflowNode) => (order.includes(node.id) ? order.indexOf(node.id) : order.length);
    return rank(a) - rank(b);
  });
  const types = [...new Set(workflow.nodes.map((node) => node.type))];

  const lines = [
    ...fm,
    "<!--",
    `  Generated from samples/workflows/${recipe.sample} and apps/docs/recipes.config.json.`,
    "  DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes` (or `pnpm docs:build`).",
    "-->",
    "",
    `# ${recipe.title}`,
    "",
    recipe.summary,
    "",
    '<div class="recipe-actions">',
    `  <a class="hub-button" href="${download}" download>Download the workflow JSON</a>`,
    ...(inDemo ? [`  <a class="hub-button hub-button-quiet" href="${demoUrl}" target="_self">${recorded ? "Open it in the demo and play a run" : "Open it in the demo"}</a>`] : []),
    "</div>",
    "",
    "## Workflow",
    "",
    '<figure class="recipe-diagram">',
    diagramSvg(workflow, `rd-${recipe.slug}`),
    "<figcaption>Solid arrows are the order the steps run in. Dashed lines attach a chat model, memory, tools or workers to an agent; the agent uses them while it runs.</figcaption>",
    "</figure>",
    "",
    "## Nodes",
    "",
    "| Node | Type | Role |",
    "| --- | --- | --- |",
    ...nodes.map((node) => {
      const link = referenceLink(node.type);
      const type = link ? `[\`${node.type}\`](${link})` : `\`${node.type}\``;
      return `| ${escapeMd(node.name)} | ${type} | ${roleOf(node, workflow)} |`;
    }),
    "",
    `${types.length} node types. Each type links to its config fields in the [node reference](/nodes/reference/).`,
    "",
    "## Use it",
    "",
    `1. Download <a href="${download}" download>${recipe.sample}</a>.`,
    "2. Import it in the studio's workflow editor (see [import and export](/product/workflow-editor)).",
    "3. Run it as it is, then change one node at a time: a real chat model, your own MCP server, your own prompts.",
    ""
  ];
  if (recipe.docs && recipe.docs.length > 0) {
    lines.push("## Further reading", "", ...recipe.docs.map((doc) => `- [${doc.text}](${doc.link})`), "");
  }
  return lines.join("\n");
}

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as { recipes: RecipeConfig[] };
  const demo = readDemoSupport();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const slugs = new Set<string>();
  for (const recipe of config.recipes) {
    if (!/^[a-z0-9-]+$/.test(recipe.slug) || recipe.slug === "index") throw new Error(`[recipes] bad slug "${recipe.slug}"`);
    if (slugs.has(recipe.slug)) throw new Error(`[recipes] slug "${recipe.slug}" is used twice`);
    slugs.add(recipe.slug);
    const source = path.join(SAMPLES, recipe.sample);
    if (!fs.existsSync(source)) throw new Error(`[recipes] ${recipe.sample} is not in samples/workflows/`);
    const raw = fs.readFileSync(source, "utf8");
    const parsed = JSON.parse(raw) as { workflow?: Workflow } & Workflow;
    const workflow = parsed.workflow ?? parsed;
    fs.writeFileSync(path.join(OUT_DIR, `${recipe.slug}.md`), renderRecipe(recipe, workflow, demo));
    fs.copyFileSync(source, path.join(FILES_DIR, recipe.sample));
    console.log(`  recipes/${recipe.slug}.md from ${recipe.sample}${demo.workflows.has(workflow.id) ? " (in the demo)" : ""}`);
  }
  // Remove pages and files of recipes that left the config.
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file.endsWith(".md") && file !== "index.md" && !slugs.has(file.slice(0, -3))) {
      const text = fs.readFileSync(path.join(OUT_DIR, file), "utf8");
      if (text.includes("DO NOT EDIT BY HAND: run `pnpm --filter @ai-orchestrator/docs gen:recipes`")) fs.rmSync(path.join(OUT_DIR, file));
    }
  }
  const samples = new Set(config.recipes.map((recipe) => recipe.sample));
  for (const file of fs.readdirSync(FILES_DIR)) if (!samples.has(file)) fs.rmSync(path.join(FILES_DIR, file));
  console.log(`\nWrote ${config.recipes.length} recipe page(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
