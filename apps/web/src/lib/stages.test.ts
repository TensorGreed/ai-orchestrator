import { describe, expect, it } from "vitest";
import {
  ORBIT,
  computeAttachmentSlots,
  computeStages,
  hasOrbitOverlap,
  hasUsablePositions,
  orbitPositions,
  ringGeometry,
  summarizeNode,
  tidyLayout
} from "./stages";

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  config
});

const edge = (source: string, target: string, sourceHandle?: string) => ({ source, target, sourceHandle });

describe("computeStages", () => {
  it("assigns topological depth with parallel branches sharing a stage", () => {
    const nodes = [
      node("trigger", "webhook_input"),
      node("a", "llm_call"),
      node("b", "http_request"),
      node("merge", "merge_node"),
      node("out", "output")
    ];
    const edges = [edge("trigger", "a"), edge("trigger", "b"), edge("a", "merge"), edge("b", "merge"), edge("merge", "out")];
    const result = computeStages(nodes, edges);
    expect(result.stages).toEqual([["trigger"], ["a", "b"], ["merge"], ["out"]]);
    expect(result.depth).toEqual({ trigger: 0, a: 1, b: 1, merge: 2, out: 3 });
    expect(result.preds.merge).toEqual(["a", "b"]);
    expect(result.succs.trigger).toEqual(["a", "b"]);
  });

  it("excludes attached nodes and sticky notes from stages", () => {
    const nodes = [
      node("trigger", "webhook_input"),
      node("agent", "agent_orchestrator"),
      node("model", "openai_chat_model"),
      node("mem", "local_memory"),
      node("tool", "mcp_tool"),
      node("note", "sticky_note"),
      node("out", "output")
    ];
    const edges = [
      edge("trigger", "agent"),
      edge("agent", "model", "chat_model"),
      edge("agent", "mem", "memory"),
      edge("agent", "tool", "tool"),
      edge("agent", "out")
    ];
    const result = computeStages(nodes, edges);
    expect(result.stages).toEqual([["trigger"], ["agent"], ["out"]]);
    expect([...result.attached].sort()).toEqual(["mem", "model", "tool"]);
    expect(result.depth.note).toBeUndefined();
  });

  it("tolerates loop back-edges without infinite recursion", () => {
    const nodes = [node("a", "text_input"), node("loop", "loop_node"), node("body", "code_node")];
    const edges = [edge("a", "loop"), edge("loop", "body"), edge("body", "loop")];
    const result = computeStages(nodes, edges);
    expect(result.stages).toEqual([["a"], ["loop"], ["body"]]);
  });
});

describe("computeAttachmentSlots", () => {
  it("groups attachments per hub port and lists hubs with empty slots", () => {
    const nodes = [
      node("sup", "supervisor_node"),
      node("worker", "agent_orchestrator"),
      node("model", "openai_chat_model"),
      node("tool", "mcp_tool")
    ];
    const edges = [edge("sup", "worker", "worker"), edge("worker", "model", "chat_model"), edge("worker", "tool", "tool")];
    const slots = computeAttachmentSlots(nodes, edges);
    expect(slots.sup).toEqual({ chat_model: [], memory: [], tool: [], worker: ["worker"] });
    expect(slots.worker).toEqual({ chat_model: ["model"], memory: [], tool: ["tool"], worker: [] });
  });
});

describe("orbitPositions", () => {
  const slots = {
    agent: { chat_model: ["model"], memory: ["mem"], tool: ["t1", "t2"], worker: [] }
  };

  it("places the model on top of the inner ring and memory below", () => {
    const hub = { x: 100, y: 100 };
    const positions = orbitPositions("agent", slots, hub);
    const cx = hub.x + ORBIT.hubSize / 2;
    const cy = hub.y + ORBIT.hubSize / 2;
    const s = ORBIT.satelliteSize / 2;
    expect(positions.model).toEqual({ x: Math.round(cx - s), y: Math.round(cy - ORBIT.innerRadius - s) });
    expect(positions.mem).toEqual({ x: Math.round(cx - s), y: Math.round(cy + ORBIT.innerRadius - s) });
  });

  it("is deterministic and keeps tools on the outer ring", () => {
    const a = orbitPositions("agent", slots, { x: 0, y: 0 });
    const b = orbitPositions("agent", slots, { x: 0, y: 0 });
    expect(a).toEqual(b);
    const c = ORBIT.hubSize / 2;
    for (const id of ["t1", "t2"]) {
      const p = a[id]!;
      const dx = p.x + ORBIT.satelliteSize / 2 - c;
      const dy = p.y + ORBIT.satelliteSize / 2 - c;
      expect(Math.round(Math.hypot(dx, dy))).toBeCloseTo(ORBIT.outerRadius, -1);
    }
  });

  it("positions workers and their own mini-orbit relative to the worker", () => {
    const nested = {
      sup: { chat_model: [], memory: [], tool: [], worker: ["w"] },
      w: { chat_model: ["wm"], memory: [], tool: [], worker: [] }
    };
    const positions = orbitPositions("sup", nested, { x: 0, y: 0 });
    expect(positions.w).toBeDefined();
    const workerCenter = { x: positions.w!.x + ORBIT.hubSize / 2, y: positions.w!.y + ORBIT.hubSize / 2 };
    const modelCenter = { x: positions.wm!.x + ORBIT.satelliteSize / 2, y: positions.wm!.y + ORBIT.satelliteSize / 2 };
    expect(Math.round(Math.hypot(modelCenter.x - workerCenter.x, modelCenter.y - workerCenter.y))).toBe(ORBIT.miniRadius);
  });

  it("includes placeholder slots in the ring geometry", () => {
    const geometry = ringGeometry({ chat_model: [], memory: [], tool: ["t"], worker: [] }, { allowWorkers: true });
    expect(geometry.find((g) => g.port === "chat_model")?.nodeId).toBeNull();
    expect(geometry.find((g) => g.port === "memory")?.nodeId).toBeNull();
    expect(geometry.filter((g) => g.port === "tool").map((g) => g.nodeId)).toEqual(["t", null]);
    expect(geometry.filter((g) => g.port === "worker").map((g) => g.nodeId)).toEqual([null]);
  });
});

describe("tidyLayout", () => {
  const nodes = [
    node("trigger", "webhook_input"),
    node("agent", "agent_orchestrator"),
    node("model", "openai_chat_model"),
    node("b", "http_request"),
    node("out", "output")
  ];
  const edges = [edge("trigger", "agent"), edge("trigger", "b"), edge("agent", "model", "chat_model"), edge("agent", "out"), edge("b", "out")];

  it("is deterministic and lays stages out left to right", () => {
    const first = tidyLayout(nodes, edges);
    const second = tidyLayout(nodes, edges);
    expect(first).toEqual(second);
    expect(first.trigger!.x).toBeLessThan(first.agent!.x);
    expect(first.agent!.x).toBeLessThan(first.out!.x);
  });

  it("stacks parallel nodes vertically and reserves room for hub rings", () => {
    const layout = tidyLayout(nodes, edges);
    expect(layout.agent!.y).not.toBe(layout.b!.y);
    const hubCenterY = layout.agent!.y + ORBIT.hubSize / 2;
    const cardTop = layout.b!.y;
    // The card must sit outside the hub's outer ring.
    expect(Math.abs(cardTop - hubCenterY)).toBeGreaterThanOrEqual(ORBIT.outerRadius);
    // Attached nodes are positioned on the orbit.
    expect(layout.model).toEqual(orbitPositions("agent", computeAttachmentSlots(nodes, edges), layout.agent!).model);
  });
});

describe("hasOrbitOverlap", () => {
  const hub = { ...node("agent", "agent_orchestrator"), position: { x: 500, y: 500 } };
  const model = node("model", "openai_chat_model");
  const edges = [edge("agent", "model", "chat_model")];

  it("is true when a card sits inside a hub's reach", () => {
    const card = { ...node("parser", "output_parser"), position: { x: 560, y: 320 } };
    expect(hasOrbitOverlap([hub, model, card], [...edges, edge("agent", "parser")])).toBe(true);
  });

  it("is false when cards are outside the reach and attached nodes are ignored", () => {
    const far = { ...node("out", "output"), position: { x: 1200, y: 500 } };
    const attachedInside = { ...model, position: { x: 540, y: 400 } };
    expect(hasOrbitOverlap([hub, attachedInside, far], [...edges, edge("agent", "out")])).toBe(false);
  });

  it("is true when two hubs' reaches intersect and false when they are apart", () => {
    const other = { ...node("agent2", "agent_orchestrator"), position: { x: 700, y: 500 } };
    expect(hasOrbitOverlap([hub, other], [])).toBe(true);
    const apart = { ...other, position: { x: 1400, y: 500 } };
    expect(hasOrbitOverlap([hub, apart], [])).toBe(false);
  });

  it("is false without hubs", () => {
    expect(hasOrbitOverlap([node("a", "text_input"), { ...node("b", "output"), position: { x: 10, y: 10 } }], [edge("a", "b")])).toBe(false);
  });
});

describe("hasUsablePositions", () => {
  it("is false when all nodes share one point", () => {
    expect(hasUsablePositions([node("a", "x"), node("b", "y")])).toBe(false);
  });
  it("is true when positions differ", () => {
    expect(hasUsablePositions([node("a", "x"), { ...node("b", "y"), position: { x: 300, y: 0 } }])).toBe(true);
  });
});

describe("summarizeNode", () => {
  it("summarises llm_call provider config", () => {
    expect(
      summarizeNode({ type: "llm_call", config: { provider: { providerId: "openai", model: "gpt-4o-mini", temperature: 0 } } })
    ).toBe("openai · gpt-4o-mini · t=0");
  });
  it("summarises http_request", () => {
    expect(summarizeNode({ type: "http_request", config: { method: "GET", urlTemplate: "https://api.example.com/v1" } })).toBe(
      "GET · https://api.example.com/v1"
    );
  });
  it("summarises mcp_tool", () => {
    expect(summarizeNode({ type: "mcp_tool", config: { serverId: "mock-mcp", toolName: "get_current_time" } })).toBe(
      "mock-mcp · get_current_time"
    );
  });
  it("summarises webhook_input and schedule_trigger", () => {
    expect(summarizeNode({ type: "webhook_input", config: { method: "POST", path: "agent-demo", authMode: "none" } })).toBe(
      "POST · /webhook/agent-demo · auth none"
    );
    expect(summarizeNode({ type: "schedule_trigger", config: { cronExpression: "0 9 * * *", timezone: "UTC" } })).toBe("0 9 * * * · UTC");
  });
  it("falls back to scalar keys for unknown types", () => {
    expect(summarizeNode({ type: "mystery_node", config: { foo: "bar", nested: { a: 1 }, n: 3 } })).toBe("foo bar · n 3");
    expect(summarizeNode({ type: "mystery_node", config: {} })).toBe("mystery node");
  });
});
