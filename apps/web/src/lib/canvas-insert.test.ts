import { describe, expect, it } from "vitest";
import { canAutoConnect, planInsertConnection, chooseSourceHandle, findFreePosition, insertPositionAfter, sourceHandleIds, type InsertNode } from "./canvas-insert";

function node(id: string, nodeType: string, x: number, y: number, config: Record<string, unknown> = {}): InsertNode {
  return { id, position: { x, y }, data: { nodeType, config } };
}

describe("sourceHandleIds", () => {
  it("lists a node type's output handles, the main one as null", () => {
    expect(sourceHandleIds(node("a", "http_request", 0, 0))).toEqual([null]);
    expect(sourceHandleIds(node("a", "if_node", 0, 0))).toEqual(["true", "false"]);
    expect(sourceHandleIds(node("a", "try_catch", 0, 0))).toEqual(["success", "error"]);
    expect(sourceHandleIds(node("a", "approval_gate", 0, 0))).toEqual(["approved", "rejected", "timed_out"]);
    expect(sourceHandleIds(node("a", "agent_orchestrator", 0, 0))).toEqual([null]);
  });

  it("names a Switch's handles from its cases, as the canvas draws them", () => {
    const switchNode = node("s", "switch_node", 0, 0, { cases: [{ label: "billing" }, { value: "tech" }, "", "general"] });
    expect(sourceHandleIds(switchNode)).toEqual(["billing", "tech", "case_2", "general", "default"]);
  });
});

describe("chooseSourceHandle", () => {
  it("picks the first output that has no connection yet", () => {
    const ifNode = node("if", "if_node", 0, 0);
    expect(chooseSourceHandle(ifNode, [])).toBe("true");
    expect(chooseSourceHandle(ifNode, [{ source: "if", target: "x", sourceHandle: "true" }])).toBe("false");
    expect(
      chooseSourceHandle(ifNode, [
        { source: "if", target: "x", sourceHandle: "true" },
        { source: "if", target: "y", sourceHandle: "false" }
      ])
    ).toBe("true");
  });

  it("uses the main output of a plain node", () => {
    expect(chooseSourceHandle(node("h", "http_request", 0, 0), [{ source: "h", target: "x" }])).toBeNull();
  });
});

describe("canAutoConnect", () => {
  it("connects ordinary steps", () => {
    expect(canAutoConnect("webhook_input", "set_node")).toBe(true);
    expect(canAutoConnect("set_node", "output")).toBe(true);
    expect(canAutoConnect("agent_orchestrator", "output")).toBe(true);
  });

  it("never feeds a trigger or input node, and leaves sticky notes alone", () => {
    expect(canAutoConnect("set_node", "webhook_input")).toBe(false);
    expect(canAutoConnect("set_node", "schedule_trigger")).toBe(false);
    expect(canAutoConnect("set_node", "text_input")).toBe(false);
    expect(canAutoConnect("set_node", "sticky_note")).toBe(false);
    expect(canAutoConnect("sticky_note", "set_node")).toBe(false);
  });

  it("does not draw a step edge from an agent to what belongs on its ports", () => {
    expect(canAutoConnect("agent_orchestrator", "openai_chat_model")).toBe(false);
    expect(canAutoConnect("supervisor_node", "mcp_tool")).toBe(false);
    expect(canAutoConnect("agent_orchestrator", "local_memory")).toBe(false);
    // Another agent after an agent is a step; a Supervisor's workers have their own `+ worker` slot.
    expect(canAutoConnect("agent_orchestrator", "agent_orchestrator")).toBe(true);
  });
});

describe("insertPositionAfter", () => {
  it("places the new node to the right of the source, on the row of its output", () => {
    const source = node("a", "http_request", 100, 50);
    expect(insertPositionAfter(source, null, [source])).toEqual({ x: 100 + 240 + 80, y: 50 });
    const ifNode = node("if", "if_node", 0, 0);
    expect(insertPositionAfter(ifNode, "false", [ifNode]).y).toBeGreaterThan(insertPositionAfter(ifNode, "true", [ifNode]).y);
  });

  it("uses the measured width when the canvas knows it", () => {
    const source = { ...node("a", "agent_orchestrator", 0, 0), width: 150, height: 150 };
    expect(insertPositionAfter(source, null, [source]).x).toBe(150 + 80);
  });

  it("moves down past nodes already in the way", () => {
    const source = node("a", "set_node", 0, 0);
    const blocker = node("b", "output", 320, 0);
    const position = insertPositionAfter(source, null, [source, blocker]);
    expect(position.x).toBe(320);
    expect(position.y).toBeGreaterThanOrEqual(96);
  });
});

describe("findFreePosition", () => {
  it("keeps a free spot and steps down from an occupied one", () => {
    expect(findFreePosition({ x: 0, y: 0 }, [])).toEqual({ x: 0, y: 0 });
    const spot = findFreePosition({ x: 0, y: 0 }, [node("a", "set_node", 10, 10), node("b", "set_node", 10, 130)]);
    expect(spot.x).toBe(0);
    expect(spot.y).toBeGreaterThanOrEqual(130 + 96);
  });
});

describe("planInsertConnection", () => {
  const rule = (id: string, nodeType: string, label = id) => ({ id, data: { nodeType, label } });

  it("connects through the editor's connection rules, with the handle they settle on", () => {
    const rules = rule("rules", "guard");
    expect(planInsertConnection(rules, "pass", rule("p", "guard_protection"), [rules], [])).toEqual({ kind: "connect", sourceHandle: "protection" });
    const ifNode = rule("if", "if_node");
    expect(planInsertConnection(ifNode, "false", rule("x", "set_node"), [ifNode], [])).toEqual({ kind: "connect", sourceHandle: "false" });
  });

  it("refuses with the same notice as a dragged connection, so the node is placed unconnected", () => {
    const model = rule("m", "llm_call", "Model");
    expect(planInsertConnection(model, null, rule("a", "agent_orchestrator", "Agent"), [model], [])).toEqual({
      kind: "refused",
      message: "Attach 'Model' from the Agent 'chat_model' port (drag edge from Agent to node)."
    });
    const set = rule("s", "set_node");
    expect(planInsertConnection(set, "tool", rule("x", "output"), [set], [])).toEqual({
      kind: "refused",
      message: "chat_model/memory/tool/worker/guard handles can only be used from an Agent Orchestrator or Supervisor node."
    });
  });

  it("only places start nodes, sticky notes and an agent's port nodes", () => {
    const set = rule("s", "set_node");
    expect(planInsertConnection(set, null, rule("w", "webhook_input"), [set], [])).toEqual({ kind: "place" });
    const agent = rule("a", "agent_orchestrator");
    expect(planInsertConnection(agent, null, rule("m", "openai_chat_model"), [agent], [])).toEqual({ kind: "place" });
  });
});

describe("inserting after a node's Error output", () => {
  const rule = (id: string, nodeType: string, label = id) => ({ id, data: { nodeType, label } });

  it("places the node on the row below the node's other outputs", () => {
    const card = node("a", "http_request", 100, 50);
    expect(insertPositionAfter(card, "error", [card]).y).toBeGreaterThan(insertPositionAfter(card, null, [card]).y);
    const ifNode = node("if", "if_node", 0, 0);
    expect(insertPositionAfter(ifNode, "error", [ifNode]).y).toBeGreaterThan(insertPositionAfter(ifNode, "false", [ifNode]).y);
  });

  it("connects from the error handle, through the connection rules, for cards and agents", () => {
    expect(planInsertConnection(rule("http", "http_request"), "error", rule("notify", "set_node"), [rule("http", "http_request")], [])).toEqual({
      kind: "connect",
      sourceHandle: "error"
    });
    // An agent's Error output is a step edge, not one of its attachment ports.
    expect(planInsertConnection(rule("agent", "agent_orchestrator"), "error", rule("fallback", "set_node"), [rule("agent", "agent_orchestrator")], [])).toEqual({
      kind: "connect",
      sourceHandle: "error"
    });
    // An LLM Call after an agent's Error output is a step too, not a chat model attachment.
    expect(planInsertConnection(rule("agent", "agent_orchestrator"), "error", rule("llm", "llm_call"), [rule("agent", "agent_orchestrator")], [])).toEqual({
      kind: "connect",
      sourceHandle: "error"
    });
  });

  it("is never picked as the free output when chaining from a selected node", () => {
    const card = node("a", "http_request", 0, 0);
    expect(chooseSourceHandle({ ...card, data: { ...card.data, config: { onError: "branch" } } }, [])).toBeNull();
  });
});
