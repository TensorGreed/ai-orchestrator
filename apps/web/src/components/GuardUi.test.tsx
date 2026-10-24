import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GuardEventView, GuardProfileSummary, GuardSimulationView, GuardProfileVersionView, Project, WorkflowListItem } from "@ai-orchestrator/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { GuardTracePanel } from "./GuardTracePanel";
import { GuardSecurityPage } from "./GuardSecurityPage";
import { GuardProfilesView } from "./GuardProfilesView";
import { GuardProtectionFields } from "./GuardNodeConfigFields";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchExecutionGuardEvents: vi.fn(),
    fetchGuardEvents: vi.fn(),
    fetchGuardStats: vi.fn(),
    fetchGuardProfiles: vi.fn(),
    fetchGuardProfile: vi.fn(),
    fetchGuardProfileVersions: vi.fn(),
    fetchGuardDetectors: vi.fn(),
    fetchGuardProjectBinding: vi.fn(),
    updateGuardProjectBinding: vi.fn(),
    fetchGuardWorkflowBinding: vi.fn(),
    updateGuardProfile: vi.fn(),
    simulateGuardProfile: vi.fn(),
    fetchGuardSimulation: vi.fn()
  };
});

const now = new Date().toISOString();
const profiles: GuardProfileSummary[] = [
  { id: "default", name: "Default guard profile", builtIn: true, latestVersion: 1, hash: "aaaaaaaaaaaaaaaa", createdAt: now, updatedAt: now },
  { id: "strict", name: "Strict", builtIn: false, latestVersion: 2, hash: "bbbbbbbbbbbbbbbb", createdAt: now, updatedAt: now }
];
const strictDoc = {
  id: "strict",
  name: "Strict",
  version: "2",
  channels: { prompt: { detectors: [{ id: "guard.dlp", threshold: 0.6 }], actions: { email: { action: "mask" } }, defaultAction: { action: "block" } } }
};
const versions: GuardProfileVersionView[] = [
  { profileId: "strict", version: 2, hash: "bbbbbbbbbbbbbbbb", document: strictDoc, note: "tighter", createdAt: now },
  { profileId: "strict", version: 1, hash: "cccccccccccccccc", document: strictDoc, createdAt: now }
];
const projects = [{ id: "default", name: "Default Project" }] as Project[];
const workflows = [{ id: "wf-1", name: "Support agent", projectId: "default" }] as WorkflowListItem[];

const enforcedBinding = {
  binding: { projectId: "default", mode: "enforced" as const, profileId: "strict", updatedAt: now, updatedBy: "admin", locked: true },
  effective: {
    source: "enforced" as const,
    enforced: { profileId: "strict", version: 2, hash: "b", name: "Strict" },
    stack: [{ profileId: "strict", version: 2, hash: "b", name: "Strict" }],
    chain: [{ level: "project" as const, mode: "enforced" as const, profileId: "strict", version: 2 }]
  }
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles, autoApply: true, builtInId: "default" });
  vi.mocked(api.fetchGuardProfile).mockResolvedValue({ profile: profiles[1]!, latest: versions[0]!, bindings: [] });
  vi.mocked(api.fetchGuardProfileVersions).mockResolvedValue({ versions });
  vi.mocked(api.fetchGuardDetectors).mockResolvedValue({
    channels: ["prompt"],
    detectors: [
      { id: "guard.dlp", tier: "core", description: "Personal data", channels: ["prompt"], categories: ["sensitive_data"] },
      { id: "guard.injection.direct", tier: "core", description: "Prompt injection", channels: ["prompt"], categories: ["prompt_injection"] }
    ]
  });
  vi.mocked(api.fetchGuardProjectBinding).mockResolvedValue(enforcedBinding);
});

describe("GuardTracePanel", () => {
  it("shows guard verdicts with masked evidence and a shadow badge, and fills in failed nodes from events", async () => {
    vi.mocked(api.fetchExecutionGuardEvents).mockResolvedValue({
      events: [
        {
          id: "e1",
          verdictId: "v9",
          executionId: "x1",
          workflowId: "wf-1",
          projectId: "default",
          nodeId: "writer",
          placement: "agent",
          iteration: 3,
          channel: "final_output",
          detectorId: "guard.canary",
          category: "canary_leak",
          score: 1,
          requestedAction: "block",
          effectiveAction: "block",
          verdictAction: "block",
          shadow: false,
          evidence: [{ evidence: "L2M-****" }],
          profileId: "default",
          profileVersion: 1,
          profileHash: "h",
          latencyMs: 2,
          budgetExceeded: false,
          skippedDetectors: [],
          createdAt: now
        } as GuardEventView
      ]
    });
    render(
      <GuardTracePanel
        executionId="x1"
        nodeResults={[
          {
            nodeId: "g1",
            status: "success",
            output: {
              guard: {
                action: "mask",
                route: "pass",
                channel: "prompt",
                source: "workflow",
                verdicts: [
                  {
                    profile: { profileId: "strict", version: 2, hash: "b" },
                    summary: {
                      action: "mask",
                      shadowAction: "block",
                      findings: [{ detectorId: "guard.dlp", category: "sensitive_data", dataClass: "email", score: 0.91, evidence: "j***@e***.com" }],
                      actions: [{ detectorId: "guard.dlp", requested: "mask", effective: "mask", shadow: false }],
                      timings: { totalMs: 1.2, detectors: [{ detectorId: "guard.dlp", durationMs: 0.8, status: "ran" }] },
                      budget: { exceeded: false, skippedDetectors: [] }
                    }
                  }
                ]
              }
            }
          }
        ]}
      />
    );
    const panel = await screen.findByRole("region", { name: "Guard verdicts" });
    expect(within(panel).getByText("j***@e***.com")).toBeInTheDocument();
    expect(within(panel).getByText(/shadow: would blocked/i)).toBeInTheDocument();
    expect(within(panel).getByText("workflow binding")).toBeInTheDocument();
    expect(await within(panel).findByText("writer")).toBeInTheDocument();
    expect(within(panel).getByText("L2M-****")).toBeInTheDocument();
    expect(within(panel).getByText("2 verdicts · 2 nodes")).toBeInTheDocument();
  });

  it("lists an enforced profile evaluated twice, and its repeated finding, once (no duplicate keys)", async () => {
    vi.mocked(api.fetchExecutionGuardEvents).mockResolvedValue({ events: [] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = (hash: string, action: string) => ({
      profile: { profileId: "support-baseline", version: 2, hash, name: "Support baseline" },
      summary: {
        action,
        channel: "prompt",
        findings: [{ detectorId: "dlp.patterns", category: "sensitive_data", dataClass: "email", score: 0.9, evidence: "j***@e***.com" }],
        actions: [{ requested: action, effective: action, shadow: false }],
        shadowAction: "allow",
        timings: { totalMs: 1, detectors: [{ detectorId: "dlp.patterns", durationMs: 0.5, status: "ran" }] },
        budget: { exceeded: false, skippedDetectors: [] }
      }
    });
    render(
      <GuardTracePanel
        executionId="x3"
        nodeResults={[
          {
            nodeId: "guard",
            output: {
              guard: {
                action: "review",
                channel: "prompt",
                source: "enforced",
                profiles: [
                  { profileId: "support-baseline", version: 2, hash: "a", name: "Support baseline" },
                  { profileId: "support-baseline", version: 2, hash: "b", name: "Support baseline" }
                ],
                verdicts: [entry("a", "mask"), entry("b", "review")]
              }
            }
          }
        ]}
      />
    );
    await waitFor(() => expect(api.fetchExecutionGuardEvents).toHaveBeenCalled());
    expect(screen.getAllByText(/Support baseline v2/)).toHaveLength(1);
    expect(screen.getByText("Support baseline v2 + tightened")).toBeInTheDocument();
    expect(screen.getAllByText("j***@e***.com")).toHaveLength(1);
    // One finding row and one timing for the detector, the two evaluations added up.
    expect(document.querySelectorAll(".guard-finding")).toHaveLength(1);
    expect(screen.getByLabelText("Detector timings")).toHaveTextContent(/^dlp\.patterns 1 ms$/);
    expect(errors.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    errors.mockRestore();
  });

  it("renders nothing for a run without guard activity", async () => {
    vi.mocked(api.fetchExecutionGuardEvents).mockResolvedValue({ events: [] });
    const { container } = render(<GuardTracePanel executionId="x2" nodeResults={[{ nodeId: "a", output: { answer: "hi" } }]} />);
    await waitFor(() => expect(api.fetchExecutionGuardEvents).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Security page", () => {
  it("shows totals, top detectors and masked latest events with run links", async () => {
    vi.mocked(api.fetchGuardStats).mockResolvedValue({
      since: null,
      stats: {
        verdicts: [
          { key: "block", count: 3 },
          { key: "allow", count: 10 },
          { key: "mask", count: 2 }
        ],
        actions: [{ key: "block", count: 3 }],
        categories: [{ key: "indirect_injection", count: 3 }],
        channels: [{ key: "tool_result", count: 3 }],
        detectors: [{ key: "guard.injection.indirect", count: 3 }],
        shadowWouldBlock: 4,
        shadowFindings: 5,
        budgetExceeded: 0,
        daily: [{ day: now.slice(0, 10), action: "block", count: 3 }]
      }
    } as Awaited<ReturnType<typeof api.fetchGuardStats>>);
    vi.mocked(api.fetchGuardEvents).mockResolvedValue({
      total: 1,
      events: [
        {
          id: "e1",
          verdictId: "v1",
          executionId: "exec-12345678",
          workflowId: "wf-1",
          workflowName: "Support agent",
          projectId: "default",
          nodeId: "agent",
          placement: "agent",
          iteration: 1,
          toolName: "fetch_page",
          channel: "tool_result",
          detectorId: "guard.injection.indirect",
          category: "indirect_injection",
          score: 0.93,
          requestedAction: "block",
          effectiveAction: "block",
          verdictAction: "block",
          shadow: false,
          evidence: [{ evidence: "ignore previous instru…" }],
          profileId: "default",
          profileVersion: 1,
          profileHash: "h",
          latencyMs: 4,
          budgetExceeded: false,
          skippedDetectors: [],
          createdAt: now
        }
      ]
    } as Awaited<ReturnType<typeof api.fetchGuardEvents>>);
    const onOpenRun = vi.fn();
    render(<GuardSecurityPage projects={projects} workflows={workflows} role="viewer" onOpenRun={onOpenRun} />);
    const totals = await screen.findByLabelText("Totals");
    await waitFor(() => expect(within(totals).getByText("15")).toBeInTheDocument());
    expect(within(totals).getByText("4")).toBeInTheDocument();
    expect(screen.getByText("ignore previous instru…")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Top detectors")).getByText("guard.injection.indirect")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "exec-123" }));
    expect(onOpenRun).toHaveBeenCalledWith("exec-12345678");

    await userEvent.selectOptions(screen.getByLabelText("Workflow"), "wf-1");
    await waitFor(() => expect(api.fetchGuardStats).toHaveBeenLastCalledWith(expect.objectContaining({ workflowId: "wf-1" })));
  });
});

describe("Profile editor and bindings", () => {
  it("shows the enforced lock to a builder, who cannot change it", async () => {
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    expect(await screen.findByRole("note")).toHaveTextContent(/Enforced by an admin/);
    const bindings = screen.getByRole("region", { name: "Bindings" });
    const modeSelects = within(bindings).getAllByLabelText("Mode");
    expect(modeSelects[0]).toBeDisabled();
    expect(within(bindings).getByText(/Strict v2 · enforced/)).toBeInTheDocument();
  });

  it("lets an admin change an enforced binding", async () => {
    vi.mocked(api.updateGuardProjectBinding).mockResolvedValue({
      binding: { projectId: "default", mode: "override", profileId: "strict", updatedAt: now, updatedBy: "admin", locked: false },
      effective: { source: "project", enforced: null, stack: [{ profileId: "strict", version: 2, hash: "b" }], chain: [] }
    });
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="admin" />);
    await screen.findByRole("note");
    const bindings = screen.getByRole("region", { name: "Bindings" });
    const mode = within(bindings).getAllByLabelText("Mode")[0]!;
    expect(mode).toBeEnabled();
    await userEvent.selectOptions(mode, "override");
    expect(api.updateGuardProjectBinding).toHaveBeenCalledWith("default", { mode: "override", profileId: "strict" });
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
  });

  it("edits a channel and saves a new version, showing field errors from the API", async () => {
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [profiles[1]!, profiles[0]!], autoApply: true, builtInId: "default" });
    vi.mocked(api.updateGuardProfile).mockRejectedValueOnce(
      new api.ApiError("Invalid guard profile", 400, { issues: [{ path: "channels.prompt.detectors.0.threshold", message: "Number must be less than or equal to 1" }] })
    );
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    const detector = await screen.findByRole("checkbox", { name: "guard.injection.direct" });
    await userEvent.click(detector);
    await userEvent.click(screen.getByRole("button", { name: "Save new version" }));
    expect(api.updateGuardProfile).toHaveBeenCalledWith(
      "strict",
      expect.objectContaining({ document: expect.objectContaining({ channels: expect.objectContaining({ prompt: expect.objectContaining({ detectors: [{ id: "guard.dlp", threshold: 0.6 }, { id: "guard.injection.direct", threshold: 0.5 }] }) }) }) })
    );
    expect(await screen.findByText("channels.prompt.detectors.0.threshold")).toBeInTheDocument();
  });

  it("keeps the built-in profile read-only", async () => {
    vi.mocked(api.fetchGuardProfile).mockResolvedValue({ profile: profiles[0]!, latest: { ...versions[1]!, profileId: "default", version: 1 }, bindings: [] });
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="admin" />);
    expect(await screen.findByText("built-in · read-only")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simulate on recent traffic" })).toBeNull();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
  });
});

describe("Simulate on recent traffic", () => {
  const counts = { newlyBlocked: 0, noLongerBlocked: 0, actionChanged: 0, nowMasked: 0, unchanged: 0, notReached: 0 };
  const done: GuardSimulationView = {
    id: "gsim_1",
    profileId: "strict",
    source: { kind: "inline", version: null, hash: "h" },
    baseVersion: 2,
    status: "completed",
    createdAt: now,
    createdBy: "builder@example.com",
    finishedAt: now,
    jobIds: ["run_1"],
    summary: {
      runs: 2, workflows: 1, compared: 1, diverged: 1, notSimulated: 0,
      runsNewlyBlocked: 1, runsNowMasked: 1, runsNoLongerBlocked: 0, runsChanged: 2, runsUnchanged: 0,
      checkpoints: { ...counts, newlyBlocked: 1, actionChanged: 1, nowMasked: 1 },
      byDataClass: { email: { newlyBlocked: 1, noLongerBlocked: 0, actionChanged: 1 } },
      byDetector: { "guard.dlp": { newlyBlocked: 1, noLongerBlocked: 0, actionChanged: 1 } },
      sentence: "Across 2 recent runs in 1 workflow: 1 newly blocked, 1 now masked, 0 no longer blocked. 1 run diverged after the guard change."
    },
    workflows: [
      {
        workflowId: "wf-1", workflowName: "Support agent", projectId: "default", jobId: "run_1",
        cases: [
          { recordingId: "r1", recordingName: "Refund question", recordedAt: now, executionId: "e1", outcome: "compared", counts: { ...counts, newlyBlocked: 1 },
            checkpoints: [{ nodeId: "agent", placement: "pre_model", channel: "prompt", occurrence: 1, before: "allow", after: "block", change: "newly_blocked", detectors: [] }] },
          { recordingId: "r2", recordingName: "Order email", recordedAt: now, executionId: "e2", outcome: "diverged", divergedAt: { step: 1, kind: "model", nodeId: "agent", message: "" },
            counts: { ...counts, actionChanged: 1, nowMasked: 1 }, checkpoints: [] }
        ]
      }
    ]
  };

  it("simulates the unsaved document and shows one sentence with the detail behind it", async () => {
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [profiles[1]!, profiles[0]!], autoApply: true, builtInId: "default" });
    vi.mocked(api.simulateGuardProfile).mockResolvedValue({ simulation: { ...done, status: "running", summary: null, workflows: undefined, progress: { done: 0, total: 2 } } });
    vi.mocked(api.fetchGuardSimulation).mockResolvedValue({ simulation: done });
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "guard.injection.direct" }));
    await userEvent.click(screen.getByRole("button", { name: "Simulate on recent traffic" }));
    expect(api.simulateGuardProfile).toHaveBeenCalledWith("strict", {
      document: expect.objectContaining({ channels: expect.objectContaining({ prompt: expect.objectContaining({ detectors: [{ id: "guard.dlp", threshold: 0.6 }, { id: "guard.injection.direct", threshold: 0.5 }] }) }) })
    });
    expect(api.updateGuardProfile).not.toHaveBeenCalled();
    expect(await screen.findByText(/0 of 2 runs replayed/)).toBeInTheDocument();
    expect(await screen.findByTestId("guard-sim-sentence", {}, { timeout: 3000 })).toHaveTextContent("Across 2 recent runs in 1 workflow: 1 newly blocked, 1 now masked, 0 no longer blocked.");
    expect(screen.getByText(/nothing called a model/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Details"));
    expect(screen.getByText("Refund question")).toBeInTheDocument();
    expect(screen.getByText(/Diverged at step 1/)).toBeInTheDocument();
    expect(screen.getAllByText("email").length).toBeGreaterThan(0);
  });

  it("can simulate a saved version from Advanced, and explains an empty result", async () => {
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [profiles[1]!, profiles[0]!], autoApply: true, builtInId: "default" });
    vi.mocked(api.simulateGuardProfile).mockResolvedValue({
      simulation: { ...done, source: { kind: "version", version: 1, hash: "c" }, jobIds: [], workflows: [], summary: { ...done.summary!, runs: 0, workflows: 0, sentence: "No recent recorded runs to simulate." }, emptyReason: "No workflow you can read uses this profile." }
    });
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    await userEvent.click(await screen.findByRole("button", { name: "Simulate on recent traffic" }));
    expect(await screen.findByText("No recent runs to simulate on yet.")).toBeInTheDocument();
    expect(screen.getByText("No workflow you can read uses this profile.")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Advanced"));
    await userEvent.selectOptions(screen.getByLabelText("Version to simulate"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Simulate version" }));
    expect(api.simulateGuardProfile).toHaveBeenLastCalledWith("strict", { version: 1 });
  });

  it("shows field issues for an invalid document", async () => {
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [profiles[1]!, profiles[0]!], autoApply: true, builtInId: "default" });
    vi.mocked(api.simulateGuardProfile).mockRejectedValue(new api.ApiError("Invalid guard profile", 400, { issues: [{ path: "channels.prompt.defaultAction.action", message: "Invalid enum value" }] }));
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    await userEvent.click(await screen.findByRole("button", { name: "Simulate on recent traffic" }));
    expect(await screen.findByText("channels.prompt.defaultAction.action")).toBeInTheDocument();
  });

  it("is not offered to viewers or on the built-in profile", async () => {
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="viewer" />);
    await screen.findByLabelText("Name");
    expect(screen.queryByRole("button", { name: "Simulate on recent traffic" })).toBeNull();
  });
});

describe("Protection provider fields", () => {
  it("stores only a secret reference for the key", async () => {
    let config: Record<string, unknown> = { providerId: "keyed_hash", dataClasses: ["email"] };
    const setConfig = (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
      config = update(config);
    };
    render(<GuardProtectionFields config={config} setConfig={setConfig} secrets={[{ id: "sec_1", name: "Hash key", provider: "custom", createdAt: now } as api.SecretListItem]} />);
    await userEvent.selectOptions(screen.getByLabelText("Key (from Secrets)"), "sec_1");
    expect(config.keySecretRef).toEqual({ secretId: "sec_1" });
    expect(JSON.stringify(config)).not.toMatch(/key"\s*:\s*"/i);
  });
});
