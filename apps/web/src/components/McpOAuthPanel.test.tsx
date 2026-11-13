import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpOAuthConnectionStatus } from "@ai-orchestrator/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { McpOAuthPanel } from "./McpOAuthPanel";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMcpServerOAuth: vi.fn(),
    resetMcpServerOAuthIssuerBinding: vi.fn()
  };
});

function status(overrides: Partial<McpOAuthConnectionStatus> = {}): McpOAuthConnectionStatus {
  return {
    serverId: "mcp_1",
    state: "connected",
    subject: null,
    scope: null,
    authorizationServer: "https://as.example.test",
    clientRegistration: "pre_registered",
    clientId: "l2m-client",
    expiresAt: null,
    hasRefreshToken: false,
    lastRefreshAt: null,
    connectedAt: null,
    connectedBy: null,
    lastError: null,
    updatedAt: null,
    redirectUri: "https://l2m.example.test/api/mcp/oauth/callback",
    issuerBinding: { clientId: "l2m-client", issuer: "https://as.example.test", boundAt: "2026-11-12T10:00:00.000Z" },
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("McpOAuthPanel issuer binding", () => {
  it("shows the bound authorization server and lets an admin reset it after confirming", async () => {
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: status() });
    vi.mocked(api.resetMcpServerOAuthIssuerBinding).mockResolvedValue({ status: status({ issuerBinding: null }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);

    expect(await screen.findByText("Client id bound to")).toBeInTheDocument();
    const reset = screen.getByRole("button", { name: "Reset" });
    await userEvent.click(reset);
    expect(api.resetMcpServerOAuthIssuerBinding).toHaveBeenCalledWith("mcp_1");
    await waitFor(() => expect(screen.queryByText("Client id bound to")).not.toBeInTheDocument());
  });

  it("does nothing when the admin cancels", async () => {
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: status() });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect(api.resetMcpServerOAuthIssuerBinding).not.toHaveBeenCalled();
  });

  it("shows the binding without a reset button to non-admins, and nothing when unbound", async () => {
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: status() });
    render(<McpOAuthPanel serverId="mcp_1" isAdmin={false} />);
    expect(await screen.findByText("Client id bound to")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
    cleanup();

    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: status({ issuerBinding: null }) });
    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    expect(await screen.findByText("Authorization server")).toBeInTheDocument();
    expect(screen.queryByText("Client id bound to")).not.toBeInTheDocument();
  });
});

describe("McpOAuthPanel scope step-up notice", () => {
  it("shows a connected server's missing scope as a status note, and errors only as errors", async () => {
    const note = "The server refused an operation because the connection lacks OAuth scope (tools:admin). Reconnect it to grant the scope; the existing scope is kept.";
    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: status({ lastError: note }) });
    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    expect(await screen.findByRole("status")).toHaveTextContent("tools:admin");
    cleanup();

    vi.mocked(api.fetchMcpServerOAuth).mockResolvedValue({ status: status() });
    render(<McpOAuthPanel serverId="mcp_1" isAdmin />);
    expect(await screen.findByText("Authorization server")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
