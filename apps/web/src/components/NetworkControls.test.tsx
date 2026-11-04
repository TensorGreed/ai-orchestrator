import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkSettingsView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { ClientNetwork, describeClientNetwork } from "./McpClientNetwork";
import { NetworkSettingsTab } from "./NetworkSettingsTab";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, updateMcpClientNetwork: vi.fn(), fetchNetworkSettings: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FP = "1b50219ee0272a0d26c7d09b2b293bd5b52c2fbcd7473c52d3ef982bfc293f58";

const client: api.McpClientView = {
  id: "mcc_1",
  name: "Team IDE",
  tokenPrefix: "l2m_mcp_abcdefghijkl",
  toolsetIds: ["mts_1"],
  role: "builder",
  createdBy: "usr_1",
  createdByEmail: "admin@example.com",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-10-20T10:00:00.000Z",
  allowedIps: [],
  certFingerprints: [],
  certSubject: null,
  status: "active",
  effectiveRole: "builder",
  activeSessions: 0,
  usage: { calls: 0, errors: 0, lastCalledAt: null }
};

describe("13.2 — client network settings", () => {
  it("summarises the lists", () => {
    expect(describeClientNetwork(client)).toBe("any address");
    expect(describeClientNetwork({ allowedIps: ["10.0.0.0/8"], certFingerprints: [FP, FP], certSubject: null })).toBe("1 address range · certificate pinned (2)");
  });

  it("validates entries before saving and saves the lists an admin enters", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSaved = vi.fn();
    vi.mocked(api.updateMcpClientNetwork).mockResolvedValue({ client: { ...client, allowedIps: ["10.0.0.0/8"], certFingerprints: [FP], certSubject: "agent" } });
    render(<ClientNetwork client={client} isAdmin onSaved={onSaved} />);
    await user.type(screen.getByLabelText("Allowed addresses"), "10.0.0.0/8{enter}bogus");
    await user.click(screen.getByRole("button", { name: "Save network settings" }));
    expect(await screen.findByText("'bogus' is not an IP address or CIDR range")).toBeTruthy();
    expect(api.updateMcpClientNetwork).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Allowed addresses"));
    await user.type(screen.getByLabelText("Allowed addresses"), "10.0.0.0/8");
    await user.type(screen.getByLabelText("Certificate fingerprints"), FP);
    await user.type(screen.getByLabelText("Certificate subject pin"), "agent");
    await user.click(screen.getByRole("button", { name: "Save network settings" }));
    await waitFor(() =>
      expect(api.updateMcpClientNetwork).toHaveBeenCalledWith("mcc_1", { allowedIps: ["10.0.0.0/8"], certFingerprints: [FP], certSubject: "agent" })
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ allowedIps: ["10.0.0.0/8"] }));
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("is read-only for non-admins and revoked clients", () => {
    render(<ClientNetwork client={{ ...client, allowedIps: ["10.0.0.0/8"] }} isAdmin={false} onSaved={() => undefined} />);
    expect((screen.getByLabelText("Allowed addresses") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save network settings" })).toBeNull();
  });
});

describe("13.2 — Settings > Network", () => {
  const view: NetworkSettingsView = {
    mode: "report",
    active: true,
    scopes: [
      { scope: "ui", env: "NETWORK_ALLOW_UI", ranges: ["10.0.0.0/8"], matched: true },
      { scope: "api", env: "NETWORK_ALLOW_API", ranges: ["192.168.0.0/16"], matched: false },
      { scope: "webhook", env: "NETWORK_ALLOW_WEBHOOK", ranges: [], matched: null },
      { scope: "public", env: "NETWORK_ALLOW_PUBLIC", ranges: [], matched: null },
      { scope: "mcp_gateway", env: "NETWORK_ALLOW_MCP_GATEWAY", ranges: [], matched: null },
      { scope: "metrics", env: "NETWORK_ALLOW_METRICS", ranges: [], matched: null }
    ],
    breakGlass: { ranges: ["127.0.0.0/8", "::1/128"], matched: false },
    trustProxy: { configured: true, summary: "1 hop trusted" },
    clientCertificate: { header: null, proxies: [] },
    yourIp: "10.1.2.3",
    matchedScopes: ["ui"],
    warnings: ["Report mode: nothing is refused."]
  };

  it("shows the lists read-only with the caller's address, the mode and the warnings", async () => {
    vi.mocked(api.fetchNetworkSettings).mockResolvedValue(view);
    render(<NetworkSettingsTab />);
    expect((await screen.findByTestId("network-your-ip")).textContent).toBe("Your address is 10.1.2.3, matched by: Studio (UI).");
    expect(screen.getByTestId("network-mode").textContent).toContain("Mode: report");
    expect(screen.getByTestId("network-scope-api").textContent).toContain("192.168.0.0/16");
    expect(screen.getByTestId("network-scope-api").textContent).toContain("Not listed");
    expect(screen.getByTestId("network-scope-webhook").textContent).toContain("Open");
    expect(screen.getByText("Report mode: nothing is refused.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
