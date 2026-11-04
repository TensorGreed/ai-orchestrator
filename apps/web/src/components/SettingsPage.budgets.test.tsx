import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { BudgetsPanel, budgetScopeLabel } from "./SettingsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchBudgets: vi.fn(), fetchBudgetAlerts: vi.fn(), createBudget: vi.fn(), fetchMcpClients: vi.fn() };
});

const client = (id: string, name: string, status: api.McpClientView["status"]): api.McpClientView => ({
  id,
  name,
  tokenPrefix: "l2m_mcp_x",
  toolsetIds: [],
  role: "builder",
  createdBy: null,
  createdByEmail: null,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: status === "revoked" ? "2026-10-01T00:00:00.000Z" : null,
  createdAt: "2026-10-01T00:00:00.000Z",
  rateLimit: null,
  status,
  effectiveRole: "builder",
  activeSessions: 0,
  usage: { calls: 0, errors: 0, lastCalledAt: null }
});

const budget = (overrides: Partial<api.Budget>): api.Budget =>
  ({
    id: "b1",
    name: "IDE spend",
    scopeType: "mcp_client",
    scopeId: "mcc_1",
    period: "month",
    limitType: "usd",
    limitValue: 20,
    warnThresholdPct: 0.8,
    action: "block",
    notifyChannel: null,
    enabled: true,
    createdBy: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  }) as api.Budget;

describe("Budgets panel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchBudgets).mockResolvedValue({ budgets: [budget({})] });
    vi.mocked(api.fetchBudgetAlerts).mockResolvedValue({ alerts: [] });
    vi.mocked(api.fetchMcpClients).mockResolvedValue({ usageWindow: "7d", clients: [client("mcc_1", "Team IDE", "active"), client("mcc_2", "Old agent", "revoked")] });
    vi.mocked(api.createBudget).mockResolvedValue({ budget: budget({ id: "b2" }) });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("names a client budget's client, says block applies to every trigger, and creates a budget for an active client", async () => {
    const user = userEvent.setup();
    render(<BudgetsPanel />);
    expect(await screen.findByText("MCP client: Team IDE")).toBeInTheDocument();
    expect(screen.getByText(/stops new runs from every trigger/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ New budget" }));
    await user.type(screen.getByLabelText("Name"), "Agent cap");
    await user.selectOptions(screen.getByLabelText("Scope"), "mcp_client");
    const picker = screen.getByLabelText("Client");
    expect(within(picker).queryByRole("option", { name: "Old agent" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scope ID")).not.toBeInTheDocument();
    await user.selectOptions(picker, "mcc_1");
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(api.createBudget).toHaveBeenCalledWith(expect.objectContaining({ name: "Agent cap", scopeType: "mcp_client", scopeId: "mcc_1" }));
  });

  it("labels each scope", () => {
    expect(budgetScopeLabel({ scopeType: "mcp_client", scopeId: "gone" }, [])).toBe("MCP client: gone");
    expect(budgetScopeLabel({ scopeType: "project", scopeId: "p1" }, [])).toBe("project:p1");
    expect(budgetScopeLabel({ scopeType: "global", scopeId: null }, [])).toBe("global");
  });
});
