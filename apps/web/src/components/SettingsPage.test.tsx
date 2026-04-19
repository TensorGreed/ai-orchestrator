import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { Project } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMfaStatus: vi.fn()
  };
});

function makeProjects(): Project[] {
  return [
    {
      id: "default",
      name: "Default",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows loading state for MFA tab while status is fetched", () => {
    vi.mocked(api.fetchMfaStatus).mockReturnValue(new Promise(() => undefined));

    render(
      <SettingsPage
        authUser={{ id: "u-1", email: "builder@example.com", role: "builder" }}
        projects={makeProjects()}
        activeProjectId="default"
      />
    );

    expect(screen.getByText(/Loading MFA status/)).toBeInTheDocument();
  });

  it("hides admin-only tabs for non-admin users", async () => {
    vi.mocked(api.fetchMfaStatus).mockResolvedValue({
      enabled: false,
      pending: false,
      activatedAt: null,
      remainingBackupCodes: 0
    });

    render(
      <SettingsPage
        authUser={{ id: "u-1", email: "builder@example.com", role: "builder" }}
        projects={makeProjects()}
        activeProjectId="default"
      />
    );

    expect(await screen.findByText("Two-factor authentication")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Custom Roles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "SSO Mappings" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "API Keys" })).toBeInTheDocument();
  });
});
