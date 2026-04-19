import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, WorkflowListItem } from "@ai-orchestrator/shared";
import { vi } from "vitest";
import type { StudioMode } from "./studio-layout-types";
import { TopBar } from "./TopBar";

function makeProps(overrides: Partial<Parameters<typeof TopBar>[0]> = {}): Parameters<typeof TopBar>[0] {
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
    ...overrides
  };
}

describe("TopBar", () => {
  it("renders workflow selector and project selector", () => {
    render(<TopBar {...makeProps()} />);

    expect(screen.getByRole("textbox", { name: "Workflow name" })).toHaveValue("Workflow 1");
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("default");
    expect(screen.getByRole("combobox", { name: "Workflow" })).toHaveValue("wf-1");
  });

  it("hides secrets tab when user cannot manage secrets", () => {
    render(<TopBar {...makeProps({ canManageSecrets: false })} />);
    expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
  });

  it("loads selected workflow from dropdown", async () => {
    const user = userEvent.setup();
    const onLoadWorkflowById = vi.fn();

    render(<TopBar {...makeProps({ onLoadWorkflowById })} />);

    const workflowSelect = screen.getByRole("combobox", { name: "Workflow" });
    await user.selectOptions(workflowSelect, "wf-2");
    expect(onLoadWorkflowById).toHaveBeenCalledWith("wf-2");
  });
});
