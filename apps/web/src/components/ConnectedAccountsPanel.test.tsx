import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedAccountProviderView } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import type { SecretListItem } from "../lib/api";
import { ConnectedAccountsPanel } from "./ConnectedAccountsPanel";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchConnectProviders: vi.fn(),
    saveConnectApp: vi.fn(),
    deleteConnectApp: vi.fn(),
    refreshConnectedAccount: vi.fn(),
    disconnectConnectedAccount: vi.fn(),
    startConnect: vi.fn()
  };
});

const redirectUrl = "https://l2m.example.com/api/connect/callback";
function provider(id: "slack" | "google", overrides: Partial<ConnectedAccountProviderView> = {}): ConnectedAccountProviderView {
  return {
    id,
    label: id === "slack" ? "Slack" : "Google",
    configured: false,
    appScope: null,
    clientId: null,
    tenant: null,
    redirectUrl,
    consoleUrl: "https://console.example.test",
    setupSteps: [`Add this exact redirect URL: ${redirectUrl}`],
    scopeSets:
      id === "google"
        ? [
            { id: "sheets", label: "Sheets", description: "Read and write spreadsheets", default: true },
            { id: "gmail", label: "Gmail (send)", description: "Send mail", default: false }
          ]
        : [],
    canConfigureProject: true,
    canConfigureInstance: true,
    ...overrides
  };
}

const account: SecretListItem = {
  id: "sec_acct",
  name: "Slack · Acme",
  provider: "oauth_account",
  createdAt: "2026-11-20T00:00:00.000Z",
  connection: {
    providerId: "slack",
    accountLabel: "Acme",
    scopes: ["chat:write"],
    status: "needs_reconnect",
    expiresAt: null,
    refreshable: true,
    lastError: "invalid_grant",
    connectedBy: "ana@example.com",
    connectedAt: "2026-11-20T00:00:00.000Z",
    lastRefreshAt: null
  }
};

describe("ConnectedAccountsPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("sets up an app with the exact redirect URL shown, then offers Connect", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchConnectProviders)
      .mockResolvedValueOnce({ redirectUrl, providers: [provider("slack"), provider("google")] })
      .mockResolvedValueOnce({ redirectUrl, providers: [provider("slack", { configured: true, appScope: "instance", clientId: "c1" }), provider("google")] });
    vi.mocked(api.saveConnectApp).mockResolvedValue({ id: "slack:*", providerId: "slack", projectId: null, clientId: "c1" });
    render(<ConnectedAccountsPanel projectId="default" secrets={[]} onChanged={vi.fn()} />);
    const slack = await screen.findByTestId("connect-provider-slack");
    expect(within(slack).getByText("No app set up yet")).toBeVisible();
    expect(within(slack).queryByRole("button", { name: "Connect Slack" })).toBeNull();
    await user.click(within(slack).getByRole("button", { name: "Set up app" }));
    expect(within(slack).getByLabelText("Redirect URL")).toHaveValue(redirectUrl);
    expect(within(slack).getByText(`Add this exact redirect URL: ${redirectUrl}`)).toBeVisible();
    expect(within(slack).getByRole("button", { name: "Save app" })).toBeDisabled();
    await user.type(within(slack).getByLabelText("Client ID"), "c1");
    await user.type(within(slack).getByLabelText("Client secret"), "s1");
    await user.click(within(slack).getByRole("button", { name: "Save app" }));
    expect(api.saveConnectApp).toHaveBeenCalledWith("slack", { projectId: null, clientId: "c1", clientSecret: "s1" });
    expect(await within(screen.getByTestId("connect-provider-slack")).findByRole("button", { name: "Connect Slack" })).toBeVisible();
  });

  it("lists accounts with their state, and offers Reconnect for one that needs it", async () => {
    vi.mocked(api.fetchConnectProviders).mockResolvedValue({ redirectUrl, providers: [provider("slack", { configured: true, appScope: "instance" })] });
    render(<ConnectedAccountsPanel secrets={[account, { id: "k", name: "Key", provider: "openai", createdAt: "" }]} onChanged={vi.fn()} />);
    const row = screen.getByTestId("connected-account-sec_acct");
    expect(within(row).getByText("Needs reconnect")).toBeVisible();
    expect(within(row).getByText("Needs reconnect: invalid_grant")).toBeVisible();
    expect(within(row).getByText("Scopes: chat:write")).toBeVisible();
    await waitFor(() => expect(within(row).getByRole("button", { name: "Reconnect" })).toBeVisible());
    expect(screen.queryByText("Key")).toBeNull();
  });

  it("shows Google's scope choices with the defaults ticked, and says who to ask when it cannot set up", async () => {
    vi.mocked(api.fetchConnectProviders).mockResolvedValue({
      redirectUrl,
      providers: [provider("google", { configured: true, appScope: "instance" }), provider("slack", { canConfigureInstance: false, canConfigureProject: false })]
    });
    render(<ConnectedAccountsPanel secrets={[]} onChanged={vi.fn()} />);
    const google = await screen.findByTestId("connect-provider-google");
    expect(within(google).getByLabelText("Sheets")).toBeChecked();
    expect(within(google).getByLabelText("Gmail (send)")).not.toBeChecked();
    expect(within(screen.getByTestId("connect-provider-slack")).getByText("Ask an admin to set up the Slack app.")).toBeVisible();
  });
});
