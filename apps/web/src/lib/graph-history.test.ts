import { describe, expect, it } from "vitest";
import { GraphHistory, movedNodeIds } from "./graph-history";

interface N {
  id: string;
  position: { x: number; y: number };
}
interface E {
  id: string;
  source: string;
  target: string;
}

const a = (x = 0, y = 0): N => ({ id: "a", position: { x, y } });
const b = (x = 200, y = 0): N => ({ id: "b", position: { x, y } });
const ab: E = { id: "a-b", source: "a", target: "b" };

describe("GraphHistory", () => {
  it("undoes and redoes in order, one step per pushed change", () => {
    const history = new GraphHistory<N, E>();
    // add b
    history.push({ nodes: [a()], edges: [] });
    // connect a -> b
    history.push({ nodes: [a(), b()], edges: [] });
    const current = { nodes: [a(), b()], edges: [ab] };

    const first = history.undo(current);
    expect(first).toEqual({ nodes: [a(), b()], edges: [] });
    const second = history.undo(first!);
    expect(second).toEqual({ nodes: [a()], edges: [] });
    expect(history.undo(second!)).toBeNull();

    expect(history.redo(second!)).toEqual({ nodes: [a(), b()], edges: [] });
    expect(history.redo({ nodes: [a(), b()], edges: [] })).toEqual(current);
    expect(history.redo(current)).toBeNull();
  });

  it("drops the redo branch when a new change is pushed", () => {
    const history = new GraphHistory<N, E>();
    history.push({ nodes: [], edges: [] });
    const undone = history.undo({ nodes: [a()], edges: [] });
    expect(undone).toEqual({ nodes: [], edges: [] });
    expect(history.canRedo).toBe(true);
    history.push({ nodes: [], edges: [] });
    expect(history.canRedo).toBe(false);
  });

  it("stores copies, so later edits of the live graph do not change a snapshot", () => {
    const history = new GraphHistory<N, E>();
    const nodes = [a(10, 10)];
    history.push({ nodes, edges: [] });
    nodes[0]!.position.x = 999;
    expect(history.undo({ nodes, edges: [] })).toEqual({ nodes: [a(10, 10)], edges: [] });
  });

  it("keeps at most `limit` steps, dropping the oldest", () => {
    const history = new GraphHistory<N, E>(2);
    history.push({ nodes: [a(1)], edges: [] });
    history.push({ nodes: [a(2)], edges: [] });
    history.push({ nodes: [a(3)], edges: [] });
    expect(history.undo({ nodes: [a(4)], edges: [] })?.nodes[0]?.position.x).toBe(3);
    expect(history.undo({ nodes: [a(3)], edges: [] })?.nodes[0]?.position.x).toBe(2);
    expect(history.undo({ nodes: [a(2)], edges: [] })).toBeNull();
  });

  it("clear() forgets both directions (a different workflow was opened)", () => {
    const history = new GraphHistory<N, E>();
    history.push({ nodes: [], edges: [] });
    history.undo({ nodes: [a()], edges: [] });
    history.push({ nodes: [], edges: [] });
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});

describe("movedNodeIds", () => {
  it("lists nodes whose position changed by at least half a pixel", () => {
    expect(movedNodeIds([a(0, 0), b(200, 0)], [a(0, 0.2), b(200, 40)])).toEqual(["b"]);
    expect(movedNodeIds([a(0, 0)], [a(0, 0)])).toEqual([]);
  });

  it("ignores nodes that are missing on either side", () => {
    expect(movedNodeIds([a()], [b()])).toEqual([]);
  });
});
