import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, WorkflowListItem } from "@ai-orchestrator/shared";
import { vi } from "vitest";
import type { StudioMode } from "./studio-layout-types";
import { deriveRunStatus } from "./studio-layout-types";
import { StudioHud } from "./StudioHud";

function makeProps(overrides: Partial<Parameters<typeof StudioHud>[0]> = {}): Parameters<typeof StudioHud>[0] {
  const workflows: WorkflowListItem[] = [
    {
      id: "wf-1",
      name: "Workflow 1",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "wf-2",
      name: "Workflow 2",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  const projects: Project[] = [
    {
      id: "default",
      name: "Default",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  return {
    activeMode: "editor" as StudioMode,
    canManageSecrets: true,
    currentWorkflowName: "Workflow 1",
    currentWorkflowId: "wf-1",
    currentWorkflowExists: true,
    workflowList: workflows,
    authUser: { id: "u-1", email: "admin@example.com", role: "admin" },
    busy: false,
    secretBusy: false,
    importFileRef: createRef<HTMLInputElement>(),
    onWorkflowNameChange: vi.fn(),
    onLoadWorkflowById: vi.fn(),
    onModeChange: vi.fn(),
    onSave: vi.fn(),
    onExport: vi.fn(),
    onImportClick: vi.fn(),
    onImportFileChange: vi.fn(),
    onRefreshSecrets: vi.fn(),
    onLogout: vi.fn(),
    theme: "light",
    onToggleTheme: vi.fn(),
    onOpenShortcuts: vi.fn(),
    projects,
    activeProjectId: "default",
    onChangeActiveProject: vi.fn(),
    onCreateProject: vi.fn(),
    runStatus: { state: "ok", label: "last run 4.2 s · 3 of 3 ok" },
    onRun: vi.fn(),
    ...overrides
  };
}

describe("StudioHud", () => {
  it("renders the breadcrumb with an editable name and the workflow picker in editor mode", () => {
    render(<StudioHud {...makeProps()} />);

    expect(screen.getByRole("textbox", { name: "Workflow name" })).toHaveValue("Workflow 1");
    expect(screen.getByRole("combobox", { name: "Workflow" })).toHaveValue("wf-1");
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("last run 4.2 s · 3 of 3 ok");
  });

  it("shows a read-only name outside the editor and hides Run", () => {
    render(<StudioHud {...makeProps({ activeMode: "dashboard" })} />);

    expect(screen.queryByRole("textbox", { name: "Workflow name" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Workflow" })).toHaveValue("wf-1");
    expect(screen.queryByRole("button", { name: "Run workflow" })).not.toBeInTheDocument();
  });

  it("runs the workflow from the primary Run pill", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(<StudioHud {...makeProps({ onRun })} />);

    await user.click(screen.getByRole("button", { name: "Run workflow" }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("loads the selected workflow from the picker", async () => {
    const user = userEvent.setup();
    const onLoadWorkflowById = vi.fn();
    render(<StudioHud {...makeProps({ onLoadWorkflowById })} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow" }), "wf-2");
    expect(onLoadWorkflowById).toHaveBeenCalledWith("wf-2");
  });

  it("moves export and import into the overflow menu", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<StudioHud {...makeProps({ onExport })} />);

    expect(screen.queryByRole("menuitem", { name: "Export JSON" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export JSON" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("offers import from another builder in the overflow and the palette", async () => {
    const user = userEvent.setup();
    const onImportExternal = vi.fn();
    render(<StudioHud {...makeProps({ onImportExternal })} />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Import from another builder…" }));
    expect(onImportExternal).toHaveBeenCalledTimes(1);

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("another builder");
    expect(screen.getByText("Import from another builder")).toBeInTheDocument();
  });

  it("hides import from another builder when the handler is absent", async () => {
    const user = userEvent.setup();
    render(<StudioHud {...makeProps()} />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "Import from another builder…" })).not.toBeInTheDocument();
  });

  it("opens the command palette with Ctrl+K and closes it with Escape", async () => {
    const user = userEvent.setup();
    render(<StudioHud {...makeProps()} />);

    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("renders the navigation menu button only when the drawer is wired up", async () => {
    const user = userEvent.setup();
    const onToggleNavDrawer = vi.fn();
    const { unmount } = render(<StudioHud {...makeProps()} />);
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
    unmount();

    render(<StudioHud {...makeProps({ onToggleNavDrawer, navDrawerOpen: false })} />);
    const menu = screen.getByRole("button", { name: "Open navigation" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveAttribute("aria-controls", "app-sidebar");
    await user.click(menu);
    expect(onToggleNavDrawer).toHaveBeenCalledTimes(1);
  });

  it("offers Save in the editor overflow for phone widths where the Save pill is hidden", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<StudioHud {...makeProps({ onSave, isDirty: true })} />);

    expect(screen.getByRole("button", { name: /Save/ })).toHaveClass("hud-secondary");
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Save (unsaved changes)" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("logs out from the account menu", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    render(<StudioHud {...makeProps({ onLogout })} />);

    await user.click(screen.getByRole("button", { name: "admin" }));
    await user.click(screen.getByRole("menuitem", { name: "Logout" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

describe("deriveRunStatus", () => {
  it("reports running while busy", () => {
    expect(deriveRunStatus(true, null)).toEqual({ state: "running", label: "running…" });
  });

  it("reports idle without a result", () => {
    expect(deriveRunStatus(false, null).state).toBe("idle");
  });

  it("summarises the last run", () => {
    const status = deriveRunStatus(false, {
      workflowId: "wf-1",
      status: "success",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:42.000Z",
      nodeResults: [
        { nodeId: "a", status: "success", startedAt: "2026-01-01T00:00:00.000Z" },
        { nodeId: "b", status: "error", startedAt: "2026-01-01T00:00:00.000Z" }
      ]
    });
    expect(status).toEqual({ state: "ok", label: "last run 42 s · 1 of 2 ok · 1 failed" });
  });

  it("ignores skipped attachment nodes in the summary", () => {
    const status = deriveRunStatus(false, {
      workflowId: "wf-1",
      status: "success",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      nodeResults: [
        { nodeId: "trigger", status: "success", startedAt: "2026-01-01T00:00:00.000Z" },
        { nodeId: "agent", status: "success", startedAt: "2026-01-01T00:00:00.000Z" },
        { nodeId: "chat_model", status: "skipped", startedAt: "2026-01-01T00:00:00.000Z" }
      ]
    });
    expect(status.label).toBe("last run 1.0 s · 2 ok");
  });

  it("flags failed runs", () => {
    const status = deriveRunStatus(false, {
      workflowId: "wf-1",
      status: "error",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.500Z",
      nodeResults: [],
      error: "boom"
    });
    expect(status.state).toBe("error");
    expect(status.label).toContain("500 ms");
  });
});
