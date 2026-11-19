import { describe, expect, it } from "vitest";
import { readableNodeId } from "./node-ids";

describe("readable node ids for new nodes", () => {
  it("derives the id from the label, in lower case with underscores", () => {
    expect(readableNodeId("Fetch items", "http_request", new Set())).toBe("fetch_items");
    expect(readableNodeId("HTTP Request", "http_request", new Set())).toBe("http_request");
    expect(readableNodeId("  Café — résumé (v2)!  ", "set_node", new Set())).toBe("cafe_resume_v2");
  });

  it("numbers a one-word label, so it never reads like a field name", () => {
    expect(readableNodeId("Set", "set_node", new Set())).toBe("set_1");
    expect(readableNodeId("Output", "output", new Set())).toBe("output_1");
    expect(readableNodeId("IF", "if_node", new Set())).toBe("if_1");
  });

  it("numbers an id that is taken, by a node, pinned data or a past run", () => {
    expect(readableNodeId("HTTP Request", "http_request", new Set(["http_request"]))).toBe("http_request_2");
    expect(readableNodeId("HTTP Request", "http_request", new Set(["http_request", "http_request_2"]))).toBe("http_request_3");
    expect(readableNodeId("Set", "set_node", new Set(["set_1", "set_2"]))).toBe("set_3");
  });

  it("adds the id to the taken set, so a batch of new nodes gets distinct ids", () => {
    const taken = new Set<string>();
    const ids = [1, 2, 3].map(() => readableNodeId("Set", "set_node", taken));
    expect(ids).toEqual(["set_1", "set_2", "set_3"]);
    expect([...taken]).toEqual(ids);
  });

  it("never uses a name the run's templates already read", () => {
    for (const reserved of ["results", "vars", "workflow", "execution", "parent_outputs", "user_prompt", "system_prompt", "session_id", "webhook", "item"]) {
      const label = reserved.replace(/_/g, " ");
      expect(readableNodeId(label, "set_node", new Set()), reserved).toBe(`${reserved}_1`);
    }
  });

  it("falls back to the node type for a label with no letters or digits, and starts with a letter", () => {
    expect(readableNodeId("!!!", "http_request", new Set())).toBe("http_request");
    expect(readableNodeId("", "set_node", new Set())).toBe("set_node");
    expect(readableNodeId("2nd step", "set_node", new Set())).toBe("n_2nd_step");
  });

  it("keeps ids short and usable in a template path and in JavaScript", () => {
    const id = readableNodeId("A very long label that goes on and on about what this step does", "set_node", new Set());
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(id.endsWith("_")).toBe(false);
  });
});
