import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { CommandPalette, filterCommandItems } from "./CommandPalette";
import type { CommandPaletteItem } from "./studio-layout-types";

function makeItems(): CommandPaletteItem[] {
  return [
    { id: "run", label: "Run workflow", group: "Actions", run: vi.fn() },
    { id: "save", label: "Save workflow", group: "Actions", hint: "⌘S", run: vi.fn() },
    { id: "mode-settings", label: "Go to Settings", group: "Navigate", run: vi.fn() },
    { id: "wf-1", label: "Open Invoice parser", group: "Workflows", hint: "wf-1", run: vi.fn() }
  ];
}

describe("filterCommandItems", () => {
  it("returns everything for an empty query", () => {
    const items = makeItems();
    expect(filterCommandItems(items, "   ")).toHaveLength(items.length);
  });

  it("matches case-insensitively on label, group and hint", () => {
    const items = makeItems();
    expect(filterCommandItems(items, "SETTINGS").map((item) => item.id)).toEqual(["mode-settings"]);
    expect(filterCommandItems(items, "workflows").map((item) => item.id)).toEqual(["wf-1"]);
    expect(filterCommandItems(items, "⌘s").map((item) => item.id)).toEqual(["save"]);
  });

  it("requires every term to match", () => {
    const items = makeItems();
    expect(filterCommandItems(items, "run workflow").map((item) => item.id)).toEqual(["run"]);
    expect(filterCommandItems(items, "run settings")).toHaveLength(0);
  });
});

describe("CommandPalette", () => {
  it("filters as the user types and runs the highlighted item on Enter", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    const onClose = vi.fn();
    render(<CommandPalette open items={items} onClose={onClose} />);

    const input = screen.getByRole("combobox", { name: "Search commands" });
    await user.type(input, "invoice");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Open Invoice parser/ })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");
    expect(items[3].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves the highlight with the arrow keys", async () => {
    const user = userEvent.setup();
    const items = makeItems();
    render(<CommandPalette open items={items} onClose={vi.fn()} />);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: /Go to Settings/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /Save workflow/ })).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape and shows an empty state when nothing matches", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette open items={makeItems()} onClose={onClose} />);

    await user.type(screen.getByRole("combobox", { name: "Search commands" }), "zzz");
    expect(screen.getByText("No matching commands")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} items={makeItems()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
