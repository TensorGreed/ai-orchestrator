import { describe, expect, it } from "vitest";
import { buildTemplateThumbnail } from "./template-thumbnail";

function makeWorkflow(nodes: Array<{ id: string; type: string; x: number; y: number }>, edges: Array<{ source: string; target: string }> = []) {
  return {
    schemaVersion: "1.0.0",
    workflow: {
      id: "wf-test",
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.id,
        position: { x: n.x, y: n.y },
        config: {}
      })),
      edges: edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target }))
    }
  };
}

describe("buildTemplateThumbnail", () => {
  it("returns empty string when the workflow has no nodes", () => {
    expect(buildTemplateThumbnail(makeWorkflow([]))).toBe("");
    expect(buildTemplateThumbnail({})).toBe("");
    expect(buildTemplateThumbnail(null)).toBe("");
  });

  it("emits a top-level <svg> with viewBox 320×96", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow([{ id: "n1", type: "text_input", x: 0, y: 0 }])
    );
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('viewBox="0 0 320 96"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/<\/svg>$/);
  });

  it("renders one <rect> per node with the node id and type as a tooltip", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow([
        { id: "n1", type: "text_input", x: 0, y: 0 },
        { id: "n2", type: "output", x: 100, y: 100 }
      ])
    );
    const rectMatches = svg.match(/<rect [^/]*\/?>?/g) ?? [];
    // Background rect + 2 node rects = 3 total
    expect(rectMatches.length).toBe(3);
    expect(svg).toContain("<title>n1 (text_input)</title>");
    expect(svg).toContain("<title>n2 (output)</title>");
  });

  it("renders one <line> per edge between known nodes", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow(
        [
          { id: "a", type: "text_input", x: 0, y: 0 },
          { id: "b", type: "llm_call", x: 200, y: 0 },
          { id: "c", type: "output", x: 400, y: 0 }
        ],
        [
          { source: "a", target: "b" },
          { source: "b", target: "c" }
        ]
      )
    );
    const lineMatches = svg.match(/<line /g) ?? [];
    expect(lineMatches.length).toBe(2);
  });

  it("ignores edges that reference unknown nodes", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow(
        [{ id: "a", type: "text_input", x: 0, y: 0 }],
        [{ source: "a", target: "ghost" }]
      )
    );
    expect(svg).not.toContain("<line ");
  });

  it("colours trigger-shaped node types differently from defaults", () => {
    const triggerSvg = buildTemplateThumbnail(
      makeWorkflow([{ id: "t", type: "webhook_input", x: 0, y: 0 }])
    );
    const plainSvg = buildTemplateThumbnail(
      makeWorkflow([{ id: "p", type: "text_input", x: 0, y: 0 }])
    );
    // Different fills for trigger vs plain — exact colour values per the palette in the module.
    expect(triggerSvg).toContain("#fbf5e8");
    expect(plainSvg).toContain("#dceaf6");
  });

  it("colours agent_orchestrator with the agent palette", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow([{ id: "a", type: "agent_orchestrator", x: 0, y: 0 }])
    );
    expect(svg).toContain("#f3eefa"); // agent fill
    expect(svg).toContain("#9b6dd8"); // agent stroke
  });

  it("colours mcp_tool with the mcp palette", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow([{ id: "m", type: "mcp_tool", x: 0, y: 0 }])
    );
    expect(svg).toContain("#ecf7f0"); // mcp fill
    expect(svg).toContain("#5cb888"); // mcp stroke
  });

  it("escapes special chars in node ids inside the title tag", () => {
    const svg = buildTemplateThumbnail(
      makeWorkflow([{ id: "<script>alert(1)</script>", type: "text_input", x: 0, y: 0 }])
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("scales nodes to fit the viewport regardless of input position range", () => {
    // Far-apart positions should still produce in-bounds rects.
    const svg = buildTemplateThumbnail(
      makeWorkflow([
        { id: "a", type: "text_input", x: -5000, y: -5000 },
        { id: "b", type: "output", x: 99999, y: 99999 }
      ])
    );
    // Both nodes should be inside the viewport with sane x,y values (no negatives, no >320).
    const rectXs = [...svg.matchAll(/<rect x="(-?\d+\.\d+)" y="(-?\d+\.\d+)" width="18"/g)].map(
      (m) => Number(m[1])
    );
    for (const x of rectXs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(320 - 18);
    }
  });
});
