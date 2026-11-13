/**
 * Who may see and answer an MCP elicitation from a run someone else started: operator and above by rank, so builders
 * (above operator) may, as operators always could; viewers and unknown roles may not.
 */
import { describe, expect, it } from "vitest";
import { seesOthersElicitations } from "./mcp-elicitation-service.js";

describe("seesOthersElicitations", () => {
  it("is operator and above by rank", () => {
    expect(["viewer", "operator", "builder", "admin"].map(seesOthersElicitations)).toEqual([false, true, true, true]);
    expect(seesOthersElicitations("")).toBe(false);
    expect(seesOthersElicitations("project_admin")).toBe(false);
    expect(seesOthersElicitations("constructor")).toBe(false);
  });
});
