import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkflowCardMenu } from "./WorkflowCardMenu";

function renderMenu(overrides: { onDelete?: () => void; onChat?: () => void } = {}) {
  const onChat = overrides.onChat ?? vi.fn();
  const onDelete = overrides.onDelete ?? vi.fn();
  render(
    <div>
      <button type="button">Outside</button>
      <WorkflowCardMenu
        label="More actions for Billing flow"
        actions={[
          { id: "chat", label: "Chat", onSelect: onChat },
          { id: "execute", label: "Execute", onSelect: vi.fn() },
          { id: "tags", label: "Tags", onSelect: vi.fn() },
          { id: "folder", label: "Folder", onSelect: vi.fn() },
          { id: "duplicate", label: "Duplicate", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: onDelete, danger: true }
        ]}
      />
    </div>
  );
  return { onChat, onDelete };
}

describe("WorkflowCardMenu", () => {
  it("renders a closed trigger with menu semantics", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "More actions for Billing flow" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on click and lists every action", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "More actions for Billing flow" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Chat", "Execute", "Tags", "Folder", "Duplicate", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("danger");
    expect(screen.getByRole("button", { name: "More actions for Billing flow" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("invokes the action and closes when an item is selected", async () => {
    const user = userEvent.setup();
    const { onChat } = renderMenu();
    await user.click(screen.getByRole("button", { name: "More actions for Billing flow" }));
    await user.click(screen.getByRole("menuitem", { name: "Chat" }));
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByRole("button", { name: "More actions for Billing flow" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "More actions for Billing flow" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves focus with arrow keys", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "More actions for Billing flow" }));
    expect(screen.getByRole("menuitem", { name: "Chat" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Execute" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });
});
