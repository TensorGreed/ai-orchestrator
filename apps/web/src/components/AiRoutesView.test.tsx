import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGatewayRoute, AiGatewayUsageSummary } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { AiRoutesView } from "./AiRoutesView";
import { ClientAiGrants } from "./McpGatewayGovernance";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchAiGatewayRouteSets: vi.fn(),
    createAiGatewayRouteSet: vi.fn(),
    updateAiGatewayRouteSet: vi.fn(),
    deleteAiGatewayRouteSet: vi.fn(),
    createAiGatewayRoute: vi.fn(),
    updateAiGatewayRoute: vi.fn(),
    deleteAiGatewayRoute: vi.fn(),
    fetchAiGatewayClientGrants: vi.fn(),
    updateAiGatewayClientGrants: vi.fn(),
    fetchAiGatewayRouteSetGuard: vi.fn(),
    updateAiGatewayRouteSetGuard: vi.fn(),
    fetchAiGatewayUsage: vi.fn(),
    fetchMcpClients: vi.fn(),
    fetchProjects: vi.fn(),
    fetchSecrets: vi.fn(),
    fetchGuardProfiles: vi.fn(),
    fetchGuardProfile: vi.fn()
  };
});

const mocked = vi.mocked(api);

const route: AiGatewayRoute = {
  id: "airoute_1",
  routeSetId: "aiset_1",
  alias: "fast-chat",
  kind: "chat",
  providerId: "openai",
  model: "gpt-4o-mini",
  baseUrl: null,
  secretRef: { secretId: "sec_1" },
  extra: {},
  defaults: {},
  enabled: true,
  createdBy: "admin",
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z"
};

const set: api.AiGatewayRouteSetView = {
  id: "aiset_1",
  name: "Product apps",
  description: "",
  projectId: "default",
  enabled: true,
  rateLimit: null,
  createdBy: "admin",
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
  routes: [route],
  clientIds: ["mcc_1"]
};

const emptyTotals = { requests: 0, errors: 0, blocked: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, lastRequestAt: null };
const usage: AiGatewayUsageSummary = {
  window: "7d",
  totals: { ...emptyTotals, requests: 12, totalTokens: 3400, costUsd: 0.42, blocked: 1, lastRequestAt: "2026-11-04T11:00:00.000Z" },
  byAlias: [{ ...emptyTotals, alias: "fast-chat", providerId: "openai", model: "gpt-4o-mini", requests: 12, totalTokens: 3400, costUsd: 0.42, lastRequestAt: "2026-11-04T11:00:00.000Z" }],
  byClient: []
};

beforeEach(() => {
  mocked.fetchAiGatewayRouteSets.mockResolvedValue({ routeSets: [set], providers: { chat: ["openai", "anthropic"], embedding: ["openai"] } });
  mocked.fetchAiGatewayUsage.mockResolvedValue(usage);
  mocked.fetchMcpClients.mockResolvedValue({ usageWindow: "7d", clients: [{ id: "mcc_1", name: "Checkout app" } as api.McpClientView] });
  mocked.fetchProjects.mockResolvedValue({ projects: [{ id: "default", name: "Default" } as never] });
  mocked.fetchSecrets.mockResolvedValue([{ id: "sec_1", name: "OpenAI key", provider: "openai", createdAt: "2026-11-01T00:00:00.000Z", projectId: "default" }]);
  mocked.fetchGuardProfiles.mockResolvedValue({ profiles: [] } as never);
  mocked.fetchAiGatewayRouteSetGuard.mockResolvedValue({
    binding: { scope: "ai_route_set", scopeId: "aiset_1", mode: "inherit", profileId: null, updatedAt: null, updatedBy: null },
    effective: { stack: [] } as never
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AiRoutesView", () => {
  it("shows route sets, routes, clients and usage read-only for builders", async () => {
    render(<AiRoutesView isAdmin={false} />);
    const card = await screen.findByRole("article", { name: "Route set Product apps" });
    expect(within(card).getByText("fast-chat")).toBeInTheDocument();
    expect(within(card).getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(await within(card).findByText("Checkout app")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New route set" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "+ Add route" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    const usagePanel = screen.getByTestId("ai-gateway-usage");
    expect(await within(usagePanel).findByText(/12 requests/)).toBeInTheDocument();
    expect(within(usagePanel).getByText(/1 blocked by Guard/)).toBeInTheDocument();
    expect(screen.getByTestId("ai-gateway-endpoint").textContent).toMatch(/\/v1$/);
  });

  it("lets admins create a route set and add a route with a stored secret", async () => {
    const user = userEvent.setup();
    mocked.createAiGatewayRouteSet.mockResolvedValue({ ...set, id: "aiset_2", name: "Internal", routes: [], clientIds: [] });
    mocked.createAiGatewayRoute.mockResolvedValue({ ...route, id: "airoute_2", alias: "embed" });
    render(<AiRoutesView isAdmin activeProjectId="default" />);
    await user.click(await screen.findByRole("button", { name: "+ New route set" }));
    const form = screen.getByRole("form", { name: "New route set" });
    await user.type(within(form).getByLabelText("Name"), "Internal");
    await user.click(within(form).getByRole("button", { name: "Create route set" }));
    await waitFor(() => expect(mocked.createAiGatewayRouteSet).toHaveBeenCalledWith({ name: "Internal", description: "", projectId: "default" }));

    const card = await screen.findByRole("article", { name: "Route set Product apps" });
    await user.click(within(card).getByRole("button", { name: "+ Add route" }));
    const routeForm = within(card).getByRole("form", { name: "New route" });
    await user.type(within(routeForm).getByLabelText("Model name"), "embed");
    await user.selectOptions(within(routeForm).getByLabelText("Kind"), "embedding");
    await user.type(within(routeForm).getByLabelText("Upstream model"), "text-embedding-3-small");
    await user.selectOptions(within(routeForm).getByLabelText("API key"), "sec_1");
    await user.click(within(routeForm).getByRole("button", { name: "Add route" }));
    await waitFor(() =>
      expect(mocked.createAiGatewayRoute).toHaveBeenCalledWith("aiset_1", {
        alias: "embed",
        kind: "embedding",
        providerId: "openai",
        model: "text-embedding-3-small",
        baseUrl: null,
        secretRef: { secretId: "sec_1" },
        defaults: {},
        enabled: true
      })
    );
  });

  it("shows the API's refusal of a route", async () => {
    const user = userEvent.setup();
    mocked.createAiGatewayRoute.mockRejectedValue(new api.ApiError("The model name 'fast-chat' is already used by another route.", 409));
    render(<AiRoutesView isAdmin />);
    const card = await screen.findByRole("article", { name: "Route set Product apps" });
    await user.click(within(card).getByRole("button", { name: "+ Add route" }));
    const routeForm = within(card).getByRole("form", { name: "New route" });
    await user.type(within(routeForm).getByLabelText("Model name"), "fast-chat");
    await user.type(within(routeForm).getByLabelText("Upstream model"), "gpt-4o");
    await user.click(within(routeForm).getByRole("button", { name: "Add route" }));
    expect(await within(card).findByText(/already used by another route/)).toBeInTheDocument();
  });
});

describe("ClientAiGrants", () => {
  it("lets an admin grant route sets to a client", async () => {
    const user = userEvent.setup();
    mocked.fetchAiGatewayClientGrants.mockResolvedValue({ clientId: "mcc_9", routeSetIds: [] });
    mocked.updateAiGatewayClientGrants.mockResolvedValue({ clientId: "mcc_9", routeSetIds: ["aiset_1"] });
    render(<ClientAiGrants clientId="mcc_9" isAdmin />);
    const box = await screen.findByRole("checkbox", { name: /Product apps/ });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.updateAiGatewayClientGrants).toHaveBeenCalledWith("mcc_9", ["aiset_1"]));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows the grants read-only to builders", async () => {
    mocked.fetchAiGatewayClientGrants.mockResolvedValue({ clientId: "mcc_1", routeSetIds: ["aiset_1"] });
    render(<ClientAiGrants clientId="mcc_1" isAdmin={false} />);
    expect(await screen.findByText("Product apps")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
