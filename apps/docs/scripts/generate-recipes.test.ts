import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  diagramSvg,
  headingSlug,
  readDemoSupport,
  referenceLink,
  renderRecipe,
  runOrder,
  validateRecipes,
  type DemoSupport,
  type RecipeConfig,
  type Workflow
} from "./generate-recipes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const SAMPLES = path.join(REPO, "samples", "workflows");

const loadSample = (file: string): Workflow => {
  const parsed = JSON.parse(fs.readFileSync(path.join(SAMPLES, file), "utf8")) as { workflow?: Workflow } & Workflow;
  return parsed.workflow ?? parsed;
};

// A supervisor with one worker; the worker has its own model and tool. Attachment edges carry a port name.
const swarm: Workflow = {
  id: "wf-test-swarm",
  name: "Test swarm",
  nodes: [
    { id: "trigger", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 } },
    { id: "boss", type: "supervisor_node", name: "Supervisor", position: { x: 240, y: 0 } },
    { id: "boss_model", type: "llm_call", name: "Boss model", position: { x: 240, y: 120 } },
    { id: "worker", type: "agent_orchestrator", name: "Researcher", position: { x: 480, y: 120 } },
    { id: "worker_tool", type: "mcp_tool", name: "Search tool", position: { x: 480, y: 240 } },
    { id: "out", type: "output", name: "Answer", position: { x: 480, y: 0 } }
  ],
  edges: [
    { id: "e1", source: "trigger", target: "boss" },
    { id: "e2", source: "boss", target: "out" },
    { id: "e3", source: "boss", target: "boss_model", sourceHandle: "chat_model" },
    { id: "e4", source: "boss", target: "worker", sourceHandle: "worker" },
    { id: "e5", source: "worker", target: "worker_tool", sourceHandle: "tool" }
  ]
};

const recipe: RecipeConfig = {
  sample: "test-flow.json",
  slug: "test-recipe",
  title: "A test recipe",
  description: "A recipe used by the generator's tests.",
  keys: "none",
  keysNote: "No API key",
  time: "5 minutes",
  tags: ["agent"],
  whatYouGet: "A supervisor and one worker.",
  summary: "Runs a supervisor that delegates to a worker."
};

const noDemo: DemoSupport = { workflows: new Set(), recorded: new Set() };

describe("headingSlug", () => {
  it("matches the anchors VitePress gives headings", () => {
    expect(headingSlug("Read-only classification")).toBe("read-only-classification");
    expect(headingSlug("What counts as a breaking change?")).toBe("what-counts-as-a-breaking-change");
    expect(headingSlug("mcp_tool — MCP Tool")).toBe("mcp-tool-—-mcp-tool");
    expect(headingSlug("4. Get and inspect the SBOMs")).toBe("_4-get-and-inspect-the-sboms");
    expect(headingSlug("Café  (beta)")).toBe("cafe-beta");
  });
});

describe("referenceLink", () => {
  it("links a known node type to its category page and section", () => {
    const link = referenceLink("mcp_tool");
    expect(link).toMatch(/^\/nodes\/reference\/[a-z0-9-]+#mcp-tool-/);
  });

  it("returns null for a type with no definition", () => {
    expect(referenceLink("no_such_node_type")).toBeNull();
  });
});

describe("runOrder", () => {
  it("orders DAG steps and leaves out nodes attached through ports", () => {
    expect(runOrder(swarm).map((node) => node.id)).toEqual(["trigger", "boss", "out"]);
  });

  it("falls back to the declared order when the graph has a cycle", () => {
    const cyclic: Workflow = {
      id: "wf-cycle",
      name: "Cycle",
      nodes: [
        { id: "a", type: "output", name: "A" },
        { id: "b", type: "output", name: "B" }
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "ba", source: "b", target: "a" }
      ]
    };
    expect(runOrder(cyclic).map((node) => node.id)).toEqual(["a", "b"]);
  });

  it("runs the real supervisor sample from its trigger to its output", () => {
    const order = runOrder(loadSample("supervisor-worker-swarm-flow.json")).map((node) => node.type);
    expect(order[0]).toBe("manual_trigger");
    expect(order.at(-1)).toBe("output");
    expect(order).not.toContain("llm_call");
    expect(order).not.toContain("mcp_tool");
  });
});

describe("diagramSvg", () => {
  const svg = diagramSvg(swarm, "rd-test");

  it("draws one box per node and one path per edge", () => {
    expect(svg.match(/<g class="rd-node"/g)).toHaveLength(swarm.nodes.length);
    expect(svg.match(/<path class="rd-edge/g)).toHaveLength(swarm.edges.length);
  });

  it("dashes attachment edges and gives only DAG edges an arrow", () => {
    expect(svg.match(/class="rd-edge is-port"/g)).toHaveLength(3);
    expect(svg.match(/marker-end="url\(#rd-test-arrow\)"/g)).toHaveLength(2);
  });

  it("is accessible: a title and a description that reads the run order and the attachments", () => {
    expect(svg).toContain('aria-labelledby="rd-test-title rd-test-desc"');
    expect(svg).toContain("Diagram of the Test swarm workflow");
    expect(svg).toContain("Runs Start, then Supervisor, then Answer.");
    expect(svg).toContain("Researcher is attached to Supervisor as its worker");
    expect(svg).toContain("Search tool is attached to Researcher as its tool");
  });

  it("escapes markup in node names", () => {
    const named: Workflow = { ...swarm, nodes: swarm.nodes.map((node) => (node.id === "out" ? { ...node, name: "<b>&\"x\"" } : node)) };
    const out = diagramSvg(named, "rd-esc");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;b&gt;&amp;&quot;x&quot;");
  });

  it("places nodes without a position in a row instead of failing", () => {
    const unplaced: Workflow = { ...swarm, nodes: swarm.nodes.map(({ position: _position, ...node }) => node) };
    expect(diagramSvg(unplaced, "rd-row")).toMatch(/^<svg viewBox="-24 -24 /);
  });
});

describe("renderRecipe", () => {
  it("writes the frontmatter the recipes index reads", () => {
    const page = renderRecipe({ ...recipe, related: ["supervisor-agent"] }, swarm, noDemo);
    expect(page.startsWith("---\n")).toBe(true);
    expect(page).toContain('title: "A test recipe"');
    expect(page).toContain('keys: "none"');
    expect(page).toContain(`nodeCount: ${swarm.nodes.length}`);
    expect(page).toContain('related: ["supervisor-agent"]');
    expect(page).toContain("DO NOT EDIT BY HAND");
  });

  it("has no demo link when the demo does not carry the workflow", () => {
    const page = renderRecipe(recipe, swarm, noDemo);
    expect(page).not.toContain("demo:");
    expect(page).not.toContain("/demo/?");
  });

  it("links the demo, and plays the recorded run only when there is one", () => {
    const listed = renderRecipe(recipe, swarm, { workflows: new Set([swarm.id]), recorded: new Set() });
    expect(listed).toContain(`demo: "${swarm.id}"`);
    expect(listed).toContain("demoRecorded: false");
    expect(listed).toContain("/demo/?mode=editor&amp;workflowId=wf-test-swarm");
    expect(listed).toContain("Open it in the demo<");

    const recorded = renderRecipe(recipe, swarm, { workflows: new Set([swarm.id]), recorded: new Set([swarm.id]) });
    expect(recorded).toContain("demoRecorded: true");
    expect(recorded).toContain("demoRun=recorded");
    expect(recorded).toContain("Open it in the demo and play a run");
  });

  it("lists every node in run order first, with its role", () => {
    const page = renderRecipe(recipe, swarm, noDemo);
    const rows = page.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Node") && !line.startsWith("| ---"));
    expect(rows).toHaveLength(swarm.nodes.length);
    expect(rows.slice(0, 3).map((row) => row.split(" | ")[0].slice(2))).toEqual(["Start", "Supervisor", "Answer"]);
    expect(page).toContain("| Researcher | ");
    expect(page).toContain("Attached to Supervisor on its `worker` port");
  });

  it("uses the default steps unless the config gives its own, numbered after download and import", () => {
    expect(renderRecipe(recipe, swarm, noDemo)).toContain("3. Run it as it is and open the run to see each step.");
    const custom = renderRecipe({ ...recipe, steps: ["Click **Run**.", "Open the run."] }, swarm, noDemo);
    expect(custom).toContain("3. Click **Run**.\n4. Open the run.");
    expect(custom).not.toContain("Run it as it is");
  });

  it("adds the optional sections only when configured, and says safety controls are optional", () => {
    const bare = renderRecipe(recipe, swarm, noDemo);
    expect(bare).not.toContain("## Make it yours");
    expect(bare).not.toContain("## Make it safer");
    expect(bare).not.toContain("## Further reading");

    const full = renderRecipe(
      {
        ...recipe,
        sections: [{ heading: "What a run does", body: "It runs." }],
        makeItYours: "- Swap the model.",
        makeItSafer: "- Require approval.",
        docs: [{ text: "Agent loop", link: "/runtime/agent-loop" }]
      },
      swarm,
      noDemo
    );
    expect(full).toContain("## What a run does\n\nIt runs.");
    expect(full.indexOf("## What a run does")).toBeGreaterThan(full.indexOf("## How it works"));
    expect(full).toContain("## Make it safer\n\nThese controls are optional; the recipe runs without them.");
    expect(full).toContain("- [Agent loop](/runtime/agent-loop)");
  });

  it("escapes node names that would break a Markdown table or a Vue template", () => {
    const tricky: Workflow = { ...swarm, nodes: swarm.nodes.map((node) => (node.id === "out" ? { ...node, name: "A | {{b}} <c>" } : node)) };
    const page = renderRecipe(recipe, tricky, noDemo);
    expect(page).toContain("| A \\| { {b}} &lt;c> |");
  });
});

describe("readDemoSupport", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const fixtures = (files: Record<string, unknown>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipes-test-"));
    dirs.push(dir);
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    return dir;
  };

  it("reads workflow ids from a list or a map, and recorded runs from runs.json", () => {
    const fromList = readDemoSupport(fixtures({ "workflows.json": { workflows: [{ workflow: { id: "wf-a" } }, { id: "wf-b" }] }, "runs.json": { "wf-a": {} } }));
    expect([...fromList.workflows]).toEqual(["wf-a", "wf-b"]);
    expect([...fromList.recorded]).toEqual(["wf-a"]);

    const fromMap = readDemoSupport(fixtures({ "workflows.json": { workflows: { x: { workflow: { id: "wf-c" } } } }, "runs.json": {} }));
    expect([...fromMap.workflows]).toEqual(["wf-c"]);
  });

  it("returns no demo links when the fixtures cannot be read", () => {
    const support = readDemoSupport(fixtures({}));
    expect(support.workflows.size).toBe(0);
    expect(support.recorded.size).toBe(0);
  });

  it("finds the real demo fixtures", () => {
    expect(readDemoSupport().workflows.size).toBeGreaterThan(0);
  });
});

describe("validateRecipes", () => {
  it("accepts the checked-in config", () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(here, "..", "recipes.config.json"), "utf8")) as { recipes: RecipeConfig[] };
    expect(() => validateRecipes(config.recipes)).not.toThrow();
  });

  const sample = "mcp-agent-quickstart-flow.json";
  const ok = { ...recipe, sample };

  it("rejects a bad slug, the reserved slug index, and a repeated slug", () => {
    expect(() => validateRecipes([{ ...ok, slug: "Bad Slug" }])).toThrow(/bad slug/);
    expect(() => validateRecipes([{ ...ok, slug: "index" }])).toThrow(/bad slug/);
    expect(() => validateRecipes([ok, ok])).toThrow(/used twice/);
  });

  it("rejects unknown keys and a sample that is not in samples/workflows", () => {
    expect(() => validateRecipes([{ ...ok, keys: "free" as RecipeConfig["keys"] }])).toThrow(/keys must be/);
    expect(() => validateRecipes([{ ...ok, sample: "missing-flow.json" }])).toThrow(/is not in samples\/workflows/);
  });
});
