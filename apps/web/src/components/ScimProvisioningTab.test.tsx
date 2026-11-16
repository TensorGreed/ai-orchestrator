import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScimSettingsView, ScimTokenSummary } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { ScimProvisioningTab } from "./ScimProvisioningTab";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchScimSettings: vi.fn(),
    fetchScimGroups: vi.fn(),
    createScimToken: vi.fn(),
    rotateScimToken: vi.fn(),
    revokeScimToken: vi.fn()
  };
});

const token = (overrides: Partial<ScimTokenSummary> = {}): ScimTokenSummary => ({
  id: "sct_1",
  name: "idp",
  tokenPrefix: "scim_abcdefghij",
  createdBy: "usr_admin",
  createdAt: "2026-11-16T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  supersededBy: null,
  active: true,
  ...overrides
});

const settings = (overrides: Partial<ScimSettingsView> = {}): ScimSettingsView => ({
  enabled: true,
  baseUrl: "https://l2m.example.com/scim/v2",
  tokens: [token()],
  provisionedUsers: 3,
  disabledUsers: 1,
  groups: 2,
  ...overrides
});

describe("Provisioning (SCIM) tab", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchScimSettings).mockResolvedValue(settings());
    vi.mocked(api.fetchScimGroups).mockResolvedValue({
      groups: [
        { id: "scg_1", displayName: "Engineering", externalId: null, memberCount: 4, mappingIds: ["sgm_1"], createdAt: "", updatedAt: "" },
        { id: "scg_2", displayName: "Everyone", externalId: "g-2", memberCount: 9, mappingIds: [], createdAt: "", updatedAt: "" }
      ]
    });
  });

  afterEach(() => cleanup());

  it("shows the endpoint, tokens and which groups grant something", async () => {
    render(<ScimProvisioningTab />);
    expect(await screen.findByText("https://l2m.example.com/scim/v2")).toBeTruthy();
    expect(screen.getByText("scim_abcdefghij")).toBeTruthy();
    expect(screen.getByText("1 mapping")).toBeTruthy();
    expect(screen.getByText("nothing (no mapping)")).toBeTruthy();
  });

  it("says when SCIM is off", async () => {
    vi.mocked(api.fetchScimSettings).mockResolvedValue(settings({ enabled: false, tokens: [] }));
    render(<ScimProvisioningTab />);
    expect(await screen.findByText(/SCIM is off/)).toBeTruthy();
    expect(screen.getByText("No tokens yet.")).toBeTruthy();
  });

  it("shows a new token once", async () => {
    vi.mocked(api.createScimToken).mockResolvedValue({ token: "scim_abcdefghij.secret", record: token() });
    render(<ScimProvisioningTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Generate token" }));
    expect(api.createScimToken).toHaveBeenCalledWith({ name: "identity-provider" });
    expect(await screen.findByText("scim_abcdefghij.secret")).toBeTruthy();
  });

  it("revokes after a confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.revokeScimToken).mockResolvedValue({ ok: true });
    render(<ScimProvisioningTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke idp" }));
    expect(api.revokeScimToken).toHaveBeenCalledWith("sct_1");
  });
});
