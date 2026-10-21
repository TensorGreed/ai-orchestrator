import { createRef, useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { SHELL_DRAWER_MEDIA_QUERY } from "../lib/use-media-query";
import { readStudioUrlState } from "../lib/studio-session";
import { AppSidebar, SIDEBAR_COLLAPSED_STORAGE_KEY, SidebarMenuButton } from "./AppSidebar";
import { StudioHud } from "./StudioHud";
import { MCP_MODE_ITEMS, isMcpMode, studioModeLabel, type StudioMode } from "./studio-layout-types";

type Listener = () => void;

function installMatchMedia(drawer: boolean) {
  const original = window.matchMedia;
  const listeners = new Set<Listener>();
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query === SHELL_DRAWER_MEDIA_QUERY ? drawer : false,
    onchange: null,
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function Shell({ canManageSecrets = true, initialMode = "dashboard" as StudioMode, onModeChange = vi.fn() }) {
  const [mode, setMode] = useState<StudioMode>(initialMode);
  const [open, setOpen] = useState(false);
  return (
    <>
      <SidebarMenuButton open={open} onToggle={() => setOpen((value) => !value)} />
      <AppSidebar
        activeMode={mode}
        canManageSecrets={canManageSecrets}
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

const MCP_LABELS = ["Overview", "Servers", "Tools", "Policies", "Toolsets", "Clients", "Playground", "Changes"];

describe("MCP navigation", () => {
  let restore: () => void;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    restore?.();
  });

  it("groups the MCP pages in their own sidebar section", async () => {
    restore = installMatchMedia(false);
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<Shell onModeChange={onModeChange} />);

    const group = screen.getByRole("group", { name: "MCP" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(MCP_LABELS);
    // The single "MCP servers" item is gone from the workspace list.
    expect(screen.queryByRole("button", { name: "MCP servers" })).not.toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: "Tools" }));
    expect(onModeChange).toHaveBeenLastCalledWith("mcp-tools");
    expect(within(group).getByRole("button", { name: "Tools" })).toHaveAttribute("aria-current", "page");

    // Keyboard: the items are plain buttons in tab order.
    within(group).getByRole("button", { name: "Changes" }).focus();
    await user.keyboard("{Enter}");
    expect(onModeChange).toHaveBeenLastCalledWith("mcp-changes");
  });

  it("hides the section from operators and viewers", () => {
    restore = installMatchMedia(false);
    render(<Shell canManageSecrets={false} />);
    expect(screen.queryByRole("group", { name: "MCP" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
  });

  it("names collapsed rail items by their tooltip", () => {
    restore = installMatchMedia(false);
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "1");
    render(<Shell />);
    const group = screen.getByRole("group", { name: "MCP" });
    const tools = within(group).getByRole("button", { name: "MCP tools" });
    expect(tools).toHaveAttribute("title", "MCP tools");
    expect(within(group).getByRole("button", { name: "MCP overview" })).toBeInTheDocument();
  });

  it("works from the phone drawer and closes it on navigation", async () => {
    restore = installMatchMedia(true);
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<Shell onModeChange={onModeChange} />);

    const menu = screen.getByRole("button", { name: "Open navigation" });
    await user.click(menu);
    const nav = screen.getByRole("complementary", { name: "Studio navigation" });
    expect(nav).toHaveAttribute("data-drawer", "open");
    const group = within(nav).getByRole("group", { name: "MCP" });
    // The drawer always shows labels, so items keep their visible names.
    await user.click(within(group).getByRole("button", { name: "Policies" }));
    expect(onModeChange).toHaveBeenLastCalledWith("mcp-policies");
    expect(nav).toHaveAttribute("data-drawer", "closed");
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });

  it("lists every MCP page in the command palette", async () => {
    restore = installMatchMedia(false);
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(
      <StudioHud
        activeMode="dashboard"
        canManageSecrets
        currentWorkflowName="Flow"
        currentWorkflowId="wf-1"
        currentWorkflowExists
        workflowList={[]}
        authUser={{ id: "u-1", email: "builder@example.com", role: "builder" }}
        busy={false}
        secretBusy={false}
        importFileRef={createRef<HTMLInputElement>()}
        onWorkflowNameChange={vi.fn()}
        onLoadWorkflowById={vi.fn()}
        onModeChange={onModeChange}
        onSave={vi.fn()}
        onExport={vi.fn()}
        onImportClick={vi.fn()}
        onImportFileChange={vi.fn()}
        onRefreshSecrets={vi.fn()}
        onLogout={vi.fn()}
        theme="dark"
        onToggleTheme={vi.fn()}
        onOpenShortcuts={vi.fn()}
        runStatus={{ state: "idle", label: "no runs yet" }}
        projects={[]}
        activeProjectId="default"
        onChangeActiveProject={vi.fn()}
        onCreateProject={vi.fn()}
      />
    );

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("MCP");
    const palette = screen.getByRole("dialog", { name: "Command palette" });
    for (const label of MCP_LABELS) {
      expect(within(palette).getByText(`Go to MCP · ${label}`)).toBeInTheDocument();
    }
    await user.click(within(palette).getByText("Go to MCP · Changes"));
    expect(onModeChange).toHaveBeenCalledWith("mcp-changes");
  });

  it("keeps the MCP modes in the URL-restorable set", () => {
    for (const item of MCP_MODE_ITEMS) {
      expect(isMcpMode(item.mode)).toBe(true);
      expect(studioModeLabel(item)).toBe(`MCP · ${item.label}`);
      window.history.replaceState({}, "", `/?mode=${item.mode}`);
      expect(readStudioUrlState().mode).toBe(item.mode);
    }
    expect(isMcpMode("secrets")).toBe(false);
    act(() => window.history.replaceState({}, "", "/"));
  });
});
