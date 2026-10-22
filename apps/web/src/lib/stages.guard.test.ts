import { describe, expect, it } from "vitest";
import { GUARD_ANGLE, ORBIT, attachedNodeIds, computeAttachmentSlots, computeStages, findHubOf, isHubEntry, orbitPositions, ringGeometry, summarizeNode } from "./stages";

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const edge = (source: string, target: string, sourceHandle?: string) => ({ source, target, sourceHandle });

describe("guard and protection ports on the canvas", () => {
  it("puts a port guard on the agent and protection on the guard", () => {
    const nodes = [node("in", "text_input"), node("agent", "agent_orchestrator"), node("g", "guard"), node("vault", "guard_protection"), node("out", "output")];
    const edges = [edge("in", "agent"), edge("agent", "g", "guard"), edge("g", "vault", "protection"), edge("agent", "out")];
    const slots = computeAttachmentSlots(nodes, edges);
    expect(slots.agent!.guard).toEqual(["g"]);
    expect(slots.g).toMatchObject({ carrier: "guard", protection: ["vault"] });
    expect(isHubEntry(slots.agent)).toBe(true);
    expect(isHubEntry(slots.g)).toBe(false);
    expect([...attachedNodeIds(slots)].sort()).toEqual(["g", "vault"]);
    expect(findHubOf("vault", slots)).toEqual({ hubId: "g", port: "protection" });
    // Neither attachment is a DAG step.
    expect(computeStages(nodes, edges).stages).toEqual([["in"], ["agent"], ["out"]]);
  });

  it("ignores protection edges that do not start at a guard node", () => {
    const nodes = [node("agent", "agent_orchestrator"), node("vault", "guard_protection")];
    const slots = computeAttachmentSlots(nodes, [edge("agent", "vault", "protection")]);
    expect(slots.agent!.protection).toBeUndefined();
    expect(slots.vault).toBeUndefined();
  });

  it("gives every hub an empty guard slot on the inner ring and places the guard satellite there", () => {
    const empty = ringGeometry({ chat_model: [], memory: [], tool: [], worker: [] });
    expect(empty.find((slot) => slot.port === "guard")).toMatchObject({ nodeId: null, angle: GUARD_ANGLE, radius: ORBIT.innerRadius });

    const nodes = [node("agent", "agent_orchestrator"), node("g", "guard"), node("p1", "guard_protection"), node("p2", "guard_protection")];
    const edges = [edge("agent", "g", "guard"), edge("g", "p1", "protection"), edge("g", "p2", "protection")];
    const slots = computeAttachmentSlots(nodes, edges);
    const positions = orbitPositions("agent", slots, { x: 0, y: 0 });
    expect(Object.keys(positions).sort()).toEqual(["g", "p1", "p2"]);
    // Guard sits up and to the left of the hub centre; its providers sit further out.
    const centre = ORBIT.hubSize / 2;
    expect(positions.g!.x).toBeLessThan(centre);
    expect(positions.g!.y).toBeLessThan(centre);
    const dist = (point: { x: number; y: number }) => Math.hypot(point.x + ORBIT.satelliteSize / 2 - centre, point.y + ORBIT.satelliteSize / 2 - centre);
    expect(dist(positions.p1!)).toBeGreaterThan(dist(positions.g!));
    expect(positions.p1).not.toEqual(positions.p2);
  });

  it("keeps the guard slot off the model axis and away from the first seven tool bearings", () => {
    const tools = Array.from({ length: 7 }, (_, index) => `t${index}`);
    const ring = ringGeometry({ chat_model: ["m"], memory: [], tool: tools, worker: [] });
    const guard = ring.find((slot) => slot.port === "guard")!;
    const model = ring.find((slot) => slot.port === "chat_model")!;
    const degrees = (angle: number) => ((((angle * 180) / Math.PI) % 360) + 360) % 360;
    const apart = (a: number, b: number) => Math.min(Math.abs(degrees(a) - degrees(b)), 360 - Math.abs(degrees(a) - degrees(b)));
    expect(apart(guard.angle, model.angle)).toBeGreaterThanOrEqual(45);
    for (const tool of ring.filter((slot) => slot.port === "tool" && slot.nodeId)) {
      expect(apart(guard.angle, tool.angle)).toBeGreaterThanOrEqual(15);
    }
  });

  it("hangs protection providers below a guard card on DAG edges", () => {
    const nodes = [node("in", "text_input"), node("g", "guard"), node("p", "guard_protection"), node("out", "output")];
    const slots = computeAttachmentSlots(nodes, [edge("in", "g"), edge("g", "p", "protection"), edge("g", "out", "pass")]);
    const positions = orbitPositions("g", slots, { x: 100, y: 100 });
    expect(positions.p!.y).toBeGreaterThan(100 + ORBIT.cardHeight);
  });

  it("summarises guard and protection nodes", () => {
    expect(summarizeNode({ type: "guard", config: { profileId: "effective", channel: "tool_result" } })).toBe("effective profile · tool_result");
    expect(summarizeNode({ type: "guard_protection", config: { providerId: "token_vault", dataClasses: ["email", "phone"] } })).toBe("token_vault · email, phone");
    expect(summarizeNode({ type: "guard_protection", config: { providerId: "mask", dataClasses: "*" } })).toBe("mask · all classes");
  });
});
