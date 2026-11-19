import { describe, expect, it } from "vitest";
import { rankPaletteItems, scorePaletteItem, type PaletteSearchItem } from "./palette-search";

function item(type: string, label: string, description = ""): PaletteSearchItem {
  return { type, label, description };
}

// A slice of the real catalogue, in the alphabetical order the palette lists it.
const catalogue: PaletteSearchItem[] = [
  item("agent_orchestrator", "Agent Orchestrator", "Runs a tool-calling loop over a chat model."),
  item("error_trigger", "Error Trigger", "Starts when another workflow fails and passes the output of the failed run."),
  item("mcp_server_trigger", "Expose as MCP Tool", "Lets agents call this workflow; if the client sends arguments they become the input."),
  item("http_request", "HTTP Request", "Calls an HTTP endpoint and returns the response."),
  item("if_node", "IF", "Routes to true or false."),
  item("loop_node", "Loop / ForEach", "Runs the connected steps once for each item."),
  item("output", "Output", "Returns the workflow result."),
  item("pdf_output", "PDF Output", "Renders a PDF."),
  item("set_node", "Set / Transform", "Sets fields on the item."),
  item("switch_node", "Switch", "Routes on a value."),
  item("webhook_input", "Webhook Input", "Starts a run from an HTTP call."),
  item("webhook_response", "Webhook Response", "Answers the webhook caller.")
];

function topLabels(query: string, count = 3): string[] {
  return rankPaletteItems(catalogue, query)
    .slice(0, count)
    .map((entry) => entry.label);
}

describe("palette search ranking", () => {
  it("puts an exact label match first, ahead of earlier description matches", () => {
    expect(topLabels("output")[0]).toBe("Output");
    expect(topLabels("if")[0]).toBe("IF");
    expect(topLabels("switch")[0]).toBe("Switch");
  });

  it("puts a label prefix match ahead of word and description matches", () => {
    expect(topLabels("loop")[0]).toBe("Loop / ForEach");
    expect(topLabels("webh", 2)).toEqual(["Webhook Input", "Webhook Response"]);
    expect(topLabels("http")[0]).toBe("HTTP Request");
  });

  it("matches a later word of the label before a description", () => {
    expect(topLabels("request")[0]).toBe("HTTP Request");
    expect(topLabels("transform")[0]).toBe("Set / Transform");
  });

  it("finds nodes by alias", () => {
    expect(topLabels("api")[0]).toBe("HTTP Request");
    expect(topLabels("foreach")[0]).toBe("Loop / ForEach");
    expect(topLabels("condition")[0]).toBe("IF");
  });

  it("keeps description-only matches, after every label match", () => {
    const ranked = rankPaletteItems(catalogue, "output").map((entry) => entry.label);
    expect(ranked.slice(0, 2)).toEqual(["Output", "PDF Output"]);
    expect(ranked).toContain("Error Trigger");
    expect(ranked.indexOf("Error Trigger")).toBeGreaterThan(ranked.indexOf("PDF Output"));
  });

  it("drops items that do not match at all, and is case and space insensitive", () => {
    expect(scorePaletteItem(catalogue[4]!, "zzz")).toBeNull();
    expect(topLabels("  OUTPUT ")[0]).toBe("Output");
    expect(rankPaletteItems(catalogue, "")).toHaveLength(catalogue.length);
  });

  it("matches the node type id", () => {
    expect(topLabels("set_node")[0]).toBe("Set / Transform");
  });

  it("keeps the original order between equal scores", () => {
    const ranked = rankPaletteItems([item("a", "Alpha one"), item("b", "Alpha two")], "alpha").map((entry) => entry.type);
    expect(ranked).toEqual(["a", "b"]);
  });
});
