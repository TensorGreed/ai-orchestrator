import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import type { AuditSigningKeysResponse, Project, RunManifestView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { AuditBundlePanel } from "./AuditBundlePanel";
import { AuditSigningKeysSection } from "./AuditSigningKeysSection";
import { ExecutionHistoryPanel } from "./ExecutionHistoryPanel";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchExecutionManifest: vi.fn(),
    downloadAuditBundle: vi.fn(),
    fetchAuditSigningKeys: vi.fn(),
    rotateAuditSigningKey: vi.fn(),
    fetchExecutionGuardEvents: vi.fn(),
    fetchMcpElicitations: vi.fn(),
    fetchMfaStatus: vi.fn()
  };
});

const DIGEST = "fdbbf3632246f303fe602ceba3688f28bac49af3d8cc6a7b80045be09e08122a";
const PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAx1vW3Q0aY3h8q3Q8e1yJ2v0nqv6m5Gm1n2F0d8c9mVQ=\n-----END PUBLIC KEY-----\n";

function manifestView(): RunManifestView {
  const now = "2026-10-22T16:38:11.205Z";
  return {
    executionId: "ex-1",
    digest: DIGEST,
    keyId: "49c841233ae6b5b6",
    algorithm: "Ed25519",
    signedAt: now,
    signature: "c2ln",
    manifest: {
      format: "l2m.run-manifest",
      manifestVersion: 1,
      generatedAt: now,
      deployment: { keyId: "49c841233ae6b5b6", algorithm: "Ed25519" },
      run: { executionId: "ex-1", status: "success", triggerType: "manual", subject: "admin@example.com", startedAt: now, completedAt: now, durationMs: 59, error: null, inputDigest: null, outputDigest: null },
      workflow: { id: "wf-1", name: "Workflow 1", schemaVersion: "1.0.0", workflowVersion: 3, savedVersion: 3, hash: "80f14b596af6e8d4ab6602221c4a019be179f094a82e1b8dd2e0777ae9f12e3a", source: "captured", nodeCount: 2, edgeCount: 1 },
      nodes: [],
      modelCalls: [],
      toolCalls: [],
      mcpServers: [],
      prompts: [],
      citations: [],
      approvals: [],
      totals: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, costUsd: null, modelCalls: 2, toolCalls: 1 }
    }
  };
}

function keys(overrides: Partial<AuditSigningKeysResponse> = {}): AuditSigningKeysResponse {
  return {
    activeKeyId: "49c841233ae6b5b6",
    canRotate: true,
    keys: [
      { keyId: "49c841233ae6b5b6", algorithm: "Ed25519", publicKey: "x1vW3Q0aY3h8q3Q8e1yJ2v0nqv6m5Gm1n2F0d8c9mVQ=", publicKeyPem: PEM, source: "generated", status: "active", createdAt: "2026-10-22T10:00:00.000Z", retiredAt: null },
      { keyId: "0a1b2c3d4e5f6a7b", algorithm: "Ed25519", publicKey: "b2xk", publicKeyPem: PEM, source: "generated", status: "retired", createdAt: "2026-09-01T10:00:00.000Z", retiredAt: "2026-10-22T10:00:00.000Z" }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchExecutionGuardEvents).mockResolvedValue({ events: [] });
  vi.mocked(api.fetchMcpElicitations).mockResolvedValue({ items: [] });
});

describe("Runs page: audit bundle", () => {
  it("shows the manifest digest, signing key and signed-at of a finished run, and downloads the bundle", async () => {
    vi.mocked(api.fetchExecutionManifest).mockResolvedValue(manifestView());
    vi.mocked(api.downloadAuditBundle).mockResolvedValue({ blob: new Blob(["zip"]), fileName: "l2m-audit-ex-1.zip", manifestDigest: DIGEST, keyId: "49c841233ae6b5b6" });
    const createUrl = vi.fn(() => "blob:bundle");
    const revokeUrl = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(
      <ExecutionHistoryPanel
        executionHistoryTotal={1}
        executionsLoading={false}
        executionsError={null}
        executionHistoryItems={[
          { id: "ex-1", workflowId: "wf-1", workflowName: "Workflow 1", status: "success", startedAt: "2026-10-22T16:38:04.642Z", completedAt: "2026-10-22T16:38:04.701Z", durationMs: 59, triggerType: "manual", triggeredBy: "admin@example.com", customData: {}, error: null, createdAt: "2026-10-22T16:38:04.642Z" }
        ]}
        workflowList={[]}
        filters={{ status: "", workflowId: "", startedFrom: "", startedTo: "" }}
        expandedExecutionIds={["ex-1"]}
        executionDetailById={{
          "ex-1": { id: "ex-1", workflowId: "wf-1", workflowName: "Workflow 1", status: "success", startedAt: "2026-10-22T16:38:04.642Z", completedAt: "2026-10-22T16:38:04.701Z", durationMs: 59, triggerType: "manual", triggeredBy: "admin@example.com", customData: {}, error: null, createdAt: "2026-10-22T16:38:04.642Z", input: {}, output: {}, nodeResults: [] }
        }}
        statusColors={{}}
        onFiltersChange={vi.fn()}
        onRefresh={vi.fn()}
        onToggleRow={vi.fn()}
        onDebugExecution={vi.fn()}
        onRerunExecution={vi.fn()}
        onCancelExecution={vi.fn()}
      />
    );

    const panel = await screen.findByRole("region", { name: "Audit bundle" });
    await waitFor(() => expect(within(panel).getByText("49c841233ae6b5b6")).toBeInTheDocument());
    expect(api.fetchExecutionManifest).toHaveBeenCalledWith("ex-1");
    expect(within(panel).getByTitle(DIGEST)).toHaveTextContent("sha256 fdbbf3632246…9e08122a");
    expect(within(panel).getByText("Signed at")).toBeInTheDocument();
    expect(within(panel).getByText(new Date("2026-10-22T16:38:11.205Z").toLocaleString())).toBeInTheDocument();
    expect(within(panel).getByText(/0 nodes · 0 model calls · 0 tool calls · 0 citations/)).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Audit bundle" }));
    await waitFor(() => expect(api.downloadAuditBundle).toHaveBeenCalledWith("ex-1"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:bundle");
  });

  it("shows a refused export inline", async () => {
    vi.mocked(api.fetchExecutionManifest).mockResolvedValue(manifestView());
    vi.mocked(api.downloadAuditBundle).mockRejectedValue(new api.ApiError("Audit bundle is 120 MB, over the limit", 413, { code: "too_large" }));
    render(<AuditBundlePanel executionId="ex-1" status="success" completedAt="2026-10-22T16:38:04.701Z" />);
    await userEvent.click(await screen.findByRole("button", { name: "Audit bundle" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("over the limit");
  });

  it("is not offered for runs still in progress", () => {
    const { container } = render(<AuditBundlePanel executionId="ex-1" status="running" completedAt={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.fetchExecutionManifest).not.toHaveBeenCalled();
  });
});

describe("Settings: audit signing keys", () => {
  function projects(): Project[] {
    return [{ id: "default", name: "Default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];
  }

  it("shows the active key id and public key with copy, download and rotate, plus retired keys", async () => {
    vi.mocked(api.fetchAuditSigningKeys).mockResolvedValue(keys());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AuditSigningKeysSection />);
    expect(await screen.findByText("49c841233ae6b5b6")).toBeInTheDocument();
    expect(screen.getByText(/BEGIN PUBLIC KEY/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy public key" }));
    expect(writeText).toHaveBeenCalledWith(PEM);
    expect(screen.getByRole("button", { name: "Rotate key" })).toBeInTheDocument();
    expect(screen.getByText("0a1b2c3d4e5f6a7b")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(2);
  });

  it("rotates after confirmation and shows the new key", async () => {
    vi.mocked(api.fetchAuditSigningKeys).mockResolvedValue(keys());
    const rotatedKeys = keys({ activeKeyId: "ffffeeeeddddcccc" });
    rotatedKeys.keys = [{ ...rotatedKeys.keys[0]!, keyId: "ffffeeeeddddcccc" }, { ...rotatedKeys.keys[0]!, status: "retired", retiredAt: "2026-10-22T11:00:00.000Z" }];
    vi.mocked(api.rotateAuditSigningKey).mockResolvedValue({ key: rotatedKeys.keys[0]!, keys: rotatedKeys });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AuditSigningKeysSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    expect(await screen.findByText(/New signing key ffffeeeeddddcccc is active/)).toBeInTheDocument();
    expect(api.rotateAuditSigningKey).toHaveBeenCalledTimes(1);
  });

  it("explains that an environment key is rotated by changing the variable", async () => {
    const envKeys = keys({ canRotate: false });
    envKeys.keys = [{ ...envKeys.keys[0]!, source: "env" }];
    vi.mocked(api.fetchAuditSigningKeys).mockResolvedValue(envKeys);
    render(<AuditSigningKeysSection />);
    expect(await screen.findByText(/rotate by changing it and restarting/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate key" })).not.toBeInTheDocument();
  });

  it("is an admin-only Settings tab", async () => {
    vi.mocked(api.fetchMfaStatus).mockResolvedValue({ enabled: false, pending: false, activatedAt: null, remainingBackupCodes: 0 });
    vi.mocked(api.fetchAuditSigningKeys).mockResolvedValue(keys());
    const { unmount } = render(<SettingsPage authUser={{ id: "u-1", email: "builder@example.com", role: "builder" }} projects={projects()} activeProjectId="default" />);
    expect(screen.queryByRole("tab", { name: "Audit Signing" })).not.toBeInTheDocument();
    unmount();
    render(<SettingsPage authUser={{ id: "u-2", email: "admin@example.com", role: "admin" }} projects={projects()} activeProjectId="default" />);
    await userEvent.click(screen.getByRole("tab", { name: "Audit Signing" }));
    expect(await screen.findByText("49c841233ae6b5b6")).toBeInTheDocument();
  });
});
