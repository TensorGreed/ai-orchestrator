import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { SHELL_DRAWER_MEDIA_QUERY } from "../lib/use-media-query";
import { AppSidebar, SIDEBAR_COLLAPSED_STORAGE_KEY, SidebarMenuButton } from "./AppSidebar";
import type { StudioMode } from "./studio-layout-types";

type Listener = () => void;

/** matchMedia stub whose drawer query result can be flipped while the test runs. */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query === SHELL_DRAWER_MEDIA_QUERY ? matches : false;
    },
    onchange: null,
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      act(() => listeners.forEach((listener) => listener()));
    },
    restore() {
      window.matchMedia = original;
    }
  };
}

function Shell({ initialMode = "dashboard" as StudioMode, onModeChange = vi.fn() }) {
  const [mode, setMode] = useState<StudioMode>(initialMode);
  const [open, setOpen] = useState(false);
  return (
    <>
      <SidebarMenuButton open={open} onToggle={() => setOpen((value) => !value)} />
      <button type="button" onClick={() => setMode("executions")}>
        Go to Runs elsewhere
      </button>
      <AppSidebar
        activeMode={mode}
        canManageSecrets
        onModeChange={(next) => {
          onModeChange(next);
          setMode(next);
        }}
        drawerOpen={open}
        onDrawerOpenChange={setOpen}
      />
    </>
  );
}

describe("AppSidebar drawer (phone widths)", () => {
  let media: ReturnType<typeof installMatchMedia>;

  beforeEach(() => {
    localStorage.clear();
    media = installMatchMedia(true);
  });

  afterEach(() => {
    media.restore();
  });

  it("is hidden by default and wired to the menu button", () => {
    render(<Shell />);

    const button = screen.getByRole("button", { name: "Open navigation" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", "app-sidebar");

    const aside = document.getElementById("app-sidebar");
    expect(aside).toHaveAttribute("data-drawer", "closed");
    expect(aside).toHaveAttribute("aria-hidden", "true");
    expect(aside).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Home" })).not.toBeInTheDocument();
  });

  it("opens as a labelled region, focuses the active item and closes from its Close button", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const button = screen.getByRole("button", { name: "Open navigation" });

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const drawer = screen.getByRole("complementary", { name: "Studio navigation" });
    expect(drawer).toHaveAttribute("data-drawer", "open");
    expect(drawer).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Home" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(drawer).toHaveAttribute("data-drawer", "closed");
    expect(button).toHaveFocus();
  });

  it("closes on Escape and returns focus to the menu button", async () => {
    const user = userEvent.setup();
    render(<Shell />);
    const button = screen.getByRole("button", { name: "Open navigation" });

    await user.click(button);
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("app-sidebar")).toHaveAttribute("data-drawer", "closed");
    expect(button).toHaveFocus();
  });

  it("closes on scrim click", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const scrim = document.querySelector(".app-sidebar-scrim");
    expect(scrim).not.toBeNull();
    await user.click(scrim as Element);
    expect(document.getElementById("app-sidebar")).toHaveAttribute("data-drawer", "closed");
    expect(document.querySelector(".app-sidebar-scrim")).toBeNull();
  });

  it("closes when a workspace item is chosen", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<Shell onModeChange={onModeChange} />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(onModeChange).toHaveBeenCalledWith("knowledge");
    expect(document.getElementById("app-sidebar")).toHaveAttribute("data-drawer", "closed");
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when the mode changes from elsewhere (e.g. the command palette)", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    act(() => {
      (screen.getByRole("button", { name: "Go to Runs elsewhere", hidden: true }) as HTMLButtonElement).click();
    });
    expect(document.getElementById("app-sidebar")).toHaveAttribute("data-drawer", "closed");
  });

  it("keeps Tab focus inside the open drawer", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    screen.getByRole("button", { name: "Close navigation" }).focus();
    await user.tab();
    const drawer = document.getElementById("app-sidebar");
    expect(drawer?.contains(document.activeElement)).toBe(true);
  });

  it("shows labels in the drawer without touching the stored desktop collapsed preference", async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "1");
    const user = userEvent.setup();
    render(<Shell />);

    const aside = document.getElementById("app-sidebar");
    expect(aside).not.toHaveClass("is-collapsed");
    expect(aside).toHaveAttribute("data-collapsed", "true");
    expect(screen.queryByRole("button", { name: /Collapse sidebar|Expand sidebar/, hidden: true })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(screen.getByRole("button", { name: "Runs" }));
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.keyboard("{Escape}");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");

    media.set(false);
    expect(aside).toHaveClass("is-collapsed");
    expect(aside).not.toHaveAttribute("data-drawer");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("closes the drawer when the window grows past the breakpoint", async () => {
    const user = userEvent.setup();
    render(<Shell />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    media.set(false);
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".app-sidebar-scrim")).toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
  });

  it("works without a controlling parent", async () => {
    const user = userEvent.setup();
    render(<AppSidebar activeMode="dashboard" canManageSecrets onModeChange={vi.fn()} />);

    const aside = document.getElementById("app-sidebar");
    expect(aside).toHaveAttribute("data-drawer", "closed");
    expect(screen.queryByRole("button", { name: "Home" })).not.toBeInTheDocument();
    expect(aside?.querySelector(".sidebar-toggle")).toHaveAttribute("aria-label", "Close navigation");
    await user.keyboard("{Escape}");
    expect(aside).toHaveAttribute("data-drawer", "closed");
  });
});

describe("AppSidebar on desktop widths", () => {
  it("renders inline with no drawer state", () => {
    localStorage.clear();
    render(<Shell />);
    const aside = screen.getByRole("complementary", { name: "Studio navigation" });
    expect(aside).not.toHaveAttribute("data-drawer");
    expect(aside).not.toHaveAttribute("aria-hidden");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });
});
