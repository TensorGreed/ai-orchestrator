import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectRetentionView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { ProjectRetentionOverrides, ProjectRetentionTab } from "./ProjectRetentionTab";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProjectRetention: vi.fn(), updateProjectRetention: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const projects = [
  { id: "proj-a", name: "Project A" },
  { id: "proj-b", name: "Project B" }
] as Project[];

function view(overrides: Partial<ProjectRetentionView> = {}): ProjectRetentionView {
  return {
    projectId: "proj-a",
    bounds: { minDays: 1, maxDays: null },
    exemptions: "Golden runs and golden-set cases, paused runs, pending approvals are never deleted by age.",
    canEdit: true,
    classes: [
      {
        class: "runs",
        label: "Runs",
        what: "Run history",
        deploymentDays: 30,
        deploymentSetting: "EXECUTION_HISTORY_RETENTION_DAYS",
        days: 7,
        effectiveDays: 7,
        clamped: false,
        updatedBy: "ana",
        updatedAt: "2026-11-10T00:00:00.000Z"
      },
      {
        class: "tool_calls",
        label: "Tool calls",
        what: "Telemetry",
        deploymentDays: 30,
        deploymentSetting: "EXECUTION_HISTORY_RETENTION_DAYS",
        days: null,
        effectiveDays: 30,
        clamped: false,
        updatedBy: null,
        updatedAt: null
      },
      {
        class: "rule_events",
        label: "Rule events",
        what: "Content rules events",
        deploymentDays: 30,
        deploymentSetting: "EXECUTION_HISTORY_RETENTION_DAYS",
        days: 1000,
        effectiveDays: 365,
        clamped: true,
        updatedBy: "ana",
        updatedAt: "2026-11-10T00:00:00.000Z"
      },
      {
        class: "agent_memory",
        label: "Agent memory",
        what: "Simple Memory sessions",
        deploymentDays: 0,
        deploymentSetting: "AGENT_MEMORY_RETENTION_DAYS",
        days: null,
        effectiveDays: 0,
        clamped: false,
        updatedBy: null,
        updatedAt: null
      }
    ],
    ...overrides
  };
}

describe("ProjectRetentionTab", () => {
  it("shows each class with its own value or the inherited default, and the exemptions", async () => {
    vi.mocked(api.fetchProjectRetention).mockResolvedValue(view());
    render(<ProjectRetentionTab projects={projects} initialProjectId="proj-a" />);
    expect(await screen.findByLabelText("Runs days")).toHaveValue(7);
    expect(screen.getByLabelText("Tool calls days")).toHaveValue(null);
    expect(screen.getByLabelText("Tool calls days")).toHaveAttribute("placeholder", "Default: 30 days");
    expect(screen.getByLabelText("Agent memory days")).toHaveAttribute("placeholder", "Default: Kept forever");
    expect(screen.getByTestId("project-retention-tool_calls")).toHaveTextContent("Inherited from EXECUTION_HISTORY_RETENTION_DAYS");
    expect(screen.getByTestId("project-retention-rule_events")).toHaveTextContent("nearest limit applies");
    expect(screen.getByTestId("retention-exemptions")).toHaveTextContent("Golden runs");
    expect(api.fetchProjectRetention).toHaveBeenCalledWith("proj-a");
  });

  it("saves only what changed: a new value, and null to go back to the deployment default", async () => {
    vi.mocked(api.fetchProjectRetention).mockResolvedValue(view());
    vi.mocked(api.updateProjectRetention).mockResolvedValue(view({ classes: view().classes.map((entry) => ({ ...entry })) }));
    render(<ProjectRetentionTab projects={projects} initialProjectId="proj-a" />);
    fireEvent.change(await screen.findByLabelText("Tool calls days"), { target: { value: "90" } });
    // "Use deployment default" on Runs clears its value.
    const runsRow = screen.getByTestId("project-retention-runs");
    fireEvent.click(runsRow.querySelector("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateProjectRetention).toHaveBeenCalledWith("proj-a", { runs: null, tool_calls: 90 }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("refuses a value that is not a whole number before calling the API, and shows the API's refusal", async () => {
    vi.mocked(api.fetchProjectRetention).mockResolvedValue(view());
    vi.mocked(api.updateProjectRetention).mockRejectedValue(new api.ApiError("Runs: must be at least 7 days", 400));
    render(<ProjectRetentionTab projects={projects} initialProjectId="proj-a" />);
    const runs = await screen.findByLabelText("Runs days");
    fireEvent.change(runs, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/enter a whole number of days/)).toBeInTheDocument();
    expect(api.updateProjectRetention).not.toHaveBeenCalled();
    fireEvent.change(runs, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Runs: must be at least 7 days")).toBeInTheDocument();
  });

  it("is read-only for members who cannot change it, and loads another project when picked", async () => {
    vi.mocked(api.fetchProjectRetention).mockResolvedValue(view({ canEdit: false }));
    render(<ProjectRetentionTab projects={projects} initialProjectId="proj-a" />);
    expect(await screen.findByText(/Only admins and this project's admins/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Runs days")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByTestId("project-retention-tool_calls")).toHaveTextContent("Deployment default");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "proj-b" } });
    await waitFor(() => expect(api.fetchProjectRetention).toHaveBeenLastCalledWith("proj-b"));
  });
});

describe("ProjectRetentionOverrides", () => {
  it("lists projects with their own values, and nothing when there are none", () => {
    const { container, rerender } = render(<ProjectRetentionOverrides overrides={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ProjectRetentionOverrides overrides={[{ projectId: "proj-a", projectName: "Project A", classes: { runs: 7, agent_memory: 0 } }]} />);
    expect(screen.getByTestId("retention-override-proj-a")).toHaveTextContent("Project A");
    expect(screen.getByTestId("retention-override-proj-a")).toHaveTextContent("Runs: 7 days, Agent memory: Kept forever");
  });
});
