import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import * as api from "../lib/api";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMfaStatus: vi.fn(),
    fetchMySessions: vi.fn(),
    fetchDeploymentUsers: vi.fn(),
    revokeUserSessions: vi.fn(),
    resetUserPassword: vi.fn(),
    changeMyPassword: vi.fn()
  };
});

const projects = [{ id: "default", name: "Default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];

describe("Settings users and sessions", () => {
  beforeEach(() => {
    vi.mocked(api.fetchMfaStatus).mockReset().mockResolvedValue({ enabled: false, pending: false, activatedAt: null, remainingBackupCodes: 0 });
    vi.mocked(api.fetchMySessions).mockReset().mockResolvedValue({
      sessions: [],
      policy: { idleTimeoutMinutes: null, absoluteTimeoutHours: 12, maxPerUser: null }
    });
    vi.mocked(api.fetchDeploymentUsers).mockReset().mockResolvedValue({
      users: [
        { id: "u-admin", email: "admin@example.com", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "u-2", email: "dev@example.com", role: "builder", createdAt: "2026-01-02T00:00:00.000Z" }
      ]
    });
    vi.mocked(api.revokeUserSessions).mockReset().mockResolvedValue({ revoked: 3 });
    vi.mocked(api.resetUserPassword).mockReset().mockResolvedValue({ ok: true, userId: "u-2", temporaryPassword: "Tmp-pass-abcdefghijklmn", sessionsEnded: 2 });
    vi.mocked(api.changeMyPassword).mockReset().mockResolvedValue({ ok: true, sessionsEnded: 1 });
  });

  it("shows the signed-in sessions card on the Security tab", async () => {
    render(<SettingsPage authUser={{ id: "u-2", email: "dev@example.com", role: "builder" }} projects={projects} activeProjectId="default" />);
    expect(await screen.findByRole("heading", { name: "Signed-in sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Users" })).not.toBeInTheDocument();
  });

  it("an admin signs a user out everywhere after confirming", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage authUser={{ id: "u-admin", email: "admin@example.com", role: "admin" }} projects={projects} activeProjectId="default" />);
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign dev@example.com out everywhere" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.revokeUserSessions).toHaveBeenCalledWith("u-2"));
    expect(await screen.findByText("Ended 3 sessions for dev@example.com.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("does nothing when the confirm is dismissed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SettingsPage authUser={{ id: "u-admin", email: "admin@example.com", role: "admin" }} projects={projects} activeProjectId="default" />);
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign dev@example.com out everywhere" }));
    expect(api.revokeUserSessions).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("changes your own password on the Security tab once the new one is confirmed", async () => {
    render(<SettingsPage authUser={{ id: "u-2", email: "dev@example.com", role: "builder" }} projects={projects} activeProjectId="default" />);
    const submit = await screen.findByRole("button", { name: "Change password" });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: "new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm the new password"), { target: { value: "new-password-2" } });
    expect(screen.getByText("The passwords do not match.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm the new password"), { target: { value: "new-password-1" } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.changeMyPassword).toHaveBeenCalledWith({ currentPassword: "old-password", newPassword: "new-password-1" }));
    expect(await screen.findByText("Password changed. 1 other session was signed out.")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("an admin sets a temporary password for another user and sees it once", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SettingsPage authUser={{ id: "u-admin", email: "admin@example.com", role: "admin" }} projects={projects} activeProjectId="default" />);
    fireEvent.click(screen.getByRole("tab", { name: "Users" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set a temporary password for dev@example.com" }));
    await waitFor(() => expect(api.resetUserPassword).toHaveBeenCalledWith("u-2"));
    expect(await screen.findByText("Tmp-pass-abcdefghijklmn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set a temporary password for admin@example.com" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Tmp-pass-abcdefghijklmn")).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
