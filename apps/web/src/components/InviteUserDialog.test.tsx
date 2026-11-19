import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { InviteUserDialog } from "./InviteUserDialog";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, inviteUser: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("InviteUserDialog", () => {
  it("invites by email and role, and shows the link when no mail server is set", async () => {
    vi.mocked(api.inviteUser).mockResolvedValue({
      user: { id: "usr_1", email: "ana@example.com", role: "operator", pending: true },
      invite: { id: "inv_1", expiresAt: "2026-11-25T00:00:00.000Z" },
      emailed: false,
      inviteUrl: "http://localhost:5173/#invite=abc"
    });
    const onInvited = vi.fn();
    render(<InviteUserDialog onInvited={onInvited} onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Email"), "ana@example.com");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "operator");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(api.inviteUser).toHaveBeenCalledWith({ email: "ana@example.com", role: "operator" });
    expect(onInvited).toHaveBeenCalled();
    expect(screen.getByLabelText("Invite link")).toHaveValue("http://localhost:5173/#invite=abc");
    // Or send it from their own mail app: a message to the invitee with the link in it.
    const send = screen.getByRole("link", { name: "Send email" });
    const href = send.getAttribute("href") ?? "";
    expect(href.startsWith("mailto:ana@example.com?")).toBe(true);
    expect(decodeURIComponent(href)).toContain("http://localhost:5173/#invite=abc");
    expect(decodeURIComponent(href)).toContain("as operator");
  });

  it("says the invite was emailed when it was, and checks the email first", async () => {
    vi.mocked(api.inviteUser).mockResolvedValue({
      user: { id: "usr_1", email: "ana@example.com", role: "viewer", pending: true },
      invite: { id: "inv_1", expiresAt: "2026-11-25T00:00:00.000Z" },
      emailed: true
    });
    render(<InviteUserDialog onInvited={() => undefined} onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Email"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Enter an email address/);
    expect(api.inviteUser).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Email"));
    await userEvent.type(screen.getByLabelText("Email"), "ana@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(screen.getByRole("status")).toHaveTextContent("Invite sent to ana@example.com as viewer.");
    expect(screen.queryByLabelText("Invite link")).not.toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    vi.mocked(api.inviteUser).mockRejectedValue(new Error("An account with this email already exists"));
    render(<InviteUserDialog onInvited={() => undefined} onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Email"), "ana@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An account with this email already exists");
  });
});
