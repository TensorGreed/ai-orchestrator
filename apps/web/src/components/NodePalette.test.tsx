import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodePalette, type PaletteDefinition, type PaletteSection } from "./NodePalette";

function def(type: string, label: string, description: string): PaletteDefinition {
  return { type, label, description, category: "x", sampleConfig: {} };
}

// The real palette lists Triggers first, then later categories; Enter used to add the first category's first hit.
const sections: PaletteSection[] = [
  {
    key: "trigger",
    title: "Triggers",
    description: "",
    icon: "trigger",
    items: [
      def("error_trigger", "Error Trigger", "Starts when another workflow fails and passes the output of the failed run."),
      def("mcp_server_trigger", "Expose as MCP Tool", "Lets agents call this workflow; if arguments are sent they become the input.")
    ]
  },
  { key: "ai", title: "AI", description: "", icon: "ai", items: [def("agent_orchestrator", "Agent Orchestrator", "Runs a loop over a chat model and tools.")] },
  {
    key: "flow",
    title: "Flow",
    description: "",
    icon: "flow",
    items: [def("if_node", "IF", "Routes to true or false."), def("loop_node", "Loop / ForEach", "Runs the steps for each item.")]
  },
  {
    key: "core",
    title: "Core",
    description: "",
    icon: "core",
    items: [def("output", "Output", "Returns the workflow result."), def("pdf_output", "PDF Output", "Renders a PDF.")]
  }
];

async function pickWithEnter(query: string): Promise<string | undefined> {
  const onPick = vi.fn();
  const view = render(<NodePalette title="Add a node" subtitle="" sections={sections} onPick={onPick} onClose={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("Search nodes"), `${query}{Enter}`);
  view.unmount();
  return (onPick.mock.calls[0]?.[0] as PaletteDefinition | undefined)?.label;
}

describe("NodePalette search", () => {
  it("adds the best match on Enter, not the first category's first hit", async () => {
    expect(await pickWithEnter("output")).toBe("Output");
    expect(await pickWithEnter("if")).toBe("IF");
    expect(await pickWithEnter("loop")).toBe("Loop / ForEach");
  });

  it("marks the best match and lists its category first", async () => {
    render(<NodePalette title="Add a node" subtitle="" sections={sections} onPick={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search nodes"), "output");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Output");
    expect(options[0]).toHaveTextContent("Best match");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Best match")).toHaveLength(1);
    expect(screen.getAllByRole("listbox").map((list) => list.getAttribute("aria-label"))).toEqual(["Core", "Triggers"]);
  });

  it("keeps the category order and shows no badge without a query", () => {
    render(<NodePalette title="Add a node" subtitle="" sections={sections} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole("listbox").map((list) => list.getAttribute("aria-label"))).toEqual(["Triggers", "AI", "Flow", "Core"]);
    expect(screen.queryByText("Best match")).toBeNull();
  });
});
