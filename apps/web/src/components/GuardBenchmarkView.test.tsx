import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GuardBenchmarkListEntry, GuardBenchmarkReport, GuardBenchmarkResponse, GuardProfileSummary, GuardProfileVersionView, Project, WorkflowListItem } from "@ai-orchestrator/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { GuardBenchmarkView } from "./GuardBenchmarkView";
import { GuardProfilesView } from "./GuardProfilesView";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchGuardProfiles: vi.fn(),
    fetchGuardProfile: vi.fn(),
    fetchGuardProfileVersions: vi.fn(),
    fetchGuardDetectors: vi.fn(),
    fetchGuardProjectBinding: vi.fn(),
    fetchGuardWorkflowBinding: vi.fn(),
    fetchGuardSimulations: vi.fn(),
    fetchGuardBenchmarks: vi.fn(),
    fetchGuardBenchmark: vi.fn(),
    runGuardBenchmark: vi.fn()
  };
});

const now = "2026-11-04T10:00:00.000Z";
const profiles: GuardProfileSummary[] = [
  { id: "default", name: "Default rule set", builtIn: true, latestVersion: 1, hash: "aaaaaaaaaaaaaaaa", createdAt: now, updatedAt: now },
  { id: "strict", name: "Strict", builtIn: false, latestVersion: 2, hash: "bbbbbbbbbbbbbbbb", createdAt: now, updatedAt: now }
];

function report(detectedJailbreak: number, version = "1"): GuardBenchmarkReport {
  const category = (name: string, split: "main" | "heldout", detected: number) => ({
    category: name,
    split,
    channel: "prompt",
    owasp: ["LLM01"],
    attacks: 10,
    benign: 10,
    detected,
    falsePositives: 1,
    detectionRate: detected / 10,
    falsePositiveRate: 0.1,
    missed: detected < 10 ? ["jb-a02"] : [],
    flagged: [{ id: "jb-b03", action: "block", detectors: ["injection.direct"] }],
    attackActions: { block: detected },
    benignActions: { allow: 9, block: 1 }
  });
  return {
    format: "l2m.guard-benchmark",
    version: 1,
    generatedAt: now,
    profile: { id: "default", name: "Default rule set", version, hash: "h".repeat(64) },
    corpus: { hash: "c".repeat(64), items: 40, attacks: 20, benign: 20, categories: ["jailbreak"] },
    splits: ["main", "heldout"],
    totals: [
      { split: "main", attacks: 10, benign: 10, detected: detectedJailbreak, falsePositives: 1, detectionRate: detectedJailbreak / 10, falsePositiveRate: 0.1 },
      { split: "heldout", attacks: 10, benign: 10, detected: 3, falsePositives: 1, detectionRate: 0.3, falsePositiveRate: 0.1 }
    ],
    categories: [category("jailbreak", "main", detectedJailbreak), category("jailbreak", "heldout", 3)],
    detectors: [{ detectorId: "injection.direct", attacksCaught: 10, falsePositives: 2 }],
    latency: { p50Ms: 0.4, p95Ms: 2.5, maxMs: 4 },
    workflow: {
      suite: "reference",
      version: "1",
      categories: ["indirect_injection"],
      results: [{ configuration: "guard", split: "main", attacks: 20, benign: 20, detected: 20, detectionRate: 1, attackSucceeded: 0, attackSuccessRate: 0, falsePositives: 0, falsePositiveRate: 0, succeeded: [], flagged: [], pausedForApproval: 0 }]
    }
  };
}

const history: GuardBenchmarkListEntry[] = [
  { id: "gbm_2", profileId: "default", profileVersion: 1, profileHash: "h", corpusHash: "c", suites: ["profile", "workflow"], detectionRate: 0.5, falsePositiveRate: 0.1, splits: [{ split: "main", detectionRate: 0.7, falsePositiveRate: 0.1 }, { split: "heldout", detectionRate: 0.3, falsePositiveRate: 0.1 }], attackSuccessRate: 0, createdBy: "admin@example.com", createdAt: now },
  { id: "gbm_1", profileId: "default", profileVersion: 1, profileHash: "h", corpusHash: "old", suites: ["profile"], detectionRate: 0.5, falsePositiveRate: 0.1, splits: [{ split: "main", detectionRate: 0.6, falsePositiveRate: 0.2 }], attackSuccessRate: null, createdBy: null, createdAt: now }
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles, autoApply: true, builtInId: "default" });
  vi.mocked(api.fetchGuardBenchmarks).mockResolvedValue({ benchmarks: history });
  vi.mocked(api.fetchGuardBenchmark).mockResolvedValue({ benchmark: history[0]!, report: report(7) });
});

describe("Security > Benchmark", () => {
  it("shows the latest stored result by category and split, the workflow suite and the trend", async () => {
    render(<GuardBenchmarkView role="viewer" />);
    const totals = await screen.findByLabelText("Benchmark totals");
    expect(within(totals).getByText("70%")).toBeInTheDocument();
    expect(within(totals).getByText("30%")).toBeInTheDocument();
    const row = screen.getByRole("rowheader", { name: /Jailbreak/ }).closest("tr")!;
    expect(within(row).getByText("7/10")).toHaveAttribute("title", "Missed: jb-a02");
    expect(within(row).getByText("3/10")).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Rule set" })).toBeInTheDocument();
    const trend = screen.getByRole("table", { name: "Benchmark history" });
    expect(within(trend).getAllByRole("row")).toHaveLength(3);
    expect(within(trend).getByText("corpus changed")).toBeInTheDocument();
    // Viewers read; only builders and admins run.
    expect(screen.queryByRole("button", { name: "Run benchmark" })).toBeNull();
  });

  it("runs a benchmark of the saved version and says how it compares", async () => {
    const response: GuardBenchmarkResponse = {
      report: report(6),
      comparison: {
        ok: false,
        failures: [{ kind: "regression", category: "jailbreak", split: "main", metric: "detection", expected: 0.7, actual: 0.6, message: "jailbreak (main): detection fell from 70.0% to 60.0%" }],
        newlyMissed: [{ category: "jailbreak", split: "main", id: "jb-a03" }],
        newlyFlagged: [],
        corpusChanged: false
      },
      baseline: { id: "gbm_2", profileVersion: 1, createdAt: now },
      stored: { id: "gbm_3", createdAt: now },
      draft: false,
      partial: false
    };
    vi.mocked(api.runGuardBenchmark).mockResolvedValue(response);
    render(<GuardBenchmarkView role="builder" />);
    await screen.findByLabelText("Benchmark totals");
    await userEvent.click(screen.getByLabelText("Include the reference workflow suite"));
    await userEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    expect(api.runGuardBenchmark).toHaveBeenCalledWith("default", { suites: ["profile", "workflow"] });
    expect(await screen.findByRole("status")).toHaveTextContent("1 regression against the last stored benchmark (v1).");
    expect(within(screen.getByRole("list", { name: "Regressions" })).getByText(/detection fell from 70.0% to 60.0%/)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByLabelText("Benchmark totals")).getByText("60%")).toBeInTheDocument());
  });

  it("says when a rule set has no benchmark yet", async () => {
    vi.mocked(api.fetchGuardBenchmarks).mockResolvedValue({ benchmarks: [] });
    render(<GuardBenchmarkView role="viewer" />);
    expect(await screen.findByText("No benchmark of this rule set yet.")).toBeInTheDocument();
    expect(screen.getByText("A builder or an admin can run one.")).toBeInTheDocument();
  });
});

describe("Benchmark this draft", () => {
  const strictDoc = { id: "strict", name: "Strict", version: "2", channels: { prompt: { detectors: [{ id: "guard.dlp", threshold: 0.6 }], defaultAction: { action: "block" } } } };
  const versions: GuardProfileVersionView[] = [{ profileId: "strict", version: 2, hash: "bbbbbbbbbbbbbbbb", document: strictDoc, createdAt: now }];
  const projects = [{ id: "default", name: "Default Project" }] as Project[];
  const workflows = [] as WorkflowListItem[];

  beforeEach(() => {
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles: [profiles[1]!, profiles[0]!], autoApply: true, builtInId: "default" });
    vi.mocked(api.fetchGuardProfile).mockImplementation(async (id: string) =>
      id === "default"
        ? { profile: profiles[0]!, latest: { ...versions[0]!, profileId: "default", version: 1, document: { ...strictDoc, id: "default" } }, bindings: [] }
        : { profile: profiles[1]!, latest: versions[0]!, bindings: [] }
    );
    vi.mocked(api.fetchGuardProfileVersions).mockResolvedValue({ versions });
    vi.mocked(api.fetchGuardDetectors).mockResolvedValue({ channels: ["prompt"], detectors: [{ id: "guard.dlp", tier: "core", description: "Personal data", channels: ["prompt"], categories: ["sensitive_data"] }] });
    vi.mocked(api.fetchGuardProjectBinding).mockResolvedValue({
      binding: { projectId: "default", mode: "inherit", profileId: null, updatedAt: now, updatedBy: "admin", locked: false },
      effective: { source: "instance", enforced: null, stack: [], chain: [] }
    } as Awaited<ReturnType<typeof api.fetchGuardProjectBinding>>);
    vi.mocked(api.fetchGuardSimulations).mockResolvedValue({ simulations: [] });
  });

  it("benchmarks the editor's unsaved document and shows the result next to the latest stored one", async () => {
    vi.mocked(api.runGuardBenchmark).mockResolvedValue({ report: { ...report(9, "draft") }, comparison: { ok: true, failures: [], newlyMissed: [], newlyFlagged: [], corpusChanged: false }, baseline: { id: "gbm_2", profileVersion: 2, createdAt: now }, stored: null, draft: true, partial: false });
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    await userEvent.click(await screen.findByRole("button", { name: "Benchmark this draft" }));
    expect(api.runGuardBenchmark).toHaveBeenCalledWith("strict", { document: strictDoc });
    const card = await screen.findByTestId("guard-bench-draft");
    expect(card).toHaveTextContent("Detects 90% of attacks with 10% false positives (held-out: 30% and 10%).");
    expect(card).toHaveTextContent("No regression against the last stored benchmark (v2). The draft was not saved and its result is not stored.");
  });

  it("does not offer a builder a draft benchmark of the default rule set", async () => {
    vi.mocked(api.fetchGuardProfiles).mockResolvedValue({ profiles, autoApply: true, builtInId: "default" });
    render(<GuardProfilesView projects={projects} workflows={workflows} activeProjectId="default" role="builder" />);
    await screen.findByRole("button", { name: /Simulate on recent traffic/ });
    expect(screen.queryByRole("button", { name: "Benchmark this draft" })).toBeNull();
  });
});
