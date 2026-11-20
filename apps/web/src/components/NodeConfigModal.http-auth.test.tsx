import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "reactflow";
import type { EditorNodeData } from "../lib/workflow";
import * as api from "../lib/api";
import type { SecretListItem } from "../lib/api";
import { NodeInspector } from "./NodeConfigModal";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchProviderModels: vi.fn(), previewExpression: vi.fn(), startConnect: vi.fn() };
});

const secrets: SecretListItem[] = [
  { id: "sec_key", name: "Tickets key", provider: "custom", createdAt: "2026-11-20T00:00:00.000Z" },
  {
    id: "sec_acct",
    name: "Google · ana@example.com",
    provider: "oauth_account",
    createdAt: "2026-11-20T00:00:00.000Z",
    connection: {
      providerId: "google",
      accountLabel: "ana@example.com",
      scopes: [],
      status: "needs_reconnect",
      expiresAt: null,
      refreshable: true,
      lastError: "invalid_grant",
      connectedBy: null,
      connectedAt: "2026-11-20T00:00:00.000Z",
      lastRefreshAt: null
    }
  }
];

function node(nodeType: string, config: Record<string, unknown>): Node<EditorNodeData> {
  return { id: "n", type: "workflowNode", position: { x: 0, y: 0 }, data: { label: "Node", nodeType, config } } as Node<EditorNodeData>;
}

function props(nodeType: string, config: Record<string, unknown>, onSave = vi.fn()): Parameters<typeof NodeInspector>[0] {
  return {
    node: node(nodeType, config),
    inputOptions: [],
    executionResult: null,
    nodeLabels: new Map(),
    onNavigateNode: vi.fn(),
    workflowContext: { id: "wf-1", name: "Workflow 1", vars: {} },
    pinnedData: {},
    showRuntimeInspection: true,
    secrets,
    onRefreshSecrets: vi.fn(),
    mcpServerDefinitions: [],
    onClose: vi.fn(),
    onSave,
    onExecuteStep: vi.fn(),
    onPinNodeOutput: vi.fn(),
    onUnpinNodeOutput: vi.fn()
  };
}

const optionLabels = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((option) => option.textContent);

describe("HTTP Request Auth", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.previewExpression).mockResolvedValue({ ok: true, result: "" });
  });

  it("shows only the Auth choice for None, and an old secret-only config as Bearer token", () => {
    const { unmount } = render(<NodeInspector {...props("http_request", { method: "GET", urlTemplate: "https://x.test" })} />);
    expect(screen.getByLabelText("Auth")).toHaveValue("none");
    expect(screen.queryByLabelText("Token secret")).toBeNull();
    unmount();
    render(<NodeInspector {...props("http_request", { method: "GET", urlTemplate: "https://x.test", secretRef: { secretId: "sec_key" } })} />);
    expect(screen.getByLabelText("Auth")).toHaveValue("bearer");
    expect(screen.getByLabelText("Token secret")).toHaveValue("sec_key");
    // Connected accounts are not offered as typed secrets.
    expect(optionLabels(screen.getByLabelText("Token secret"))).not.toContain("Google · ana@example.com (needs reconnect)");
  });

  it("asks for the fields each choice needs", async () => {
    const user = userEvent.setup();
    render(<NodeInspector {...props("http_request", { method: "GET", urlTemplate: "https://x.test" })} />);
    await user.selectOptions(screen.getByLabelText("Auth"), "header");
    expect(screen.getByLabelText("Header name")).toHaveValue("X-API-Key");
    await user.selectOptions(screen.getByLabelText("Auth"), "oauth2_client_credentials");
    expect(screen.getByLabelText("Token URL")).toBeVisible();
    expect(screen.getByLabelText("Client ID")).toBeVisible();
    expect(screen.getByLabelText("Client secret")).toBeVisible();
    expect(screen.getByLabelText("Send client credentials")).not.toBeVisible(); // under More
    await user.selectOptions(screen.getByLabelText("Auth"), "connected");
    const account = screen.getByLabelText("Account");
    expect(optionLabels(account)).toEqual([
      "Select account",
      "Google · ana@example.com (needs reconnect)",
      "+ Connect Slack…",
      "+ Connect Google…",
      "+ Connect GitHub…",
      "+ Connect Microsoft…",
      "+ Connect Notion…"
    ]);
  });

  it("offers Reconnect for a picked account that needs it", () => {
    render(<NodeInspector {...props("http_request", { method: "GET", urlTemplate: "https://x.test", secretRef: { secretId: "sec_acct" }, secretAuth: { type: "connected" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/needs to be reconnected/);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });
});

describe("Connector nodes offer their provider's account", () => {
  it("Slack lists Connect Slack next to Add New Credential", () => {
    render(<NodeInspector {...props("slack_send_message", { authType: "bot", channel: "#ops", text: "hi" })} />);
    const picker = screen.getAllByRole("combobox").find((element) => optionLabels(element).includes("+ Connect Slack…"));
    expect(picker).toBeTruthy();
    expect(optionLabels(picker!)).toContain("+ Add New Credential...");
    // A Google account is not offered for Slack.
    expect(optionLabels(picker!).some((label) => label?.startsWith("Google ·"))).toBe(false);
  });
});
